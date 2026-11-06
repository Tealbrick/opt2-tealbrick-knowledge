-- C392 R1 hardening (F5, F4). Expand only: two nullable columns and backfills; nothing of 0001-0005 is dropped or renamed.
--
-- F5: trust is keyed on WHO SENT a message, so it only holds for an identity the sender cannot fake. `verified_by` says why
-- an identity is trusted as the sender: `platform_id` = a Slack, Buzz or Telegram id (the platform API names the author, a
-- third party cannot send as another id) whose link to this person the OWNER confirmed (an accepted identity proposal, or
-- the owner's relationship_set verifyIdentities). `dkim_spf_aligned` is reserved for an email sender that Connect attests per
-- message (a spec follow-up: messages/1 `author.verified`); no code path writes it yet, so an email identity is never
-- verified and a lookup by email reads at most `draft_only`. NULL = unverified (every email, phone and other identity, and
-- every identity an agent put in). The CHECK pins each value to its kinds, so a handler bug cannot verify an email as a
-- platform id.
ALTER TABLE kn_rel_identities ADD COLUMN verified_by TEXT CHECK (
  verified_by IS NULL
  OR (verified_by = 'platform_id' AND kind IN ('slack', 'buzz', 'telegram'))
  OR (verified_by = 'dkim_spf_aligned' AND kind = 'email')
);
-- Backfill: platform ids the owner confirmed (rows not written by an agent; an agent's created_by is its agt_ id).
UPDATE kn_rel_identities SET verified_by = 'platform_id' WHERE kind IN ('slack', 'buzz', 'telegram') AND created_by NOT LIKE 'agt\_%' ESCAPE '\';

-- F4: a label is owner text only when the owner typed it (relationship_set). An agent's label (a new person's, or an
-- accepted label proposal: the words still come from a message) is NULL here and reads back under `observed`.
ALTER TABLE kn_rel_people ADD COLUMN label_set_by TEXT;
-- Backfill from the append-only log: the newest label change of the person, if it was the owner's relationship_set.
UPDATE kn_rel_people SET label_set_by = (
  SELECT CASE WHEN l.action = 'relationship_set' THEN l.actor END
  FROM kn_rel_log l
  WHERE l.person_id = kn_rel_people.id AND l.operator = kn_rel_people.operator
    AND ((l.action = 'relationship_set' AND (' ' || coalesce(l.detail, '') || ' ') LIKE '% label %')
      OR (l.action = 'proposal_accepted' AND coalesce(l.detail, '') LIKE 'label %'))
  ORDER BY l.id DESC LIMIT 1
);
