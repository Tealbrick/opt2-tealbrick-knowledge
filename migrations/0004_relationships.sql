-- C392 R1: the relationships store. Agents observe conversations and keep, per OPERATOR (a Governance directory person, the
-- owner of agents), a record of each THIRD-PARTY person they deal with: identities, a relationship type, the owner's stance
-- and trust, and cited history. Agents PROPOSE (type, identity, label); the owner CONFIRMS. Stance and trust are set by the
-- owner only. A value an agent proposes never changes what the type, stance or trust read until the owner accepts it, so a
-- third party cannot raise an agent's permission through a message (prompt injection). Expand only: new tables, nothing
-- of 0001-0003 changes. A third-party person belongs to ONE operator (no sharing between operators in R1).

-- A third-party person, owned by one operator. `UNIQUE (id, operator)` lets every child row name the pair, so a child row
-- can never point at another operator's person.
CREATE TABLE kn_rel_people (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'rp\_%' ESCAPE '\'),
  operator    TEXT NOT NULL CHECK (length(operator) BETWEEN 1 AND 64),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (id, operator)
);
CREATE INDEX kn_rel_people_operator ON kn_rel_people(operator);

-- How the operator reaches a person. `value` is normalized (src/relationships.ts: canonical handles for email, slack, buzz and
-- telegram; `+` and digits for phone). One identity names at most one person per operator; two operators may each know it.
CREATE TABLE kn_rel_identities (
  person_id   TEXT NOT NULL,
  operator    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'slack', 'phone', 'buzz', 'telegram', 'other')),
  value       TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 254),
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (operator, kind, value),
  FOREIGN KEY (person_id, operator) REFERENCES kn_rel_people(id, operator) ON DELETE CASCADE
);
CREATE INDEX kn_rel_identities_person ON kn_rel_identities(person_id);

-- The edge operator → person. `type` is the OWNER-CONFIRMED type only (a pending proposal never shows here). `stance` (JSON
-- {tone, formality, avoidTopics[]}) and `trust` are owner-set only; `trust` defaults to `hold` (draft nothing out, send nothing).
CREATE TABLE kn_relationships (
  operator         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'unknown' CHECK (type IN ('friend', 'family', 'colleague', 'customer', 'supplier', 'unknown')),
  stance           TEXT CHECK (stance IS NULL OR json_valid(stance)),
  trust            TEXT NOT NULL DEFAULT 'hold' CHECK (trust IN ('reply', 'draft_only', 'hold')),
  set_by           TEXT,
  set_at           INTEGER,
  last_contact_at  INTEGER,
  PRIMARY KEY (operator, person_id),
  FOREIGN KEY (person_id, operator) REFERENCES kn_rel_people(id, operator) ON DELETE CASCADE
);

-- Agent proposals, each with the citation of the message it came from. Only type, identity (value = JSON {kind, value}) and
-- label: an agent can never propose stance or trust (the CHECK holds even if a handler is wrong).
CREATE TABLE kn_rel_proposals (
  id           TEXT PRIMARY KEY CHECK (id LIKE 'rpp\_%' ESCAPE '\'),
  operator     TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  field        TEXT NOT NULL CHECK (field IN ('type', 'identity', 'label')),
  value        TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 400),
  citation     TEXT NOT NULL CHECK (json_valid(citation)),
  proposed_by  TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  CHECK ((state = 'pending') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)),
  FOREIGN KEY (person_id, operator) REFERENCES kn_rel_people(id, operator) ON DELETE CASCADE
);
CREATE INDEX kn_rel_proposals_person ON kn_rel_proposals(operator, person_id, state);

-- Observed history (written at once: an observation, not a claim about permission), each item cited {source, ref, at}.
-- `open` is for promises only (1 = still open).
CREATE TABLE kn_rel_history (
  id          TEXT PRIMARY KEY CHECK (id LIKE 'rph\_%' ESCAPE '\'),
  operator    TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('contact', 'promise', 'topic')),
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  open        INTEGER CHECK ((kind = 'promise') = (open IS NOT NULL) AND (open IS NULL OR open IN (0, 1))),
  citation    TEXT NOT NULL CHECK (json_valid(citation)),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (person_id, operator) REFERENCES kn_rel_people(id, operator) ON DELETE CASCADE
);
CREATE INDEX kn_rel_history_person ON kn_rel_history(operator, person_id, created_at);

-- Append-only log of every relationships write (person created, proposed, history added, proposal decided, owner set).
-- `detail` holds ids, field names and enum values only: never an identity value, a label, a stance text or history text.
-- No foreign key and no CHECK on `action`: R2 (forget) adds a tombstone action and keeps the row after the person is gone.
CREATE TABLE kn_rel_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  operator    TEXT NOT NULL,
  person_id   TEXT,
  detail      TEXT
);
CREATE INDEX kn_rel_log_operator ON kn_rel_log(operator, id);
CREATE TRIGGER kn_rel_log_no_update BEFORE UPDATE ON kn_rel_log BEGIN SELECT RAISE(ABORT, 'kn_rel_log is append-only'); END;
CREATE TRIGGER kn_rel_log_no_delete BEFORE DELETE ON kn_rel_log BEGIN SELECT RAISE(ABORT, 'kn_rel_log is append-only'); END;
