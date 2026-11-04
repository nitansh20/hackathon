// Deterministic preflight engine + optional AI adapter (provider-independent).
// Every finding links ONLY to real approved knowledge_items in the workspace.
const { db, uid } = require('./db');

const today = () => new Date().toISOString().slice(0, 10);

function getApproved(workspaceId) {
  return db.prepare(`SELECT * FROM knowledge_items WHERE workspace_id=? AND status='approved' ORDER BY created_at`).all(workspaceId);
}

function spanOf(body, term) {
  if (!term) return { start: -1, end: -1 };
  const i = body.toLowerCase().indexOf(term.toLowerCase());
  return i < 0 ? { start: -1, end: -1 } : { start: i, end: i + term.length };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Some rules have no "text span" (e.g. a fact the content should state correctly but
// states wrongly, or a disclaimer that is entirely missing). We record matched_text
// as the span text or the offending sentence.
function runDeterministicChecks(workspaceId, submission) {
  const body = submission.body || '';
  const lower = body.toLowerCase();
  const knowledge = getApproved(workspaceId);
  const todayStr = today();
  const findings = [];
  const add = (f) => findings.push({ id: uid('fnd'), ...f });

  const facts = knowledge.filter((k) => k.type === 'fact');
  const terms = knowledge.filter((k) => k.type === 'terminology');
  const claims = knowledge.filter((k) => k.type === 'claim');
  const voices = knowledge.filter((k) => k.type === 'voice');
  const expired = (k) => k.expires_at && k.expires_at < todayStr;
  const moneyRe = /₹\s*[\d,.]+(?:\s*\/\s*month)?/gi;
  const numRe = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\s*(?:%|million|customers?|users?)\b/gi;

  // --- 1. Terminology: forbidden terms present -> POLICY VIOLATION
  for (const t of terms) {
    if (!t.forbidden_term) continue;
    const sp = spanOf(body, t.forbidden_term);
    if (sp.start >= 0) {
      add({
        subject: t.name, category: 'POLICY VIOLATION', severity: t.severity || 'high',
        matched_text: body.slice(sp.start, sp.end), span_start: sp.start, span_end: sp.end,
        explanation: `Forbidden term "${t.forbidden_term}" used. Approved term is "${t.preferred_term || t.replacement}". ${t.description || ''}`.trim(),
        evidence_id: t.id, evidence_excerpt: `${t.forbidden_term} → ${t.preferred_term || t.replacement}${t.description ? ' — ' + t.description : ''}`,
        correction: t.replacement || t.preferred_term, correction_mode: 'deterministic',
      });
    }
  }

  // --- 2. Product facts: contradictions, stale, price mismatch
  for (const fact of facts) {
    const approved = fact.approved_value || '';
    // stale fact usage check: any ₹ price different from approved price
    if (/₹/.test(approved)) {
      let m;
      const re = new RegExp(moneyRe.source, 'gi');
      while ((m = re.exec(body)) !== null) {
        const norm = m[0].replace(/\s+/g, '').replace(/,/g, '');
        const approvedNorm = approved.replace(/\s+/g, '').replace(/,/g, '');
        if (norm !== approvedNorm) {
          add({
            subject: fact.name, category: 'CONTRADICTED', severity: fact.severity || 'critical',
            matched_text: m[0], span_start: m.index, span_end: m.index + m[0].length,
            explanation: `Price "${m[0]}" conflicts with the approved value "${approved}".`,
            evidence_id: fact.id, evidence_excerpt: `${fact.name}: ${approved}${fact.source ? ' — Source: ' + fact.source : ''}`,
            correction: approved, correction_mode: 'deterministic',
          });
        }
      }
    }
    // launch status contradictions: look for negation patterns of approved status
    if (fact.name.toLowerCase().includes('launch')) {
      const negations = [
        { re: /fully launched|launched worldwide|now available|available now|launch(?:ed)?\b(?!.*early access)/i, claim: 'fully launched / generally available' },
        { re: /early access/i, claim: 'early access' },
      ];
      for (const n of negations) {
        const m = body.match(n.re);
        if (m) {
          const claimIsDifferent = !approved.toLowerCase().includes(m[0].toLowerCase()) && !m[0].toLowerCase().includes(approved.toLowerCase());
          if (claimIsDifferent) {
            const matched = m[0];
            const s = spanOf(body, matched);
            add({
              subject: fact.name, category: 'CONTRADICTED', severity: fact.severity || 'high',
              matched_text: matched, span_start: s.start, span_end: s.end,
              explanation: `Content states "${matched}" but the approved launch status is "${approved}".`,
              evidence_id: fact.id, evidence_excerpt: `${fact.name}: ${approved}`,
              correction: approved, correction_mode: 'deterministic',
            });
          }
        }
      }
    }
    // staleness: fact expired but content relies on it (price mentioned)
    if (expired(fact) && body.toLowerCase().includes(fact.name.toLowerCase().split(' ')[0])) {
      add({
        subject: fact.name, category: 'STALE', severity: fact.severity || 'medium',
        matched_text: '', span_start: -1, span_end: -1,
        explanation: `Supporting fact "${fact.name}" expired on ${fact.expires_at} and should be re-verified before publication.`,
        evidence_id: fact.id, evidence_excerpt: `${fact.name}: ${approved} (expired ${fact.expires_at})`,
        correction: '', correction_mode: 'deterministic',
      });
    }
  }

  // --- 3. Prohibited claims present -> POLICY VIOLATION; approved claims missing required disclaimers
  for (const c of claims) {
    const txt = c.claim_text || c.name;
    if (c.claim_type === 'prohibited' && txt) {
      const sp = spanOf(body, txt);
      if (sp.start >= 0) {
        add({
          subject: c.name, category: 'POLICY VIOLATION', severity: c.severity || 'critical',
          matched_text: body.slice(sp.start, sp.end), span_start: sp.start, span_end: sp.end,
          explanation: `Prohibited claim "${txt}" appears in the content. ${c.description || ''}`.trim(),
          evidence_id: c.id, evidence_excerpt: `Prohibited: "${txt}"${c.description ? ' — ' + c.description : ''}`,
          correction: '', correction_mode: 'deterministic',
        });
      }
    }
  }

  // --- 4. Required disclaimers missing
  for (const k of knowledge.filter((x) => x.type === 'disclaimer' || (x.type === 'claim'))) {
    const d = k.disclaimer_text || (k.claim_type === 'required' ? k.claim_text : '');
    if (d && !body.toLowerCase().includes(d.toLowerCase())) {
      add({
        subject: k.name, category: 'POLICY VIOLATION', severity: k.severity || 'high',
        matched_text: '', span_start: -1, span_end: -1,
        explanation: `Required disclaimer is missing: "${d}".`,
        evidence_id: k.id, evidence_excerpt: `Required disclaimer: "${d}"`,
        correction: d, correction_mode: 'deterministic',
      });
    }
  }

  // --- 5. Unverified quantitative / superlative claims (no evidence -> UNSUPPORTED, not "false")
  const numbers = [...body.matchAll(numRe)].map((m) => ({ text: m[0], index: m.index }));
  let sawPrice = false;
  for (const n of numbers) {
    if (/₹/.test(n.text)) { if (!sawPrice) { sawPrice = true; } continue; }
    const approvedMatch = facts.some((f) => (f.approved_value || '').toLowerCase().includes(n.text.toLowerCase()));
    if (!approvedMatch) {
      add({
        subject: 'Unverified claim', category: 'UNSUPPORTED', severity: 'high',
        matched_text: n.text, span_start: n.index, span_end: n.index + n.text.length,
        explanation: `Claim "${n.text}" has no approved source in this workspace. It is unverified, not proven false — remove it or add an approved source.`,
        evidence_id: '', evidence_excerpt: 'No approved source found in this workspace.',
        correction: '', correction_mode: 'deterministic',
      });
    }
  }
  const superlatives = ['world\'s most accurate', 'most accurate ai', 'best in the world', 'number one', 'unmatched', 'revolutionary'];
  for (const s of superlatives) {
    const sp = spanOf(body, s);
    if (sp.start >= 0) {
      const supported = claims.some((c) => c.claim_type === 'approved' && (c.claim_text || '').toLowerCase().includes(s.toLowerCase()));
      if (!supported) {
        add({
          subject: 'Unverified superlative', category: 'UNSUPPORTED', severity: 'high',
          matched_text: body.slice(sp.start, sp.end), span_start: sp.start, span_end: sp.end,
          explanation: `Superlative "${body.slice(sp.start, sp.end)}" is unverified — no approved source supports it.`,
          evidence_id: '', evidence_excerpt: 'No approved source found in this workspace.',
          correction: '', correction_mode: 'deterministic',
        });
      }
    }
  }
  // "fully launched worldwide" style scope claims with no evidence
  if (/fully launched|launched worldwide/i.test(body)) {
    const launchFact = facts.find((f) => f.name.toLowerCase().includes('launch'));
    if (launchFact) {
      add({
        subject: 'Global availability claim', category: 'UNSUPPORTED', severity: 'high',
        matched_text: 'worldwide', span_start: spanOf(body, 'worldwide').start, span_end: spanOf(body, 'worldwide').end,
        explanation: `Global availability ("worldwide") is contradicted by approved launch status "${launchFact.approved_value}" and is unverified.`,
        evidence_id: launchFact.id, evidence_excerpt: `Launch status: ${launchFact.approved_value}`,
        correction: '', correction_mode: 'deterministic',
      });
    }
  }

  // --- 6. Approved claims present -> ok (no finding); voice rules -> style / policy checks
  const exaggerated = ['guaranteed', '100% success', 'perfect', 'never fails', 'instantly'];
  for (const t of terms.concat(claims.filter((c) => c.claim_type === 'prohibited'))) {
    const txt = t.forbidden_term || t.claim_text || '';
    if (!txt) continue;
    const sp = spanOf(body, txt);
    if (sp.start >= 0) {
      const note = `Voice rule "${t.name}" (${t.tone || 'professional'}): avoid exaggerated promises.`;
      add({
        subject: 'Exaggerated language', category: 'STYLE SUGGESTION', severity: 'low',
        matched_text: body.slice(sp.start, sp.end), span_start: sp.start, span_end: sp.end,
        explanation: `Exaggerated language detected ("${body.slice(sp.start, sp.end)}"). ${t.description || note}`,
        evidence_id: t.id, evidence_excerpt: t.description || note,
        correction: '', correction_mode: 'deterministic',
      });
    }
  }
  for (const ex of exaggerated) {
    if (ex === 'guaranteed') continue; // already covered as prohibited phrase
    const sp = spanOf(body, ex);
    if (sp.start >= 0) {
      const voice = voices[0];
      add({
        subject: 'Exaggerated language', category: 'STYLE SUGGESTION', severity: 'low',
        matched_text: body.slice(sp.start, sp.end), span_start: sp.start, span_end: sp.end,
        explanation: `"${body.slice(sp.start, sp.end)}" reads as an exaggerated promise. Brand voice rules ask for direct, non-exaggerated language.`,
        evidence_id: voice ? voice.id : '', evidence_excerpt: voice ? voice.description : 'Avoid exaggerated promises.',
        correction: '', correction_mode: 'deterministic',
      });
    }
  }

  // --- 7. Conflicting rules: flag once per workspace scan if two approved items share name but differ
  const byName = {};
  for (const k of knowledge) { (byName[k.name] = byName[k.name] || []).push(k); }
  for (const [name, items] of Object.entries(byName)) {
    const vals = new Set(items.map((i) => (i.approved_value || i.preferred_term || i.claim_text || '').trim()));
    if (items.length > 1 && vals.size > 1) {
      add({
        subject: name, category: 'CONFLICTING', severity: 'high',
        matched_text: '', span_start: -1, span_end: -1,
        explanation: `Approved sources for "${name}" disagree (${[...vals].join(' vs ')}). Resolve the conflict in Brand Knowledge before relying on either.`,
        evidence_id: items[0].id, evidence_excerpt: items.map((i) => `${i.approved_value || i.preferred_term || i.claim_text}`).join(' / '),
        correction: '', correction_mode: 'deterministic',
      });
    }
  }

  return findings;
}

// AI adapter stub: only runs when OPENAI_API_KEY is set server-side. Without a key
// the app reports "AI analysis unavailable" — deterministic checks still run.
async function runAiAnalysis(workspaceId, submission, deterministic) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return { available: false, findings: [] };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: 'You classify marketing claims. Return ONLY JSON array of {matched_text,category,severity,explanation}. Do not invent source IDs.' },
          { role: 'user', content: `Content: ${submission.body}` },
        ],
      }),
    });
    if (!res.ok) return { available: false, findings: [] };
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content || '[]');
    const findings = [];
    for (const p of Array.isArray(parsed) ? parsed : []) {
      if (!p.matched_text) continue;
      const sp = spanOf(submission.body, p.matched_text);
      findings.push({
        id: uid('fnd'), subject: p.matched_text, category: p.category || 'UNSUPPORTED',
        severity: p.severity || 'medium', matched_text: p.matched_text,
        span_start: sp.start, span_end: sp.end, explanation: p.explanation || '',
        evidence_id: '', evidence_excerpt: 'AI analysis — no approved source cited.',
        correction: '', correction_mode: 'ai',
      });
    }
    return { available: true, findings };
  } catch { return { available: false, findings: [] }; }
}

function executePreflight(workspaceId, submissionId) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id=? AND workspace_id=?').get(submissionId, workspaceId);
  if (!sub) throw new Error('submission not found');
  if (!sub.body || !sub.body.trim()) throw new Error('empty content');

  const runId = uid('run');
  const deterministic = runDeterministicChecks(workspaceId, sub);
  const inserts = [];
  for (const f of deterministic) {
    if (f.evidence_id) {
      const ev = db.prepare('SELECT id FROM knowledge_items WHERE id=? AND workspace_id=? AND status=?').get(f.evidence_id, workspaceId, 'approved');
      if (!ev) { f.evidence_id = ''; f.evidence_excerpt = 'Evidence could not be verified against approved records — UNVERIFIED.'; f.category = 'UNSUPPORTED'; }
    }
    inserts.push(f);
  }
  const ai = { available: false, findings: [] };
  const crit = inserts.filter((f) => f.severity === 'critical').length;
  const summary = `${inserts.length} finding(s) · ${crit} critical · deterministic checks`;
  db.prepare('INSERT INTO preflight_runs (id, submission_id, workspace_id, result_summary, findings_count, critical_count, ai_used) VALUES (?,?,?,?,?,?,?)')
    .run(runId, submissionId, workspaceId, summary, inserts.length, crit, ai.available ? 1 : 0);
  const stmt = db.prepare(`INSERT INTO findings (id, run_id, submission_id, workspace_id, subject, matched_text, span_start, span_end, category, severity, status, explanation, evidence_id, evidence_excerpt, correction, correction_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const f of inserts) {
    stmt.run(f.id, runId, submissionId, workspaceId, f.subject, f.matched_text, f.span_start, f.span_end, f.category, f.severity, 'open', f.explanation, f.evidence_id, f.evidence_excerpt, f.correction, f.correction_mode);
  }
  if (sub.status === 'draft' || sub.status === 'preflighted' || sub.status === 'resubmitted' || sub.status === 'changes_requested') {
    db.prepare(`UPDATE submissions SET status='preflighted', updated_at=datetime('now') WHERE id=?`).run(submissionId);
  }
  return { run_id: runId, findings: inserts, ai_available: ai.available, summary };
}

function highlightSpans(body, findings) {
  const spans = findings.filter((f) => f.span_start >= 0 && f.span_end > f.span_start)
    .sort((a, b) => a.span_start - b.span_start);
  let out = '', pos = 0;
  for (const f of spans) {
    if (f.span_start < pos) continue;
    out += escapeHtml(body.slice(pos, f.span_start));
    out += `<mark data-finding="${f.id}" class="finding-highlight sev-${f.severity}">${escapeHtml(body.slice(f.span_start, f.span_end))}</mark>`;
    pos = f.span_end;
  }
  out += escapeHtml(body.slice(pos));
  return out;
}

module.exports = { runDeterministicChecks, executePreflight, highlightSpans, runAiAnalysis };
