#!/usr/bin/env bash
# gen_stats.sh — generate _shared/stats.json from the substrate.
#
# THE LAW (design spec §0 rule 1, §5.4): no human types a substrate number.
# This generator computes every managed stat and OWNS the single rounding
# rule for the binary size: SI megabytes, one decimal (1,193,744 B → "1.2 MB").
# The Figure injector in deploy.sh replaces <data class="fig"> text content
# from this file; the honesty gate bans the same literals outside <data>.
#
# Sources (per stat, recorded in the output):
#   repo:rail_native  git cat-file -s on origin/master:rail_native
#   repo:version      latest git tag (version sort)
#   repo:tags         git tag | wc -l
#   stdlib:modules    git ls-tree origin/master:stdlib (*.rail count)
#   tests:total       live attested build record (/attest/latest → result.json,
#                     pass/total), falling back to the "/N tests passed"
#                     literal in origin/master:tools/compile.rail
#   beacon:cadence    entropy beacon publish cadence (design constant ~2 s)
#
# Usage: tools/gen_stats.sh [output-path]   (default _shared/stats.json)
# Env:   RAIL_REPO (default ~/projects/rail), RAIL_REF (default origin/master)

set -euo pipefail

cd "$(dirname "$0")/.."

RAIL_REPO="${RAIL_REPO:-$HOME/projects/rail}"
RAIL_REF="${RAIL_REF:-origin/master}"
OUT="${1:-_shared/stats.json}"
SITE_ORIGIN="https://ledatic.org"

[ -d "$RAIL_REPO/.git" ] || { echo "gen_stats: no rail repo at $RAIL_REPO" >&2; exit 1; }

# ── Repo-derived stats (read-only against the rail repo) ────────────────
BIN_BYTES=$(git -C "$RAIL_REPO" cat-file -s "$(git -C "$RAIL_REPO" rev-parse "$RAIL_REF:rail_native")")
TAG_COUNT=$(git -C "$RAIL_REPO" tag | wc -l | tr -d ' ')
VERSION=$(git -C "$RAIL_REPO" tag --sort=-v:refname | head -1)
MODULES=$(git -C "$RAIL_REPO" ls-tree "$RAIL_REF:stdlib" | grep -c '\.rail$')

# ── Test count — attested build record first, source literal fallback ───
# The attested record is the honest source: it states pass/total as MEASURED
# by the build attestation pipeline, pulse-anchored. The fallback parses the
# declared suite size from the compiler source at the same ref as the binary.
TESTS_PASS="" TESTS_TOTAL="" TESTS_SOURCE="" TESTS_RECORD="" TESTS_PULSE=""
ATTEST_LATEST=$(curl -sf --max-time 8 "$SITE_ORIGIN/attest/latest" 2>/dev/null || true)
if [ -n "$ATTEST_LATEST" ]; then
  TESTS_RECORD=$(printf '%s' "$ATTEST_LATEST" | python3 -c \
    "import sys,json;d=json.load(sys.stdin);print((d.get('builds') or {}).get('record') or '')" 2>/dev/null || true)
fi
if [ -n "$TESTS_RECORD" ]; then
  REC=$(curl -sf --max-time 8 "$TESTS_RECORD" 2>/dev/null || true)
  if [ -n "$REC" ]; then
    TESTS_PASS=$(printf '%s' "$REC" | python3 -c \
      "import sys,json;d=json.load(sys.stdin);print(d.get('pass',''))" 2>/dev/null || true)
    TESTS_TOTAL=$(printf '%s' "$REC" | python3 -c \
      "import sys,json;d=json.load(sys.stdin);print(d.get('total',''))" 2>/dev/null || true)
    TESTS_PULSE=$(printf '%s' "$REC" | python3 -c \
      "import sys,json;d=json.load(sys.stdin);print(d.get('pulse_end',''))" 2>/dev/null || true)
    TESTS_SOURCE="attested build record $TESTS_RECORD (pass/total, pulse-anchored)"
  fi
fi
if [ -z "$TESTS_TOTAL" ]; then
  TESTS_TOTAL=$(git -C "$RAIL_REPO" show "$RAIL_REF:tools/compile.rail" \
    | grep -oE '/[0-9]+ tests passed' | grep -oE '[0-9]+' | head -1)
  TESTS_PASS="$TESTS_TOTAL"
  TESTS_SOURCE="declared suite size in $RAIL_REF:tools/compile.rail (\"/N tests passed\" literal); attested record unreachable"
fi
[ -n "$TESTS_TOTAL" ] || { echo "gen_stats: could not source test count" >&2; exit 1; }

# ── Current pulse (for data-pulse stamping on Figures) ──────────────────
PULSE_ID=$(curl -sf --max-time 8 "$SITE_ORIGIN/entropy/pulse" 2>/dev/null \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['pulse_id'])" 2>/dev/null || true)

# ── Emit JSON (python3 owns formatting: SI rounding + comma grouping) ───
BIN_BYTES="$BIN_BYTES" TAG_COUNT="$TAG_COUNT" VERSION="$VERSION" \
MODULES="$MODULES" TESTS_PASS="$TESTS_PASS" TESTS_TOTAL="$TESTS_TOTAL" \
TESTS_SOURCE="$TESTS_SOURCE" TESTS_PULSE="$TESTS_PULSE" PULSE_ID="$PULSE_ID" \
RAIL_REF="$RAIL_REF" OUT="$OUT" python3 <<'PYEOF'
import json, os, datetime

bin_bytes  = int(os.environ["BIN_BYTES"])
tags       = int(os.environ["TAG_COUNT"])
version    = os.environ["VERSION"]
modules    = int(os.environ["MODULES"])
t_pass     = int(os.environ["TESTS_PASS"])
t_total    = int(os.environ["TESTS_TOTAL"])
t_source   = os.environ["TESTS_SOURCE"]
t_pulse    = os.environ["TESTS_PULSE"]
pulse_id   = os.environ["PULSE_ID"]
ref        = os.environ["RAIL_REF"]

# THE rounding rule. SI megabytes (1 MB = 1,000,000 B), one decimal.
# 1,193,744 B → 1.2 MB. This function is the single owner; nothing else
# in the site pipeline may round the binary size.
def si_mb(b: int) -> str:
    return f"{b / 1_000_000:.1f} MB"

stats = {
    "repo:rail_native": {
        "value": bin_bytes,
        "display": si_mb(bin_bytes),
        "formats": {
            "mb": si_mb(bin_bytes),
            "approx_mb": "~" + si_mb(bin_bytes),
            "bytes": f"{bin_bytes:,}",
            "bytes_b": f"{bin_bytes:,} B",
        },
        "source": f"git cat-file -s {ref}:rail_native; SI MB, 1 decimal (rounding rule owned by gen_stats.sh)",
    },
    "repo:version": {
        "value": version,
        "display": version,
        "source": "latest rail git tag (version sort)",
    },
    "repo:tags": {
        "value": tags,
        "display": str(tags),
        "formats": {"count": str(tags), "tags": f"{tags} tags"},
        "source": "git tag | wc -l (rail repo)",
    },
    "tests:total": {
        "value": t_total,
        "pass": t_pass,
        "display": f"{t_pass}/{t_total}",
        "formats": {
            "ratio": f"{t_pass}/{t_total}",
            "count": str(t_total),
            "pass": str(t_pass),
        },
        "source": t_source,
        **({"attested_pulse": int(t_pulse)} if t_pulse else {}),
    },
    "stdlib:modules": {
        "value": modules,
        "display": str(modules),
        "formats": {"count": str(modules), "modules": f"{modules} modules"},
        "source": f"git ls-tree {ref}:stdlib | grep -c '.rail'",
    },
    "beacon:cadence": {
        "value": 2,
        "display": "~2 s",
        "formats": {"s": "~2 s", "words": "every ~2 s"},
        "source": "entropy beacon publish cadence (design constant; the pulse clock measures the real interval at runtime)",
    },
}

out = {
    "kind": "ledatic.site.stats",
    "version": 1,
    "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "pulse_id": int(pulse_id) if pulse_id else None,
    "rail_ref": ref,
    "notes": "Generated by tools/gen_stats.sh — no human types these numbers. "
             "Figure injector (deploy.sh) writes them into <data class=\"fig\"> elements; "
             "tools/honesty_gate.sh bans the same literals outside <data>.",
    "stats": stats,
}

path = os.environ["OUT"]
with open(path, "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"gen_stats: wrote {path}")
for k, v in stats.items():
    print(f"  {k:18s} = {v['display']}")
PYEOF
