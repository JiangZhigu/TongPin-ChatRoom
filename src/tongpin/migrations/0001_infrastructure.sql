CREATE TABLE jobs (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 entity_id TEXT NOT NULL DEFAULT '',
 dedupe_key TEXT UNIQUE,
 payload_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL CHECK(status IN('pending','running','completed','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 run_after INTEGER NOT NULL,
 lease_until INTEGER,
 created_at INTEGER NOT NULL,
 completed_at INTEGER,
 last_error_code TEXT,
 result_json TEXT
);
CREATE INDEX jobs_ready ON jobs(status,run_after);
CREATE TABLE instance_metadata (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
