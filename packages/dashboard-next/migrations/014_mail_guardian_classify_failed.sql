ALTER TABLE mail_guardian_processed DROP CONSTRAINT IF EXISTS mail_guardian_processed_action_check;
ALTER TABLE mail_guardian_processed ADD CONSTRAINT mail_guardian_processed_action_check
  CHECK (action IN ('trashed','would_trash','pending_review','kept','skipped','classify_failed'));
INSERT INTO migrations (name) VALUES ('014_mail_guardian_classify_failed') ON CONFLICT DO NOTHING;
