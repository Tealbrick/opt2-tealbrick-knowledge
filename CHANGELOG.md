# Changelog

All notable changes to the Knowledge mini app. Versions are assigned at merge (C340).

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
