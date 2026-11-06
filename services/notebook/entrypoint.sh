#!/bin/sh
# Compose the database URL from the private host, then hand over to the upstream entrypoint unchanged.
set -eu
: "${SURREAL_HOST:?required}"
export SURREAL_URL="ws://${SURREAL_HOST}:8000/rpc"
# INC-20261104-01 (0.1.36): IPv6 path to the IPv4-only API (an IPv6-only Railway private network reaches only IPv6).
# Restarted if it ever exits; the container's stop ends it with everything else.
(while :; do node /opt/knowledge/ipv6-forward.ts; sleep 1; done) &
exec /app/scripts/docker-entrypoint.sh "$@"
