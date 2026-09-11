CREATE TABLE friendships (
 low_id TEXT NOT NULL REFERENCES users(id),
 high_id TEXT NOT NULL REFERENCES users(id),
 id TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(low_id,high_id),
 CHECK(low_id < high_id)
);
CREATE INDEX friendships_high ON friendships(high_id,low_id);
CREATE TABLE friend_requests (
 id TEXT PRIMARY KEY,
 sender_id TEXT NOT NULL REFERENCES users(id),
 target_id TEXT NOT NULL REFERENCES users(id),
 low_id TEXT NOT NULL,
 high_id TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN('pending','accepted','rejected','cancelled')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK(sender_id <> target_id AND low_id < high_id)
);
CREATE UNIQUE INDEX friend_pending_pair ON friend_requests(low_id,high_id) WHERE status='pending';
CREATE INDEX friend_request_sender ON friend_requests(sender_id,id);
CREATE INDEX friend_request_target ON friend_requests(target_id,id);
CREATE TABLE blocks (
 user_id TEXT NOT NULL REFERENCES users(id),
 target_id TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,target_id),
 CHECK(user_id <> target_id)
);
CREATE TABLE friend_preferences (
 user_id TEXT NOT NULL REFERENCES users(id),
 friend_id TEXT NOT NULL REFERENCES users(id),
 notify_online INTEGER NOT NULL DEFAULT 0 CHECK(notify_online IN(0,1)),
 PRIMARY KEY(user_id,friend_id)
);
CREATE TABLE conversations (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('direct','group')),
 low_id TEXT REFERENCES users(id),
 high_id TEXT REFERENCES users(id),
 owner_id TEXT REFERENCES users(id),
 name TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','dissolved','frozen')),
 last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0),
 role_version INTEGER NOT NULL DEFAULT 1,
 write_version INTEGER NOT NULL DEFAULT 1,
 everyone_muted INTEGER NOT NULL DEFAULT 0 CHECK(everyone_muted IN(0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 dissolved_at INTEGER,
 CHECK((kind='direct' AND low_id IS NOT NULL AND high_id IS NOT NULL AND low_id<high_id) OR (kind='group' AND owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX direct_pair ON conversations(low_id,high_id) WHERE kind='direct';
CREATE INDEX conversations_activity ON conversations(updated_at,id);
-- Membership periods are the shared history boundary; group operations arrive in M5.
CREATE TABLE memberships (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN('owner','admin','member')),
 visible_from_seq INTEGER NOT NULL CHECK(visible_from_seq>=1),
 write_version INTEGER NOT NULL DEFAULT 1,
 muted_until INTEGER,
 joined_at INTEGER NOT NULL,
 left_at INTEGER,
 left_reason TEXT
);
CREATE UNIQUE INDEX active_membership ON memberships(conversation_id,user_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX active_owner ON memberships(conversation_id) WHERE left_at IS NULL AND role='owner';
CREATE INDEX user_memberships ON memberships(user_id,conversation_id,left_at);
CREATE TABLE conversation_preferences (
 user_id TEXT NOT NULL REFERENCES users(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 read_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_seq>=0),
 muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN(0,1)),
 pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN(0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
 PRIMARY KEY(user_id,conversation_id)
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 seq INTEGER NOT NULL CHECK(seq>=1),
 sender_id TEXT REFERENCES users(id),
 client_message_id TEXT,
 payload_hash TEXT NOT NULL,
 kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN('user','system')),
 text TEXT NOT NULL,
 reply_id TEXT REFERENCES messages(id),
 mentioned_ids TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN('sent','recalled','moderated','purged')),
 created_at INTEGER NOT NULL,
 removed_at INTEGER,
 removed_by TEXT REFERENCES users(id),
 removed_reason TEXT,
 UNIQUE(conversation_id,seq),
 UNIQUE(sender_id,client_message_id)
);
CREATE INDEX messages_retention ON messages(status,removed_at);
CREATE INDEX messages_sender ON messages(sender_id,created_at,id);
CREATE TABLE user_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL,
 entity_ref TEXT NOT NULL,
 conversation_id TEXT REFERENCES conversations(id),
 created_at INTEGER NOT NULL
);
CREATE INDEX events_recipient ON user_events(user_id,id);
CREATE INDEX events_retention ON user_events(created_at,id);
CREATE TABLE notifications (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL,
 entity_ref TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id),
 created_at INTEGER NOT NULL,
 read_at INTEGER
);
CREATE INDEX notifications_recipient ON notifications(user_id,created_at,id);
INSERT INTO instance_metadata(key,value) VALUES('event_floor','0');
