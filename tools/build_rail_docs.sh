#!/usr/bin/env bash
# Build static HTML for Rail docs from $HOME/projects/rail/docs/site/*.md
# Outputs to $HOME/projects/ledatic-site/rail/docs/*.html
# Deploy keys then become "rail/docs/<name>.html" → served at /rail/docs/<name>.

set -euo pipefail

SRC=$HOME/projects/rail/docs/site
OUT=$HOME/projects/ledatic-site/rail/docs

mkdir -p "$OUT" "$OUT/examples"

# md_to_body: emit just the <body> inner HTML for a markdown file.
md_to_body() {
  awk '
    BEGIN { in_code=0; in_list=0; in_para=0 }
    function esc(s) { gsub(/&/,"\\&amp;",s); gsub(/</,"\\&lt;",s); gsub(/>/,"\\&gt;",s); return s }
    function inline(s) {
      # backtick code first (greedy match per token)
      while (match(s, /`[^`]+`/)) {
        c = substr(s, RSTART+1, RLENGTH-2)
        s = substr(s, 1, RSTART-1) "<code>" esc(c) "</code>" substr(s, RSTART+RLENGTH)
      }
      # links [text](url)
      while (match(s, /\[[^]]+\]\([^)]+\)/)) {
        seg = substr(s, RSTART, RLENGTH)
        sub(/^\[/, "", seg); sub(/\]\(/, "\x01", seg); sub(/\)$/, "", seg)
        split(seg, parts, "\x01")
        s = substr(s, 1, RSTART-1) "<a href=\"" parts[2] "\">" parts[1] "</a>" substr(s, RSTART+RLENGTH)
      }
      gsub(/\*\*([^*]+)\*\*/, "<strong>\\1</strong>", s)
      return s
    }
    function flush_para() { if (in_para) { print "</p>"; in_para=0 } }
    function flush_list() { if (in_list) { print "</ul>"; in_list=0 } }

    /^```/ {
      flush_para(); flush_list()
      if (in_code) { print "</code></pre>"; in_code=0 }
      else { lang = $0; sub(/^```/, "", lang); print "<pre><code class=\"lang-" lang "\">"; in_code=1 }
      next
    }
    in_code { print esc($0); next }
    /^# /  { flush_para(); flush_list(); s=$0; sub(/^# /, "", s);  print "<h1>" inline(s) "</h1>"; next }
    /^## / { flush_para(); flush_list(); s=$0; sub(/^## /, "", s); print "<h2>" inline(s) "</h2>"; next }
    /^### /{ flush_para(); flush_list(); s=$0; sub(/^### /,"", s); print "<h3>" inline(s) "</h3>"; next }
    /^- / || /^\* / {
      flush_para()
      if (!in_list) { print "<ul>"; in_list=1 }
      s=$0; sub(/^[-*] /, "", s); print "<li>" inline(s) "</li>"; next
    }
    /^> / { flush_para(); flush_list(); s=$0; sub(/^> /, "", s); print "<blockquote>" inline(s) "</blockquote>"; next }
    /^---+$/ { flush_para(); flush_list(); print "<hr>"; next }
    /^$/ { flush_para(); flush_list(); next }
    {
      flush_list()
      if (!in_para) { print "<p>"; in_para=1 }
      print inline($0)
    }
    END { flush_para(); flush_list(); if (in_code) print "</code></pre>" }
  ' "$1"
}

html_wrap() {
  local title="$1" body_file="$2" rel_root="$3"
  cat <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Rail Docs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
body { margin:0; background:#0b0b0c; color:#dcdcde; font-family:'Sora',system-ui,sans-serif; }
nav.topnav { display:flex; align-items:center; justify-content:space-between; padding:1rem 2rem; border-bottom:1px solid #222; background:#0b0b0c; position:sticky; top:0; z-index:10; }
nav.topnav .logo { color:#dcdcde; text-decoration:none; font-weight:600; font-size:1.05rem; }
nav.topnav .accent { color:#9b6bff; }
nav.topnav .navlinks a { color:#9095a0; text-decoration:none; margin:0 .8rem; font-size:.95rem; }
nav.topnav .navlinks a.active, nav.topnav .navlinks a:hover { color:#fff; }
nav.topnav .nav-cta { color:#9b6bff; border:1px solid #9b6bff; padding:.35rem .8rem; border-radius:.3rem; text-decoration:none; font-size:.9rem; }
main { max-width:820px; margin:2rem auto; padding:0 1.5rem 4rem; line-height:1.65; }
main h1, main h2, main h3 { font-weight:600; line-height:1.25; }
main h1 { font-size:2rem; margin:1.5rem 0 1rem; border-bottom:1px solid #222; padding-bottom:.4rem; }
main h2 { font-size:1.4rem; margin:2rem 0 .8rem; color:#fff; }
main h3 { font-size:1.1rem; margin:1.6rem 0 .5rem; color:#cfd0d4; }
main p { margin:.7rem 0; color:#c2c4ca; }
main a { color:#a98bff; text-decoration:none; border-bottom:1px solid #9b6bff44; }
main a:hover { border-bottom-color:#9b6bff; color:#cdb8ff; }
main code { font-family:'IBM Plex Mono',ui-monospace,monospace; font-size:.92em; background:#1a1a1d; color:#e0d0ff; padding:.1em .35em; border-radius:.25em; }
main pre { background:#121214; border:1px solid #1f1f23; border-left:3px solid #9b6bff; padding:1rem 1.2rem; overflow-x:auto; border-radius:.4rem; margin:1.2rem 0; }
main pre code { background:transparent; padding:0; color:#dcdcde; font-size:.88em; line-height:1.55; }
main ul { padding-left:1.6rem; color:#c2c4ca; }
main li { margin:.25rem 0; }
main blockquote { border-left:3px solid #444; padding:.3rem 1rem; color:#9aa; margin:1rem 0; background:#0e0e10; }
main hr { border:none; border-top:1px solid #222; margin:2rem 0; }
.docfooter { max-width:820px; margin:3rem auto 1rem; padding:0 1.5rem; color:#666; font-size:.85rem; border-top:1px solid #1c1c1f; padding-top:1.5rem; }
.docfooter a { color:#888; }
</style>
</head>
<body>
<nav class="topnav">
  <a class="logo" href="/">Ledatic<span class="accent"> /</span></a>
  <div class="navlinks">
    <a href="/rail.html">Rail</a>
    <a href="/rail/docs/" class="active">Docs</a>
    <a href="/plasma.html">Plasma</a>
    <a href="/fleet.html">Fleet</a>
  </div>
  <a class="nav-cta" href="https://github.com/zemo-g/rail" target="_blank" rel="noopener">Source</a>
</nav>
<main>
HTML
  cat "$body_file"
  cat <<HTML
</main>
<div class="docfooter">
  Rail — self-hosted compiler · <a href="/rail/docs/">All docs</a> · <a href="https://github.com/zemo-g/rail">GitHub</a>
</div>
</body>
</html>
HTML
}

# Build top-level pages
for md in "$SRC"/*.md; do
  name=$(basename "$md" .md)
  [ "$name" = "TODO" ] && continue
  title=$(head -1 "$md" | sed 's/^# *//')
  body=$(mktemp)
  md_to_body "$md" > "$body"
  html_wrap "$title" "$body" "" > "$OUT/$name.html"
  rm -f "$body"
  echo "wrote $OUT/$name.html"
done

# Build examples
for md in "$SRC"/examples/*.md; do
  name=$(basename "$md" .md)
  title=$(head -1 "$md" | sed 's/^# *//')
  body=$(mktemp)
  md_to_body "$md" > "$body"
  html_wrap "$title" "$body" "../" > "$OUT/examples/$name.html"
  rm -f "$body"
  echo "wrote $OUT/examples/$name.html"
done

# Index page: rewrite index.html to point to .html siblings, and link to all examples.
# index.md is already written with .md links; we need to swap .md → .html in the index.
sed -i.bak 's|\.md)|\.html)|g; s|\.md"|\.html"|g' "$OUT/index.html" && rm -f "$OUT/index.html.bak"
sed -i.bak 's|\.md)|\.html)|g; s|\.md"|\.html"|g' "$OUT/quickstart.html" && rm -f "$OUT/quickstart.html.bak"
sed -i.bak 's|\.md)|\.html)|g; s|\.md"|\.html"|g' "$OUT/backends.html" && rm -f "$OUT/backends.html.bak"
sed -i.bak 's|\.md)|\.html)|g; s|\.md"|\.html"|g' "$OUT/stdlib.html" && rm -f "$OUT/stdlib.html.bak"

# Examples index
{
  cat <<HTML
<h1>Rail Examples</h1>
<p>Twenty-two runnable programs, each verified end-to-end. Pick one and read the source — that is the fastest way to learn Rail.</p>
<ul>
HTML
  for md in "$SRC"/examples/*.md; do
    name=$(basename "$md" .md)
    title=$(head -1 "$md" | sed 's/^# *//')
    echo "  <li><a href=\"examples/${name}.html\">${title}</a> — <code>${name}</code></li>"
  done
  echo "</ul>"
} > /tmp/examples_index_body.html
html_wrap "Examples" /tmp/examples_index_body.html "" > "$OUT/examples/index.html"
echo "wrote $OUT/examples/index.html"

# Top-level index (already exists from index.md, but add examples link)
echo "build complete. Output: $OUT"
ls -la "$OUT"
