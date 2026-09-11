ALTER TABLE friend_preferences ADD COLUMN remark TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_preferences ADD COLUMN only_mentions INTEGER NOT NULL DEFAULT 0 CHECK(only_mentions IN(0,1));
ALTER TABLE messages ADD COLUMN mention_all INTEGER NOT NULL DEFAULT 0 CHECK(mention_all IN(0,1));
CREATE INDEX users_deletion_due ON users(status,deletion_at,id);

CREATE TABLE message_reactions (
 message_id TEXT NOT NULL REFERENCES messages(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 emoji_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(message_id,user_id,emoji_key)
);
CREATE INDEX reaction_message_key ON message_reactions(message_id,emoji_key);
CREATE TABLE bookmarks (
 user_id TEXT NOT NULL REFERENCES users(id),
 message_id TEXT NOT NULL REFERENCES messages(id),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,message_id)
);
CREATE INDEX bookmark_activity ON bookmarks(user_id,created_at,message_id);
CREATE TABLE reports (
 id TEXT PRIMARY KEY,
 reporter_id TEXT NOT NULL REFERENCES users(id),
 client_report_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 target_kind TEXT NOT NULL CHECK(target_kind IN('message','user','group')),
 target_id TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN('spam','harassment','illegal','other')),
 description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','claimed','resolved','rejected')),
 assigned_to TEXT REFERENCES users(id),
 feedback TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(reporter_id,client_report_id)
);
CREATE INDEX report_queue ON reports(status,created_at,id);
CREATE INDEX reporter_history ON reports(reporter_id,created_at,id);
CREATE TABLE report_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 report_id TEXT NOT NULL REFERENCES reports(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
