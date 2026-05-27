#!/usr/bin/env python3.11
"""
Lakes indexer — incrementally consume signed AIS batches into SQLite.

Reads from:   ~/.ledatic/lakes/batches/*.jsonl   (atomic-rotated by lakes_attest_publisher.sh)
Writes to:    ~/.ledatic/lakes/lakes.db

Schema:
  vessels      — particulars keyed by MMSI (one row per vessel; UPSERTed)
  positions    — every recorded fix (mmsi, ts) PK
  ports        — Great Lakes major ports with geofence centroid + radius (seed)
  port_calls   — detected arrivals/departures (populated by lakes_index_calls.py later)
  anomalies    — detected anomalies (populated by P6)
  index_state  — bookkeeping (last_batch_id consumed)

Idempotent. Safe to run continuously on a 60s timer. Picks up any new batches
since last run, plus any historical batches not yet indexed (first run = full
backfill of everything in batches/).
"""
import json
import math
import sqlite3
import sys
import time
from pathlib import Path

HOME = Path.home()
BATCH_DIR = HOME / ".ledatic" / "lakes" / "batches"
DB_PATH   = HOME / ".ledatic" / "lakes" / "lakes.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS vessels (
    mmsi         INTEGER PRIMARY KEY,
    imo          INTEGER,
    name         TEXT,
    callsign     TEXT,
    type         INTEGER,
    dim_a        INTEGER,
    dim_b        INTEGER,
    dim_c        INTEGER,
    dim_d        INTEGER,
    draught      REAL,
    destination  TEXT,
    eta          TEXT,
    updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS positions (
    mmsi      INTEGER NOT NULL,
    ts        TEXT NOT NULL,
    lat       REAL,
    lon       REAL,
    sog       REAL,
    cog       REAL,
    heading   INTEGER,
    batch_id  TEXT,
    PRIMARY KEY (mmsi, ts)
);
CREATE INDEX IF NOT EXISTS positions_mmsi_idx ON positions(mmsi);
CREATE INDEX IF NOT EXISTS positions_ts_idx   ON positions(ts);

CREATE TABLE IF NOT EXISTS ports (
    key                 TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    country             TEXT,
    lat                 REAL NOT NULL,
    lon                 REAL NOT NULL,
    geofence_radius_nm  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS port_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi         INTEGER NOT NULL,
    port_key     TEXT    NOT NULL,
    arrived_at   TEXT,
    departed_at  TEXT,
    dwell_min    INTEGER,
    UNIQUE (mmsi, port_key, arrived_at)
);
CREATE INDEX IF NOT EXISTS port_calls_mmsi_idx     ON port_calls(mmsi);
CREATE INDEX IF NOT EXISTS port_calls_port_idx     ON port_calls(port_key);
CREATE INDEX IF NOT EXISTS port_calls_arrived_idx  ON port_calls(arrived_at);

CREATE TABLE IF NOT EXISTS anomalies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi         INTEGER,
    kind         TEXT NOT NULL,
    first_seen   TEXT NOT NULL,
    last_seen    TEXT,
    data_json    TEXT,
    narrative    TEXT,
    UNIQUE (mmsi, kind, first_seen)
);

CREATE TABLE IF NOT EXISTS index_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

# Major Great Lakes + Seaway ports. Centroids are approximate (harbor mouth or
# inner basin). Radii are conservative — wider radius captures more port-call
# events but also more transit noise; tuned per port.
PORTS_SEED = [
    # key,                 name,                       country, lat,     lon,     nm
    ("duluth",             "Duluth-Superior",           "US",   46.7700, -92.1000, 4.0),
    ("two_harbors",        "Two Harbors",               "US",   47.0150, -91.6750, 3.0),
    ("silver_bay",         "Silver Bay",                "US",   47.2900, -91.2600, 2.5),
    ("taconite_harbor",    "Taconite Harbor",           "US",   47.5300, -90.9100, 2.5),
    ("thunder_bay",        "Thunder Bay",               "CA",   48.4000, -89.2100, 4.0),
    ("marquette",          "Marquette",                 "US",   46.5500, -87.3900, 3.0),
    ("stoneport",          "Stoneport",                 "US",   45.2700, -83.4100, 2.5),
    ("alpena",             "Alpena",                    "US",   45.0700, -83.4350, 3.0),
    ("sault_ste_marie",    "Sault Ste. Marie (Locks)",  "US",   46.5050, -84.3500, 2.5),
    ("port_huron",         "Port Huron",                "US",   42.9700, -82.4200, 2.0),
    ("detroit",            "Detroit",                   "US",   42.3300, -83.0500, 3.5),
    ("toledo",             "Toledo",                    "US",   41.6500, -83.4900, 3.5),
    ("cleveland",          "Cleveland",                 "US",   41.5050, -81.6900, 3.5),
    ("erie",               "Erie",                      "US",   42.1300, -80.0900, 3.0),
    ("buffalo",            "Buffalo",                   "US",   42.8800, -78.8700, 3.0),
    ("welland_south",      "Welland Canal (south)",     "CA",   42.8800, -79.2500, 2.0),
    ("welland_north",      "Welland Canal (north)",     "CA",   43.2150, -79.2050, 2.0),
    ("hamilton",           "Hamilton",                  "CA",   43.2700, -79.8500, 3.0),
    ("toronto",            "Toronto",                   "CA",   43.6500, -79.3600, 3.0),
    ("oshawa",             "Oshawa",                    "CA",   43.8550, -78.8250, 2.5),
    ("chicago",            "Chicago",                   "US",   41.8900, -87.6100, 3.5),
    ("milwaukee",          "Milwaukee",                 "US",   43.0400, -87.8900, 3.0),
    ("green_bay",          "Green Bay",                 "US",   44.5200, -88.0000, 3.0),
    ("escanaba",           "Escanaba",                  "US",   45.7450, -87.0500, 3.0),
    ("ludington",          "Ludington",                 "US",   43.9550, -86.4600, 2.5),
    ("muskegon",           "Muskegon",                  "US",   43.2300, -86.3400, 2.5),
    ("burns_harbor",       "Burns Harbor (Indiana)",    "US",   41.6450, -87.1500, 2.5),
    ("gary",               "Gary",                      "US",   41.6200, -87.2800, 2.5),
    ("conneaut",           "Conneaut",                  "US",   41.9700, -80.5500, 2.5),
    ("ashtabula",          "Ashtabula",                 "US",   41.9100, -80.7900, 2.5),
]


def open_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn


def seed_ports(conn: sqlite3.Connection) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO ports (key, name, country, lat, lon, geofence_radius_nm) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        PORTS_SEED,
    )


def state_get(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM index_state WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def state_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO index_state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def list_new_batches(last_id: str) -> list[Path]:
    """Batch files are named YYYYMMDDTHHMMSSZ.jsonl. Lex sort = time sort."""
    out = []
    for p in sorted(BATCH_DIR.glob("*.jsonl")):
        if p.name.startswith("latest"):
            continue
        bid = p.stem  # e.g. 20260527T001550Z
        if bid > last_id:
            out.append(p)
    return out


def upsert_vessel_minimal(conn, mmsi: int, name: str, ts: str) -> None:
    """Touch a vessel row with just MMSI + name from a position report."""
    if not mmsi:
        return
    name = (name or "").strip() or None
    conn.execute(
        """
        INSERT INTO vessels (mmsi, name, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(mmsi) DO UPDATE SET
          name       = COALESCE(NULLIF(excluded.name, ''), vessels.name),
          updated_at = excluded.updated_at
        """,
        (mmsi, name, ts),
    )


def upsert_vessel_static(conn, rec: dict) -> None:
    """A ShipStaticData record (full particulars)."""
    mmsi = rec.get("mmsi")
    if not mmsi:
        return
    name = (rec.get("name") or "").strip() or None
    ts = rec.get("ingested_at") or rec.get("ts")
    conn.execute(
        """
        INSERT INTO vessels (mmsi, imo, name, callsign, type, dim_a, dim_b, dim_c, dim_d,
                             draught, destination, eta, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mmsi) DO UPDATE SET
          imo         = COALESCE(excluded.imo,         vessels.imo),
          name        = COALESCE(NULLIF(excluded.name, ''), vessels.name),
          callsign    = COALESCE(NULLIF(excluded.callsign, ''), vessels.callsign),
          type        = COALESCE(excluded.type,        vessels.type),
          dim_a       = COALESCE(excluded.dim_a,       vessels.dim_a),
          dim_b       = COALESCE(excluded.dim_b,       vessels.dim_b),
          dim_c       = COALESCE(excluded.dim_c,       vessels.dim_c),
          dim_d       = COALESCE(excluded.dim_d,       vessels.dim_d),
          draught     = COALESCE(excluded.draught,     vessels.draught),
          destination = COALESCE(NULLIF(excluded.destination, ''), vessels.destination),
          eta         = COALESCE(NULLIF(excluded.eta, ''),         vessels.eta),
          updated_at  = excluded.updated_at
        """,
        (
            mmsi,
            rec.get("imo"),
            name,
            (rec.get("callsign") or "").strip() or None,
            rec.get("type"),
            rec.get("dim_a"),
            rec.get("dim_b"),
            rec.get("dim_c"),
            rec.get("dim_d"),
            rec.get("draught"),
            (rec.get("destination") or "").strip() or None,
            (rec.get("eta") or "").strip() or None,
            ts,
        ),
    )


def insert_position(conn, rec: dict, batch_id: str) -> None:
    mmsi = rec.get("mmsi")
    ts   = rec.get("ts") or rec.get("ingested_at")
    if not mmsi or not ts:
        return
    conn.execute(
        """
        INSERT OR IGNORE INTO positions (mmsi, ts, lat, lon, sog, cog, heading, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            mmsi, ts,
            rec.get("lat"), rec.get("lon"),
            rec.get("sog_knots"), rec.get("cog_deg"),
            rec.get("heading"), batch_id,
        ),
    )


def index_batch(conn: sqlite3.Connection, path: Path) -> tuple[int, int]:
    """Returns (positions_added, static_records)."""
    batch_id = path.stem
    pos_n = 0
    stat_n = 0
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = rec.get("kind", "")
            if kind == "ais.position":
                ts = rec.get("ts") or rec.get("ingested_at")
                upsert_vessel_minimal(conn, rec.get("mmsi"), rec.get("name", ""), ts)
                insert_position(conn, rec, batch_id)
                pos_n += 1
            elif kind == "ais.static":
                upsert_vessel_static(conn, rec)
                stat_n += 1
    return pos_n, stat_n


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in nautical miles. ~1% accurate for Great Lakes scale, plenty for geofencing."""
    R_NM = 3440.065  # Earth radius in nm
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_NM * math.asin(math.sqrt(a))


SOG_ARRIVED = 1.5   # knots — at or below, vessel is "in port"
SOG_DEPARTED = 2.0  # knots — at or above, vessel is "moving"


def detect_port_calls(conn: sqlite3.Connection) -> tuple[int, int]:
    """
    For each vessel's most-recent position (within last 6h), check every port:
      - If vessel is inside port radius AND slow AND no open call exists → open a new port_call
      - If an open call exists AND vessel is now outside radius AND moving → close it

    Returns (opened, closed).
    """
    ports = conn.execute(
        "SELECT key, lat, lon, geofence_radius_nm FROM ports"
    ).fetchall()

    # Latest position per vessel in the last 6 hours.
    latest = conn.execute(
        """
        SELECT p.mmsi, p.lat, p.lon, p.sog, p.ts
        FROM positions p
        JOIN (
          SELECT mmsi, MAX(ts) AS max_ts
          FROM positions
          WHERE ts > datetime('now', '-6 hours')
          GROUP BY mmsi
        ) m ON m.mmsi = p.mmsi AND m.max_ts = p.ts
        """
    ).fetchall()

    opened = 0
    closed = 0
    for mmsi, lat, lon, sog, ts in latest:
        if lat is None or lon is None:
            continue
        sog_v = sog if sog is not None else 0.0
        for port_key, plat, plon, radius_nm in ports:
            dist_nm = haversine_nm(lat, lon, plat, plon)
            in_port = dist_nm <= radius_nm

            open_call = conn.execute(
                "SELECT id, arrived_at FROM port_calls "
                "WHERE mmsi=? AND port_key=? AND departed_at IS NULL "
                "ORDER BY arrived_at DESC LIMIT 1",
                (mmsi, port_key),
            ).fetchone()

            if in_port and sog_v <= SOG_ARRIVED and not open_call:
                # Open a new port call. arrived_at = earliest position in the
                # last 3h where vessel was slow (rough; sufficient for the demo).
                row = conn.execute(
                    "SELECT MIN(ts) FROM positions "
                    "WHERE mmsi=? AND ts > datetime(?, '-3 hours') AND sog <= ?",
                    (mmsi, ts, SOG_ARRIVED),
                ).fetchone()
                arrived = (row[0] if row and row[0] else ts)
                cur = conn.execute(
                    "INSERT OR IGNORE INTO port_calls (mmsi, port_key, arrived_at) "
                    "VALUES (?, ?, ?)",
                    (mmsi, port_key, arrived),
                )
                if cur.rowcount:
                    opened += 1
            elif open_call and not in_port and sog_v >= SOG_DEPARTED:
                # Close the open call.
                pc_id, arrived_at = open_call
                dwell_min_row = conn.execute(
                    "SELECT CAST((julianday(?) - julianday(?)) * 24 * 60 AS INTEGER)",
                    (ts, arrived_at),
                ).fetchone()
                dwell_min = dwell_min_row[0] if dwell_min_row else None
                conn.execute(
                    "UPDATE port_calls SET departed_at=?, dwell_min=? WHERE id=?",
                    (ts, dwell_min, pc_id),
                )
                closed += 1

    return opened, closed


def main() -> None:
    if not BATCH_DIR.exists():
        sys.exit(f"[lakes_index] batches dir missing: {BATCH_DIR}")

    t0 = time.monotonic()
    conn = open_db()
    seed_ports(conn)

    last_id = state_get(conn, "last_batch_id", "")
    new_batches = list_new_batches(last_id)
    if not new_batches:
        print(f"[lakes_index] up to date (last_batch_id={last_id or 'none'})")
        return

    print(f"[lakes_index] indexing {len(new_batches)} batches (since {last_id or 'beginning'})")
    total_pos, total_stat = 0, 0
    conn.execute("BEGIN")
    try:
        for i, path in enumerate(new_batches, 1):
            pos, stat = index_batch(conn, path)
            total_pos += pos
            total_stat += stat
            state_set(conn, "last_batch_id", path.stem)
            if i % 200 == 0:
                conn.execute("COMMIT")
                conn.execute("BEGIN")
                elapsed = time.monotonic() - t0
                print(f"[lakes_index] {i}/{len(new_batches)} batches  pos={total_pos} stat={total_stat}  t={elapsed:.1f}s")
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    # Port-call detection runs after each indexing pass.
    opened, closed = detect_port_calls(conn)

    elapsed = time.monotonic() - t0
    n_vessels = conn.execute("SELECT COUNT(*) FROM vessels").fetchone()[0]
    n_pos     = conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
    n_calls   = conn.execute("SELECT COUNT(*) FROM port_calls").fetchone()[0]
    print(
        f"[lakes_index] done: {len(new_batches)} batches  +{total_pos} positions  +{total_stat} static  "
        f"calls(+{opened}/-{closed}) total_calls={n_calls}  "
        f"vessels_total={n_vessels} positions_total={n_pos} t={elapsed:.1f}s"
    )


if __name__ == "__main__":
    main()
