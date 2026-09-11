CREATE TABLE todo_group_settings (
 group_id TEXT PRIMARY KEY REFERENCES conversations(id),
 create_policy TEXT NOT NULL DEFAULT 'members' CHECK(create_policy IN('members','managers')),
 version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE todo_labels (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN('list','tag')),
 name TEXT NOT NULL,
 UNIQUE(user_id,kind,name)
);
CREATE TABLE todo_tasks (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN('personal','group')),
 owner_id TEXT REFERENCES users(id),
 group_id TEXT REFERENCES conversations(id),
 creator_id TEXT NOT NULL REFERENCES users(id),
 assignee_id TEXT REFERENCES users(id),
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high')),
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN('todo','doing','done')),
 due_on TEXT,
 due_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
 due_start INTEGER,
 due_end INTEGER,
 source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 list_id TEXT REFERENCES todo_labels(id) ON DELETE SET NULL,
 completed_at INTEGER,
 completed_by TEXT REFERENCES users(id),
 deleted_at INTEGER,
 moderated_deleted INTEGER NOT NULL DEFAULT 0 CHECK(moderated_deleted IN(0,1)),
 report_only INTEGER NOT NULL DEFAULT 0 CHECK(report_only IN(0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 schedule_revision INTEGER NOT NULL DEFAULT 1,
 CHECK((scope='personal' AND owner_id IS NOT NULL AND group_id IS NULL AND assignee_id=owner_id) OR (scope='group' AND owner_id IS NULL AND group_id IS NOT NULL)),
 CHECK((due_on IS NULL AND due_start IS NULL AND due_end IS NULL) OR (due_on IS NOT NULL AND due_start IS NOT NULL AND due_end IS NOT NULL))
);
CREATE INDEX todo_owner ON todo_tasks(owner_id,deleted_at,status,due_end,updated_at,id);
CREATE INDEX todo_group ON todo_tasks(group_id,deleted_at,status,due_end,updated_at,id);
CREATE INDEX todo_assignee ON todo_tasks(assignee_id,deleted_at,status,due_end,updated_at,id);
CREATE TABLE todo_task_tags (
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 label_id TEXT NOT NULL REFERENCES todo_labels(id) ON DELETE CASCADE,
 PRIMARY KEY(task_id,label_id)
);
CREATE TABLE todo_check_items (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 text TEXT NOT NULL,
 done INTEGER NOT NULL DEFAULT 0 CHECK(done IN(0,1)),
 position INTEGER NOT NULL
);
CREATE INDEX todo_checks_order ON todo_check_items(task_id,position,id);
CREATE TABLE todo_activities (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 actor_id TEXT REFERENCES users(id),
 kind TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX todo_activity_page ON todo_activities(task_id,created_at,id);
CREATE TABLE todo_comments (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id),
 period_id TEXT REFERENCES memberships(id),
 text TEXT NOT NULL,
 removed_at INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX todo_comments_page ON todo_comments(task_id,created_at,id);
CREATE TABLE todo_membership_watermarks (
 period_id TEXT PRIMARY KEY REFERENCES memberships(id),
 activity_floor INTEGER NOT NULL,
 comment_floor INTEGER NOT NULL
);
INSERT INTO todo_membership_watermarks SELECT id,0,0 FROM memberships WHERE left_at IS NULL;
CREATE TABLE todo_message_cards (
 message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('live','snapshot')),
 task_id TEXT REFERENCES todo_tasks(id) ON DELETE SET NULL,
 snapshot_json TEXT,
 CHECK((kind='live' AND snapshot_json IS NULL) OR (kind='snapshot' AND task_id IS NULL AND snapshot_json IS NOT NULL))
);
CREATE TABLE todo_mutation_keys (
 user_id TEXT NOT NULL REFERENCES users(id),
 key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 result_kind TEXT NOT NULL,
 result_ref TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,key)
);
CREATE INDEX todo_key_expiry ON todo_mutation_keys(created_at);
CREATE TABLE todo_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 assignments INTEGER NOT NULL DEFAULT 1 CHECK(assignments IN(0,1)),
 comments INTEGER NOT NULL DEFAULT 1 CHECK(comments IN(0,1)),
 completed INTEGER NOT NULL DEFAULT 1 CHECK(completed IN(0,1)),
 due INTEGER NOT NULL DEFAULT 1 CHECK(due IN(0,1)),
 timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'
);
CREATE TABLE todo_marks (
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 followed INTEGER NOT NULL DEFAULT 0 CHECK(followed IN(0,1)),
 bookmarked INTEGER NOT NULL DEFAULT 0 CHECK(bookmarked IN(0,1)),
 PRIMARY KEY(task_id,user_id)
);
CREATE TABLE todo_reminders (
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 rule TEXT NOT NULL CHECK(rule IN('none','day_before','due_day')),
 local_time TEXT NOT NULL DEFAULT '09:00',
 version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(task_id,user_id)
);
CREATE TABLE todo_reminder_receipts (
 task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 schedule_revision INTEGER NOT NULL,
 preference_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,user_id,schedule_revision,preference_version)
);
CREATE TABLE todo_reports (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES todo_tasks(id),
 comment_id TEXT,
 reporter_id TEXT NOT NULL REFERENCES users(id),
 category TEXT NOT NULL CHECK(category IN('spam','harassment','illegal','other')),
 description TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),
 resolution TEXT,
 created_at INTEGER NOT NULL,
 closed_at INTEGER,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX todo_report_page ON todo_reports(status,created_at,id);
