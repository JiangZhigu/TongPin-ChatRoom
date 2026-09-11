ALTER TABLE users ADD COLUMN admin_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN mute_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN restriction_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN upload_disabled INTEGER NOT NULL DEFAULT 0 CHECK(upload_disabled IN(0,1));
ALTER TABLE users ADD COLUMN group_creation_disabled INTEGER NOT NULL DEFAULT 0 CHECK(group_creation_disabled IN(0,1));
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN(0,1));
ALTER TABLE reset_credentials ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN admin_governance_version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER admin_membership_insert AFTER INSERT ON memberships BEGIN
 UPDATE conversations SET admin_governance_version=admin_governance_version+1 WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER admin_membership_update AFTER UPDATE ON memberships BEGIN
 UPDATE conversations SET admin_governance_version=admin_governance_version+1 WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER admin_invite_insert AFTER INSERT ON group_invites BEGIN
 UPDATE conversations SET admin_governance_version=admin_governance_version+1 WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER admin_invite_update AFTER UPDATE ON group_invites BEGIN
 UPDATE conversations SET admin_governance_version=admin_governance_version+1 WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER admin_application_insert AFTER INSERT ON group_applications BEGIN
 UPDATE conversations SET admin_governance_version=admin_governance_version+1 WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER admin_application_update AFTER UPDATE ON group_applications BEGIN
 UPDATE conversations SET admin_governance_version=admin_governance_version+1 WHERE id=NEW.conversation_id;
END;
CREATE INDEX users_admin_list ON users(status,site_role,created_at,id);
CREATE INDEX reset_credentials_user ON reset_credentials(user_id,consumed_at,expires_at);
CREATE TABLE admin_previews (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT NOT NULL REFERENCES sessions(id),
 payload_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 targets_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX admin_previews_expiry ON admin_previews(expires_at);
CREATE TABLE admin_commands (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT NOT NULL REFERENCES sessions(id),
 action TEXT NOT NULL,
 reason TEXT NOT NULL,
 parameters_json TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 request_id TEXT NOT NULL,
 job_id TEXT REFERENCES jobs(id),
 status TEXT NOT NULL CHECK(status IN('queued','running','completed','partial','failed','cancelled')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX admin_commands_time ON admin_commands(created_at,id);
CREATE TABLE admin_command_items (
 command_id TEXT NOT NULL REFERENCES admin_commands(id),
 ordinal INTEGER NOT NULL,
 target_id TEXT NOT NULL,
 label TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','succeeded','failed','cancelled')),
 code TEXT,
 message TEXT,
 PRIMARY KEY(command_id,ordinal),
 UNIQUE(command_id,target_id)
);
CREATE TABLE admin_alerts (
 id TEXT PRIMARY KEY,
 rule TEXT NOT NULL,
 title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('active','resolved')),
 value REAL,
 threshold REAL NOT NULL,
 first_seen_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 resolved_at INTEGER
);
CREATE UNIQUE INDEX admin_alert_active ON admin_alerts(rule) WHERE status='active';
CREATE INDEX admin_alert_time ON admin_alerts(first_seen_at,id);
