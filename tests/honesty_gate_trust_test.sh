#!/usr/bin/env bash
# R8 (trust the system does not have) and R9 (em-dash ratchet) fail through
# the real gate. Run: tests/honesty_gate_trust_test.sh (exit 1 on any miss).
# Each case copies the working tree, plants one violation where a reader would
# see it, and runs tools/honesty_gate.sh on the copy; the clean copy must pass.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f _shared/stats.json ] || ./tools/gen_stats.sh >/dev/null 2>&1
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0

fresh() {  # a copy of the working tree as deploy.sh would see it
  rm -rf "$T/tree"; mkdir -p "$T/tree"
  { git ls-files; git ls-files --others --exclude-standard; echo _shared/stats.json; } \
    | sort -u | while IFS= read -r f; do [ -f "$f" ] && rsync -R "$f" "$T/tree/"; done
}

expect() {  # expect <name> <rc wanted> <rule tag or -> <shell that plants the case>
  local name=$1 want=$2 tag=$3 plant=$4 out rc
  fresh
  (cd "$T/tree" && eval "$plant")
  out=$(cd "$T/tree" && tools/honesty_gate.sh 2>&1); rc=$?
  if [ "$rc" != "$want" ]; then echo "FAIL $name: rc=$rc, want $want"; fails=$((fails+1)); return; fi
  if [ "$tag" != "-" ] && ! printf '%s\n' "$out" | grep -q "FAIL \[$tag"; then
    echo "FAIL $name: no $tag line"; fails=$((fails+1)); return
  fi
  echo "ok   $name"
}

expect "clean tree passes"               0 -  ":"
expect "independent witness, data page"  1 R8 "printf '<p>signed by an independent witness</p>\n' >> data.html"
expect "split by a tag and a line wrap"  1 R8 "printf '<p>a beacon no<b>body</b>\n   controls</p>\n' >> rail/docs/index.html"
expect "inside a meta attribute"         1 R8 "printf '<meta name=\"d\" content=\"No trust in us.\">\n' >> replay.html"
expect "in llms.txt"                     1 R8 "printf 'Zero C dependencies.\n' >> llms.txt"
expect "cannot be backdated"             1 R8 "printf '<p>It cannot be backdated.</p>\n' >> receipts.html"
expect "one more em-dash entity"         1 R9 "printf '<p>a &mdash; b</p>\n' >> thanks.html"
expect "one more em-dash in a .py"       1 R9 "printf '# a \xe2\x80\x94 b\n' >> sdk/ledatic_receipts.py"
expect "true scoped claim still passes"  0 -  "printf '<p>independently re-verifiable by the buyer</p>\n' >> data.html"

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails FAILED"
exit $(( fails > 0 ))
