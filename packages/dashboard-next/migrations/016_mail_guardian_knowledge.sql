CREATE TABLE mail_guardian_knowledge (
  id BIGSERIAL PRIMARY KEY,
  brief TEXT NOT NULL CHECK (char_length(brief) <= 1500),
  source_decisions INT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO migrations (name) VALUES ('016_mail_guardian_knowledge') ON CONFLICT DO NOTHING;
