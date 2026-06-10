#!/usr/bin/env python3
"""inject_figures.py — the Figure injector (design spec §5.4).

Reads _shared/stats.json and rewrites every Figure element in an HTML file:

    <data class="fig" value="..." data-src="KEY" [data-fmt="FMT"] [data-pulse="..."]>TEXT</data>

For each such element this injector:
  - replaces TEXT with stats[KEY]["formats"][FMT] (or stats[KEY]["display"]
    when no data-fmt is present),
  - rewrites value="..." to the canonical machine value,
  - stamps data-pulse="..." from stats.json's pulse_id (provenance anchor).

Contract (page agents):
  - data-src keys are the registry in stats.json ("repo:rail_native",
    "repo:version", "repo:tags", "tests:total", "stdlib:modules",
    "beacon:cadence").
  - A Figure <data> element must open and close on ONE source line.
  - Unknown data-src / data-fmt, a fig without data-src, or a multi-line
    fig element is a hard error (exit 2) — unresolved Figures block deploys
    (honesty rule 2).

Idempotent: output is a pure function of (stats.json, input HTML).

Usage: inject_figures.py <stats.json> <file.html>   (transformed HTML → stdout)
"""

import json
import re
import sys

OPEN_RE = re.compile(r'<data\b[^>]*>')
FIG_RE = re.compile(r'(<data\b[^>]*class="[^"]*\bfig\b[^"]*"[^>]*>)([^<]*)(</data>)')
ATTR_RE = re.compile(r'([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"')


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: inject_figures.py <stats.json> <file.html>\n")
        return 2

    stats_path, html_path = sys.argv[1], sys.argv[2]
    with open(stats_path) as f:
        doc = json.load(f)
    stats = doc.get("stats", {})
    pulse_id = doc.get("pulse_id")

    with open(html_path) as f:
        lines = f.read().split("\n")

    errors = []
    out_lines = []

    for lineno, line in enumerate(lines, 1):
        # Contract check: any fig-classed <data> that opens on this line must
        # also close on it (keeps both injector and honesty gate line-wise,
        # auditable with plain grep).
        for m in OPEN_RE.finditer(line):
            tag = m.group(0)
            cls = ATTR_RE.findall(tag)
            attrs = dict(cls)
            if "fig" in attrs.get("class", "").split():
                rest = line[m.start():]
                if "</data>" not in rest:
                    errors.append(f"{html_path}:{lineno}: fig <data> element does not close on its own line")

        def repl(m):
            tag, _text, close = m.group(1), m.group(2), m.group(3)
            attrs = dict(ATTR_RE.findall(tag))
            key = attrs.get("data-src")
            if not key:
                errors.append(f"{html_path}:{lineno}: fig <data> missing data-src")
                return m.group(0)
            if key not in stats:
                errors.append(f"{html_path}:{lineno}: unresolved Figure data-src=\"{key}\"")
                return m.group(0)
            entry = stats[key]
            fmt = attrs.get("data-fmt")
            if fmt is not None:
                formats = entry.get("formats", {})
                if fmt not in formats:
                    errors.append(f"{html_path}:{lineno}: data-src=\"{key}\" has no format \"{fmt}\"")
                    return m.group(0)
                display = formats[fmt]
            else:
                display = entry["display"]

            new_attrs = dict(attrs)
            new_attrs["value"] = str(entry["value"])
            if pulse_id is not None:
                new_attrs["data-pulse"] = str(pulse_id)

            def sub_attr(am):
                name = am.group(1)
                if name in new_attrs:
                    val = new_attrs.pop(name)
                    return f'{name}="{val}"'
                return am.group(0)

            new_tag = ATTR_RE.sub(sub_attr, tag)
            # Append attrs that weren't present on the authored element
            # (value / data-pulse), just before the closing '>'.
            extra = "".join(f' {k}="{v}"' for k, v in new_attrs.items()
                            if k in ("value", "data-pulse"))
            if extra:
                new_tag = new_tag[:-1] + extra + ">"
            return f"{new_tag}{display}{close}"

        out_lines.append(FIG_RE.sub(repl, line))

    if errors:
        for e in errors:
            sys.stderr.write(f"inject_figures: {e}\n")
        return 2

    sys.stdout.write("\n".join(out_lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
