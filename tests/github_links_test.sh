#!/usr/bin/env bash
# Every link from a public page into a Ledatic-Empire repository must resolve.
# 2026-11-15: /entropy and /entropy/spec linked tools/plasma/mhd_verify_epoch.rail in the
# Rail repository for 26 days after that file moved to rail-plasma (2026-10-20); both 404'd.
# Release ledger rows are history and are not links, so they are not checked.
#
#   tests/github_links_test.sh        exit 0 all resolve, 1 a dead link, 2 no network
set -uo pipefail
cd "$(dirname "$0")/.."
curl -s -o /dev/null --max-time 15 https://github.com/Ledatic-Empire/rail || { echo "github_links_test: cannot reach github.com" >&2; exit 2; }
fail=0; n=0
while read -r url; do
  n=$((n + 1))
  code=$(curl -s -o /dev/null -L --max-time 20 -w '%{http_code}' "$url")
  if [ "$code" != "200" ]; then
    echo "FAIL $code $url  ($(grep -rlF --include='*.html' --include='*.txt' --include='*.js' -e "$url" . | grep -v '\.venv' | tr '\n' ' '))"; fail=$((fail + 1))
  fi
done < <(grep -rhoE 'https://github\.com/Ledatic-Empire/[A-Za-z0-9_.-]+/(blob|tree)/[^"<> )]+' --include='*.html' --include='*.txt' --include='*.js' . 2>/dev/null | grep -v '\.venv' | sed -E "s/[';]+\$//" | sort -u)
echo "$n links, $fail dead"
[ "$fail" -eq 0 ] && echo "all passed" || exit 1
