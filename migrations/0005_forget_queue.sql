-- C392 R2: engine pages still to purge after an owner's "forget person". `relationship_forget` hard-deletes the Knowledge
-- documents the owner picked and, in the same transaction, queues one row per document here; the app then purges the
-- document's GBrain page through the engine helper (upstream's trusted local CLI `gbrain delete <slug> --purge`, which
-- upstream refuses over MCP). A row is deleted when the page is purged or absent; a failed try backs off and retries
-- (never gives up silently). Ids only: never a title, text, identity or label. Expand only.
CREATE TABLE kn_forget_queue (
  source_id        TEXT NOT NULL,
  document_id      TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (source_id, document_id)
);
CREATE INDEX kn_forget_queue_due ON kn_forget_queue(next_attempt_at);
