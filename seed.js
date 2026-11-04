// Seeds Acme Cloud workspace with approved sources + the intentionally flawed draft.
const { db, migrate, uid, audit } = require('./db');
migrate();

const ws = 'ws_acme_cloud';
db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, slug, description)
            VALUES (?, 'Acme Cloud', 'acme-cloud', 'Fictional demo company for Inkloom AI brand governance.')`).run(ws);

const members = [
  ['m_1', 'Alex (Admin)', 'admin'], ['m_2', 'Casey (Creator)', 'creator'], ['m_3', 'Robin (Reviewer)', 'reviewer'],
];
for (const [id, name, role] of members) {
  db.prepare('INSERT OR IGNORE INTO memberships (id, workspace_id, user_id, user_name, role) VALUES (?,?,?,?,?)')
    .run(id, ws, name.toLowerCase().replace(/[^a-z]/g, ''), name, role);
}

const knowledge = [
  { id: 'know_voice_1', type: 'voice', name: 'Brand voice: professional, direct, helpful',
    status: 'approved', severity: 'medium', version: '1.0', source: 'Brand Guidelines v3.1 §2',
    description: 'Tone: professional, direct, helpful, clear. Avoid exaggerated promises.',
    tone: 'Professional, direct, helpful', acceptable_examples: 'Explore how it can reduce manual reporting work.',
    unacceptable_examples: 'Guaranteed results!', created_by: 'Alex (Admin)' },
  { id: 'know_term_name', type: 'terminology', name: 'Product name terminology',
    status: 'approved', severity: 'high', version: '1.0', source: 'Product Naming Standard 2025-11',
    description: 'The approved product name is Acme Intelligence.', preferred_term: 'Acme Intelligence',
    forbidden_term: 'Acme AI Intelligence', replacement: 'Acme Intelligence', created_by: 'Alex (Admin)' },
  { id: 'know_fact_name', type: 'fact', name: 'Product name', status: 'approved', severity: 'critical',
    version: '1.0', source: 'Product Launch Brief 2025-11', approved_value: 'Acme Intelligence',
    description: 'Canonical product name.', effective_from: '2025-11-01', last_verified: '2025-11-10', owner: 'Product Marketing', created_by: 'Alex (Admin)' },
  { id: 'know_fact_price', type: 'fact', name: 'Price', status: 'approved', severity: 'critical',
    version: '1.0', source: 'Pricing Sheet (approved 2025-11)', approved_value: '₹999/month',
    description: 'Public monthly price per workspace.', effective_from: '2025-11-01', last_verified: '2025-11-10', owner: 'Revenue', created_by: 'Alex (Admin)' },
  { id: 'know_fact_launch', type: 'fact', name: 'Launch status', status: 'approved', severity: 'high',
    version: '1.0', source: 'Launch Brief 2025-11', approved_value: 'Early access',
    description: 'Product is in early access; not generally available.', effective_from: '2025-11-01', last_verified: '2025-11-10', owner: 'Product Marketing', created_by: 'Alex (Admin)' },
  { id: 'know_fact_lang', type: 'fact', name: 'Supported languages', status: 'approved', severity: 'low',
    version: '1.0', source: 'Product Datasheet v2', approved_value: 'English and Hindi',
    description: 'Supported languages.', effective_from: '2025-11-01', last_verified: '2025-11-10', owner: 'Product', created_by: 'Alex (Admin)' },
  { id: 'know_claim_ok', type: 'claim', name: 'Approved claim: reduce manual reporting work', status: 'approved',
    severity: 'medium', version: '1.0', source: 'Messaging Framework v4', claim_text: 'reduces manual reporting work',
    claim_type: 'approved', description: 'Approved benefit claim.', created_by: 'Alex (Admin)' },
  { id: 'know_claim_ban', type: 'claim', name: 'Prohibited phrase: guaranteed results', status: 'approved',
    severity: 'critical', version: '1.0', source: 'Claims Policy 2025', claim_text: 'guaranteed results',
    claim_type: 'prohibited', description: 'Never promise guaranteed outcomes.', created_by: 'Alex (Admin)' },
  { id: 'know_disclaimer', type: 'claim', name: 'Required disclaimer: availability varies', status: 'approved',
    severity: 'high', version: '1.0', source: 'Legal — pricing footnote template', claim_text: 'Availability may vary by plan.',
    claim_type: 'required', disclaimer_text: 'Availability may vary by plan.', description: 'Must appear with pricing and availability statements.',
    created_by: 'Alex (Admin)' },
];
for (const k of knowledge) {
  db.prepare(`INSERT OR IGNORE INTO knowledge_items
    (id, workspace_id, type, name, status, severity, version, source, approved_value, description,
     preferred_term, forbidden_term, replacement, claim_text, disclaimer_text, claim_type, context,
     effective_from, expires_at, last_verified, owner, acceptable_examples, unacceptable_examples, tone, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(k.id, ws, k.type, k.name, k.status, k.severity, k.version, k.source, k.approved_value || '', k.description || '',
      k.preferred_term || '', k.forbidden_term || '', k.replacement || '', k.claim_text || '', k.disclaimer_text || '',
      k.claim_type || '', '', k.effective_from || '', '', k.last_verified || '', k.owner || '',
      k.acceptable_examples || '', k.unacceptable_examples || '', k.tone || '', k.created_by);
}

// Flawed demo draft
const subId = 'sub_demo_flawed';
db.prepare(`INSERT OR IGNORE INTO submissions (id, workspace_id, title, body, channel, audience, campaign, language, status, author)
            VALUES (?, ?, 'Launch announcement draft', 'Acme AI Intelligence is now fully launched worldwide! Get the world''s most accurate AI for just ₹799/month. Guaranteed results for every team. Join 50,000 happy customers today!', 'website', 'Small businesses', 'Launch', 'English', 'draft', 'Casey (Creator)')`).run(subId, ws);
db.prepare(`INSERT OR IGNORE INTO submission_versions (id, submission_id, version, title, body, label)
            VALUES ('ver_demo_1', ?, 1, 'Launch announcement draft', 'Acme AI Intelligence is now fully launched worldwide! Get the world''s most accurate AI for just ₹799/month. Guaranteed results for every team. Join 50,000 happy customers today!', 'Demo draft')`).run(subId);

if (!db.prepare('SELECT id FROM audit_events WHERE record_id=? AND event_type=? LIMIT 1').get(ws, 'workspace.seeded')) {
  audit(ws, 'System', 'admin', 'workspace.seeded', 'workspace', ws, 'Acme Cloud demo workspace seeded');
}
console.log('Seed complete: Acme Cloud workspace, 9 knowledge items, flawed demo draft.');
