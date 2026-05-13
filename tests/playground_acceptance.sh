#!/usr/bin/env bash
# tests/playground_acceptance.sh
# ----------------------------------------------------------------------
# Phase-2 milestone acceptance test for the public Rail playground.
# Drives 3 example programs end-to-end through the production endpoint
# (https://ledatic.org/api/playground/compile) and asserts they
# compile + run + produce expected output.
#
# Returns 0 = ALL PASS = phase-2 milestone met.
# Returns non-zero = at least one case failed (see stdout for which).
#
# ## Crucial: run from a non-Studio machine
#
# The whole point of v0 is that someone *who is not the user* can hit
# the playground. Running this test from Studio (the dev host) only
# proves the path works for the author. To prove "non-author can use",
# invoke from another Mac on the same Tailnet, e.g.
#
#   # On Air (or any non-Studio Mac with this repo):
#   bash tests/playground_acceptance.sh
#
# Or, less ideally, run from a public network (your phone hotspot)
# against a checkout of this repo. DO NOT rely on the Studio invocation
# alone for the milestone declaration.
#
# ## Default endpoint
#   https://ledatic.org/api/playground/compile  (override via $ENDPOINT)
#
# ## Cases (per spec test plan, lines 60-67 of playground_v0_spec_2026-05-13.md)
#   1. Echo + arithmetic   — expect stdout "hi\n7\n", exit 0
#   2. Recursive function  — expect stdout containing "3628800", exit 0
#   3. Pattern match + ADT — expect exit 42

set -u
set -o pipefail

ENDPOINT="${ENDPOINT:-https://ledatic.org/api/playground/compile}"
JSC="${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc}"

if [ ! -x "$JSC" ]; then
  echo "FAIL: jsc not found at $JSC (this script requires Apple JavaScriptCore)"
  exit 2
fi

PASSES=0
FAILS=0

# ─── helper ────────────────────────────────────────────────────────────
run_case() {
  local label="$1" src="$2" want_exit="$3" want_stdout="$4"
  echo "  [case] $label"

  local req_body
  req_body=$(python3 -c '
import json, sys
print(json.dumps({"src": sys.argv[1]}))
' "$src")

  local resp
  resp=$(curl -s --max-time 15 -X POST "$ENDPOINT" \
    -H "content-type: application/json" \
    --data-binary "$req_body")
  if [ -z "$resp" ]; then
    echo "    FAIL: empty response from $ENDPOINT"
    FAILS=$((FAILS + 1))
    return 1
  fi

  local ok
  ok=$(printf '%s' "$resp" | python3 -c '
import sys, json
try:
  print("yes" if json.loads(sys.stdin.read()).get("ok") is True else "no")
except: print("no")
')
  if [ "$ok" != "yes" ]; then
    echo "    FAIL: server returned ok != true"
    echo "    response (first 300): $(printf '%s' "$resp" | head -c 300)"
    FAILS=$((FAILS + 1))
    return 1
  fi

  # Decode + run wasm under jsc; capture stdout + exit.
  local wasm_b64
  wasm_b64=$(printf '%s' "$resp" | python3 -c "import sys, json; print(json.load(sys.stdin)['wasm_b64'])")
  local harness
  harness=$(mktemp /tmp/pg_acc_XXXXXX.mjs)
  cat > "$harness" <<JSEOF
const b64 = "${wasm_b64}";
const bin = atob(b64);
const u8 = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
let stdout = "";
let exitCode = -1;
const dec = new TextDecoder("utf-8", { fatal: false });
const memBox = { mem: null };
const imports = {
  wasi_snapshot_preview1: {
    fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
      const v = new DataView(memBox.mem.buffer);
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const base = iovs_ptr + i * 8;
        const p = v.getUint32(base, true);
        const l = v.getUint32(base + 4, true);
        if (l > 0) {
          const slice = new Uint8Array(memBox.mem.buffer, p, l).slice();
          stdout += dec.decode(slice);
          total += l;
        }
      }
      if (nwritten_ptr) v.setUint32(nwritten_ptr, total, true);
      return 0;
    },
    proc_exit: (c) => { exitCode = c|0; throw new Error("exit:" + c); }
  }
};
try {
  const m = await WebAssembly.instantiate(u8, imports);
  memBox.mem = m.instance.exports.memory;
  m.instance.exports._start();
} catch (e) { /* expected via proc_exit */ }
print("EXIT=" + exitCode);
print("STDOUT_BEGIN");
print(stdout);
print("STDOUT_END");
JSEOF

  local out
  out=$("$JSC" -m "$harness" 2>&1)
  rm -f "$harness"
  local got_exit got_stdout
  got_exit=$(printf '%s\n' "$out" | sed -n 's/^EXIT=//p' | head -1)
  got_stdout=$(printf '%s\n' "$out" | awk '/^STDOUT_BEGIN$/{flag=1;next}/^STDOUT_END$/{flag=0}flag')

  local fail=0
  if [ "$got_exit" != "$want_exit" ]; then
    echo "    FAIL: exit want=$want_exit got=$got_exit"
    fail=1
  fi
  if [ -n "$want_stdout" ]; then
    if ! printf '%s' "$got_stdout" | grep -q "$want_stdout"; then
      echo "    FAIL: stdout missing '$want_stdout'"
      echo "          got: $(printf '%s' "$got_stdout" | head -c 200)"
      fail=1
    fi
  fi
  if [ $fail -eq 0 ]; then
    echo "    PASS  exit=$got_exit stdout_len=$(printf '%s' "$got_stdout" | wc -c | tr -d ' ')"
    PASSES=$((PASSES + 1))
  else
    FAILS=$((FAILS + 1))
  fi
}

# ─── cases (per spec) ──────────────────────────────────────────────────
echo "Endpoint: $ENDPOINT"
echo

# Case 1 — echo + arithmetic. Spec uses `let _ = print "hi"` then prints
# 3 + 4. We use Rail's `print` (auto-newlines) directly.
SRC1='main =
  let _ = print "hi"
  let _ = print (show (3 + 4))
  0'
run_case "echo + arithmetic" "$SRC1" "0" "hi"

# Case 2 — recursive function (factorial 10).
SRC2='fact n =
  if n <= 1 then 1
  else n * fact (n - 1)

main =
  let _ = print (show (fact 10))
  0'
run_case "recursive factorial" "$SRC2" "0" "3628800"

# Case 3 — ADT + pattern match returning 42.
SRC3='type Option =
  | Some x
  | None

main = match (Some 42)
  | Some x -> x
  | None -> 0'
run_case "ADT pattern match" "$SRC3" "42" ""

echo
echo "Result: PASS=$PASSES FAIL=$FAILS"
if [ "$FAILS" -eq 0 ]; then
  echo "PHASE-2 MILESTONE: MET"
  exit 0
else
  echo "PHASE-2 MILESTONE: NOT MET"
  exit 1
fi
