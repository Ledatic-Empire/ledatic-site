#!/usr/bin/env python3
"""changelog_gate.py: the public ledger must match the release history.

/changelog is a hand-maintained page and CHANGELOG.md is a hand-maintained
file, and on 2026-08-28 they disagreed in BOTH directions: the page was
missing six releases including the two most recent (v5.2.0 and v5.3.0),
while listing five the changelog never documented. Two hand-kept ledgers,
each wrong where nobody was looking, on a site whose whole argument is that
you can check its claims.

Nothing compared them, so nothing caught it. This does.

The reverse direction is a real debt rather than a bug, so it is named
instead of hidden: five versions shipped before CHANGELOG.md existed in its
current form. They are allowlisted BY NAME below, which bounds the debt and
means any NEW divergence fails loudly. An unbounded warning would just be
the thing that already did not work.
"""
import re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD = os.path.expanduser("~/projects/rail/CHANGELOG.md")
PAGE = os.path.join(ROOT, "changelog.html")

# On the page, absent from CHANGELOG.md. Predate the current changelog and
# would have to be reconstructed from git history to document honestly.
# Shrink this list; never grow it without a reason written here.
PREDATES_CHANGELOG = {"v3.11.0", "v3.10.0", "v3.9.0", "v3.8.0", "v0.6.0"}

def main():
    if not os.path.exists(MD):
        print(f"changelog gate: cannot read {MD}", file=sys.stderr)
        return 3
    md_text = open(MD, encoding="utf-8").read()
    # "## v2.17.0 - v2.21.0 (date)" is one entry covering a range; the page
    # carries it under its first version, so that is what we compare.
    md = re.findall(r"^## (v\d+\.\d+\.\d+)", md_text, re.M)
    page = re.findall(r'<span class="lver">(?:<data value="[^"]*">)?(v\d+\.\d+\.\d+)',
                      open(PAGE, encoding="utf-8").read())

    missing = [v for v in md if v not in page]
    extra = [v for v in page if v not in md and v not in PREDATES_CHANGELOG]
    stale_alw = sorted(PREDATES_CHANGELOG - set(page))

    bad = False
    if missing:
        print("changelog gate: CHANGELOG.md documents releases the public "
              f"ledger does not show: {', '.join(missing)}", file=sys.stderr)
        bad = True
    if extra:
        print("changelog gate: the public ledger shows releases CHANGELOG.md "
              f"does not document: {', '.join(extra)}", file=sys.stderr)
        bad = True
    if stale_alw:
        print("changelog gate: allowlisted versions are no longer on the page, "
              f"so the allowlist is stale: {', '.join(stale_alw)}", file=sys.stderr)
        bad = True
    if bad:
        return 1
    if "--quiet" not in sys.argv:
        print(f"changelog gate: {len(page)} ledger entries cover all {len(md)} "
              f"documented releases ({len(PREDATES_CHANGELOG)} predate the changelog)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
