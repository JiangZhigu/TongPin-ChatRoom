CREATE TABLE attachments (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 client_upload_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 conversation_id TEXT REFERENCES conversations(id),
 access_key TEXT,
 purpose TEXT NOT NULL CHECK(purpose IN ('message','user_avatar','group_avatar')),
 name TEXT NOT NULL,
 extension TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','file')),
 mime TEXT NOT NULL,
 expected_size INTEGER NOT NULL CHECK(expected_size>0),
 expected_sha256 TEXT NOT NULL,
 size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0),
 quota_bytes INTEGER NOT NULL CHECK(quota_bytes>=0),
 state TEXT NOT NULL CHECK(state IN ('reserved','uploading','processing','ready','quarantined','rejected','cancelled','expired')),
 scan_status TEXT NOT NULL DEFAULT 'not_scanned' CHECK(scan_status IN ('not_scanned','clean','infected','unknown')),
 storage_key TEXT NOT NULL UNIQUE,
 preview_key TEXT,
 thumbnail_key TEXT,
 width INTEGER,
 height INTEGER,
 frame_count INTEGER,
 lease_token TEXT,
 lease_until INTEGER,
 message_id TEXT REFERENCES messages(id),
 message_position INTEGER,
 avatar_bound INTEGER NOT NULL DEFAULT 0 CHECK(avatar_bound IN (0,1)),
 error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 UNIQUE(owner_id,client_upload_id)
);
CREATE INDEX attachments_owner_state ON attachments(owner_id,state,created_at,id);
CREATE INDEX attachments_message ON attachments(message_id,message_position);
CREATE INDEX attachments_cleanup ON attachments(state,expires_at,id);
ALTER TABLE users ADD COLUMN avatar_id TEXT REFERENCES attachments(id);
ALTER TABLE conversations ADD COLUMN avatar_id TEXT REFERENCES attachments(id);

