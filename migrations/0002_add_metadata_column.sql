-- Migration number: 0002 	 2025-01-27T00:00:01.000Z
-- Add metadata column to store parsed email metadata as JSON
ALTER TABLE email_inbox ADD COLUMN metadata TEXT;
