#!/usr/bin/env python3.11
"""
Detect anomalies in the AIS stream, narrate new ones via 122B, publish to R2.

Anomaly kinds:
  going_dark   — vessel had recent activity (≥3 positions in last 24h) and
                 hasn't reported in the last 45 minutes.
  loitering    — vessel has ≥10 consecutive position fixes in the last 90
                 minutes all with sog < 0.5 kt, and is not within any port
                 geofence.
  speed_spike  — any single position reports sog > 25 kt (Great Lakes
                 commercial traffic rarely exceeds 18 kt; flag for review).

For each newly detected anomaly, call the 122B for a one-paragraph narrative.
Then publish the open-anomalies list (with narratives) to
/greatlakes/data/anomalies.json.
"""
import json
import math
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME      = Path.home()
DB_PATH   = HOME / ".ledatic" / "lakes" / "lakes.db"
TOKEN_F   = HOME / ".ledatic" / "entropy" / "beacon_token"
LLM_URL   = "http://10.42.0.2:8082/v1/chat/completions"
LLM_MODEL = "/Users/user/models/Qwen3.5-122B-A10B-heretic-v2-2.34bit-msq"
PUT_URL   = "https://ledatic.org/greatlakes/data/anomalies.json"

NARRATE_SYSTEM = (
    "You are a maritime operations analyst. Given a single anomaly detected "
    "in the live AIS stream, write a one-paragraph operations note (max 60 "
    "words). State the fact, give a plausible reason or two, and note the "
    "recommended next check. No headers, no lists, no preamble."
)


def haversine_nm(lat1, lon1, lat2, lon2) -> float:
    R_NM = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R_NM * math.asin(math.sqrt(a))


def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


# ─── Detection ───────────────────────────────────────────────────────────────

def detect_going_dark(conn) -> list[dict]:
    """Vessels with recent baseline activity but a 45+ min silence."""
    rows = conn.execute(
        """
        WITH active AS (
          SELECT mmsi, COUNT(*) AS n, MAX(ts) AS last_ts
          FROM positions
          WHERE ts > datetime('now', '-24 hours')
          GROUP BY mmsi
          HAVING COUNT(*) >= 3
        )
        SELECT a.mmsi, a.last_ts, v.name, p.lat, p.lon
        FROM active a
        JOIN vessels v ON v.mmsi = a.mmsi
        JOIN positions p ON p.mmsi = a.mmsi AND p.ts = a.last_ts
        WHERE a.last_ts < datetime('now', '-45 minutes')
          AND v.name IS NOT NULL
        ORDER BY a.last_ts ASC
        LIMIT 30
        """
    ).fetchall()
    out = []
    for r in rows:
        out.append({
            "kind": "going_dark",
            "mmsi": r["mmsi"],
            "first_seen": r["last_ts"],
            "data": {
                "name": r["name"],
                "last_ts": r["last_ts"],
                "last_lat": r["lat"], "last_lon": r["lon"],
            },
        })
    return out


def detect_loitering(conn) -> list[dict]:
    """≥10 consecutive slow fixes in last 90min, not in any port radius."""
    ports = conn.execute(
        "SELECT lat, lon, geofence_radius_nm FROM ports"
    ).fetchall()

    # Candidate vessels: those with ≥10 slow fixes in last 90min
    candidates = conn.execute(
        """
        SELECT mmsi, COUNT(*) AS slow_n, MAX(ts) AS last_ts
        FROM positions
        WHERE ts > datetime('now', '-90 minutes') AND sog < 0.5
        GROUP BY mmsi
        HAVING COUNT(*) >= 10
        """
    ).fetchall()

    out = []
    for c in candidates:
        mmsi = c["mmsi"]
        last = conn.execute(
            "SELECT lat, lon, ts FROM positions WHERE mmsi=? ORDER BY ts DESC LIMIT 1",
            (mmsi,),
        ).fetchone()
        if not last or last["lat"] is None:
            continue
        # Check if inside any port radius
        in_port = any(
            haversine_nm(last["lat"], last["lon"], p["lat"], p["lon"]) <= p["geofence_radius_nm"]
            for p in ports
        )
        if in_port:
            continue
        v = conn.execute("SELECT name FROM vessels WHERE mmsi=?", (mmsi,)).fetchone()
        if not v or not v["name"]:
            continue
        first_slow = conn.execute(
            "SELECT MIN(ts) FROM positions WHERE mmsi=? AND ts > datetime('now', '-90 minutes') AND sog < 0.5",
            (mmsi,),
        ).fetchone()[0]
        out.append({
            "kind": "loitering",
            "mmsi": mmsi,
            "first_seen": first_slow,
            "data": {
                "name": v["name"],
                "slow_fixes_90m": c["slow_n"],
                "last_ts": last["ts"],
                "last_lat": last["lat"], "last_lon": last["lon"],
            },
        })
    return out


def detect_speed_spike(conn) -> list[dict]:
    """Any position in last 6h with sog > 25 kt."""
    rows = conn.execute(
        """
        SELECT p.mmsi, p.ts, p.lat, p.lon, p.sog, v.name
        FROM positions p
        JOIN vessels v ON v.mmsi = p.mmsi
        WHERE p.ts > datetime('now', '-6 hours') AND p.sog > 25.0 AND p.sog < 100.0
          AND v.name IS NOT NULL
        ORDER BY p.ts DESC
        LIMIT 30
        """
    ).fetchall()
    return [{
        "kind": "speed_spike",
        "mmsi": r["mmsi"],
        "first_seen": r["ts"],
        "data": {
            "name": r["name"],
            "sog": r["sog"],
            "ts": r["ts"], "lat": r["lat"], "lon": r["lon"],
        },
    } for r in rows]


# ─── Narration ───────────────────────────────────────────────────────────────

def narrate(anomaly: dict) -> str:
    data = anomaly["data"]
    if anomaly["kind"] == "going_dark":
        prompt = (
            f"Anomaly: vessel {data['name']} (MMSI {anomaly['mmsi']}) went silent. "
            f"Last AIS fix was at {data['last_ts']} at lat {data['last_lat']:.3f}, lon {data['last_lon']:.3f}. "
            f"It has not broadcast in over 45 minutes despite having reported "
            f"regularly earlier today. Possible causes and recommended check?"
        )
    elif anomaly["kind"] == "loitering":
        prompt = (
            f"Anomaly: vessel {data['name']} (MMSI {anomaly['mmsi']}) is loitering. "
            f"It has reported {data['slow_fixes_90m']} consecutive fixes in the "
            f"last 90 minutes all below 0.5 knots, currently at lat {data['last_lat']:.3f}, "
            f"lon {data['last_lon']:.3f}. It is not inside any known Great Lakes port. "
            f"Possible causes and recommended check?"
        )
    elif anomaly["kind"] == "speed_spike":
        prompt = (
            f"Anomaly: vessel {data['name']} (MMSI {anomaly['mmsi']}) reported an "
            f"unusual speed of {data['sog']:.1f} knots at {data['ts']}, position "
            f"lat {data['lat']:.3f}, lon {data['lon']:.3f}. Great Lakes commercial "
            f"traffic rarely exceeds 18 knots. Possible causes and recommended check?"
        )
    else:
        return ""

    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": NARRATE_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 220,
        "temperature": 0.4,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        LLM_URL, data=body, method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = json.loads(resp.read())
    return (d["choices"][0]["message"].get("content") or "").strip()


# ─── Storage + publish ───────────────────────────────────────────────────────

def upsert_anomaly(conn, a: dict, narrative: str) -> bool:
    """Returns True if a new row was inserted."""
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO anomalies (mmsi, kind, first_seen, last_seen, data_json, narrative)
        VALUES (?, ?, ?, datetime('now'), ?, ?)
        """,
        (a["mmsi"], a["kind"], a["first_seen"], json.dumps(a["data"]), narrative),
    )
    if cur.rowcount:
        return True
    # Update last_seen for existing anomalies (they're still happening).
    conn.execute(
        "UPDATE anomalies SET last_seen = datetime('now') "
        "WHERE mmsi=? AND kind=? AND first_seen=?",
        (a["mmsi"], a["kind"], a["first_seen"]),
    )
    return False


def open_anomalies(conn) -> list[dict]:
    """Anomalies seen in the last 4h, sorted newest first."""
    rows = conn.execute(
        """
        SELECT mmsi, kind, first_seen, last_seen, data_json, narrative
        FROM anomalies
        WHERE last_seen > datetime('now', '-4 hours')
        ORDER BY first_seen DESC
        LIMIT 40
        """
    ).fetchall()
    out = []
    for r in rows:
        try:
            data = json.loads(r["data_json"] or "{}")
        except json.JSONDecodeError:
            data = {}
        out.append({
            "mmsi": r["mmsi"], "kind": r["kind"],
            "first_seen": r["first_seen"], "last_seen": r["last_seen"],
            "data": data, "narrative": r["narrative"] or "",
        })
    return out


def put_anomalies(payload: dict, token: str) -> tuple[int, str]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(
        PUT_URL, data=body, method="PUT",
        headers={
            "x-beacon-token": token,
            "content-type": "application/json",
            "user-agent": "lakes-anomaly-detector/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(64).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(128).decode(errors="replace")


def main() -> None:
    if not TOKEN_F.exists():
        sys.exit(f"[lakes_anomaly] beacon token missing: {TOKEN_F}")
    token = TOKEN_F.read_text().strip()

    t0 = time.monotonic()
    conn = open_db()

    detected = []
    detected += detect_going_dark(conn)
    detected += detect_loitering(conn)
    detected += detect_speed_spike(conn)

    new_count = 0
    narrate_failures = 0
    for a in detected:
        # Pre-check: is this anomaly already in DB? If yes, just bump last_seen.
        existing = conn.execute(
            "SELECT id, narrative FROM anomalies "
            "WHERE mmsi=? AND kind=? AND first_seen=?",
            (a["mmsi"], a["kind"], a["first_seen"]),
        ).fetchone()
        narrative = existing[1] if existing else ""
        if not existing:
            try:
                narrative = narrate(a)
            except (urllib.error.URLError, OSError) as e:
                narrate_failures += 1
                narrative = f"(narration failed: {e})"
        if upsert_anomaly(conn, a, narrative):
            new_count += 1

    open_list = open_anomalies(conn)
    payload = {
        "kind": "lakes.anomalies",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(open_list),
        "anomalies": open_list,
    }
    status, _ = put_anomalies(payload, token)
    elapsed = time.monotonic() - t0
    print(
        f"[lakes_anomaly] detected={len(detected)} new={new_count} "
        f"open={len(open_list)} narrate_fail={narrate_failures} "
        f"put={status} t={elapsed:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
