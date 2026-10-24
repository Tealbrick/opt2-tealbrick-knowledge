# Open Notebook research engine (upstream unmodified) + tb-exec wrapper.
# Build context: repository root.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS tb
# C62/BSD-10: tb-exec from the integrity-pinned lock (services/tb-exec), no install scripts.
COPY services/tb-exec/package.json services/tb-exec/package-lock.json /opt/tb/
RUN npm ci --prefix /opt/tb --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
# tb-exec reads the app manifest (claim digest, helper, backup) from its default path.
COPY tealbrick.manifest.json /opt/tb/tealbrick.manifest.json

FROM lfnovo/open_notebook:1.14.0@sha256:6c5fb35b6c60549e4c2dc7617d1f07aaf0a67c4954564a73498d536b8186e879
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=tb /usr/local/bin/node /usr/local/bin/node
COPY --from=tb /opt/tb /opt/tb
COPY services/notebook/entrypoint.sh /opt/knowledge/entrypoint.sh
RUN chmod 0755 /opt/knowledge/entrypoint.sh
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--", "/opt/knowledge/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
