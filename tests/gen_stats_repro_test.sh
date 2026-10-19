#!/usr/bin/env bash
# The repro-witness figure reads verdict lines only. Run: tests/gen_stats_repro_test.sh
# (exit 1 on any miss). 2026-10-13 to 10-19 the /rail hero read "connect ssh:"
# because ssh's own error was the log's last line.
set -uo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0

run() {  # run <name> <expected display> <log lines...>
  local name=$1 want=$2; shift 2
  printf '%s\n' "$@" > "$T/log"
  REPRO_LOG="$T/log" ./tools/gen_stats.sh "$T/stats.json" >/dev/null 2>&1 || { echo "FAIL $name: gen_stats exited nonzero"; fails=$((fails+1)); return; }
  local got
  got=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["stats"]["witness:repro"]["display"])' "$T/stats.json")
  if [ "$got" = "$want" ]; then echo "ok   $name: $got"; else echo "FAIL $name: got '$got', want '$want'"; fails=$((fails+1)); fi
}

run "ssh noise after failures" "repro unreachable since 2026-10-13" \
  "2026-10-12T08:37:01Z PASS node=studio master=9fabf9c reproducible sha=ad7aad50" \
  "ssh: connect to host 10.0.0.9 port 22: Operation timed out" \
  "2026-10-13T08:37:01Z UNREACHABLE node=studio ssh_rc=255" \
  "ssh: connect to host 10.0.0.9 port 22: Operation timed out" \
  "2026-10-14T08:37:00Z UNREACHABLE node=studio ssh_rc=255" \
  "ssh: connect to host 10.0.0.9 port 22: Operation timed out"
run "latest run passed" "re-proven 2026-10-12" \
  "2026-10-11T08:37:01Z FAIL node=studio" \
  "2026-10-12T08:37:01Z PASS node=studio master=9fabf9c reproducible sha=ad7aad50"
run "only noise" "not yet run" \
  "ssh: connect to host 10.0.0.9 port 22: Operation timed out"

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails FAILED"
exit $(( fails > 0 ))
