# Companion service images

Each image is a thin layer over a pinned, unmodified upstream image (or upstream source at a pinned commit),
plus the Miniapp SDK `tb-exec` wrapper entrypoint (C2: fetches the manifest-declared keys from the bridge with
the service's own instance key and execs the upstream command with them as env; runs `backup.dump`/`restore`;
starts the C6 helper). No upstream file is changed or vendored.

| Service | Upstream | Knowledge adds |
|---|---|---|
| `gbrain` | garrytan/gbrain at commit 36121271 (v0.60.424.0), built on `oven/bun` | `entrypoint.sh` (env), `boot.ts` (C69: init + migrations under a crash-safe lock, status `/health`, then serve), `helper.ts` (C6: `POST /sources` runs upstream's trusted `gbrain sources add`; C373: `POST /models` answers the model status), `models.ts` (C373: model plan from the `KN_*` role env) |
| `gbrain-db` | `pgvector/pgvector:0.8.1-pg17` | dump/restore scripts for the SDK backup runner |
| `notebook` | `lfnovo/open_notebook:1.14.0` | `entrypoint.sh` (composes `SURREAL_URL` from the private host) |
| `notebook-db` | `surrealdb/surrealdb:v2.6.5` (binary copied onto node:24-slim so `tb-exec` can run) | nothing else |

`tb-exec` (`dist/exec/cli.js`) comes from the `@opt2-tealbrick/miniapp-sdk` release tarball, installed with `npm ci --ignore-scripts`
from `services/tb-exec/package-lock.json` (integrity-pinned, C62/BSD-10; bump the SDK there and run `npm install --package-lock-only --ignore-scripts`),
run by a Node 24 binary copied into the image.

All four images build with the repository root as context (they bake `tealbrick.manifest.json` into `/opt/tb/`, where tb-exec reads it).

## GBrain crash-safe migrations (C69, knowledge 0.1.9)

Upstream `gbrain apply-migrations` guards itself with a lease row (`gbrain_cycle_locks.id = 'gbrain-apply-migrations'`,
60 min TTL, refreshed every 60 s; upstream `src/core/migration-orchestration-lock.ts` + `src/core/db-lock.ts`). It takes
a lease over only after the TTL, or for a dead pid on the same host. Up to 0.1.8 `entrypoint.sh` ran the migrations as a
child of `sh`: a stop signal killed `sh` only, upstream's own SIGTERM cleanup never ran, and the lease named a host that
no longer existed, so every new container exited 75 until Railway gave up (qa1, 2026-10-12).

`boot.ts` (wrapper only; upstream code unchanged) replaces that step:
- Knowledge runners take a Postgres session advisory lock (`pg_try_advisory_lock(7431202610120001)`) on one dedicated
  connection. The server releases it when that connection dies.
- While holding it, a lease that is expired, written by this container's host, or not refreshed for 180 s is deleted
  (fenced on its token, refresh time and the lock's backend pid) with a `migration_lock_takeover` log line.
- init and `apply-migrations` run as children that get every stop signal (SIGKILL after 5 s); a lease the child left on
  this host is removed when it exits.
- Until `gbrain serve` listens, `/health` answers 503 with `{"status":"starting"|"needs_attention","reason":...}`. A busy
  lock or an unreachable database is polled for 240 s, then the status turns `needs_attention` (`migration_lock_held`,
  `database_unreachable`); a failed run is `migrations_failed` at once. Attempts continue with backoff (30 s to 5 min);
  the process never exits for these, so there is no crash loop. On Railway, the deploy healthcheck (300 s) then marks
  the deployment FAILED, which Core reports.
- Knobs (seconds): `KNOWLEDGE_MIGRATION_WAIT_S`, `KNOWLEDGE_MIGRATION_LOCK_STALE_S`, `KNOWLEDGE_MIGRATION_POLL_S`,
  `KNOWLEDGE_MIGRATION_RETRY_MIN_S`, `KNOWLEDGE_MIGRATION_RETRY_MAX_S`.
- Upstream runs each schema migration in its own transaction (except the few marked `transaction: false`, such as
  `CREATE INDEX CONCURRENTLY`); the wrapper does not change that.

Tests: `test/gbrain-boot.test.ts` (decision logic, CI) and `test/gbrain-boot-pg.test.ts` (real Postgres via
`initdb`/`pg_ctl` + a lease-faithful upstream double: qa1 replay, SIGKILL mid-migration, live holder, SIGTERM, two
concurrent boots; skipped where no Postgres binaries exist, e.g. the CI node image).

## GBrain model roles (C373, knowledge 0.1.29)

`tb-exec` fetches the bound model roles and passes them to `entrypoint.sh` as `KN_EMBEDDINGS_{PROVIDER,MODEL,BASE_URL,KEY,DIMS}`
and `KN_REASONING_{PROVIDER,MODEL,BASE_URL,KEY}`. `models.ts` (pure) turns them into GBrain's own provider env and one of
three plans per boot: a fresh brain (`gbrain init --embedding-model …`, or `--no-embedding` when nothing is bound or GBrain
refuses the model), a built brain that keeps its model (a different binding is reported as `changed`, never applied), or a
built brain without embeddings (`gbrain embeddings enable …`, then `gbrain embed --stale` in the background). All `KN_*` are
removed from GBrain's env. `$GBRAIN_HOME/knowledge-models.json` holds labels only (no key, no address) and is served at
`POST /models`. An older Core or bridge resolves roles to nothing: the legacy provider keys then drive the same plan.
