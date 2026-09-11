ALTER TABLE messages ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN moderation_kind TEXT CHECK(moderation_kind IS NULL OR moderation_kind IN('hidden','deleted'));
ALTER TABLE messages ADD COLUMN reviewed_by TEXT REFERENCES users(id);
ALTER TABLE messages ADD COLUMN reviewed_at INTEGER;
CREATE TRIGGER message_admin_version AFTER UPDATE OF status,text,removed_at,removed_reason,reviewed_at ON messages BEGIN
 UPDATE messages SET content_version=content_version+1 WHERE id=NEW.id;
END;
CREATE INDEX messages_admin_time ON messages(created_at,id);
ALTER TABLE attachments ADD COLUMN governance TEXT NOT NULL DEFAULT 'available' CHECK(governance IN('available','quarantined','revoked'));
ALTER TABLE attachments ADD COLUMN governance_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN governance_version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER attachment_admin_version AFTER UPDATE OF governance,state,scan_status,message_id,avatar_bound,quota_bytes ON attachments BEGIN
 UPDATE attachments SET governance_version=governance_version+1 WHERE id=NEW.id;
END;
CREATE INDEX attachments_admin_time ON attachments(created_at,id);
ALTER TABLE users ADD COLUMN avatar_hidden INTEGER NOT NULL DEFAULT 0 CHECK(avatar_hidden IN(0,1));
ALTER TABLE conversations ADD COLUMN avatar_hidden INTEGER NOT NULL DEFAULT 0 CHECK(avatar_hidden IN(0,1));
CREATE INDEX report_event_history ON report_events(report_id,id);
