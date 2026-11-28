#!/usr/bin/env bash
# The top nav is copied into every page (no build step), so nothing but this test keeps the
# copies in step. The section links (everything before the per-page CTA) must be identical
# to index.html's. tios.html has its own product nav on purpose and is the one exception.
#
#   tests/nav_consistency_test.sh     exit 0 all pages agree, 1 a page drifted
set -uo pipefail
cd "$(dirname "$0")/.."
EXEMPT="tios.html"
links() { awk '/<nav class="topnav">/,/<\/nav>/' "$1" | grep -o 'href="[^"]*"' | sed -E 's/^href="//; s/"$//' | awk '{print} /^\/life$/{exit}'; }
want=$(links index.html)
[ -n "$want" ] || { echo "nav_consistency_test: index.html has no topnav links" >&2; exit 1; }
fail=0; n=0
for f in $(grep -l '<nav class="topnav">' ./*.html | sed 's#^\./##'); do
  case " $EXEMPT " in *" $f "*) continue;; esac
  n=$((n + 1))
  got=$(links "$f")
  if [ "$got" != "$want" ]; then
    echo "FAIL $f: section links differ from index.html"; diff <(echo "$want") <(echo "$got") | head -6; fail=$((fail + 1))
  fi
done
echo "$n pages, $fail drifted"
[ "$fail" -eq 0 ] && echo "all passed" || exit 1
