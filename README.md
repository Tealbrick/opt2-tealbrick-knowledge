# Knowledge (Tealbrick mini app)

Agent memory and documents inside the customer's own deployment: a canonical document store projected into unmodified upstream engines (GBrain for memory, Open Notebook for research). Built on the Miniapp SDK.

**Status:** stable 0.1.21; `main` is 0.1.26 (dev channel only). Visibility: public, Apache-2.0. Published as six public GHCR images: the app (`ghcr.io/tealbrick/opt2-tealbrick-knowledge`) and five companion services (the sixth, `opt2-tealbrick-knowledge-deep` = Foundry, from C373) (each image has its plain version tag and a `sha-` tag).

- Repository: `Tealbrick/opt2-tealbrick-knowledge` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`); upstream licences are in `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app art are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every pull request and every push to `main` runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so this CI step is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## What it does

Knowledge gives agents memory and documents, with data in the customer's own deployment. It is a normalization wrapper over engines.

- Canonical documents (collections, revisions, comments, links) live in Knowledge and are engine independent. There is no attachment storage.
- Document bodies are projected into the memory engine as GBrain pages. The engine can be rebuilt from Knowledge (`afterRestore` requeues everything). Engines are pinned, unmodified upstream services: GBrain (memory) and Open Notebook (research, optional). The Hindsight engine is disabled.
- Engine tools are exposed 1:1 under a dynamic `engine` list, bounded by a pinned surface; anything else fails closed. Without an engine, recall degrades to keyword search (`degraded: true`).
- Areas are grant scopes: one private memory area per agent and one shared company area.
- With Governance 0.3.0+ (C373): a personal area per directory person, shared by that person's agents (their default write area), and a team area per team (read by members' agents). Another person's area is readable only when the owner lets a team read it (Access page). No directory = the two areas above only.
- Companion apps (Observer) may write into the company area as app callers: `areas_list`, `document_create`, `document_update` only, never an agent's private area. The document page names the app ("Observer").
- Auth, grants, receipts, settings and backups come from the Miniapp SDK. Knowledge has no own auth.

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Quick start

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck && pnpm lint && pnpm test
pnpm conformance      # tb-conformance against the real app with a stub engine (TBCONF_STUB_ENGINE=1); not release evidence, QA is
pnpm build            # compiles with `tsc` and builds the UI
pnpm gen              # tb-gen: openapi, kit, docs, railway (gen/, not committed)
```

Run the person UI without a bridge: set `TB_STANDALONE=1` and `TB_DATA_DIR` to a scratch folder (standalone mode; operations answer 503 `no_bridge`).

## Layout

| Path | Purpose |
|---|---|
| `tealbrick.manifest.json` | The manifest: the only source for operations, scopes, settings, hooks, skills and runtime hints |
| `src/` | Handlers and domain code; `src/main.ts` calls `startApp`; `src/ui/` is the React person UI |
| `src/engines/` | Engine adapters: one interface, one adapter per upstream engine (`gbrain/`, `notebook/`) |
| `src/store/` | The canonical document store (SQLite) |
| `src/projection.ts` | Projection outbox to the engine |
| `migrations/` | 1 forward-only migration. Never edit a released file. |
| `skills/<id>/SKILL.md` | Agent skills declared in the manifest (how to work with the memory system, per engine; research) |
| `services/<id>/` | Companion service images (see below); `services/README.md` describes them |
| `test/` | Unit tests (`pnpm test`) |
| `conformance.start.ts` | Boots the app for `tb-conformance` |
| `scripts/` | UI build and app-specific scripts |
| `Dockerfile`, `tealbrick-ci.json` | App image and CI config (kind `miniapp`, five images) |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | The opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`. Do not edit. |
| `gen/` | Generated, not committed |

## Configuration

The SDK reads only `TB_*` variables (SDK API section 13). The Dockerfile does not set `TB_DATA_DIR` or `TB_BACKUP_DIR`, so the deploy must provide them (`/data` and `/data/backup`). App-specific:

- Settings (all `mutable:false`, set at deploy): `engine` (gbrain), `research` (default false), `model_provider` (openai default, google, anthropic).
- Model roles (C373, manifest `settings.modelRoles`): `embeddings` (search by meaning) and `reasoning` (ask), both optional. The owner binds each role on the bridge Keys and models page. `tb-exec` fills them into the `gbrain` service as `KN_EMBEDDINGS_{PROVIDER,MODEL,BASE_URL,KEY,DIMS}` and `KN_REASONING_{PROVIDER,MODEL,BASE_URL,KEY}`; the GBrain boot wrapper (`services/gbrain/models.ts`) turns them into the engine's own settings and reports the result at helper path `/models`. Without a role, recall is keyword-only and `ask` answers 409 `reasoning_model_missing`. The Settings page shows both roles as bound, not bound or degraded.
- Older provider keys (fallback, now optional): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. A role with no binding uses the `model_provider` defaults when its key is set.
- Environment passed to the app: `KNOWLEDGE_ENGINE`, `KNOWLEDGE_RESEARCH`, `KNOWLEDGE_MODEL_PROVIDER`, `KNOWLEDGE_GBRAIN_URL`, `KNOWLEDGE_GBRAIN_ADMIN_TOKEN`, `KNOWLEDGE_NOTEBOOK_URL`, `KNOWLEDGE_NOTEBOOK_PASSWORD` (wired by the deploy recipe).
- Service knobs: `KNOWLEDGE_MIGRATION_{WAIT_S,LOCK_STALE_S,POLL_S,RETRY_MIN_S,RETRY_MAX_S}`.
- Default model names live in `src/config.ts`. Making them customer-editable is an open item.

Companion services (built from `services/<id>/Dockerfile`, started with the SDK `tb-exec` wrapper, which fetches declared keys and runs backup dump and restore):

- `gbrain-db`: pgvector on Postgres 17.
- `gbrain`: upstream commit pinned, with a Tealbrick boot wrapper (crash-safe migration lock, model plan from the roles) and a helper (`/sources`, `/models`).
- `notebook-db`: SurrealDB (Business Source License 1.1), only when research is on.
- `notebook`: Open Notebook, only when research is on.

Upstream stays unmodified.

## How it ships

1. Set the same version in `package.json` and `tealbrick.manifest.json`. Check `publisher` and `source.repo` in the manifest; the repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-knowledge`).
2. Tag `v<semver>` on a green pipeline and push the tag. Tags are immutable.
3. The release Action pushes the GHCR images (the app and `opt2-tealbrick-knowledge-<service>` for each service) and the kit tarball. `registry-sync` signs the index entry with the image digest and the manifest digest.
4. Core deploys the newest stable version when the owner installs or updates the app. Core (E3, live since RS-3) switches to the new version only after a health check and rolls back when it fails, restoring the pre-update data snapshot; the gate is "not worse than before" (C219). The full effect needs the app to run SDK 0.1.25, which holds for the dev channel builds today and for stable after their promotion.

## Dependency pins

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile.
- The `tb-exec` service package has its own pin of `@opt2-tealbrick/miniapp-sdk` (`services/tb-exec/package.json`).

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
