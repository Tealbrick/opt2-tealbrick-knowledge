# Open Notebook research engine (upstream, one checked library patch below) + tb-exec wrapper.
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
# INC-20261104-01 (0.1.36): the API stays on upstream's IPv4 bind (Railway's health check probes over IPv4; 0.1.35 set
# API_HOST=:: and the IPv6-only uvicorn failed that check). ipv6-forward.ts adds [::]:5055 (IPv6 only) -> 127.0.0.1:5055.
# INC-20261106-02 (0.1.38): research chat answered 502 on every OpenAI workspace. esperanto (Open Notebook's model library,
# 2.25.1 here, same in 2.28.0) leaves out temperature/top_p only for models named o1/o3/o4/gpt-5; Knowledge's OpenAI chat
# model gpt-6-luna is a reasoning model too and OpenAI refuses its top_p ("Unsupported parameter: 'top_p'", 400). gpt-6
# models count as reasoning models here. The build fails if the upstream line is not there exactly once, and checks the
# result (no temperature, no top_p for gpt-6-luna; gpt-4o keeps them).
RUN f=/app/.venv/lib/python3.12/site-packages/esperanto/providers/llm/openai.py \
  && test "$(grep -c 'or self.get_model_name().startswith("gpt-5")$' "$f")" = 1 \
  && sed -i 's/or self.get_model_name().startswith("gpt-5")$/or self.get_model_name().startswith("gpt-5") or self.get_model_name().startswith("gpt-6")/' "$f" \
  && /app/.venv/bin/python -c "from esperanto.providers.llm.openai import OpenAILanguageModel as M; r = M(model_name='gpt-6-luna', api_key='build-check'); k = r._get_api_kwargs(); assert r._is_reasoning_model() and 'top_p' not in k and 'temperature' not in k, k; o = M(model_name='gpt-4o', api_key='build-check'); assert not o._is_reasoning_model() and 'top_p' in o._get_api_kwargs()"
COPY services/notebook/entrypoint.sh services/notebook/ipv6-forward.ts /opt/knowledge/
RUN chmod 0755 /opt/knowledge/entrypoint.sh
ENTRYPOINT ["node", "/opt/tb/node_modules/@opt2-tealbrick/miniapp-sdk/dist/exec/cli.js", "--", "/opt/knowledge/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
