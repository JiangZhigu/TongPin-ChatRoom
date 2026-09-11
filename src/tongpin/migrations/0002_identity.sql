CREATE TABLE users (
 id TEXT PRIMARY KEY,
 username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 nickname TEXT NOT NULL,
 bio TEXT NOT NULL DEFAULT '',
 password_hash TEXT NOT NULL,
 site_role TEXT NOT NULL DEFAULT 'user' CHECK(site_role IN ('user','super_admin')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','banned','deleting','deleted')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 muted_until INTEGER,
 deletion_at INTEGER,
 preferences TEXT NOT NULL DEFAULT '{"invisible":false,"readReceipts":true,"doNotDisturb":false}',
 quota_bytes INTEGER,
 totp_secret TEXT,
 totp_last_counter INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 idle_ms INTEGER NOT NULL,
 device TEXT NOT NULL,
 second_factor_at INTEGER,
 revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id,revoked_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE recovery_codes (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('password','second_factor')),
 digest TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL,
 consumed_at INTEGER
);
CREATE INDEX recovery_user ON recovery_codes(user_id,kind);
CREATE TABLE reauth_tokens (
 digest TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id),
 action TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);
CREATE INDEX reauth_expiry ON reauth_tokens(expires_at);
CREATE TABLE rate_buckets (
 key TEXT PRIMARY KEY,
 window_start INTEGER NOT NULL,
 attempts INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX rate_expiry ON rate_buckets(expires_at);
CREATE TABLE site_invites (
 id TEXT PRIMARY KEY,
 digest TEXT NOT NULL UNIQUE,
 created_by TEXT REFERENCES users(id),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 max_uses INTEGER NOT NULL CHECK(max_uses>0),
 used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
 revoked_at INTEGER
);
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_id TEXT REFERENCES users(id),
 subject_id TEXT,
 action TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 result TEXT NOT NULL,
 device TEXT NOT NULL DEFAULT '',
 details TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL
);
CREATE INDEX audit_time ON audit_events(created_at,id);
CREATE INDEX audit_actor ON audit_events(actor_id,id);
CREATE INDEX audit_subject ON audit_events(subject_id,id);
CREATE TABLE policy_versions (
 version INTEGER PRIMARY KEY,
 values_json TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id),
 reason TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE reset_credentials (
 digest TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 issued_by TEXT REFERENCES users(id),
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);
