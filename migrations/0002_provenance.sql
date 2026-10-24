-- Provenance and dedupe for memories (C336 lane M: M1 cite, M3 batch remember). Expand only: new nullable columns.
-- source_ref: where a memory came from (for example "claude-code:session/<id>"); NULL = written in Knowledge itself.
-- source_url: an optional link to the source. content_digest: per-area dedupe key of a saved memory item.
ALTER TABLE kn_documents ADD COLUMN source_ref TEXT;
ALTER TABLE kn_documents ADD COLUMN source_url TEXT;
ALTER TABLE kn_documents ADD COLUMN content_digest TEXT;
CREATE UNIQUE INDEX kn_documents_digest ON kn_documents(area_id, content_digest) WHERE deleted_at IS NULL AND content_digest IS NOT NULL;
