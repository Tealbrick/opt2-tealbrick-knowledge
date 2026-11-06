# Changelog

All notable changes to the Knowledge mini app. Versions are assigned at merge (C340).

## Unreleased

C392 R1: the relationships store (server, manifest, skill, tests). No owner page yet (follow-up R1-UI).

- Migration `0004_relationships.sql` (expand only): `kn_rel_people`, `kn_rel_identities`, `kn_relationships`, `kn_rel_proposals`, `kn_rel_history` and the append-only `kn_rel_log`. A third-party person belongs to one operator (a Governance person who owns agents); every child row names the pair (person, operator) in its foreign key.
- Agent ops `relationships_list`, `relationship_get` (by person id or identity) and `relationship_propose` (scopeType `area`, like `remember`). The operator is the agent's owner in the Governance directory copy; no copy or no owner answers 409 `relationships_unavailable`. Another operator's person answers 404 `person_unknown`.
- Agents propose type, identities and label (pending); history (contact, promise, topic) is written at once. Every proposal needs a citation {source, ref, at}. The type that reads back is the owner-confirmed one; a pending type shows as `proposedType`. A new person starts with type `unknown` and trust `hold`.
- Person ops `relationships_overview`, `relationship_confirm` and `relationship_set`. Only the owner sets stance and trust; the agent input schemas have no such field (`additionalProperties: false`).
- Identities are normalized with the canonical handle rule of `@opt2-tealbrick/manifest` (`normalizeHandle`) for email, Slack, Buzz and Telegram; phone = `+` and 6 to 15 digits. One identity names at most one person per operator.
- Skill `knowledge-relationships`. Receipts and `kn_rel_log` carry ids, field names and enum values only.

C392 R2: forget a person (Knowledge-local stores; C393 Q3: ship with honest "not possible yet" lines).

- Person ops `relationship_forget_scan` (read) and `relationship_forget` (destructive, hold family `destructive`, idempotency required, receipt). Owner only; agents and apps are `scope_denied`. Narrowing policy `unsupported` (a forget reads and deletes documents whatever their tags).
- The forget hard-deletes the person, identities, edge, proposals and history in one transaction and writes one tombstone row to `kn_rel_log` (`person_forgotten`, counts only).
- The scan searches every document of every area, live and soft-deleted (title, body, summary, tags, source, every revision, every comment) for the label and identity values (case-insensitive; terms under 4 characters skipped) and returns ids, areas and places, never text. `purgeDocuments` hard-deletes the picked documents that this call's scan matched (document, revisions, comments, links, projection rows, keyword index); any other id is refused and kept.
- Engine pages of purged documents: purged through the new GBrain helper path `/purge-page` (upstream's local CLI `gbrain delete <slug> --purge`; upstream refuses `purge` over MCP). Migration `0005_forget_queue.sql` (expand only) queues a page while the helper does not answer; the projection timer retries it. `guard.ts` is unchanged: agents can never purge.
- Every report lists `notPossibleYet`: Foundry, LCM-X, backups (retention from the manifest), research sources, GBrain pages not projected from a document, GBrain purge tombstones, other people's Relationships rows, deleted rows in database pages.
- Skill: agents cannot forget; they send the owner to the Relationships page. No owner page yet (R1-UI).
- Review fixes (#42): the scan answer carries each document's title and a `confirmation` text (person name, permanent, each document with area and title, not-possible-yet lines); `relationship_forget` has the same text as `holdView` and an id-and-count hold summary. The forget report, receipts and log keep ids and counts. At most 10 engine pages are purged inside the call; the rest stay queued. The helper reads `page_not_found` from the CLI's JSON error code, not by substring. Tests: app callers refused; `/purge-page` only on the `gbrain` service; the helper binds loopback only; a real-SDK test for the person call and the idempotent replay of a forget.

## 0.1.34 (2026-11-06)

C390 (knowledge#38), the second half: the GBrain and notebook databases are in every backup, and tb-exec listens on IPv4 and IPv6.

- The backup gap: `gbrain-db` and `notebook-db` declared a backup, but the app had no private address for them, so every backup and pre-update snapshot logged "service not deployed; left out of the backup" and held only the app database. New env `KNOWLEDGE_GBRAIN_DB_HOST` (`{{services.gbrain-db.host}}`) and `KNOWLEDGE_NOTEBOOK_DB_HOST` (`{{services.notebook-db.host}}`) let the SDK dump both: `services/gbrain-db.pgdump` and `services/notebook-db.surql`. A manifest test fails if a service with a backup has no address entry.
- miniapp-sdk 0.1.46 → 0.1.48 in the app and 0.1.41 → 0.1.48 in tb-exec of the companion images: tb-exec listens on `::` with a `0.0.0.0` fallback, and a helper or backup failure carries a cause label (`details.cause`), which `area provisioning failed` logs since 0.1.33. manifest 0.1.35 → 0.1.37 (the SDK's own pin).
- `upgradeFrom` `>=0.1.20 <=0.1.33`.

## 0.1.33 (2026-11-05)

C390 (knowledge#38), diagnostics: a memory area that cannot get its engine source now says why.

- The GBrain helper logs `helper_listening` at start and one line per `sources add` (outcome, cause, duration; labels only, never CLI output). It closes the CLI's stdin and stops a CLI run after 25 s, below the SDK's 30 s, so a slow CLI is `502 source_add_failed cause=cli_timeout`, not `503 helper_unavailable`.
- `area provisioning failed` logs a cause label when the error carries one (`details.cause`; the SDK adds it from miniapp-sdk 0.1.48).
- Not in this version (next, with miniapp-sdk 0.1.48): tb-exec on `::`, and the backup of `gbrain-db` / `notebook-db`.
- `upgradeFrom` `>=0.1.20 <=0.1.32`.

## 0.1.32 (2026-11-04)

The final version of 0.1.32-dev.1 (C389): embeddings on a brain built without them are enabled at the brain's own width. No other change. `upgradeFrom` admits 0.1.32-dev.1.

## 0.1.32-dev.1 (2026-11-04)

C389, DEV first. Embeddings on a brain built without them: GBrain makes that brain's vector column 1024 wide, and 0.1.31 enabled
embeddings at the legacy default 1536, which GBrain refused (`embedding_width_mismatch`), so search stayed keyword-only. A model whose
width GBrain knows is now enabled at the column's own width (no `--embedding-dimensions`); only a model GBrain cannot size passes its
width. A default or bound width for such a model is no longer reported as a model change. Area provisioning failures also log the
HTTP status of the helper error (503: the helper port does not answer; 502: the helper process behind it does not).

## 0.1.31 (2026-11-01)

The final version of the 0.1.31-dev series. See the dev entries below for what is in it. New in this cut: Access and Settings name a person by their agents and never show a raw id (C383). `upgradeFrom` now admits every 0.1.31-dev.N.

## 0.1.31-dev.5 (2026-11-01)

C383, DEV only. miniapp-sdk 0.1.46, manifest 0.1.35: an app caller can read the status of a hold on this app, and an approval of an app caller's hold serves only that call's key (audit holes 5, 6). No other change.

## 0.1.31-dev.4 (2026-11-01)

C382 batch 4, DEV only. No function or CLI change; ui 0.7.1.

- Holds and Receipts: a filter by agent and by text. A filter always shows "Showing N of M" and Clear. Receipts filters by agent on the server; the text filter reads the loaded rows and says so while more are not loaded, with Show older in reach. Held approvals that a filter hides are counted above the list.
- Memory area pickers (Library, Recall, Research): a filter on the choices, plain text or a regex. The chosen area always stays in the list. The filter is remembered and says "Showing N of M memory areas".
- Memory areas tables (Memory status, Settings): the same filter on the rows.

## 0.1.31-dev.3 (2026-10-31; C382, dev channel only; upgradeFrom adds 0.1.31-dev.2)

ui 0.4.1: on Agents & scopes the level buttons no longer move under the pointer. No operation, no migration.

## 0.1.31-dev.2 (2026-10-31; C382, dev channel only; upgradeFrom adds 0.1.31-dev.1)

Screen change only: no operation, no migration, no CLI change.

### Changed

- Agents & scopes no longer draws one dropdown per agent and memory area. It shows the defaults once, then only what differs from them, with "Back to default" and a one-line add. "Add or change many" opens the bulk editor: agents, memory areas, one click per level (ui 0.4.0 `AccessEditor`, through `tb.scopes_set`).

## 0.1.31-dev.1 (2026-10-30; C380 B6 Governance access ops, dev channel only; upgradeFrom ">=0.1.20 <=0.1.30 || 0.1.28-dev.1")

No app database migration. Two new agent operations, `access_list` and `access_revoke` (tb.access/1, spec 0.1.89), appended last in the manifest.
Only the Governance app (verified product `fleet`, listed) may call them; every other caller is refused with no data.

### Added

- `access_list`: what each agent holds (own memory area, the people's memory it reaches) and which teams may read a person's memory. Reads local data only.
  It names what it cannot list (team memory by membership, Portal scope rows, held calls), so it is never read as "nothing".
- `access_revoke`: ends a team's read grant on a person's memory (the `access_grant_remove` logic, logged in `kn_access_log`). Areas, documents and scope rows are never changed.

## 0.1.30 (2026-10-30; KN-EMBED embedding failures name their true cause, recovery without a redeploy; upgradeFrom ">=0.1.20 <=0.1.29 || 0.1.28-dev.1")

`upgradeFrom` ">=0.1.20 <=0.1.29 || 0.1.28-dev.1". No app database migration. Core's update rule passes a degraded app only with the same
attention code, so an instance whose embedding calls fail for another reason than a bad key (it reports `memory_engine_key_rejected` on
0.1.29) rolls back this update until the provider problem is fixed. Fix the cause first, then update.

### Fixed

- A failed embedding call no longer reads as "Key rejected" by itself. GBrain reports 401, 403, 400, 404 and a wrong vector size all as
  `embed_unavailable:provider_error`, and 429, 5xx and no answer as `embed_timeout:timeout`. Knowledge now asks the engine for one real
  test call (helper path `/embed-check`, at most one a minute, no retries, only while embedding calls fail) and names the cause:
  `memory_engine_key_rejected` (401, 403), `memory_engine_provider_quota`, `memory_engine_provider_busy`, `memory_engine_model_refused`,
  `memory_engine_provider_unreachable`, `memory_engine_provider_failing`. The rejected-key text names the field to replace.
- A replaced key clears the attention within minutes: after a key change the engine is probed at 30 s, 2 min and 5 min, not only by the
  10 min timer. The engine itself restarts on the new key without a redeploy (`tb-exec`, unchanged).
- Documents written while embedding calls failed get their vectors: each engine boot with a working key runs `gbrain embed --stale --yes
  --max-usd 1` in the background. The earlier enable path ran it without `--yes`, which GBrain refuses in a non-interactive run, so it never
  filled anything. This spends the owner's provider credit, at most 1 USD per boot.
- Notes about one query (`keyword_zero`, `keyword_relaxed_carried` and the like) are no longer engine faults, so the status check no longer
  reads "memory engine degraded" for them.
- Keys and Settings pages: a rejected key reads "rejected by provider" also when the key is optional (every Knowledge key is).
- Manifest: the app-key help says what the key does now (one valid key is enough for Knowledge), not "older installs only".

## 0.1.29 (2026-10-27; C373 second brain: model roles, app writers, person and team memory; upgradeFrom ">=0.1.20 <=0.1.28 || 0.1.28-dev.1")

`upgradeFrom` ">=0.1.20 <=0.1.28 || 0.1.28-dev.1". Needs Core with the manifest 0.1.32 pin (CORE-P5, core#67) and
bridge P-2 (0.2.11); until then Core skips this release. App database migration `0003_people.sql` (person memory, below;
expand only). Person and team memory needs Governance 0.3.0 or newer (its feed allows `knowledge`); with an older or no
Governance, Knowledge keeps today's access.

### Added

- Model roles `embeddings` and `reasoning` (manifest `settings.modelRoles`, both optional). The owner binds them on the bridge
  Keys and models page; `tb-exec` passes them to GBrain (`KN_EMBEDDINGS_*`, `KN_REASONING_*`); the GBrain boot wrapper plans
  the engine models from them (`services/gbrain/models.ts`) and reports them at helper path `/models`.
- Owner attention `model_role_optional` (a role is not set, recall is keyword-only or ask cannot answer) and
  `embeddings_changed` (the binding differs from the model the index was built with; the index keeps its model).
- `ask` answers 409 `reasoning_model_missing` when no reasoning model is usable.
- Settings page: the two roles as bound, not bound or degraded, with a notice in plain words. The old provider keys sit under
  "Older provider keys".
- App writers (Observer): `areas_list`, `document_create`, `document_update` as an app caller, company area only. The document
  page names the app ("Observer"). Any other op from an app is `scope_denied`.
- Access level `contribute` ("Read, add and edit": read, create, update, no delete) for area scopes, offered on the Agents and
  scopes page. It also lets the conformance row A21.owner_row_narrowed_level (SDK 0.1.41) narrow a level into a valid manifest.
- Person and team memory (C373; Martin C312.4, C322(5)). Knowledge reads the Governance directory (companion `fleet`
  `directory_feed`, read; contract `fleet.directory_feed/1`, vendored in `src/contracts/`) at start, every 60 s, after an
  agent is added and when the owner opens Access, never inside an agent call. It keeps ids and flags only (no handles,
  no trust values). New area kinds `person-…` and `team-…` (created when a new directory is read, or on first use):
  - an agent whose owner is an active person reads and writes that person's area, and writes without `area` go there;
  - an agent reads the team area of every team it or its owner is in (a blocked agent reads no team);
  - no agent reads another person's, team's or agent's area unless the owner lets one of its teams read that person
    (`access_grant_set`, optionally only some tags; `access_grant_remove`); grant changes are logged (append-only);
  - no directory (Governance missing, before 0.3.0, refusing, or no good read for 10 minutes) or no owner: today's
    access (own agent area + company area). Rules narrowing still applies on top; app callers never see these areas.
- Access page: people (directory id + their agents' names) and their memory, teams with members and grants, add and
  remove a grant, agents with no owner, the change log, and the directory state in plain words ("Update Governance to
  0.3.0"). Person ops `access_overview`, `access_grant_set`, `access_grant_remove`.
- `areas_list` names `defaultArea`, why each area is readable (`via`: owner, team, grant), `onlyTags` for a tag-limited
  grant, and `directory` (owner_known, no_owner, unavailable).

### Changed

- The legacy provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) are optional fallbacks. A
  missing key no longer holds the memory engine (`memory_engine_key_missing` is removed).
- Manifest order: `document_create` now precedes `remember`, so the conformance A12 app-caller rows run a document write (the app
  caller allow-list no longer includes `remember`). `tealbrick-conformance.json` `inputsAs.app` follows.
- Conformance start module applies `TBCONF_LEVEL_CRUD` (A21 rows, conformance 0.1.30) and lists the stub tools in the catalog (A20).
- Pins: miniapp-sdk 0.1.41, manifest 0.1.32, spec 0.1.78, conformance 0.1.30; `tb-exec` miniapp-sdk 0.1.41.
- Agents and scopes shows agent and company areas only; person and team memory is set on the Access page.
- Area descriptions in the manifest name the default area (the owner's personal memory, else the own agent area).

### Fixed

- QA of knowledge#24 (KN24-1, KN24-2, KN24-3, KN24-4, KN24-7, KN24-10):
  - Engine health comes first: `memory_engine_key_rejected`, `memory_engine_failing` and `memory_engine_starting` are no longer
    hidden by `model_role_optional` (an embeddings-only install). The model notice shows when the engine answers.
  - An app caller is refused on every dynamic `engine` tool (it only lists areas and writes documents in the company area), and the
    engine fan-out keeps only areas an app may see.
  - The GBrain boot removes the previous `knowledge-models.json` at start (the helper answers 503 until the new boot wrote its own).
    After a model-role or key change Knowledge re-reads `/models` at +30 s, +90 s and +3 min until the answer changes, and `ask`
    re-reads it before it refuses with `reasoning_model_missing`.
  - Boot: a `config.json` that names no embedding model (and not `embedding_disabled`) leaves the brain as it is (no
    `embeddings enable`); a corrupt file no longer crashes the boot (status `unreadable`, Settings notice).
  - `areas_list` shows `contribute` for the contribute level. A write by an app that is no longer listed (`Caller.listed` false) is
    allowed, as conformance A12.caller_name requires, and logged as a warning.
  - Settings notes "this provider uses its fixed address" when a base URL is bound for together, mistral, deepseek or voyage.

- Ported from 0.1.28 (hotfix/0.1.27): a memory engine that is still starting (502/503, refused, reset, timeout) is not a
  failure; attention `memory_engine_starting`; the engine is re-probed after 1 s, doubling to 60 s.

## 0.1.28 (hotfix/0.1.27)

- A starting memory engine is not a failure; quick engine re-probe. Engine-call failure log (0.1.28-dev.1).

## 0.1.27

- Node 24.22.1 base image (image-only patch).

## 0.1.26

- cite, batch remember, GBrain 0.60.424, hot tools (C336).
