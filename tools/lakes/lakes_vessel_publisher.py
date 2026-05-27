#!/usr/bin/env python3.11
"""
Per-vessel snapshot publisher.

For each vessel active in the last 24h, build a JSON snapshot (particulars +
last 7d track decimated + recent port calls) and PUT it to ledatic.org R2 via
the existing /greatlakes/data/ endpoint.

Also publishes:
  - vessels/index.json — list of active vessels with brief summary
  - calls.json         — recent port calls (open + closed)

Reads beacon token from ~/.ledatic/entropy/beacon_token for the PUT auth.

Run on a 2-min LaunchAgent timer.
"""
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME      = Path.home()
DB_PATH   = HOME / ".ledatic" / "lakes" / "lakes.db"
TOKEN_F   = HOME / ".ledatic" / "entropy" / "beacon_token"
BASE_URL  = "https://ledatic.org/greatlakes/data"

TRACK_MAX_POINTS = 500          # decimate to this many points max
TRACK_LOOKBACK   = "-7 days"
ACTIVE_LOOKBACK  = "-24 hours"
CALLS_LIMIT      = 50


def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def put_json(path: str, payload: dict, token: str) -> tuple[int, str]:
    url = f"{BASE_URL}/{path}"
    body = json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="PUT",
        headers={
            "x-beacon-token": token,
            "content-type": "application/json",
            "user-agent": "lakes-vessel-publisher/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(64).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(128).decode(errors="replace")
    except OSError as e:
        return 0, str(e)


def active_vessels(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT v.*, p.lat AS last_lat, p.lon AS last_lon, p.sog AS last_sog,
               p.cog AS last_cog, p.heading AS last_heading, p.ts AS last_ts
        FROM vessels v
        JOIN (
          SELECT mmsi, MAX(ts) AS max_ts
          FROM positions
          WHERE ts > datetime('now', '{ACTIVE_LOOKBACK}')
          GROUP BY mmsi
        ) m ON m.mmsi = v.mmsi
        JOIN positions p ON p.mmsi = v.mmsi AND p.ts = m.max_ts
        ORDER BY p.ts DESC
        """
    ).fetchall()


def vessel_track(conn: sqlite3.Connection, mmsi: int) -> list[dict]:
    rows = conn.execute(
        f"""
        SELECT ts, lat, lon, sog, cog
        FROM positions
        WHERE mmsi = ? AND ts > datetime('now', '{TRACK_LOOKBACK}')
        ORDER BY ts ASC
        """,
        (mmsi,),
    ).fetchall()
    if len(rows) <= TRACK_MAX_POINTS:
        return [dict(r) for r in rows]
    # Decimate uniformly.
    step = len(rows) / TRACK_MAX_POINTS
    return [dict(rows[int(i * step)]) for i in range(TRACK_MAX_POINTS)]


def vessel_calls(conn: sqlite3.Connection, mmsi: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT pc.port_key, p.name AS port_name, pc.arrived_at, pc.departed_at, pc.dwell_min
        FROM port_calls pc
        JOIN ports p ON p.key = pc.port_key
        WHERE pc.mmsi = ?
        ORDER BY pc.arrived_at DESC
        LIMIT 10
        """,
        (mmsi,),
    ).fetchall()
    return [dict(r) for r in rows]


def all_recent_calls(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        f"""
        SELECT pc.mmsi, v.name AS vessel_name, pc.port_key, p.name AS port_name,
               pc.arrived_at, pc.departed_at, pc.dwell_min
        FROM port_calls pc
        JOIN ports p   ON p.key = pc.port_key
        JOIN vessels v ON v.mmsi = pc.mmsi
        ORDER BY COALESCE(pc.departed_at, pc.arrived_at) DESC
        LIMIT {CALLS_LIMIT}
        """
    ).fetchall()
    return [dict(r) for r in rows]


def vessel_snapshot(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    mmsi = row["mmsi"]
    return {
        "kind": "lakes.vessel.snapshot",
        "mmsi": mmsi,
        "name": row["name"],
        "imo": row["imo"],
        "callsign": row["callsign"],
        "type": row["type"],
        "dim_a": row["dim_a"], "dim_b": row["dim_b"],
        "dim_c": row["dim_c"], "dim_d": row["dim_d"],
        "length_m": ((row["dim_a"] or 0) + (row["dim_b"] or 0)) or None,
        "beam_m":   ((row["dim_c"] or 0) + (row["dim_d"] or 0)) or None,
        "draught": row["draught"],
        "destination": row["destination"],
        "eta": row["eta"],
        "last": {
            "ts": row["last_ts"],
            "lat": row["last_lat"], "lon": row["last_lon"],
            "sog": row["last_sog"], "cog": row["last_cog"],
            "heading": row["last_heading"],
        },
        "track": vessel_track(conn, mmsi),
        "calls": vessel_calls(conn, mmsi),
    }


def main() -> None:
    if not DB_PATH.exists():
        sys.exit(f"[lakes_vp] db missing: {DB_PATH}")
    if not TOKEN_F.exists():
        sys.exit(f"[lakes_vp] beacon token missing: {TOKEN_F}")

    token = TOKEN_F.read_text().strip()
    conn = open_db()
    t0 = time.monotonic()

    vessels = active_vessels(conn)
    # Filter out invalid MMSIs (basestation, AtoN); keep 6-10 digit length per
    # Worker's path regex.
    vessels = [v for v in vessels if v["mmsi"] and 100000 <= v["mmsi"] <= 9999999999]

    ok_n, fail_n = 0, 0
    for v in vessels:
        snap = vessel_snapshot(conn, v)
        status, _ = put_json(f"vessels/{v['mmsi']}.json", snap, token)
        if status == 200:
            ok_n += 1
        else:
            fail_n += 1
            print(f"[lakes_vp] vessel {v['mmsi']} put -> {status}", file=sys.stderr)

    # Compact index for the main map.
    idx = {
        "kind": "lakes.vessels.index",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(vessels),
        "vessels": [
            {
                "mmsi": v["mmsi"], "name": v["name"], "type": v["type"],
                "lat": v["last_lat"], "lon": v["last_lon"],
                "sog": v["last_sog"], "cog": v["last_cog"],
                "ts": v["last_ts"],
                "destination": v["destination"],
            }
            for v in vessels
        ],
    }
    status, _ = put_json("vessels/index.json", idx, token)
    if status == 200:
        ok_n += 1
    else:
        fail_n += 1
        print(f"[lakes_vp] index put -> {status}", file=sys.stderr)

    # Recent calls feed.
    calls_payload = {
        "kind": "lakes.calls",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "calls": all_recent_calls(conn),
    }
    status, _ = put_json("calls.json", calls_payload, token)
    if status == 200:
        ok_n += 1
    else:
        fail_n += 1
        print(f"[lakes_vp] calls put -> {status}", file=sys.stderr)

    elapsed = time.monotonic() - t0
    print(
        f"[lakes_vp] {len(vessels)} active vessels, "
        f"{ok_n} put_ok, {fail_n} put_fail, t={elapsed:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
