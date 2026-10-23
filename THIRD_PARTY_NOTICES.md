# Third-party notices

Knowledge's own code is Apache-2.0 (see `LICENSE` and `NOTICE`). It includes, bundles or builds on the software and
assets below under their own licences. Update this file when you add a dependency, a vendored file or a companion image.

## Vendored into the built UI (`dist/ui`)

The UI build (`scripts/build-ui.ts`) copies these files into the app image.

| Name | Version | Licence | Source |
|---|---|---|---|
| React (`react`) | 19.3.0 | MIT | https://github.com/facebook/react |
| React DOM (`react-dom`) | 19.3.0 | MIT | https://github.com/facebook/react |
| `scheduler` | 0.28.0 | MIT | https://github.com/facebook/react |
| `@opt2-tealbrick/ui` (Tealbrick design system kit: tokens, components, CSS) | 0.2.4 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-packages |
| `@opt2-tealbrick/miniapp-sdk/client` and `@opt2-tealbrick/spec/bridge` (browser modules only) | 0.1.25 / 0.1.39 | MIT | see the next section |
| Nunito (variable font, `vendor/@opt2-tealbrick/ui/dist/fonts/*.woff2`) | 5.3.0 (`@fontsource-variable/nunito`) | SIL Open Font License 1.1 | https://github.com/googlefonts/nunito |

- Nunito is Copyright 2014 The Nunito Project Authors. Its licence text ships next to the font files as
  `vendor/@opt2-tealbrick/ui/dist/fonts/OFL.txt`.
- The Tealbrick brand mark and the app stills (`stills/*.webp`, from `@opt2-tealbrick/ui` `assets/`) are Tealbrick
  artwork. They are **not** covered by the Apache-2.0 licence of this app and are not licensed for reuse outside
  Tealbrick products.

## Runtime dependencies in the app image (production `node_modules`)

| Name | Version | Licence | Source |
|---|---|---|---|
| `@opt2-tealbrick/miniapp-sdk` | 0.1.25 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-sdk |
| `@opt2-tealbrick/manifest` | 0.1.18 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-sdk |
| `@opt2-tealbrick/spec` (dependency of the SDK; the manifest package nests 0.1.26) | 0.1.39 | MIT | https://github.com/Martin-Atrin/opt2-tealbrick-specs |
| `ajv` (dependency of the manifest package) | 8.17.1 | MIT | https://github.com/ajv-validator/ajv |
| `fast-deep-equal` (ajv) | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| `fast-uri` (ajv) | 3.1.8 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| `json-schema-traverse` (ajv) | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| `require-from-string` (ajv) | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |

The app image base is `node:24-slim` (Dockerfile, pinned by digest): Node.js (MIT, with bundled components under their
own licences) on Debian (the licences of its packages are in `/usr/share/doc/*/copyright` inside the image).

## Companion services (separate images built from `services/`)

Knowledge ships four companion images next to the app image (`tealbrick-ci.json`). Each one runs a pinned, unmodified
upstream and adds only the files named in `services/README.md` (Tealbrick code, Apache-2.0). Every companion image also
contains `@opt2-tealbrick/miniapp-sdk` 0.1.12 (`tb-exec`) with its dependencies (the 8 MIT/BSD-3-Clause packages of
the table above, installed from `services/tb-exec/package-lock.json`) and a Node.js 24.22.1 binary
(`node:24.22.1-bookworm-slim`, MIT).

| Companion image | Upstream | Exact image / ref | Licence | URL |
|---|---|---|---|---|
| `opt2-tealbrick-knowledge-gbrain` | GBrain (memory engine) | source at commit `99de5707f6fc0916f43b4c167802a5f8d9ea0cf0` (tag v0.60.57.0, `VERSION` 0.60.57.0), built on `oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef` | MIT, "Copyright (c) 2026 Garry Tan" (checked in the upstream `LICENSE` at that commit) | https://github.com/garrytan/gbrain |
| `opt2-tealbrick-knowledge-gbrain` (base) | Bun runtime | `oven/bun:1.4.0-debian` (digest above) | MIT, with JavaScriptCore (LGPL-2.0) and other components under their own licences (to verify against the licensing page of that Bun release) | https://github.com/oven-sh/bun |
| `opt2-tealbrick-knowledge-gbrain` (wrapper deps) | `postgres` (postgres.js), used by `boot.ts` | 3.4.9, from `services/gbrain/package-lock.json` | Unlicense | https://github.com/porsager/postgres |
| `opt2-tealbrick-knowledge-gbrain-db` | pgvector (PostgreSQL with the pgvector extension) | `pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21` | PostgreSQL License (PostgreSQL 17 and pgvector 0.8.1; the Debian packages in the image keep their own licences) (to verify against the image) | https://github.com/pgvector/pgvector |
| `opt2-tealbrick-knowledge-notebook` | Open Notebook (research engine) | `lfnovo/open_notebook:1.14.0@sha256:6c5fb35b6c60549e4c2dc7617d1f07aaf0a67c4954564a73498d536b8186e879` (source tag v1.14.0, commit `30c7e2a63e43b7f270fc2c638f0b6246934a53f4`) | MIT, "Copyright (c) 2024 Luis Novo" (checked in the upstream `LICENSE` at v1.14.0) | https://github.com/lfnovo/open-notebook |
| `opt2-tealbrick-knowledge-notebook-db` | SurrealDB (database for Open Notebook) | `surrealdb/surrealdb:v2.6.5@sha256:7db835aab6355b66e2b5779a3cddae811f201c417adadb4413310ae7f925110e`; only the `/surreal` binary is copied onto `node:24.22.1-bookworm-slim` | Business Source License 1.1 (the SurrealDB server; converts to Apache-2.0 on the change date in its licence file). Not Apache-2.0 today. Exact terms and change date: to verify in the licence file of v2.6.5 | https://github.com/surrealdb/surrealdb |

- GBrain and Open Notebook install their own dependencies when their images are built (GBrain: `bun install --frozen-lockfile
  --production` from the upstream lockfile; Open Notebook: the Python and Node packages inside the upstream image).
  Those packages keep their own licences; the inventory is the upstream lockfile at the refs above and the image itself.
- Each companion is an independent process that the app calls over a private network. None is linked into the app.
- The Tealbrick files added to the companions (`services/*/entrypoint.sh`, `boot.ts`, `helper.ts`, `migration-lock.ts`,
  `pg-lock-session.ts`, dump and restore scripts) are Apache-2.0 like the rest of this repository.

## Development only (not shipped)

TypeScript, Biome, `@types/*`, happy-dom, `postgres` (tests) and `@opt2-tealbrick/conformance` are used to build and test
the app and are not part of the app image.
