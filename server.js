// PROOFLINE server — zero external dependencies (Node stdlib http + node:sqlite)
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const url = require('node:url');
const { db, migrate, uid, audit } = require('./db');
const { executePreflight, highlightSpans } = require('./preflight');

migrate();
const PORT = process.env.PORT || 8080;

function sendJson(res, obj, status = 200) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2_000_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
// Demo identity: every request carries an actor + workspace + role from the UI shell.
function identity(req) {
  const h = (n, d) => (req.headers[n] || d || '').trim();
  return {
    actor: h('x-user', 'Alex (Admin)'),
    role: h('x-role', 'admin'),
    workspace: h('x-workspace', 'ws_acme_cloud'),
  };
}
function requireRole(role, allowed) {
  if (!allowed.includes(role)) throw Object.assign(new Error(`Forbidden: role ${role} cannot do this`), { status: 403 });
}
function workspaceMember(workspaceId, actor) {
  return db.prepare('SELECT * FROM memberships WHERE workspace_id=? AND user_name=?').get(workspaceId, actor);
}
const VALID_STATUSES = ['draft', 'pending', 'approved', 'archived'];
const VALID_TRANSITIONS = {
  draft: ['preflighted', 'in_review', 'rejected'],
  preflighted: ['in_review', 'draft'],
  in_review: ['approved', 'changes_requested', 'rejected'],
  changes_requested: ['resubmitted', 'draft'],
  resubmitted: ['in_review', 'changes_requested', 'approved', 'rejected'],
  approved: [], rejected: ['draft'],
};

function latestRun(subId) {
  return db.prepare('SELECT * FROM preflight_runs WHERE submission_id=? ORDER BY created_at DESC LIMIT 1').get(subId);
}
function findingsFor(subId) {
  const run = latestRun(subId);
  if (!run) return { run: null, findings: [], highlighted: '' };
  const findings = db.prepare('SELECT * FROM findings WHERE submission_id=? AND run_id=? ORDER BY severity, created_at').all(subId, run.id);
  const sub = db.prepare('SELECT body FROM submissions WHERE id=?').get(subId);
  return { run, findings, highlighted: sub ? highlightSpans(sub.body, findings) : '' };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const method = req.method;
  const auth = identity(req);
  try {
    if (p === '/health') return sendJson(res, { ok: true, service: 'proofline' });

    // Serve frontend
    if (p.startsWith('/static/')) {
      const file = path.join(__dirname, 'public', p.replace('/static/', ''));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(404); return res.end('not found');
    }
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }

    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('not found'); }

    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};
    const ws = body.workspace_id || auth.workspace;
    const W = auth.workspace;

    // Open endpoints (no workspace check)
    if (p === '/api/workspaces' && method === 'GET') {
      return sendJson(res, { workspaces: db.prepare('SELECT * FROM workspaces').all() });
    }
    if (p === '/api/members' && method === 'GET') {
      return sendJson(res, { members: db.prepare('SELECT * FROM memberships WHERE workspace_id=?').all(W) });
    }
    if (p === '/api/audit' && method === 'GET') {
      const q = (u.query.q || '').trim().toLowerCase();
      let rows = db.prepare('SELECT * FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200').all(W);
      if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
      return sendJson(res, { events: rows });
    }

    // Knowledge CRUD
    if (p === '/api/knowledge' && method === 'GET') {
      const type = u.query.type;
      const status = u.query.status;
      let sql = 'SELECT * FROM knowledge_items WHERE workspace_id=?'; const args = [W];
      if (type) { sql += ' AND type=?'; args.push(type); }
      if (status) { sql += ' AND status=?'; args.push(status); }
      return sendJson(res, { items: db.prepare(sql + ' ORDER BY updated_at DESC').all(...args) });
    }
    if (p === '/api/knowledge' && method === 'POST') {
      requireRole(auth.role, ['admin']);
      const k = body;
      if (!k.name || !k.type) return sendJson(res, { error: 'name and type required' }, 400);
      if (k.status && !VALID_STATUSES.includes(k.status)) return sendJson(res, { error: 'invalid status' }, 400);
      const id = uid('know');
      db.prepare(`INSERT INTO knowledge_items
        (id, workspace_id, type, name, status, severity, version, source, approved_value, description,
         preferred_term, forbidden_term, replacement, claim_text, disclaimer_text, claim_type, context,
         effective_from, expires_at, last_verified, owner, acceptable_examples, unacceptable_examples, tone, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, W, k.type, k.name, k.status || 'draft', k.severity || 'medium', k.version || '1.0', k.source || '',
          k.approved_value || '', k.description || '', k.preferred_term || '', k.forbidden_term || '', k.replacement || '',
          k.claim_text || '', k.disclaimer_text || '', k.claim_type || '', k.context || '',
          k.effective_from || '', k.expires_at || '', k.last_verified || '', k.owner || '',
          k.acceptable_examples || '', k.unacceptable_examples || '', k.tone || '', auth.actor);
      audit(W, auth.actor, auth.role, 'knowledge.created', 'knowledge_item', id, `${k.type} "${k.name}" created`);
      return sendJson(res, { id }, 201);
    }
    if (p.startsWith('/api/knowledge/')) {
      const id = p.replace('/api/knowledge/', '');
      const item = db.prepare('SELECT * FROM knowledge_items WHERE id=? AND workspace_id=?').get(id, W);
      if (!item) return sendJson(res, { error: 'not found' }, 404);
      if (method === 'GET') return sendJson(res, { item });
      if (method === 'PUT') {
        requireRole(auth.role, ['admin']);
        const st = body.status || item.status;
        if (!VALID_STATUSES.includes(st)) return sendJson(res, { error: 'invalid status' }, 400);
        const fields = ['name','status','severity','version','source','approved_value','description','preferred_term','forbidden_term','replacement','claim_text','disclaimer_text','claim_type','context','effective_from','expires_at','last_verified','owner','acceptable_examples','unacceptable_examples','tone'];
        const sets = [], vals = [];
        for (const f of fields) if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(body[f]); }
        if (sets.length) db.prepare(`UPDATE knowledge_items SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...vals, id);
        audit(W, auth.actor, auth.role, `knowledge.${body.status ? 'status_' + body.status : 'updated'}`, 'knowledge_item', id, `${item.type} "${item.name}" ${body.status ? ('set to ' + body.status) : 'updated'}`);
        return sendJson(res, { ok: true });
      }
      if (method === 'DELETE') {
        requireRole(auth.role, ['admin']);
        db.prepare('DELETE FROM knowledge_items WHERE id=?').run(id);
        audit(W, auth.actor, auth.role, 'knowledge.deleted', 'knowledge_item', id, `${item.type} "${item.name}" deleted`);
        return sendJson(res, { ok: true });
      }
    }

    // Source documents + extracted items
    if (p === '/api/documents' && method === 'GET') {
      return sendJson(res, { documents: db.prepare('SELECT * FROM source_documents WHERE workspace_id=? ORDER BY created_at DESC').all(W),
        items: db.prepare('SELECT * FROM extracted_items WHERE workspace_id=? ORDER BY created_at DESC').all(W) });
    }
    if (p === '/api/documents' && method === 'POST') {
      requireRole(auth.role, ['admin', 'creator']);
      const id = uid('doc');
      db.prepare('INSERT INTO source_documents (id, workspace_id, title, text, origin, status, created_by) VALUES (?,?,?,?,?,?,?)')
        .run(id, W, body.title || 'Untitled', body.text || '', body.origin || 'upload', 'pending', auth.actor);
      const items = extractProposals(body.text || '', id, W);
      audit(W, auth.actor, auth.role, 'document.added', 'source_document', id, `"${body.title || 'Untitled'}" added (${items.length} candidate items)`);
      return sendJson(res, { id, extracted: items }, 201);
    }
    if (p.startsWith('/api/documents/') && method === 'PUT') {
      requireRole(auth.role, ['admin']);
      const id = p.replace('/api/documents/', '');
      db.prepare('UPDATE source_documents SET status=? WHERE id=? AND workspace_id=?').run(body.status || 'approved', id, W);
      if (body.status === 'approved') approveExtracted(id, W);
      audit(W, auth.actor, auth.role, 'document.' + (body.status || 'approved'), 'source_document', id, `Document ${body.status || 'approved'}`);
      return sendJson(res, { ok: true });
    }

    // Submissions
    if (p === '/api/submissions' && method === 'GET') {
      const status = u.query.status;
      let rows = db.prepare('SELECT * FROM submissions WHERE workspace_id=? ORDER BY updated_at DESC').all(W);
      if (status) rows = rows.filter((r) => r.status === status);
      const withFindings = rows.map((r) => ({ ...r, findings_summary: findingsFor(r.id).run }));
      return sendJson(res, { submissions: withFindings });
    }
    if (p === '/api/submissions' && method === 'POST') {
      if (!body.title || !body.title.trim()) return sendJson(res, { error: 'title required' }, 400);
      if (!body.body || !body.body.trim()) return sendJson(res, { error: 'empty content' }, 400);
      const id = uid('sub');
      db.prepare(`INSERT INTO submissions (id, workspace_id, title, body, channel, audience, campaign, language, status, author)
                  VALUES (?,?,?,?,?,?,?,?, 'draft', ?)`)
        .run(id, W, body.title, body.body, body.channel || 'website', body.audience || '', body.campaign || '', body.language || 'English', auth.actor);
      const maxV = db.prepare('SELECT COALESCE(MAX(version),0) FROM submission_versions WHERE submission_id=?').get(id).valueOf?.() ?? 0;
      db.prepare('INSERT INTO submission_versions (id, submission_id, version, title, body, label) VALUES (?,?,?,?,?)')
        .run(uid('ver'), id, 1, body.title, body.body, 'Created');
      audit(W, auth.actor, auth.role, 'submission.created', 'submission', id, `"${body.title}" created`);
      return sendJson(res, { id }, 201);
    }
    if (p.startsWith('/api/submissions/')) {
      const rest = p.replace('/api/submissions/', '');
      const [id, action] = rest.split('/');
      const sub = db.prepare('SELECT * FROM submissions WHERE id=? AND workspace_id=?').get(id, W);
      if (!sub) return sendJson(res, { error: 'not found' }, 404);

      if (!action) {
        if (method === 'GET') return sendJson(res, { submission: sub, versions: db.prepare('SELECT * FROM submission_versions WHERE submission_id=? ORDER BY version').all(id) });
        if (method === 'PUT') {
          if (body.title !== undefined && !String(body.title).trim()) return sendJson(res, { error: 'title required' }, 400);
          db.prepare('UPDATE submissions SET title=?, body=?, channel=?, audience=?, campaign=?, language=?, updated_at=datetime(\'now\') WHERE id=?')
            .run(body.title ?? sub.title, body.body ?? sub.body, body.channel ?? sub.channel, body.audience ?? sub.audience,
              body.campaign ?? sub.campaign, body.language ?? sub.language, id);
          const v = db.prepare('SELECT COALESCE(MAX(version),0) AS m FROM submission_versions WHERE submission_id=?').get(id).m;
          db.prepare('INSERT INTO submission_versions (id, submission_id, version, title, body, label) VALUES (?,?,?,?,?)')
            .run(uid('ver'), id, v + 1, body.title ?? sub.title, body.body ?? sub.body, 'Edited');
          audit(W, auth.actor, auth.role, 'submission.edited', 'submission', id, `"${body.title ?? sub.title}" edited (v${v + 1})`);
          return sendJson(res, { ok: true });
        }
        if (method === 'DELETE') {
          requireRole(auth.role, ['admin']);
          db.prepare('DELETE FROM submissions WHERE id=?').run(id);
          audit(W, auth.actor, auth.role, 'submission.deleted', 'submission', id, `"${sub.title}" deleted`);
          return sendJson(res, { ok: true });
        }
      }
      if (action === 'preflight' && method === 'POST') {
        const result = executePreflight(W, id);
        audit(W, auth.actor, auth.role, 'preflight.executed', 'submission', id, `${result.findings.length} finding(s) · ${result.summary}`);
        return sendJson(res, { run_id: result.run_id, findings: result.findings, ai_available: result.ai_available, summary: result.summary });
      }
      if (action === 'findings' && method === 'GET') {
        const { run, findings, highlighted } = findingsFor(id);
        return sendJson(res, { run, findings, highlighted });
      }
      if (action === 'finding') {
        const fid = (body.finding_id || u.query.id || '').toString();
        const f = db.prepare('SELECT * FROM findings WHERE id=? AND submission_id=?').get(fid, id);
        if (!f) return sendJson(res, { error: 'finding not found' }, 404);
        if (method === 'PUT') {
          const act = body.action;
          if (act === 'accept') {
            if (!f.correction) return sendJson(res, { error: 'no correction available' }, 400);
            const newBody = sub.body.replace(f.matched_text, body.edit || f.correction);
            if (newBody === sub.body) return sendJson(res, { error: 'matched text not found in current body' }, 400);
            db.prepare('UPDATE findings SET user_action=?, action_reason=? WHERE id=?').run('accepted', body.reason || '', fid);
            db.prepare('UPDATE submissions SET body=?, updated_at=datetime(\'now\') WHERE id=?').run(newBody, id);
            const v = db.prepare('SELECT COALESCE(MAX(version),0) AS m FROM submission_versions WHERE submission_id=?').get(id).m;
            db.prepare('INSERT INTO submission_versions (id, submission_id, version, title, body, label) VALUES (?,?,?,?,?)').run(uid('ver'), id, v + 1, sub.title, newBody, 'Correction applied');
            audit(W, auth.actor, auth.role, 'finding.accepted', 'finding', fid, `Correction applied to "${f.subject}"`);
            return sendJson(res, { ok: true });
          }
          if (act === 'reject' && !body.reason) return sendJson(res, { error: 'reason required' }, 400);
          if (act === 'ignore' && !body.reason) return sendJson(res, { error: 'reason required' }, 400);
          db.prepare('UPDATE findings SET user_action=?, action_reason=? WHERE id=?').run(act, body.reason || '', fid);
          audit(W, auth.actor, auth.role, 'finding.' + act, 'finding', fid, `${act}: ${body.reason || ''}`);
          return sendJson(res, { ok: true });
        }
        if (method === 'POST') {
          // override
          if (!body.reason || !body.reason.trim()) return sendJson(res, { error: 'override reason required' }, 400);
          requireRole(auth.role, ['admin', 'reviewer']);
          const v = db.prepare('SELECT COALESCE(MAX(version),0) AS m FROM submission_versions WHERE submission_id=?').get(id).m;
          db.prepare('INSERT INTO overrides (id, finding_id, submission_id, workspace_id, user_name, reason, version) VALUES (?,?,?,?,?,?,?)')
            .run(uid('ovr'), fid, id, W, auth.actor, body.reason, v);
          db.prepare('UPDATE findings SET user_action=\'overridden\', action_reason=? WHERE id=?').run(body.reason, fid);
          audit(W, auth.actor, auth.role, 'finding.overridden', 'finding', fid, `Override: ${body.reason}`);
          return sendJson(res, { ok: true });
        }
      }
      if (action === 'transition' && method === 'POST') {
        const to = body.to;
        const allowed = VALID_TRANSITIONS[sub.status] || [];
        if (!allowed.includes(to)) return sendJson(res, { error: `Invalid transition ${sub.status} → ${to}` }, 400);
        if (['approved', 'changes_requested', 'rejected'].includes(to)) requireRole(auth.role, ['admin', 'reviewer']);
        db.prepare('UPDATE submissions SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(to, id);
        if (body.decision) {
          db.prepare('INSERT INTO review_decisions (id, submission_id, workspace_id, reviewer, decision, note) VALUES (?,?,?,?,?,?)')
            .run(uid('dec'), id, W, auth.actor, to, body.decision || '');
        }
        audit(W, auth.actor, auth.role, 'submission.' + to, 'submission', id, `"${sub.title}": ${sub.status} → ${to}${body.decision ? ' — ' + body.decision : ''}`);
        return sendJson(res, { ok: true, status: to });
      }
      if (action === 'comment' && method === 'POST') {
        if (!body.body || !body.body.trim()) return sendJson(res, { error: 'comment required' }, 400);
        db.prepare('INSERT INTO review_comments (id, submission_id, workspace_id, author, body) VALUES (?,?,?,?,?)')
          .run(uid('cmt'), id, W, auth.actor, body.body);
        audit(W, auth.actor, auth.role, 'comment.added', 'submission', id, `Comment: ${body.body.slice(0, 80)}`);
        return sendJson(res, { ok: true }, 201);
      }
      if (action === 'comments' && method === 'GET') {
        return sendJson(res, { comments: db.prepare('SELECT * FROM review_comments WHERE submission_id=? ORDER BY created_at').all(id),
          decisions: db.prepare('SELECT * FROM review_decisions WHERE submission_id=? ORDER BY created_at DESC').all(id),
          overrides: db.prepare('SELECT * FROM overrides WHERE submission_id=? ORDER BY created_at DESC').all(id) });
      }
    }

    // Overview stats (live from DB)
    if (p === '/api/overview' && method === 'GET') {
      const subs = db.prepare('SELECT * FROM submissions WHERE workspace_id=? ORDER BY updated_at DESC').all(W);
      const finds = db.prepare(`SELECT f.* FROM findings f JOIN submissions s ON s.id=f.submission_id WHERE s.workspace_id=?`).all(W);
      const openCrit = finds.filter((f) => f.severity === 'critical' && f.user_action !== 'ignored' && f.user_action !== 'rejected').length;
      const byCat = {};
      for (const f of finds) byCat[f.category] = (byCat[f.category] || 0) + 1;
      const recent = db.prepare('SELECT * FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 10').all(W);
      return sendJson(res, {
        total: subs.length,
        approved: subs.filter((s) => s.status === 'approved').length,
        needsChanges: subs.filter((s) => s.status === 'changes_requested').length,
        openCritical: openCrit,
        awaitingReview: subs.filter((s) => ['in_review', 'resubmitted'].includes(s.status)).map((s) => s.title),
        topViolations: Object.entries(byCat).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
        recentActivity: recent,
      });
    }
    // Insights (derived from real rows)
    if (p === '/api/insights' && method === 'GET') {
      const finds = db.prepare(`SELECT f.* FROM findings f JOIN submissions s ON s.id=f.submission_id WHERE s.workspace_id=?`).all(W);
      const bySubject = {}; for (const f of finds) bySubject[f.subject] = (bySubject[f.subject] || 0) + 1;
      const overrides = db.prepare('SELECT COUNT(*) AS c FROM overrides WHERE workspace_id=?').get(W).c;
      const expired = db.prepare(`SELECT * FROM knowledge_items WHERE workspace_id=? AND status='approved' AND expires_at != '' AND expires_at < date('now')`).all(W);
      const missingEvidence = db.prepare(`SELECT * FROM knowledge_items WHERE workspace_id=? AND status='approved' AND (source='' OR source IS NULL)`).all(W);
      const conflicting = db.prepare(`SELECT name, COUNT(*) AS c FROM knowledge_items WHERE workspace_id=? AND status='approved' GROUP BY name HAVING c>1`).all(W);
      const draftAwaiting = db.prepare(`SELECT * FROM knowledge_items WHERE workspace_id=? AND status='draft' ORDER BY created_at DESC`).all(W);
      return sendJson(res, {
        mostCommon: Object.entries(bySubject).map(([subject, count]) => ({ subject, count })).sort((a, b) => b.count - a.count),
        frequentlyOverridden: overrides,
        expiredCount: expired.length, expired,
        missingEvidence, conflicting, draftAwaiting,
        falsePositives: finds.filter((f) => f.user_action === 'rejected' || f.user_action === 'false_positive').length,
        proposal: 'Review most-flagged subjects and consider tightening or clarifying the related guideline. Proposals require human approval — nothing is auto-applied.',
      });
    }
    // Policy quality
    if (p === '/api/policy-quality' && method === 'GET') {
      const all = db.prepare('SELECT * FROM knowledge_items WHERE workspace_id=? ORDER BY updated_at DESC').all(W);
      return sendJson(res, {
        items: all,
        expired: all.filter((k) => k.expires_at && k.expires_at < new Date().toISOString().slice(0, 10) && k.status === 'approved'),
        missing: all.filter((k) => k.status === 'approved' && !k.source),
        drafts: all.filter((k) => k.status === 'draft'),
        pending: all.filter((k) => k.status === 'pending'),
      });
    }

    return sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error(e);
    sendJson(res, { error: e.message || 'internal error' }, e.status || 500);
  }
});

function extractProposals(text, docId, ws) {
  const made = [];
  const add = (type, name, proposed) => {
    db.prepare('INSERT INTO extracted_items (id, document_id, workspace_id, type, name, proposed, status) VALUES (?,?,?,?,?,?,?)')
      .run(uid('ext'), docId, ws, type, name, proposed, 'pending');
    made.push({ type, name, proposed });
  };
  const prices = text.match(/₹\s*[\d,.]+(?:\s*\/\s*month)?/g);
  if (prices?.length) add('fact', 'Extracted price', prices[0]);
  if (/early access/i.test(text)) add('fact', 'Extracted launch status', 'Early access');
  if (/do not use|avoid|forbidden/i.test(text)) add('voice', 'Extracted voice rule', text.slice(0, 200));
  if (/availability may vary/i.test(text)) add('claim', 'Extracted disclaimer', 'Availability may vary by plan.');
  return made;
}
function approveExtracted(docId, ws) {
  const rows = db.prepare('SELECT * FROM extracted_items WHERE document_id=? AND status=?').all(docId, 'pending');
  for (const r of rows) {
    db.prepare(`INSERT INTO knowledge_items (id, workspace_id, type, name, status, severity, version, source, approved_value, description, created_by)
                VALUES (?,?,?,?, 'approved', 'medium', '1.0', 'Extracted from source document', ?, 'Human-approved extraction', 'System')`)
      .run(uid('know'), ws, r.type, r.name, r.proposed);
    db.prepare('UPDATE extracted_items SET status=? WHERE id=?').run('approved', r.id);
  }
}

server.listen(PORT, () => console.log(`PROOFLINE running on http://localhost:${PORT}`));
