-- C373 (C312.4, C322(5)): person and team memory areas, the Governance directory copy, and the owner's team grants.
-- Two new area kinds: `person` (one per Governance directory person, read and written by that person's agents) and `team`
-- (read by the agents of the team's members). Expand only: kn_areas keeps its CHECK (a rebuild would rewrite the foreign
-- keys of kn_collections, kn_documents and kn_projection); a person or team area is stored with kind 'shared' (= not an
-- agent's own area) and names its kind in `subject_kind` and its Governance contact or team id in `subject_id`.
ALTER TABLE kn_areas ADD COLUMN subject_kind TEXT CHECK (subject_kind IS NULL OR (subject_kind IN ('person', 'team') AND kind = 'shared'));
ALTER TABLE kn_areas ADD COLUMN subject_id TEXT CHECK ((subject_id IS NULL) = (subject_kind IS NULL));
CREATE UNIQUE INDEX kn_areas_subject ON kn_areas(subject_kind, subject_id) WHERE subject_id IS NOT NULL;

-- The last good copy of Governance's `directory_feed` (contract fleet.directory_feed/1), reduced to what Knowledge needs:
-- people (id, active), agents (id, owner, blocked), teams (id, name, members). No handles and no trust values are kept
-- (C88). `usable` = 1 only after a successful read and until a refusal clears the copy; age is checked at use.
CREATE TABLE kn_directory (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  revision    INTEGER,
  synced_at   INTEGER,
  checked_at  INTEGER,
  usable      INTEGER NOT NULL DEFAULT 0,
  model       TEXT,
  error_code  TEXT,
  error       TEXT
);
INSERT INTO kn_directory (id) VALUES (1);

-- Owner grants: "team T may read person P's area" (tags NULL = the whole area; else a JSON list: only memories with at
-- least one of these tags). Keyed by Governance ids, so a grant holds before the area exists.
CREATE TABLE kn_team_grants (
  team_id     TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  tags        TEXT,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (team_id, person_id)
);

-- Append-only log of grant changes (the owner's Access page lists it; receipts carry the same summary).
CREATE TABLE kn_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('grant_added', 'grant_changed', 'grant_removed')),
  team_id     TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  tags        TEXT
);
CREATE TRIGGER kn_access_log_no_update BEFORE UPDATE ON kn_access_log BEGIN SELECT RAISE(ABORT, 'kn_access_log is append-only'); END;
CREATE TRIGGER kn_access_log_no_delete BEFORE DELETE ON kn_access_log BEGIN SELECT RAISE(ABORT, 'kn_access_log is append-only'); END;
