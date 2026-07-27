#!/usr/bin/env python3
"""citation_gate.py — the citation gate. Blocks deploys.

The honesty gate (tools/honesty_gate.sh) proves that every managed NUMBER on
this site came from the substrate rather than someone's memory. It has nothing
to say about the other half of the promise: the site does not merely state
facts, it hands visitors things to *press* and *run* — prove buttons, cited
provenance URLs, published curl recipes. Those are claims too, and until now
nothing checked them.

They rot. All three of these were live on 2026-07-25:

  * _shared/stats.json cited /builds/<sha>/result.json as the provenance for
    the test count. That URL 404s.
  * A figure rendering the current version was wired to an older release's
    attestation — and that file was not served either.
  * A whole section described paying an x402 endpoint that has never existed.

Each one is the same defect: an invitation to verify us that could not be
taken. On a site whose entire argument is "check me, don't trust me", a dead
proof link is worse than a wrong number — it fails precisely the person who
took us at our word and tried.

So this gate asserts the recursive form of the site's own invariant:

    EVERY AFFORDANCE THAT INVITES SOMEONE TO CHECK US MUST RESOLVE.

Checked (each is a proof affordance, not decoration — ordinary <a href> links
are a separate concern and deliberately out of scope):

  C1  data-manifest= / data-artifact= on prove buttons and Figures.
      A button offering proof must have proof behind it.
  C2  URL-valued "source" fields in _shared/stats.json.
      A figure's citation must point at something real.
  C3  ledatic.org URLs inside published <pre class="recipe"> blocks.
      If we print a command for a stranger to run, it has to work.

A citation passes if it resolves live (2xx), OR if it names a file this very
deploy is about to publish — that second case is what lets a new page ship
alongside the artifact it cites, instead of deadlocking on itself.

Usage: tools/citation_gate.py [--quiet]   (from anywhere; cds to repo root)
Exit:  0 clean · 1 unresolved citations · 2 missing prerequisites
"""

import html
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ORIGIN = "https://ledatic.org"

# Real UA on purpose. Cloudflare's bot protection answers a default urllib or
# bare-curl UA with a challenge or a 404, which would make this gate report
# failures that exist only in the probe. Measure the site, not its doorman.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

MANIFEST_RE = re.compile(r'data-(?:manifest|artifact)="([^"]+)"')
SOURCE_URL_RE = re.compile(r'https?://[^\s"\'<>)]+')
RECIPE_RE = re.compile(r'<pre class="recipe">(.*?)</pre>', re.S)


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def deployable_keys():
    """Keys this deploy will publish — mirrors deploy.sh's deploy_all globs.

    Used to resolve the chicken-and-egg: a page may legitimately cite an
    artifact that goes live in the same deploy.
    """
    keys = set()
    for f in sorted(os.listdir(".")):
        if f.endswith(".html"):
            keys.add(f)
    for sub, exts in (("_shared", (".css", ".js", ".json")),
                      ("_shared/shaders", (".frag",)),
                      ("data", (".html", ".json", ".jsonl", ".sha256")),
                      ("attest", (".sh", ".pem")),
                      ("sdk", (".py",))):
        if not os.path.isdir(sub):
            continue
        for f in sorted(os.listdir(sub)):
            if f.endswith(exts):
                keys.add(f"{sub}/{f}")
    for f in ("robots.txt", "llms.txt", "sitemap.xml", "og.png"):
        if os.path.exists(f):
            keys.add(f)
    return keys


def to_path(url):
    """Normalize a citation to a site-absolute path, or None if off-site."""
    u = html.unescape(url).strip().rstrip(".,;")
    # Skip citations the page builds at runtime (JS template literals in a
    # data-manifest attribute). The URL isn't knowable statically; the button
    # it belongs to is exercised by the page's own tests, not by this gate.
    if "${" in u or "{{" in u:
        return None
    if u.startswith(ORIGIN):
        u = u[len(ORIGIN):] or "/"
    elif u.startswith("http://") or u.startswith("https://"):
        return None                      # third-party; not ours to guarantee
    if not u.startswith("/"):
        u = "/" + u
    return u.split("?")[0].split("#")[0]


def collect():
    """Gather (path, origin-file, rule) for every proof affordance."""
    found = []
    pages = [f for f in sorted(os.listdir(".")) if f.endswith(".html")]
    if os.path.isdir("data"):
        pages += [f"data/{f}" for f in sorted(os.listdir("data")) if f.endswith(".html")]

    for page in pages:
        src = open(page, encoding="utf-8").read()
        for m in MANIFEST_RE.finditer(src):
            p = to_path(m.group(1))
            if p:
                found.append((p, page, "C1 prove-button manifest"))
        for block in RECIPE_RE.findall(src):
            text = html.unescape(re.sub(r"<[^>]+>", "", block))
            for u in SOURCE_URL_RE.findall(text):
                p = to_path(u)
                if p:
                    found.append((p, page, "C3 published recipe"))

    stats_path = "_shared/stats.json"
    if os.path.exists(stats_path):
        stats = json.load(open(stats_path))
        for key, entry in (stats.get("stats") or {}).items():
            for u in SOURCE_URL_RE.findall(str(entry.get("source", ""))):
                p = to_path(u)
                if p:
                    found.append((p, f"stats.json:{key}", "C2 figure citation"))

    # Dedupe on path, keeping the first citer for the error message.
    seen, out = set(), []
    for p, where, rule in found:
        if p not in seen:
            seen.add(p)
            out.append((p, where, rule))
    return out


def probe(path):
    """True if the live site serves this path. HEAD, then GET for routes that
    only implement GET."""
    code = "000"
    for args in (["-I"], []):
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "--max-time", "20", "-A", UA] + args + [ORIGIN + path],
            capture_output=True, text=True)
        code = (r.stdout or "").strip() or "000"
        if code[:1] == "2":
            return True, code
    return False, code


def main():
    quiet = "--quiet" in sys.argv or "-q" in sys.argv
    os.chdir(repo_root())

    if not os.path.exists("_shared/stats.json"):
        sys.stderr.write("citation_gate: _shared/stats.json missing — "
                         "run tools/gen_stats.sh first\n")
        return 2

    cites = collect()
    if not cites:
        print("citation_gate: no proof affordances found — suspicious", file=sys.stderr)
        return 2

    publishing = deployable_keys()
    # A citation may name an extensionless route (/rail -> rail.html) or a
    # directory-ish path; accept either spelling of a key we're publishing.
    def will_publish(p):
        k = p.lstrip("/")
        if k in publishing or f"{k}.html" in publishing:
            return True
        return p == "/" and "index.html" in publishing

    pending = [(p, w, r) for p, w, r in cites if not will_publish(p)]
    covered = len(cites) - len(pending)

    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(lambda c: probe(c[0]), pending))

    violations = 0
    for (path, where, rule), (ok, code) in zip(pending, results):
        if ok:
            if not quiet:
                print(f"  ok   {path}")
        else:
            violations += 1
            print(f"FAIL [{rule}] {where} cites {path} — HTTP {code}")

    if violations:
        print(f"citation_gate: {violations} unresolved citation(s) — deploy blocked.")
        print("               A proof someone cannot take is worse than no proof.")
        print("               Fix the target, or stop making the claim.")
        return 1

    if not quiet:
        print(f"citation_gate: clean ({len(cites)} proof affordances; "
              f"{len(pending)} verified live, {covered} shipping in this deploy).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
