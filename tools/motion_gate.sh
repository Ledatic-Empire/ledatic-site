#!/usr/bin/env bash
# motion_gate.sh: run the motion gate (tools/motion_gate.py) the way deploy.sh does.
#
# The gate needs Playwright, which lives in this repo's own venv (gitignored):
#   python3 -m venv .venv && .venv/bin/pip install playwright
# (the browsers are shared from the Playwright cache; the techsix venv installed them).
#
#   tools/motion_gate.sh            # quick: the local tree, home at 1440, with the live beacon passed through
#   tools/motion_gate.sh --full     # every page, both widths, all four modes, throttled R6/R8 (about 5 min)
#   tools/motion_gate.sh --live     # the same against https://ledatic.org instead of the local tree
#
# Exit: 0 clean, 1 a check failed, 3 the gate could not run (no venv, no browser). A gate that
# cannot run fails loud; it never reports PASS it did not measure.
set -uo pipefail
cd "$(dirname "$0")/.."
PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "motion_gate: no .venv with playwright here (python3 -m venv .venv && .venv/bin/pip install playwright)" >&2
  exit 3
fi
mode=quick; target=""
for a in "$@"; do
  case "$a" in
    --full) mode=full ;;
    --live) target="--base https://ledatic.org" ;;
    *) echo "motion_gate: unknown flag $a" >&2; exit 3 ;;
  esac
done
out="/tmp/motion-gate-$(date +%Y-%m-%d_%H%M)"
if [ "$mode" = quick ]; then
  # shellcheck disable=SC2086
  "$PY" tools/motion_gate.py --quick --out "$out" $target
else
  # shellcheck disable=SC2086
  "$PY" tools/motion_gate.py --out "$out" $target
fi
rc=$?
[ $rc -eq 2 ] && exit 3
exit $rc
