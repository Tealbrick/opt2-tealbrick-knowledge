-- Foundry (deep knowledge, C373): what Knowledge has handed to the deep service. Expand only: new tables.
-- One foundry workspace per selected area (the wall: an agent's question runs only in areas it may read).
-- text_dataset_id: the area's "knowledge_documents" dataset (one row per text document); text_digest: the (id, version) list
-- it was last built from, so an unchanged area is not re-sent.
CREATE TABLE kn_deep_areas (
  area_id         TEXT PRIMARY KEY REFERENCES kn_areas(id),
  workspace_id    TEXT NOT NULL,
  text_dataset_id TEXT,
  text_digest     TEXT,
  synced_at       INTEGER,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

-- One row per table dataset: `table_key` = the `table:<name>` tag of its documents, or `doc:<document id>` without one.
-- `source_digest`: the (document id, version) list it was built from (idempotent on document id + revision).
-- state: synced | failed (bad CSV, never retried until a document changes) | deleted (its documents are gone: an empty
-- tombstone snapshot replaced the rows; foundry has no dataset delete).
CREATE TABLE kn_deep_tables (
  area_id         TEXT NOT NULL REFERENCES kn_areas(id),
  table_key       TEXT NOT NULL,
  dataset_id      TEXT,
  name            TEXT NOT NULL,
  document_ids    TEXT NOT NULL DEFAULT '[]',
  source_digest   TEXT,
  state           TEXT NOT NULL CHECK (state IN ('synced', 'failed', 'deleted')),
  rows            INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  synced_at       INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (area_id, table_key)
);
CREATE UNIQUE INDEX kn_deep_tables_dataset ON kn_deep_tables(dataset_id) WHERE dataset_id IS NOT NULL;
