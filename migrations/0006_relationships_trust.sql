-- C392 R1 hardening (F5, F4). Expand only: two nullable columns and one backfill (label_set_by); nothing of 0001-0005 is dropped or renamed.
--
-- F5: trust is keyed on WHO SENT a message, so it may only rise above draft_only for a sender the message SOURCE attests
-- (spec 0.1.91 messages/1 `author.verified`, through Connect; not wired yet, so no read rises today). `verified_by` is the
-- OWNER's state kept for that path: `platform_id` = a Slack, Buzz or Telegram id the owner verified as this person with
-- relationship_set verifyIdentities (never an agent, never by accepting a proposal). `dkim_spf_aligned` is reserved for an
-- email identity; no code path writes it. NULL = unverified. The CHECK pins each value to its kinds, so a handler bug cannot
-- verify an email as a platform id. No backfill: R1 is unreleased and owners verify explicitly.
ALTER TABLE kn_rel_identities ADD COLUMN verified_by TEXT CHECK (
  verified_by IS NULL
  OR (verified_by = 'platform_id' AND kind IN ('slack', 'buzz', 'telegram'))
  OR (verified_by = 'dkim_spf_aligned' AND kind = 'email')
);

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
