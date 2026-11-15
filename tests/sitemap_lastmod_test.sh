#!/usr/bin/env bash
# The sitemap's lastmod is the day each page's source last changed in git.
# Runs the real generator in dry-run mode (nothing reaches KV or the repo) and
# compares every <url> with `git log`. Until 2026-11-15 every URL carried the
# day the generator ran, so the committed sitemap was modified every morning.
#
#   tests/sitemap_lastmod_test.sh [GENERATOR.rail]     exit 0 pass, 1 fail, 2 could not run
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
GEN="${1:-$REPO/railgen/gen_llms.rail}"
RAIL="$HOME/projects/rail-https"
FLAG=/tmp/ledatic_gen_llms_dry
OUT=/tmp/ledatic_sitemap.xml
[ -x "$RAIL/rail_native" ] || { echo "sitemap_lastmod_test: no rail_native in $RAIL" >&2; exit 2; }
touch "$FLAG"; trap 'rm -f "$FLAG"' EXIT
rm -f "$OUT"
log=$(cd "$RAIL" && ./rail_native --out-prefix /tmp/ledatic_sitemap_test run "$GEN" 2>&1) || { echo "$log" | tail -5; echo "sitemap_lastmod_test: generator failed" >&2; exit 2; }
[ -s "$OUT" ] || { echo "sitemap_lastmod_test: generator wrote no $OUT" >&2; exit 2; }

fail=0; n=0
file_for() { case "$1" in
  /) echo index.html ;; /llms.txt) echo llms.txt ;; /data/catalog.json) echo data/catalog.json ;;
  *) echo "${1#/}.html" ;; esac; }
while read -r loc mod; do
  n=$((n + 1)); f=$(file_for "$loc")
  want=$(git -C "$REPO" log -1 --format=%cs -- "$f")
  if [ -z "$want" ]; then echo "FAIL $loc: no commit for $f"; fail=$((fail + 1))
  elif [ "$mod" != "$want" ]; then echo "FAIL $loc: lastmod $mod, $f last changed $want"; fail=$((fail + 1)); fi
done < <(awk -F'[<>]' '/<loc>/{l=$3; sub("https://ledatic.org","",l)} /<lastmod>/{print l, $3}' "$OUT")
[ "$n" -ge 20 ] || { echo "FAIL only $n urls in the sitemap"; fail=$((fail + 1)); }
days=$(grep -o '<lastmod>[^<]*' "$OUT" | sort -u | wc -l | tr -d ' ')
echo "$n urls, $days distinct lastmod days, $fail failed"
[ "$fail" -eq 0 ] && echo "all passed" || exit 1
