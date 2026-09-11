ALTER TABLE conversations ADD COLUMN review_required INTEGER NOT NULL DEFAULT 1 CHECK(review_required IN(0,1));
ALTER TABLE conversations ADD COLUMN invite_role TEXT NOT NULL DEFAULT 'managers' CHECK(invite_role IN('managers','members'));
ALTER TABLE conversations ADD COLUMN slow_seconds INTEGER NOT NULL DEFAULT 0 CHECK(slow_seconds BETWEEN 0 AND 3600);
ALTER TABLE conversations ADD COLUMN announcement TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN announcement_pinned INTEGER NOT NULL DEFAULT 0 CHECK(announcement_pinned IN(0,1));
CREATE INDEX groups_owned ON conversations(owner_id,status) WHERE kind='group';
CREATE INDEX messages_conversation_sender ON messages(conversation_id,sender_id,created_at);
CREATE TABLE group_commands (
 actor_id TEXT NOT NULL REFERENCES users(id),
 operation TEXT NOT NULL,
 client_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 result_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(actor_id,operation,client_key)
);
CREATE TABLE group_invites (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 creator_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN('link','direct')),
 target_id TEXT REFERENCES users(id),
 token_digest TEXT UNIQUE,
 max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 200),
 used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0 AND used_count<=max_uses),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER,
 CHECK((kind='link' AND target_id IS NULL AND token_digest IS NOT NULL) OR(kind='direct' AND target_id IS NOT NULL AND token_digest IS NULL AND max_uses=1))
);
CREATE INDEX group_invites_group ON group_invites(conversation_id,created_at,id);
CREATE INDEX group_invites_target ON group_invites(target_id,created_at,id);
CREATE INDEX group_invites_expiry ON group_invites(expires_at) WHERE revoked_at IS NULL;
CREATE TABLE group_applications (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 invite_id TEXT NOT NULL REFERENCES group_invites(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN('pending','approved','rejected','cancelled','expired')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX group_application_pending ON group_applications(conversation_id,user_id) WHERE status='pending';
CREATE INDEX group_application_invite ON group_applications(invite_id,status,expires_at);
CREATE INDEX group_application_user ON group_applications(user_id,created_at,id);
CREATE INDEX group_application_group ON group_applications(conversation_id,created_at,id);
CREATE TABLE group_transfers (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 from_id TEXT NOT NULL REFERENCES users(id),
 to_id TEXT NOT NULL REFERENCES users(id),
 target_period_id TEXT NOT NULL REFERENCES memberships(id),
 status TEXT NOT NULL CHECK(status IN('pending','accepted','rejected','cancelled','expired')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 CHECK(from_id<>to_id)
);
CREATE UNIQUE INDEX group_transfer_pending ON group_transfers(conversation_id) WHERE status='pending';
CREATE INDEX group_transfer_target ON group_transfers(to_id,status);
CREATE INDEX audit_subject_id ON audit_events(subject_id,id);
