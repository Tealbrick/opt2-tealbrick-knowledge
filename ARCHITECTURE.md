# Knowledge (Tealbrick mini app): architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see the system `ARCHITECTURE.md` and `SYSTEM-OVERVIEW.md`.

## Common app pattern (verified for this repo on 2026-10-17)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Knowledge: what it does

Knowledge is a normalization wrapper over engines. Canonical documents stay in Knowledge (engine independent) and are projected into GBrain pages; the engine can be rebuilt from Knowledge (`afterRestore` requeues everything). Engine tools are exposed 1:1 under a dynamic `engine` list, bounded by a pinned surface, and anything else fails closed. Without an engine, recall degrades to keyword search (`degraded: true`).

## Operations (from `tealbrick.manifest.json`)

53 operations.
- Hot (agent, C336 M4): `recall` (meaning), `search` (words), `get` (open a `ref`), `context` (size-capped block for hooks), `ask` (engine think, model cost), `remember` (`text` or `items[]` with `source`, deduped per area). Every recall/search hit carries `ref` and `source` (citation; migration 0002 adds `source_ref`, `source_url`, `content_digest`).
- Read (agent, per area): `recall`, `areas_list`, `collections_list`, `collection_get`, `collection_tree`, `documents_search`, `document_get`, `document_revisions`, `comments_list`, `links_list`, research reads, `engine` (dynamic, search mode since 0.1.26: agents see `knowledge__engine_search` / `knowledge__engine_call` instead of ~100 `gb_*` tools; ceiling destructive).
- Write (agent): `remember`, `collection_create`, `document_create`, `document_update`, `comment_add`, `link_add`, `research_source_add`, `research_chat_start`, `research_ask`.
- Destructive, hold `destructive`: `document_delete`, `collection_delete`, `link_delete`, `research_source_delete`.
- Person: 10 library reads, 4 writes, 4 destructive (held).
- Rules' `rules.narrowing` memory tags are consumed (`src/narrowing.ts`). Writes to existing items obey read visibility (F90, C150). URL research sources are deferred until a network policy exists (C61). There is no attachment storage.

## Scopes, hooks and companions

- **App callers (C373):** Observer writes through `areas_list`, `document_create`, `document_update` (`APP_CALLER_OPS`); any other op from an app is `scope_denied`. An app sees and writes only `kind: shared` areas. Its write right is the SDK `own` default row of its instance (the SDK 0.1.41 default grants give an app only `read` on the shared area; spec and manifest need two disjoint `shared` entries to fix this cleanly). The owner switches it off with `tb.scopes_set` on that row. `kn_state` key `caller/<ins>` keeps the display name. Tags are stored as sent (lower-case, at most 20, 40 characters each); Knowledge derives none.
- **Scopes:** `area` (access `read`, `contribute` = read, create, update, `read_write`). Default grants: own area read_write, shared area read. The shared company area is read for every connected agent; write is off until the owner turns it on per agent (C1). Events `agentAdded` (creates the company area and that agent's area) and `keysChanged`.
- **Person and team memory (C373):** areas `person-<24 hex>` (a Governance person) and `team-<24 hex>` (a Governance team) are NOT SDK scope instances; Knowledge decides them per call from its copy of the Governance directory (`src/people.ts`, `src/area-access.ts`) on top of the bridge edge grant, the SDK rows above and Rules narrowing. An agent owned by person P: read and write on P's area (its default write area), read on the areas of teams it or P is in, read on another person Q's area only through an owner grant "team T may read Q" (`kn_team_grants`, optionally tag-limited; a tag-limited area is readable only by item-filtering ops). No directory or no owner = own agent area + company only (fail closed). Scope functions return `null` for these ids, so the SDK gate checks the caller's best area row. The owner manages grants on the Access page.
- **Hooks:** None.
- **Companion grants it asks for:** `fleet` `directory_feed` (read): the Governance directory (contract `fleet.directory_feed/1`, vendored in `src/contracts/`, provenance in `test/contracts/PROVENANCE.md`), read by `src/directory-feed.ts` at start, every 60 s, after `agentAdded` and from the Access page; never inside an agent call. Governance 0.3.0 or newer serves it to Knowledge; an older one answers `no_access` and Knowledge keeps today's access. Before C373 no grant was asked. It calls GBrain at `/mcp` (stateless JSON-RPC POST, no redirects, 2 MB response cap) and Open Notebook REST (4 MB cap).

## Settings, keys and environment

Settings (all `mutable:false`, set at deploy): `engine` (gbrain; hindsight is disabled), `research` (default false), `model_provider` (openai default, google, anthropic). Model roles (C373, `settings.modelRoles`): `embeddings` and `reasoning`, both `required:false`, `minPolicy:standard`, `usedBy:["gbrain"]`. `tb-exec` fills the bound role into the `gbrain` service as `KN_EMBEDDINGS_*` and `KN_REASONING_*`. `services/gbrain/models.ts` plans each boot: a role binding, else the legacy `model_provider` defaults when their key is in env, else no model. A fresh brain starts with `init --embedding-model …` or `--no-embedding`. A built brain keeps the model it was built with: a different binding is reported as `embeddings_changed` and is not applied (re-index is not automatic yet). The wrapper writes labels only to `knowledge-models.json` and answers them at helper path `/models`; the app reads them strictly (`readEngineModels`) and raises attention `model_role_optional` or `embeddings_changed`. Legacy keys, from the bridge key store (account default): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`; they are optional fallbacks and do not hold the engine. Env passed to the app: `KNOWLEDGE_ENGINE`, `KNOWLEDGE_RESEARCH`, `KNOWLEDGE_MODEL_PROVIDER`, `KNOWLEDGE_GBRAIN_URL`, `KNOWLEDGE_GBRAIN_ADMIN_TOKEN`, `KNOWLEDGE_NOTEBOOK_URL`, `KNOWLEDGE_NOTEBOOK_PASSWORD` (wired by the deploy recipe). Service knobs: `KNOWLEDGE_MIGRATION_{WAIT_S,LOCK_STALE_S,POLL_S,RETRY_MIN_S,RETRY_MAX_S}`. Default model names live in `src/config.ts` and must become customer-editable (C186, open). The Dockerfile does not set `TB_DATA_DIR` or `TB_BACKUP_DIR`; the deploy recipe sets them (SDK-API section 13; `tb-gen railway` sets both).

Companion services (built from `services/<id>/Dockerfile`, started with the SDK `tb-exec` wrapper, which fetches declared keys and runs backup dump and restore): `gbrain-db` (pgvector on Postgres 17), `gbrain` (upstream commit pinned, a Tealbrick boot wrapper with a crash-safe migration lock and a helper), and, when research is on, `notebook-db` (SurrealDB under the Business Source License 1.1, C155) and `notebook` (Open Notebook). Upstream stays unmodified.

## Data

- **Stored:** Migration 0001: `kn_areas`, `kn_collections`, `kn_documents` (title, slug, summary, body, status), `kn_revisions`, `kn_comments`, `kn_links`, `kn_documents_fts` (FTS5), `kn_projection` (outbox to the engine), `kn_state`. Migration 0003 (C373): `kn_areas.subject_kind` / `subject_id` (person and team areas, stored with kind `shared`), `kn_directory` (the reduced Governance directory copy: ids, owner, active and blocked flags, team names and members; no handles, no trust), `kn_team_grants`, `kn_access_log` (append-only). Sealed: registered engine client credentials. Engine data lives on the service volumes.
- **Never stored:** Attachments (no table, no op), model keys outside the bridge key store.

## External calls and background work

- **External:** Only the engines, on the private network. Model providers (OpenAI, Google, Anthropic) are called by GBrain and Open Notebook, not by the app code.
- **Background:** Projection outbox drain every 30 s (batch 20, max 12 attempts, backoff 5 s up to 1 hour). Engine probe at start and every 10 minutes (feeds SDK `attention()`). Retry of failed rows at boot. Migrations on the engine services are crash-safe (C69).

## Person UI

Memory (Library, Recall, Memory status), Research, Access (C373: people, teams, grants), Holds, Receipts, Agents and scopes, Keys, Backups and export (`src/ui/main.tsx`).

## Requirements and runtime hints

A model for the embeddings role and one for the reasoning role (both optional; without them recall is keyword-only and ask is unavailable). The legacy provider keys still work as a fallback (OpenAI by default; Anthropic mode still needs an OpenAI key for embeddings). Engine and database services must be healthy for engine-backed ops. SurrealDB is BSL 1.1: self-hosting inside Knowledge on the customer's Railway is expected to be fine, but legal confirmation is open (C155).

App port 5310, 0.5 cpu, 768 MB, data 5 GB plus backup 20 GB. Engine only: about 2.0 cpu, 3.3 GB RAM, 37 GB volume. With research: about 3.5 cpu, 5.4 GB RAM, 47 GB (computed from the manifest; UNVERIFIED against a deployed template). Backup cron `23 2 * * *`, retain 14; each service with a dump is dumped by `tb-exec`.

## Pinned packages

Stable 0.1.21: miniapp-sdk 0.1.25, spec 0.1.39, manifest 0.1.18, conformance 0.1.18, ui 0.2.4. This branch (C373): miniapp-sdk 0.1.41, manifest 0.1.32, spec 0.1.78 (what both pin), conformance 0.1.30, ui 0.2.4. The `tb-exec` service package pins miniapp-sdk 0.1.41.

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25: pre-update snapshot, migration lock, failed mode) is in this app only where the pin above says 0.1.25 (the plain version 0.1.21 is on the dev channel; its qa1 soak is the gate for stable, C221, PROMOTE-STABLE §7). All RS-3 apps pin SDK 0.1.25 (dev channel; stable after the qa1 soak of the plain version). Core restores the snapshot on an automatic rollback (portal-core#1, E3). This Core is live since 2026-10-16 22:37:58Z (Core 29ae2fe).

## Known gaps

- Stable 0.1.20 pins SDK 0.1.22; the dev build already pins 0.1.25.
- Model names are set by the model roles (C373); the legacy defaults in `src/config.ts` stay only as a fallback.
- Changing the embeddings model of a built index needs a re-index; it is reported (`embeddings_changed`), not applied.
- No service Dockerfile sets `USER` and no manifest service sets `dropPrivileges`, so the four service images run as their upstream image's default user (root-capable).
