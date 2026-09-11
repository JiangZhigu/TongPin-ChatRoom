INSERT INTO instance_metadata(key,value) VALUES('instance_id',lower(hex(randomblob(16))));
CREATE TABLE announcements (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('announcement','notification')),
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 audience TEXT NOT NULL CHECK(audience IN('all','users','group')),
 group_id TEXT REFERENCES conversations(id),
 creator_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN('scheduled','sending','published','withdrawn','failed')),
 recipient_count INTEGER NOT NULL,
 delivered_count INTEGER NOT NULL DEFAULT 0,
 publish_at INTEGER NOT NULL,
 published_at INTEGER,
 withdrawn_at INTEGER,
 created_at INTEGER NOT NULL,
 error_code TEXT,
 job_id TEXT NOT NULL REFERENCES jobs(id),
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX announcements_page ON announcements(created_at,id);
CREATE TABLE announcement_recipients (
 announcement_id TEXT NOT NULL REFERENCES announcements(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 delivered_at INTEGER,
 PRIMARY KEY(announcement_id,user_id)
);
CREATE INDEX announcement_delivery ON announcement_recipients(announcement_id,delivered_at,user_id);
CREATE TABLE administrator_invitations (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 inviter_id TEXT NOT NULL REFERENCES users(id),
 purpose TEXT NOT NULL CHECK(purpose IN('grant','factor_reset')),
 status TEXT NOT NULL CHECK(status IN('pending','accepted','cancelled','expired')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX administrator_invitation_pending ON administrator_invitations(user_id) WHERE status='pending';
CREATE INDEX administrator_invitation_time ON administrator_invitations(created_at,id);
CREATE TABLE administrator_enrollments (
 id TEXT PRIMARY KEY,
 invitation_id TEXT NOT NULL UNIQUE REFERENCES administrator_invitations(id),
 session_id TEXT NOT NULL,
 secret_ciphertext TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE admin_operations (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('export.create','backup.create','backup.verify','backup.drill','storage.cleanup')),
 actor_id TEXT REFERENCES users(id),
 session_id TEXT,
 parameters_json TEXT NOT NULL,
 selection_json TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL CHECK(status IN('queued','running','completed','failed','cancelled')),
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN(0,1)),
 progress INTEGER NOT NULL DEFAULT 0,
 total INTEGER NOT NULL DEFAULT 0,
 bytes INTEGER NOT NULL DEFAULT 0,
 message TEXT NOT NULL DEFAULT '',
 error_code TEXT,
 result_json TEXT NOT NULL DEFAULT '{}',
 job_id TEXT NOT NULL REFERENCES jobs(id),
 request_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 expires_at INTEGER,
 storage_key TEXT,
 sha256 TEXT,
 backup_class TEXT CHECK(backup_class IS NULL OR backup_class IN('daily','weekly'))
);
CREATE INDEX admin_operations_page ON admin_operations(created_at,id);
CREATE INDEX admin_operations_expiry ON admin_operations(expires_at);
CREATE TABLE runtime_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 level TEXT NOT NULL CHECK(level IN('warning','error')),
 code TEXT NOT NULL,
 route TEXT NOT NULL DEFAULT '',
 status INTEGER,
 actor_id TEXT,
 request_id TEXT,
 job_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX runtime_logs_page ON runtime_logs(created_at,id);
CREATE INDEX runtime_logs_request ON runtime_logs(request_id,id);
CREATE INDEX runtime_logs_job ON runtime_logs(job_id,id);
CREATE INDEX audit_request ON audit_events(json_extract(details,'$.requestId'),id);
CREATE INDEX audit_job ON audit_events(json_extract(details,'$.jobId'),id);
