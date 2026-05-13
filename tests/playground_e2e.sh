#!/usr/bin/env bash
# tests/playground_e2e.sh — Session B end-to-end test for the public Rail
# playground. Local-only; no production deploy.
#
# What it does:
#   1. Builds tools/playground/compile_server.rail in the rail repo.
#   2. Starts tools/http_server.py on a free port (default 8765).
#   3. POSTs each test case via curl to the local compile_server, then
#      drives the SAME _shared/rail_playground.js shim that the browser
#      uses (via Apple JavaScriptCore — same WebKit engine as Safari)
#      to instantiate the returned WASM and run it. Asserts:
#        (a) main = 42                          → exit 42, no stdout
#        (b) main = let _ = print "hi" in 0     → stdout "hi\n", exit 0
#        (c) shell "rm -rf /"                   → sanitize-rejected
#   4. Tears down the server, prints PASS / FAIL, exits with a count.
#
# Why JSC: no node on this Studio. JSC exposes WebAssembly + TextDecoder
# + DataView + Map exactly like Safari, so the browser code path is
# faithfully exercised. POST + base64 are done in shell since JSC has
# neither fetch nor a system bridge.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAIL_ROOT="${RAIL_ROOT:-/Users/user/projects/rail}"
PORT="${PORT:-8765}"
JSC="${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc}"
SHIM="${REPO_ROOT}/_shared/rail_playground.js"

if [ ! -x "$JSC" ]; then
  echo "FAIL: jsc not found at $JSC"
  exit 2
fi
if [ ! -f "$SHIM" ]; then
  echo "FAIL: shim not found at $SHIM"
  exit 2
fi
if [ ! -d "$RAIL_ROOT" ]; then
  echo "FAIL: RAIL_ROOT not a directory: $RAIL_ROOT"
  exit 2
fi
if [ ! -x "$RAIL_ROOT/rail_native" ]; then
  echo "FAIL: $RAIL_ROOT/rail_native not executable"
  exit 2
fi

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── 1. build compile_server.rail ────────────────────────────────────
echo "[1/5] Building compile_server.rail..."
( cd "$RAIL_ROOT" && ./rail_native tools/playground/compile_server.rail >/tmp/pg_build.log 2>&1 )
BUILD_EC=$?
if [ $BUILD_EC -ne 0 ]; then
  echo "FAIL: build_compile_server (exit $BUILD_EC)"
  tail -5 /tmp/pg_build.log
  exit 3
fi
cp /tmp/rail_out /tmp/rail_pg_handler
chmod +x /tmp/rail_pg_handler

# ── 2. start http_server.py ─────────────────────────────────────────
echo "[2/5] Starting compile_server on :$PORT..."
( cd "$RAIL_ROOT" && python3 tools/http_server.py "$PORT" /tmp/rail_pg_handler >/tmp/pg_server.log 2>&1 ) &
SERVER_PID=$!
# Wait for the listening line.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q "Rail HTTP server" /tmp/pg_server.log 2>/dev/null; then
    break
  fi
  sleep 0.3
done
if ! grep -q "Rail HTTP server" /tmp/pg_server.log 2>/dev/null; then
  echo "FAIL: server didn't start"
  cat /tmp/pg_server.log
  exit 4
fi
echo "      pid=$SERVER_PID"

# ── 3. helper: drive the shim with a pre-fetched JSON response ──────
# Usage: run_case <label> <src> <expected-kind> <expected-stdout-substr> <expected-exit>
# The fetchFn override returns the prefetched JSON without hitting
# the network; this lets us reuse runRailSource() unchanged.
run_case() {
  local label="$1" src="$2" want_kind="$3" want_stdout="$4" want_exit="$5"
  echo "      [case] $label"
  # POST via curl; capture HTTP status + body separately.
  local req_body
  req_body=$(printf '%s' "$src" | python3 -c '
import json, sys
print(json.dumps({"src": sys.stdin.read()}))
')
  local resp
  resp=$(curl -s -X POST "http://127.0.0.1:$PORT/api/playground/compile" \
    -H "content-type: application/json" \
    --data-binary "$req_body" 2>/dev/null)
  if [ -z "$resp" ]; then
    echo "        FAIL: empty response"
    return 1
  fi

  # Hand off to jsc. The harness reads the JSON from a file (so we don't
  # have to escape it for a -e argument), loads the shim as a module,
  # and asserts.
  local resp_file
  resp_file=$(mktemp /tmp/pg_resp_XXXXXX.json)
  printf '%s' "$resp" > "$resp_file"

  # JS-string-literal-encode the source so it survives heredoc + the JSC parser.
  local ESCAPED_SRC_JS
  ESCAPED_SRC_JS=$(python3 -c "
import json, sys
print(json.dumps(sys.argv[1]))
" "$src")
  local harness
  harness=$(mktemp /tmp/pg_harness_XXXXXX.mjs)
  cat > "$harness" <<JSEOF
import { runRailSource } from '${SHIM}';
const respText = readFile('${resp_file}');
const respJson = JSON.parse(respText);
const result = await runRailSource(${ESCAPED_SRC_JS}, {
  fetchFn: async () => ({ httpStatus: 200, json: respJson }),
  timeoutMs: 4000,
});
print('KIND=' + result.kind);
print('EXIT=' + (result.exit !== undefined ? result.exit : '-'));
print('STDOUT_LEN=' + ((result.stdout || '').length));
print('STDOUT_BEGIN');
print(result.stdout || '');
print('STDOUT_END');
print('REASON=' + (result.reason || ''));
JSEOF

  local out
  out=$("$JSC" -m "$harness" 2>&1)
  rm -f "$harness" "$resp_file"

  local got_kind got_exit got_stdout
  got_kind=$(printf '%s\n' "$out" | sed -n 's/^KIND=//p' | head -1)
  got_exit=$(printf '%s\n' "$out" | sed -n 's/^EXIT=//p' | head -1)
  got_stdout=$(printf '%s\n' "$out" | awk '/^STDOUT_BEGIN$/{flag=1;next}/^STDOUT_END$/{flag=0}flag')

  local fail=0
  if [ "$got_kind" != "$want_kind" ]; then
    echo "        FAIL: kind want=$want_kind got=$got_kind"
    echo "        --- jsc output ---"
    printf '%s\n' "$out" | sed 's/^/        /'
    fail=1
  fi
  if [ -n "$want_exit" ] && [ "$got_exit" != "$want_exit" ]; then
    echo "        FAIL: exit want=$want_exit got=$got_exit"
    fail=1
  fi
  if [ -n "$want_stdout" ]; then
    if ! printf '%s' "$got_stdout" | grep -q "$want_stdout"; then
      echo "        FAIL: stdout missing '$want_stdout' (got: $(printf '%s' "$got_stdout" | head -c 200))"
      fail=1
    fi
  fi
  if [ $fail -eq 0 ]; then
    echo "        PASS  kind=$got_kind exit=$got_exit stdout_len=$(printf '%s' "$got_stdout" | wc -c | tr -d ' ')"
  fi
  return $fail
}

# ── 4. run the cases ────────────────────────────────────────────────
echo "[3/5] Running cases..."
PASSES=0
FAILS=0

if run_case "main=42" "main = 42" "ok" "" "42"; then
  PASSES=$((PASSES + 1))
else
  FAILS=$((FAILS + 1))
fi

if run_case "print-hi" 'main = let _ = print "hi" in 0' "ok" "hi" "0"; then
  PASSES=$((PASSES + 1))
else
  FAILS=$((FAILS + 1))
fi

if run_case "sanitize-shell" 'main = let _ = shell "rm -rf /" in 0' "sanitize-rejected" "" ""; then
  PASSES=$((PASSES + 1))
else
  FAILS=$((FAILS + 1))
fi

# ── 5. additional sanity: served HTML well-formed ───────────────────
echo "[4/5] Smoke: playground.html shape..."
if grep -q '_shared/rail_playground.js' "$REPO_ROOT/playground.html" \
   && grep -q '<textarea[^>]*id="editor"' "$REPO_ROOT/playground.html" \
   && grep -q 'id="run-btn"' "$REPO_ROOT/playground.html"; then
  echo "      PASS  playground.html references shim + has editor + run button"
  PASSES=$((PASSES + 1))
else
  echo "      FAIL  playground.html missing critical elements"
  FAILS=$((FAILS + 1))
fi

# ── 6. summary ──────────────────────────────────────────────────────
echo "[5/5] Summary: PASS=$PASSES FAIL=$FAILS"
echo
echo "      server log:"
tail -20 /tmp/pg_server.log | sed 's/^/        /'

if [ "$FAILS" -eq 0 ]; then
  echo "      RESULT: PASS"
  exit 0
else
  echo "      RESULT: FAIL"
  exit 1
fi
