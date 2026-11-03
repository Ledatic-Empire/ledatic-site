#!/usr/bin/env bash
# deploy.sh's prune step (6b), with curl replaced: nothing reaches Cloudflare.
# Run: tests/deploy_prune_test.sh [deploy.sh]   (exit 1 on any miss)
# The function is cut out of the deploy.sh given (default: the repo's) and run
# against made-up manifests; a fake curl on PATH records every DELETE and
# answers success or failure as the case asks. The live path (a full deploy
# after a file leaves the repo) is the proof this cannot give.
set -uo pipefail
cd "$(dirname "$0")/.."
DEPLOY=${1:-deploy.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0

sed -n '/^PRUNE_MAX=/,/^PRUNE_REFUSED=0$/p; /^prune_removed() {$/,/^}$/p' "$DEPLOY" > "$T/prune.sh"
grep -q '^prune_removed() {' "$T/prune.sh" || { echo "FAIL: no prune_removed in $DEPLOY"; exit 1; }

mkdir -p "$T/bin"
cat > "$T/bin/curl" <<'SH'
#!/bin/sh
for a; do last=$a; done
echo "$last" >> "$FAKE_LOG"
if [ "${FAKE_FAIL:-0}" = 1 ]; then echo '{"success":false,"errors":[{"code":10000}]}'; else echo '{"success":true}'; fi
SH
chmod +x "$T/bin/curl"

# case <name> <prev keys> <staged keys> <want deleted, space separated or -> <want refused 0|1> [env]
case_() {
  local name=$1 prev=$2 staged=$3 want=$4 wantref=$5 env=${6:-}
  : > "$T/log"
  printf '%s\n' $prev | sed '/^$/d; s/$/\tsha/' > "$T/prev"
  printf '%s\n' $staged | sed '/^$/d; s/$/\tsha\t1/' > "$T/staged"
  out=$(env $env PATH="$T/bin:$PATH" FAKE_LOG="$T/log" PREV_SHA_FILE="$T/prev" MANIFEST_TSV="$T/staged" \
        CF_TOKEN=x CF_ACCOUNT=acct CF_KV_NS=ns PREV_N=7 bash -c ". '$T/prune.sh'; prune_removed; echo \"REFUSED=\$PRUNE_REFUSED PRUNED=\$PRUNED\"" 2>&1)
  got=$(sed 's#.*/values/##' "$T/log" | tr '\n' ' ' | sed 's/ $//')
  [ -n "$got" ] || got=-
  ref=$(printf '%s\n' "$out" | sed -n 's/^REFUSED=\([01]\).*/\1/p')
  if [ "$got" != "$want" ] || [ "$ref" != "$wantref" ]; then
    echo "FAIL $name: deleted '$got' (want '$want'), refused $ref (want $wantref)"
    printf '%s\n' "$out" | sed 's/^/     /'
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

case_ "a file left the repo"        "a.html b.html rail/docs/jit.html" "a.html b.html" "rail/docs/jit.html" 0
case_ "nothing left"                "a.html b.html" "a.html b.html c.html" - 0
case_ "no previous manifest"        "" "a.html" - 0
many=$(seq -f 'gone%g.html' 1 21 | tr '\n' ' ')
case_ "21 gone: refused, none deleted" "a.html $many" "a.html" - 1
case_ "21 gone, cap raised to 30"   "a.html $many" "a.html" "$(printf '%s\n' $many | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" 0 DEPLOY_PRUNE_MAX=30
case_ "a delete fails: refused"     "a.html b.html" "a.html" "b.html" 1 FAKE_FAIL=1

# A refused prune must stop the run before the manifest is signed, or the next
# run's previous manifest no longer names the keys and they serve forever.
main=$(sed -n '/^# ── Main/,$p' "$DEPLOY")
order=$(printf '%s\n' "$main" | grep -nE '^  prune_removed$|^    exit 6$|^    publish_signed_manifest$' | cut -d: -f2 | tr -d ' ' | tr '\n' ' ')
if [ "$order" = "prune_removed exit6 publish_signed_manifest " ]; then
  echo "ok   a refused prune exits before the manifest is signed"
else
  echo "FAIL order in main: '$order'"; fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails FAILED"
exit $(( fails > 0 ))
