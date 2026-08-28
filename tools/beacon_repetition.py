#!/usr/bin/env python3
"""beacon_repetition.py: how often does the entropy beacon repeat a value?

The figures published in the "What these numbers are not" section of
/entropy come from this script. A number on a page that nobody can
re-derive is an assertion, not a measurement, so this is the derivation.

Each pulse value is SHA-256 of one simulation frame, with prev_value_hex
carried alongside but never mixed in. Identical frames therefore produce
identical values, and the plasma revisits states. This counts how often,
and how far apart.

Usage:
  tools/beacon_repetition.py                 measure the local archive
  tools/beacon_repetition.py --json          machine-readable
  tools/beacon_repetition.py --buckets 4     widen the window

Exit 0 always; this reports, it does not gate. See --check for that.
  tools/beacon_repetition.py --check 3.04 --tolerance 1.0
    exits 1 if the measured repeat rate has moved more than tolerance
    points from the figure the page currently claims, which is the signal
    that the page needs updating rather than that the beacon is broken.
"""
import argparse, collections, json, os, statistics, sys

ARCHIVE = os.path.expanduser("~/.ledatic/entropy/archive")

def measure(nbuckets):
    if not os.path.isdir(ARCHIVE):
        print(f"no archive at {ARCHIVE}", file=sys.stderr); sys.exit(2)
    buckets = sorted((b for b in os.listdir(ARCHIVE) if b.startswith("b")),
                     key=lambda x: int(x[1:]))[-nbuckets:]
    recs = []
    for b in buckets:
        d = os.path.join(ARCHIVE, b)
        for pid in sorted(int(f[:-5]) for f in os.listdir(d) if f.endswith(".json")):
            try:
                r = json.load(open(os.path.join(d, f"{pid}.json")))
            except Exception:
                continue
            v = r.get("value_hex")
            if v:
                recs.append((pid, v))
    recs.sort()
    if not recs:
        print("no records", file=sys.stderr); sys.exit(2)
    vals = [v for _, v in recs]
    c = collections.Counter(vals)
    extra = sum(n - 1 for n in c.values() if n > 1)
    pos = collections.defaultdict(list)
    for pid, v in recs:
        pos[v].append(pid)
    gaps = [b - a for ids in pos.values() if len(ids) > 1
            for a, b in zip(ids, ids[1:])]
    out = {
        "buckets": buckets,
        "first_pulse": recs[0][0], "last_pulse": recs[-1][0],
        "records": len(recs),
        "unique_values": len(c),
        "unique_pct": round(100 * len(c) / len(recs), 2),
        "recurring_values": sum(1 for n in c.values() if n > 1),
        "redundant_pulses": extra,
        "repeat_pct": round(100 * extra / len(recs), 2),
    }
    if gaps:
        inband = sum(1 for g in gaps if 5000 <= g <= 5500)
        out.update({
            "median_gap": int(statistics.median(gaps)),
            "gaps_in_5000_5500_pct": round(100 * inband / len(gaps)),
            "period_minutes_approx": round(statistics.median(gaps) / 60),
        })
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buckets", type=int, default=2)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", type=float, help="repeat %% the page claims")
    ap.add_argument("--tolerance", type=float, default=1.0)
    a = ap.parse_args()
    m = measure(a.buckets)
    if a.json:
        print(json.dumps(m, indent=2))
    else:
        print(f"window       : pulses {m['first_pulse']} to {m['last_pulse']} "
              f"({m['records']} records)")
        print(f"unique       : {m['unique_values']} ({m['unique_pct']}%)")
        print(f"recurring    : {m['recurring_values']} distinct values, "
              f"{m['redundant_pulses']} redundant pulses ({m['repeat_pct']}%)")
        if "median_gap" in m:
            print(f"period       : median gap {m['median_gap']} pulses, "
                  f"{m['gaps_in_5000_5500_pct']}% in 5000-5500, "
                  f"~{m['period_minutes_approx']} min")
    if a.check is not None:
        drift = abs(m["repeat_pct"] - a.check)
        if drift > a.tolerance:
            print(f"DRIFT: page claims {a.check}% repeats, measured "
                  f"{m['repeat_pct']}% (moved {drift:.2f} points). The page "
                  f"needs updating.", file=sys.stderr)
            return 1
        print(f"page figure {a.check}% still within {a.tolerance} of "
              f"measured {m['repeat_pct']}%")
    return 0

if __name__ == "__main__":
    sys.exit(main())
