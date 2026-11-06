#!/bin/sh
# Compose the database URL from the private host, then hand over to the upstream entrypoint unchanged.
set -eu
: "${SURREAL_HOST:?required}"
export SURREAL_URL="ws://${SURREAL_HOST}:8000/rpc"
# INC-20261104-01 (0.1.36): IPv6 path to the IPv4-only API (an IPv6-only Railway private network reaches only IPv6).
# Restarted if it exits, with one log line per restart. A 6th start within 60 s (5 restarts) stops the whole container:
# SIGKILL to this process (after `exec` it is the upstream supervisor), so tb-exec exits 137 and the deploy fails
# visibly instead of a silent IPv6 outage behind a green IPv4 health check. Nothing of the traffic is ever logged.
main=$$
(
  starts=""
  while :; do
    now=$(date +%s)
    kept=""
    for t in $starts; do [ $((now - t)) -lt 60 ] && kept="$kept $t"; done
    starts="$kept $now"
    n=$(echo $starts | wc -w)
    if [ "$n" -gt 5 ]; then
      echo '{"component":"notebook-v6-forward","event":"crash_loop","msg":"notebook ipv6 forwarder failed 5 times in 60 s; stopping the container"}' >&2
      kill -KILL "$main"
      exit 1
    fi
    if [ "$n" -gt 1 ]; then echo "{\"component\":\"notebook-v6-forward\",\"event\":\"restart\",\"startsIn60s\":$n}" >&2; fi
    node /opt/knowledge/ipv6-forward.ts || true
    sleep 1
  done
) &
exec /app/scripts/docker-entrypoint.sh "$@"
