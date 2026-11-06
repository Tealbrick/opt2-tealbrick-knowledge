-- INC-20261106-01: a failed projection row was re-queued at every boot with no limit (12 more writes per row per boot).
-- `cycles` counts boot retries of a row that failed again; the boot retry stops at 3. A successful projection or a new
-- change of the document resets it to 0.
ALTER TABLE kn_projection ADD COLUMN cycles INTEGER NOT NULL DEFAULT 0;
