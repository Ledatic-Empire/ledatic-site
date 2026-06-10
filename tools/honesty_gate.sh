#!/usr/bin/env bash
# honesty_gate.sh — the honesty CI gate (design spec §5.4). Blocks deploys.
#
# Rules enforced (nonzero exit on any violation):
#   R1  Managed-stat literal in HTML outside a <data> element. The registry
#       (current version, test count, module count, binary byte/MB size, tag
#       count, cadence) is built dynamically from _shared/stats.json plus
#       known drift values (141, 140, 1.1 MB...). Prose allowlist:
#       tools/honesty_allowlist.txt ("glob|ERE" per line) exempts legitimate
#       lines (years, RFC numbers, "2-pass" never matched in the first place).
#   R2  Unresolved Figure: <data class="fig"> whose data-src is missing or
#       not in the stats.json registry, or a fig element split across lines
#       (contract: one line).
#   R3  Token law: literal LIVE / "live ·" indicator copy, data-state="live",
#       --e3 or a glow-top class authored in HTML (sentinel JS only may set
#       these). CSS may DEFINE the tokens; generated `content: "live"` fails.
#   R4  Tense rot: current/this-week language within 200 chars of a closed
#       engagement name (DDA). Closed work renders past-tense only.
#   R5  Internal plumbing on a public surface: mesh-VPN vendor names, CGNAT
#       100.x.x.x / 10.42.0.x IPs, internal ports, fleet auth header names,
#       LLM model/vendor names, node hostnames, operator paths.
#
# Scope: every file deploy.sh uploads — *.html at repo root, _shared CSS/JS,
# shaders. worker/ and tools/ are server/operator side, not scanned.
#
# Usage: tools/honesty_gate.sh        (from anywhere; cds to repo root)
# Exit:  0 clean · 1 violations · 2 missing prerequisites

set -uo pipefail

cd "$(dirname "$0")/.."

STATS="_shared/stats.json"
ALLOWLIST="tools/honesty_allowlist.txt"
[ -f "$STATS" ] || { echo "honesty_gate: $STATS missing — run tools/gen_stats.sh first" >&2; exit 2; }
[ -f "$ALLOWLIST" ] || { echo "honesty_gate: $ALLOWLIST missing" >&2; exit 2; }

HTML_FILES=$(ls ./*.html 2>/dev/null)
ASSET_FILES=$(ls ./_shared/*.css ./_shared/*.js ./_shared/shaders/*.frag 2>/dev/null)
[ -n "$HTML_FILES" ] || { echo "honesty_gate: no HTML files found" >&2; exit 2; }

VIOLATIONS=0

SEEN=""
violate() { # rule, file:line, text — dedupes repeat hits on the same line
  case "$SEEN" in *"|$1@$2|"*) return ;; esac
  SEEN="$SEEN|$1@$2|"
  echo "FAIL [$1] $2: $3"
  VIOLATIONS=$((VIOLATIONS + 1))
}

# ── Allowlist: "glob|ERE" lines; a hit is exempt when its path matches the
#    glob AND the line content matches the ERE. '#' comments + blanks ok. ──
allowlisted() { # $1=path  $2=line-content
  local path="$1" content="$2" glob re
  while IFS='|' read -r glob re; do
    case "$glob" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2254
    case "$path" in
      $glob) if printf '%s' "$content" | grep -qE "$re"; then return 0; fi ;;
    esac
  done < "$ALLOWLIST"
  return 1
}

# ── Registry values from stats.json (dynamic — the gate tracks the
#    substrate; when the suite grows, the ban grows with it). ─────────────
eval "$(python3 - "$STATS" <<'PYEOF'
import json, sys, re
d = json.load(open(sys.argv[1]))["stats"]
ver = re.escape(d["repo:version"]["value"])
tests = d["tests:total"]["value"]
bts = str(d["repo:rail_native"]["value"])
# 1193744 -> 1,?193,?744 (matches with or without comma grouping)
parts = []
head = len(bts) % 3 or 3
parts.append(bts[:head])
for i in range(head, len(bts), 3):
    parts.append(bts[i:i+3])
bytes_re = ",?".join(parts)
print(f"REG_VERSION='{ver}'")
print(f"REG_TESTS='{tests}'")
print(f"REG_BYTES='{bytes_re}'")
print(f"REG_MODULES='{d['stdlib:modules']['value']}'")
print(f"REG_TAGS='{d['repo:tags']['value']}'")
PYEOF
)"

# Known drift values ride along with the live ones: a page hand-typing last
# year's number is exactly the lie this gate exists to catch. The trailing
# guard ([^%0-9]|$) skips SVG/CSS percentages like width="140%".
P_VERSION="${REG_VERSION}"
P_TESTS="\b(${REG_TESTS}|141|140)\b([^%0-9]|$)"
P_BYTES="\b(${REG_BYTES})\b"
P_MB="\b1\.[0-9] ?MB\b"
P_MODULES="(>[[:space:]]*${REG_MODULES}[[:space:]]*<|\b${REG_MODULES}\b[^0-9A-Za-z]{0,4}[Ss]tdlib|\b${REG_MODULES}\b[^0-9A-Za-z]{0,4}[Mm]odule|[Ss]tdlib[^0-9]{0,16}\b${REG_MODULES}\b|[Mm]odule[s]?[^0-9]{0,16}\b${REG_MODULES}\b)"
P_TAGS="(>[[:space:]]*${REG_TAGS}[[:space:]]*<|\b${REG_TAGS} ?tag(s|ged)?\b|tag(s|ged)?[^0-9]{0,12}\b${REG_TAGS}\b|[Ff]orty[- ]five)"
P_CADENCE="(~ ?2 ?s\b|every two seconds|every ~?2 ?seconds|2 ?s cadence)"

R1_PATTERNS=("$P_VERSION" "$P_TESTS" "$P_BYTES" "$P_MB" "$P_MODULES" "$P_TAGS" "$P_CADENCE")

# ── R1: managed literals outside <data> ──────────────────────────────────
for f in $HTML_FILES; do
  rel="${f#./}"
  # Strip complete single-line <data>…</data> spans, then scan what's left.
  stripped=$(sed -E 's|<data[^>]*>[^<]*</data>||g' "$f")
  for pat in "${R1_PATTERNS[@]}"; do
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      lineno="${hit%%:*}"
      content="${hit#*:}"
      if ! allowlisted "$rel" "$content"; then
        violate "R1 managed-stat outside <data>" "$rel:$lineno" "$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//' | cut -c1-110)"
      fi
    done < <(printf '%s\n' "$stripped" | grep -nE "$pat" || true)
  done
done

# ── R2: unresolved / malformed Figures ───────────────────────────────────
KNOWN_KEYS=$(python3 -c "import json;print(' '.join(json.load(open('$STATS'))['stats'].keys()))")
for f in $HTML_FILES; do
  rel="${f#./}"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"
    content="${hit#*:}"
    # fig element must close on its own line (injector + gate are line-wise)
    if ! printf '%s' "$content" | grep -q '</data>'; then
      violate "R2 fig <data> not closed on one line" "$rel:$lineno" "$(printf '%.110s' "$content")"
      continue
    fi
    src=$(printf '%s' "$content" | grep -oE 'data-src="[^"]*"' | head -1 | sed -E 's/data-src="([^"]*)"/\1/')
    if [ -z "$src" ]; then
      violate "R2 fig <data> missing data-src" "$rel:$lineno" "$(printf '%.110s' "$content")"
    else
      case " $KNOWN_KEYS " in
        *" $src "*) : ;;
        *) violate "R2 unresolved Figure data-src=\"$src\"" "$rel:$lineno" "$(printf '%.110s' "$content")" ;;
      esac
    fi
  done < <(grep -nE '<data[^>]*class="[^"]*\bfig\b' "$f" || true)
done

# ── R3: token law — earned glow / LIVE are JS-set only ───────────────────
R3_HTML='(>[[:space:]]*LIVE[[:space:]]*<|\blive (·|&middot;)|data-state="live"|--e3\b|class="[^"]*\bglow-top\b)'
for f in $HTML_FILES; do
  rel="${f#./}"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"; content="${hit#*:}"
    if ! allowlisted "$rel" "$content"; then
      violate "R3 authored liveness (JS-set only)" "$rel:$lineno" "$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//' | cut -c1-110)"
    fi
  done < <(grep -nE "$R3_HTML" "$f" || true)
done
for f in ./_shared/*.css; do
  [ -f "$f" ] || continue
  rel="${f#./}"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"; content="${hit#*:}"
    violate "R3 CSS generated liveness" "$rel:$lineno" "$(printf '%.110s' "$content")"
  done < <(grep -nE '(content:[[:space:]]*["'"'"'][[:space:]]*live|\bglow-top\b)' "$f" || true)
done

# ── R4: tense rot near closed engagements (200-char window, cross-line) ──
R4_OUT=$(python3 - $HTML_FILES <<'PYEOF'
import re, sys
closed = re.compile(r'\bDDA\b|Drive Digital', re.I)
tense = re.compile(r'\bcurrent(ly)?\b|\bthis week\b', re.I)
for path in sys.argv[1:]:
    text = open(path).read()
    for m in closed.finditer(text):
        lo, hi = max(0, m.start() - 200), m.end() + 200
        window = text[lo:hi]
        t = tense.search(window)
        if t:
            line = text.count("\n", 0, m.start()) + 1
            snip = " ".join(window[max(0, t.start()-40):t.end()+40].split())
            print(f"{path.lstrip('./')}:{line}: '{t.group(0)}' within 200 chars of '{m.group(0)}' … {snip[:90]}")
PYEOF
)
if [ -n "$R4_OUT" ]; then
  while IFS= read -r line; do
    violate "R4 tense rot near closed engagement" "${line%%:*}:${line#*:}" ""
  done <<< "$R4_OUT"
fi

# ── R5: internal plumbing strings on public surfaces ─────────────────────
R5_PATTERNS=(
  '[Tt]ail[s]cale'
  '\b100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b10\.42\.0\.[0-9]{1,3}\b'
  ':(9101|8443|8444|8445|5590|8081|8080)\b'
  '[Xx]-[Ff]leet-[Tt]oken|[Xx]-[Bb]eacon-[Tt]oken|[Xx]-[Ll]akes-[Tt]oken'
  # Internal-stack model names are plumbing. Vendor names in comparative or
  # capability copy ("No OpenAI API", "TLS client live against Anthropic's
  # public API") are legitimate claims and stay allowed.
  '\b([Qq]wen|[Gg]emma|[Jj]osiefied|[Ll]lama-?[0-9]|[Mm]istral|[Cc]laude|GPT-[0-9])\b'
  'studio\.local|mini\.local|\bfleet_agent\b|launchctl|LaunchAgent|LaunchDaemon'
  'localhost:[0-9]+|127\.0\.0\.1'
  '~/\.(fleet|ledatic)\b'
)
for f in $HTML_FILES $ASSET_FILES; do
  rel="${f#./}"
  for pat in "${R5_PATTERNS[@]}"; do
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      lineno="${hit%%:*}"; content="${hit#*:}"
      if ! allowlisted "$rel" "$content"; then
        violate "R5 internal plumbing" "$rel:$lineno" "$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//' | cut -c1-110)"
      fi
    done < <(grep -nE "$pat" "$f" || true)
  done
done

# ── Verdict ──────────────────────────────────────────────────────────────
if [ "$VIOLATIONS" -gt 0 ]; then
  echo "honesty_gate: $VIOLATIONS violation(s) — deploy blocked." >&2
  exit 1
fi
echo "honesty_gate: clean ($(echo "$HTML_FILES" | wc -w | tr -d ' ') pages, $(echo "$ASSET_FILES" | wc -w | tr -d ' ') assets)."
