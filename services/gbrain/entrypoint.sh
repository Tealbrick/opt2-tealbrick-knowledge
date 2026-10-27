#!/bin/sh
# Composes GBrain's env, then hands over to boot.ts (C69): init + migrations under a crash-safe lock with a status
# /health while they wait, then `gbrain serve --http`. boot.ts is exec'd so it receives every stop signal itself
# (a `sh` parent died on SIGTERM and left upstream's apply-migrations lease behind: qa1, 2026-10-12).
# Models (C373): boot.ts composes GBrain's model env (services/gbrain/models.ts) from the model roles tb-exec resolved
# (KN_EMBEDDINGS_*, KN_REASONING_*) or, for installs from before model roles, the legacy KNOWLEDGE_MODEL_PROVIDER with
# its provider keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY), all as env from tb-exec.
set -eu

: "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:?required}"
: "${GBRAIN_DB_HOST:?required}"
: "${GBRAIN_DB_PASSWORD:?required}"
if [ -n "${GBRAIN_REMOTE_PRIVATE_PAGES:-}" ]; then echo "GBRAIN_REMOTE_PRIVATE_PAGES must not be set" >&2; exit 1; fi
export GBRAIN_DATABASE_URL="postgres://postgres:${GBRAIN_DB_PASSWORD}@${GBRAIN_DB_HOST}:5432/gbrain"

exec node /opt/knowledge/boot.ts
