#!/usr/bin/env bash
# R8 (trust the system does not have), R9 (em-dash ratchet) and R10 (a capability
# Rail cut, claimed as present) fail through
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
expect "R10 four backends"                1 R10 "printf '<p>Four backends, one compiler.</p>\n' >> rail/docs/index.html"
expect "R10 wasm in a backend list"       1 R10 "printf 'Backends: macOS ARM64, Linux ARM64, WASM.\n' >> llms.txt"
expect "R10 jit-emitted, meta attribute"  1 R10 "printf '<meta name=\"d\" content=\"JIT-emitted kernels.\">\n' >> rail.html"
expect "R10 metal gpu kernels, split"     1 R10 "printf '<p>its own Metal <b>GPU</b>\n kernels</p>\n' >> index.html"
expect "R10 a ledger row is history"      0 -  "perl -0pi -e 's{(<ol class=\"ledger[^>]*>)}{\$1<li><p>Rail emits its own Metal GPU kernels.</p></li>}' changelog.html"
expect "R10 saying it was cut passes"     0 -  "printf '<p>The WebAssembly backend was cut on 2026-10-21.</p>\n' >> rail.html"
expect "R10 trains a small transformer"  1 R10 "printf '<p>a binary that trains a small transformer</p>\n' >> manifesto.html"
expect "R10 x402 called unopened"        1 R10 "printf '<p>The paid endpoints are not serving yet.</p>\n' >> data.html"

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails FAILED"
exit $(( fails > 0 ))
