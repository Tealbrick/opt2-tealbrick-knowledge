# SurrealDB for Open Notebook: the unmodified upstream binary on node:24.22.1-bookworm-slim (the upstream image is
# distroless, so tb-exec could not run there). Build context: repository root.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS tb
# C62/BSD-10: tb-exec from the integrity-pinned lock (services/tb-exec), no install scripts.
COPY services/tb-exec/package.json services/tb-exec/package-lock.json /opt/tb/
RUN npm ci --prefix /opt/tb --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
# tb-exec reads the app manifest (claim digest, helper, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

FROM surrealdb/surrealdb:v2.6.5@sha256:7db835aab6355b66e2b5779a3cddae811f201c417adadb4413310ae7f925110e AS surreal

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
COPY --from=tb /opt/tb /opt/tb
COPY --from=surreal /surreal /surreal
COPY services/notebook-db/notebook-db-dump services/notebook-db/notebook-db-restore /usr/local/bin/
RUN chmod 0755 /usr/local/bin/notebook-db-dump /usr/local/bin/notebook-db-restore && mkdir -p /mydata
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--"]
CMD ["sh", "-c", "exec /surreal start --bind 0.0.0.0:8000 --user \"$SURREAL_USER\" --pass \"$SURREAL_PASS\" rocksdb:/mydata/knowledge.db"]
