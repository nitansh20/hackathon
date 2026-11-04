// PROOFLINE database — SQLite via Node built-in node:sqlite. No external deps.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'proofline.db');
const db = new DatabaseSync(DB_PATH);

function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    environment TEXT DEFAULT 'production',
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','creator','reviewer')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('voice','terminology','fact','claim','disclaimer')),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','archived')),
    severity TEXT DEFAULT 'medium' CHECK(severity IN ('critical','high','medium','low','informational')),
    version TEXT DEFAULT '1.0',
    source TEXT DEFAULT '',
    approved_value TEXT DEFAULT '',
    description TEXT DEFAULT '',
    preferred_term TEXT DEFAULT '',
    forbidden_term TEXT DEFAULT '',
    replacement TEXT DEFAULT '',
    claim_text TEXT DEFAULT '',
    disclaimer_text TEXT DEFAULT '',
    claim_type TEXT DEFAULT '',  /* approved|prohibited|required */
    context TEXT DEFAULT '',
    effective_from TEXT DEFAULT '',
    expires_at TEXT DEFAULT '',
    last_verified TEXT DEFAULT '',
    owner TEXT DEFAULT '',
    acceptable_examples TEXT DEFAULT '',
    unacceptable_examples TEXT DEFAULT '',
    tone TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS source_documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    origin TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_by TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS extracted_items (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    proposed TEXT DEFAULT '',
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    channel TEXT DEFAULT 'website',
    audience TEXT DEFAULT '',
    campaign TEXT DEFAULT '',
    language TEXT DEFAULT 'English',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','preflighted','in_review','changes_requested','resubmitted','approved','rejected')),
    author TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS submission_versions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS preflight_runs (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    result_summary TEXT DEFAULT '',
    findings_count INTEGER DEFAULT 0,
    critical_count INTEGER DEFAULT 0,
    ai_used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES preflight_runs(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    subject TEXT DEFAULT '',
    matched_text TEXT DEFAULT '',
    span_start INTEGER DEFAULT -1,
    span_end INTEGER DEFAULT -1,
    category TEXT NOT NULL,
    severity TEXT DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    explanation TEXT DEFAULT '',
    evidence_id TEXT DEFAULT '',
    evidence_excerpt TEXT DEFAULT '',
    correction TEXT DEFAULT '',
    correction_mode TEXT DEFAULT 'deterministic',
    user_action TEXT DEFAULT '',
    action_reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS review_comments (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS review_decisions (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    decision TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS overrides (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_role TEXT DEFAULT '',
    event_type TEXT NOT NULL,
    record_type TEXT DEFAULT '',
    record_id TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_ws ON knowledge_items(workspace_id, type, status);
  CREATE INDEX IF NOT EXISTS idx_sub_ws ON submissions(workspace_id, status);
  CREATE INDEX IF NOT EXISTS idx_find_sub ON findings(submission_id);
  CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_events(workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_member ON memberships(user_id);
  `);
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function audit(workspaceId, actor, actorRole, eventType, recordType, recordId, detail) {
  db.prepare(`INSERT INTO audit_events (id, workspace_id, actor, actor_role, event_type, record_type, record_id, detail)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid('aud'), workspaceId, actor, actorRole, eventType, recordType, recordId, detail);
}

module.exports = { db, migrate, uid, audit, DB_PATH };
