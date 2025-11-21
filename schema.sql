CREATE TABLE email_inbox (
    id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(
        status IN ('pending', 'processing', 'completed', 'failed')
    ),
    received_at TEXT NOT NULL,
    processed_at TEXT
);

CREATE INDEX idx_status ON email_inbox(status);
CREATE INDEX idx_received_at ON email_inbox(received_at);