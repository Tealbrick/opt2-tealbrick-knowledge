# Changelog

All notable changes to the Knowledge mini app. Versions are assigned at merge (C340).

## 0.1.39 (2026-11-06)

INC-20261106-02, second part: research chat answered without the notebook's sources.

- `research_ask` sent Open Notebook the context selection map (source and note ids mapped to "full content") as the chat context. Open Notebook puts that value into the chat prompt as given; its own UI first builds the real context with `POST /api/chat/context` and sends that. So the model saw only ids and answered "Unknown" to questions about the notebook (qa1 0.1.38, 2026-11-06 10:56Z: a canary source with a test word, answer "Unknown").
- `ask` now builds the context with `/api/chat/context` (the existing `context()`: enumerated membership, re-checked after, 413/409 refusals unchanged) and sends its sources and notes.
- `upgradeFrom` `>=0.1.20 <=0.1.38`.

## 0.1.38 (2026-11-06)

INC-20261106-02: research chat (`research_ask`) failed on every workspace with the OpenAI provider (`research_outcome_unknown`; Open Notebook `POST /api/chat/execute` 502).

- Knowledge's OpenAI chat model for Open Notebook is `gpt-6-luna`, a reasoning model. Open Notebook's model library esperanto (2.25.1 in Open Notebook 1.14.0; unchanged in 2.28.0) drops `temperature` and `top_p` only for models named `o1`/`o3`/`o4`/`gpt-5`, so it sent `top_p` and OpenAI refused the call: 400 "Unsupported parameter: 'top_p' is not supported with this model." (ostra, 2026-11-06 10:05:17Z). The key was fine.
- The notebook image patches that check so `gpt-6` models (the whole family and dated ids such as `gpt-6-luna-20260922`) count as reasoning models. The build fails if the upstream line is not there exactly once, and then checks the result in the built image: `gpt-6-luna`, `gpt-6-luna-20260922`, `gpt-6-sol` and `gpt-6-astra` send neither `temperature` nor `top_p`, and `max_tokens` goes out as `max_completion_tokens` exactly as for `gpt-5`; `gpt-4o` keeps `temperature` and `top_p`. Without the patch the check fails the build (proven). The LangChain path sends `top_p` None and `temperature` 1.0. The model choice is unchanged.
- A failed research engine call was a silent `research_outcome_unknown`. Knowledge now logs "research engine call failed" with method, path (no query), HTTP status and a short cause code derived from Open Notebook's error (`unsupported_parameter:top_p`, `auth_failed`, `rate_limited`, `model_not_found`, `credential_decrypt`, `model_config`, `timeout`, `context_too_long`, `upstream_error`, …). It never logs upstream text or the prompt.
- `upgradeFrom` `>=0.1.20 <=0.1.37`.

## 0.1.37 (2026-11-06)

INC-20261106-01: edits of documents never reached the memory engine (on every version with the GBrain 0.60.424 pin, 0.1.26+). Reproduced on qa1 with 0.1.36.

- GBrain stores every page slug in lower case and `get_page` reads the exact slug. Knowledge read the page revision with the upper-case document id (`knowledge-docs/kdoc_<ULID>`), so the read missed every existing page. The write then went out without `expected_revision`, and GBrain (since 0.60.162) refuses such a write to an existing page with `revision_required`. Creates still worked; every update and every delete did not. Recall by meaning answered with the first version of each edited document, and deleted documents stayed in the engine (recall already left them out). Reads, writes and deletes now use the lower-case slug.
- GBrain keeps a refused write under its request id and replays the refusal for the same arguments. The id was derived from slug, content and revision, so each retry got the stored refusal back, forever. Each write try now sends a fresh id; `expected_revision` keeps a repeated write safe (a stale write is a conflict, never an overwrite of newer text).
- The page frontmatter carries `knowledge_content_sha256` (the document's hash). After a conflict the page is read again: when it already holds this document (a write whose answer was lost and that landed later), the write is done. No third write, no loop.
- Writes send `allow_shrink: true` (a shorter document is an intended edit; always with `expected_revision`). `drop_timeline` is never sent: agents may add timeline entries to a document's page (`gb_add_timeline_entry`); when GBrain refuses an edit that would delete them (`timeline_rows_would_be_removed`), the page's Timeline section is kept and the edit is written again. Links agents added are kept by GBrain (its put reconciles only links derived from the content).
- A failed projection was silent. Each failed attempt now logs "projection failed" (and "projection gave up" after 12) with area, document id, attempt, boot retry, state, error code and the next try. It never logs content. The stored `last_error` starts with the code.
- The boot retry of failed rows ran 12 more writes per row on every boot. It now stops after 3 boots per row. The count is the row's `attempts` (kept across the boot retry, reset by a success or a new edit), so there is no schema change: a rollback to 0.1.36 opens the same database.
- One-time catch-up at the first boot (kn_state `engine_catchup`): a delete is queued for every deleted document, so pages left in the engine before 0.1.37 are removed (idempotent: a missing page is one read). It goes through the one paced drain (20 rows per pass, every 30 s, the same attempt cap), with the failed rows the boot retry re-queued. Logs "engine catch-up queued" and "engine catch-up done" with counts only (requeued, ok, failed, pending).
- One projection drain runs per database, also when the services are rebuilt during a pass (two passes wrote the same rows twice). A drain asked for during a pass runs one more pass after it.
- `upgradeFrom` `>=0.1.20 <=0.1.36`.

## 0.1.36 (2026-11-06)

INC-20261104-01, second step. 0.1.35 never reached stable: its update on qa1 rolled back.

- 0.1.35 set the Open Notebook API to `API_HOST=::`. uvicorn then listens on IPv6 only (asyncio sets `IPV6_V6ONLY`), Railway's health check probes over IPv4, and Railway failed the notebook deploy after 300 s. The API is back on upstream's IPv4 bind.
- New `services/notebook/ipv6-forward.ts` (run by the image's Node) listens on `[::]:5055` with `IPV6_V6ONLY` and pipes each connection to `127.0.0.1:5055`. It logs "notebook ipv6 forwarder listening [::]:5055" at start and one line per restart, never traffic. A 6th start within 60 s (5 restarts) stops the container (tb-exec exits 137), so a broken IPv6 path is a failed deploy, not a silent outage behind a green IPv4 health check. An IPv4 socket and an IPv6-only socket share the port (proven in the pinned image). So the API answers on IPv4 (health check) and on IPv6 (an IPv6-only Railway private network).
- notebook-db keeps 0.1.35's `[::]:8000` (proven live on qa1: "Started web server on [::]:8000", backup dump exitCode 0).
- `upgradeFrom` `>=0.1.20 <=0.1.35`.

## 0.1.35 (2026-11-06)

INC-20261104-01: research notebooks work on a Railway project whose private network is IPv6 only (legacy environments).

- notebook-db (SurrealDB) listened on `0.0.0.0:8000`, IPv4 only. Open Notebook resolved the private host to an IPv6 address and got `Connect call failed ('fd12:…', 8000) [Errno 111]`, so every research call failed. It now binds `[::]:8000`, which accepts IPv4 and IPv6 (proven with the pinned SurrealDB image: `127.0.0.1` and `::1` both connect; the backup dump on `127.0.0.1` keeps working).
- The Open Notebook API listened on `0.0.0.0:5055` (upstream default `API_HOST`), so the Knowledge app could not reach it on such a network either. It now binds `::` (`API_HOST=::`).
- A test fails if any companion Dockerfile or entrypoint binds a listener to `0.0.0.0`. gbrain serve already binds `::`; Postgres listens on all addresses; tb-exec listens on `::` since 0.1.34 (miniapp-sdk 0.1.48).
- `upgradeFrom` `>=0.1.20 <=0.1.34`.

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
