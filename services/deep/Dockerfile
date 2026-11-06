# Deep knowledge (C130, C325; FOUNDRY-DESIGN v2 §2): helix-foundry at a pinned commit, unmodified, + HelixDB server from
# its pinned image + tb-exec wrapper + the loopback supervisor and token proxy (services/deep/supervisor.ts).
# Build context: repository root.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS tb
# C62/BSD-10: tb-exec from the integrity-pinned lock (services/tb-exec), no install scripts.
COPY services/tb-exec/package.json services/tb-exec/package-lock.json /opt/tb/
RUN npm ci --prefix /opt/tb --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
# tb-exec reads the app manifest (claim digest, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

# HelixDB server: the image foundry pins (one-way storage upgrades: moving this pin is a migration, see services/README.md).
FROM ghcr.io/helixdb/helixdb:v0.0.12@sha256:f22b50fdab8fadbf8b5a881e656f293fdf5c688bad018f503b8dbc2f0f29543d AS helix

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS foundry
ARG FOUNDRY_REPO=https://github.com/helixdb/helix-foundry.git
ARG FOUNDRY_COMMIT=52cfaa3ed2bde3fbeeca933fb77be55580a75efb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
  && git init -q /opt/foundry && cd /opt/foundry && git remote add origin "$FOUNDRY_REPO" \
  && git fetch -q --depth 1 origin "$FOUNDRY_COMMIT" && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$FOUNDRY_COMMIT" && rm -rf .git
WORKDIR /opt/foundry
# pnpm 10 runs no dependency lifecycle scripts unless the lockfile project allows them (upstream's own Dockerfile does the same install).
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate \
  && pnpm install --frozen-lockfile && pnpm build:sdk

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=tb /opt/tb /opt/tb
COPY --from=helix /bin/helix-server /usr/local/bin/helix-server
COPY --from=foundry /opt/foundry /opt/foundry
COPY services/deep/supervisor.ts /opt/deep/supervisor.ts
RUN mkdir -p /data
ENV DEEP_DATA_DIR=/data FOUNDRY_ROOT=/opt/foundry HELIX_BIN=/usr/local/bin/helix-server PORT=3150
EXPOSE 3150
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--"]
CMD ["node", "/opt/deep/supervisor.ts"]
