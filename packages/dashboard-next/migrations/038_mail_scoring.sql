-- Optional Mail Guardian scoring metadata; schema exists before an account is configured.
ALTER TABLE mail_guardian_reviews
  ADD COLUMN subject TEXT,
  ADD COLUMN body_text TEXT,
  ADD COLUMN spam_score INTEGER CHECK (spam_score BETWEEN 0 AND 100),
  ADD COLUMN category TEXT CHECK (category IN ('personal', 'transactional', 'legitimate_marketing', 'suspicious', 'malicious_spam')),
  ADD COLUMN sender_legitimacy TEXT CHECK (sender_legitimacy IN ('legitimate', 'unknown', 'deceptive')),
  ADD COLUMN source_mailbox TEXT NOT NULL DEFAULT 'review' CHECK (source_mailbox IN ('inbox', 'review'));
ALTER TABLE mail_guardian_decisions
  ADD COLUMN spam_score INTEGER CHECK (spam_score BETWEEN 0 AND 100),
  ADD COLUMN category TEXT CHECK (category IN ('personal', 'transactional', 'legitimate_marketing', 'suspicious', 'malicious_spam')),
  ADD COLUMN sender_legitimacy TEXT CHECK (sender_legitimacy IN ('legitimate', 'unknown', 'deceptive')),
  ADD COLUMN verify_spam_score INTEGER CHECK (verify_spam_score BETWEEN 0 AND 100),
  ADD COLUMN verify_category TEXT CHECK (verify_category IN ('personal', 'transactional', 'legitimate_marketing', 'suspicious', 'malicious_spam')),
  ADD COLUMN verify_sender_legitimacy TEXT CHECK (verify_sender_legitimacy IN ('legitimate', 'unknown', 'deceptive'));
