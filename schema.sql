CREATE TABLE IF NOT EXISTS inboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inboxes_expires ON inboxes(expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  mail_from TEXT,
  rcpt_to TEXT,
  subject TEXT,
  received_at INTEGER NOT NULL,
  text_body TEXT,
  html_body TEXT,
  FOREIGN KEY(inbox_id) REFERENCES inboxes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_key ON messages(message_key);
CREATE INDEX IF NOT EXISTS idx_messages_inbox_time ON messages(inbox_id, received_at DESC);
