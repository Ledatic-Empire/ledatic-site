#!/usr/bin/env python3
"""lakes_ingest.py — AIS ingester for Great Lakes vessels.

Reads from aisstream.io if ~/.ledatic/lakes/aisstream_key exists, else falls back to
sim mode emitting plausible synthetic fixes so the rest of the pipeline can be
exercised end-to-end without a network/API dependency.

Appends one JSON record per line to ~/.ledatic/lakes/ais.jsonl. The attest
publisher rotates and signs that file on its own cadence.

Run:
    ./lakes_ingest.py              # live if key present, else sim
    ./lakes_ingest.py --sim        # force sim mode
    ./lakes_ingest.py --duration 60   # exit after N seconds (sim or live)

This is the only non-Rail component in the Lakes pipeline. Marked for
retirement when Rail stdlib gains a WebSocket client.
"""
from __future__ import annotations

import argparse
import json
import random
import signal
import sys
import time
from pathlib import Path

HOME = Path.home()
OUT = HOME / ".ledatic" / "lakes" / "ais.jsonl"
KEY_PATH = HOME / ".ledatic" / "lakes" / "aisstream_key"

# Lakes bounding box: SW (lat, lon) → NE (lat, lon)
LAKES_BBOX = [[41.5, -93.0], [49.0, -75.0]]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def append_record(rec: dict) -> None:
    rec["ingested_at"] = now_iso()
    with OUT.open("a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


# --- sim mode ----------------------------------------------------------------

# Per-vessel sim state. Each tick consumables decay; when one crosses a
# threshold a service call is scheduled at the assigned next port.
#
# (MMSI, name, type, base_lat, base_lon, sog, cog, next_port_key, eta_hours)
SIM_VESSELS = [
    (366999712, "EDGAR B SPEER",       "BulkCarrier", 46.5, -84.4, 12.5, 270, "duluth",       18),
    (367123456, "PAUL R TREGURTHA",    "BulkCarrier", 45.8, -83.4, 11.8,  90, "cleveland",    22),
    (366888888, "AMERICAN INTEGRITY",  "BulkCarrier", 41.7, -82.5, 10.2,  45, "toledo",        6),
    (316001234, "ALGOMA NIAGARA",      "BulkCarrier", 44.6, -82.8, 13.1, 180, "detroit",      11),
    (367556789, "BURNS HARBOR",        "BulkCarrier", 43.0, -87.9,  9.5, 135, "chicago",       4),
    (316019999, "CSL TADOUSSAC",       "BulkCarrier", 43.2, -78.7, 11.0, 300, "hamilton",      9),
]

PORTS = {
    "duluth":    {"name": "Duluth-Superior",     "lat": 46.78, "lon": -92.10},
    "saultste":  {"name": "Sault Ste. Marie",    "lat": 46.50, "lon": -84.36},
    "detroit":   {"name": "Detroit",             "lat": 42.33, "lon": -83.05},
    "cleveland": {"name": "Cleveland",           "lat": 41.50, "lon": -81.69},
    "toledo":    {"name": "Toledo",              "lat": 41.65, "lon": -83.53},
    "chicago":   {"name": "Chicago",             "lat": 41.85, "lon": -87.65},
    "milwaukee": {"name": "Milwaukee",           "lat": 43.04, "lon": -87.91},
    "hamilton":  {"name": "Hamilton, ON",        "lat": 43.26, "lon": -79.87},
    "thunder":   {"name": "Thunder Bay, ON",     "lat": 48.38, "lon": -89.25},
}

# Initialize per-MMSI consumable state once
_VESSEL_STATE: dict[int, dict] = {}


def _state_for(mmsi: int) -> dict:
    if mmsi not in _VESSEL_STATE:
        _VESSEL_STATE[mmsi] = {
            "fuel_pct":    round(random.uniform(35, 85), 1),
            "water_pct":   round(random.uniform(40, 90), 1),
            "holding_pct": round(random.uniform(10, 70), 1),
            "provisions_days": round(random.uniform(2.0, 9.0), 1),
        }
    return _VESSEL_STATE[mmsi]


def _decay(s: dict) -> None:
    s["fuel_pct"]        = max(2.0, round(s["fuel_pct"]    - random.uniform(0.02, 0.08), 2))
    s["water_pct"]       = max(2.0, round(s["water_pct"]   - random.uniform(0.05, 0.15), 2))
    s["holding_pct"]     = min(99.0, round(s["holding_pct"] + random.uniform(0.05, 0.15), 2))
    s["provisions_days"] = max(0.1, round(s["provisions_days"] - random.uniform(0.001, 0.004), 3))


def _services_due(s: dict) -> list[str]:
    out = []
    if s["fuel_pct"]    < 30: out.append("bunker")
    if s["water_pct"]   < 25: out.append("water")
    if s["holding_pct"] > 75: out.append("pump-out")
    if s["provisions_days"] < 3.5: out.append("provisions")
    return out


def sim_loop(duration: int | None) -> None:
    print(f"[lakes_ingest] sim mode (no key at {KEY_PATH}); writing to {OUT}", file=sys.stderr)
    started = time.time()
    while True:
        for mmsi, name, vtype, base_lat, base_lon, sog, cog, port_key, eta_h in SIM_VESSELS:
            st = _state_for(mmsi)
            _decay(st)
            jitter_lat = (random.random() - 0.5) * 0.02
            jitter_lon = (random.random() - 0.5) * 0.02
            port = PORTS[port_key]
            rec = {
                "kind": "ais.position",
                "source": "sim",
                "mmsi": mmsi,
                "name": name,
                "vessel_type": vtype,
                "lat": round(base_lat + jitter_lat, 6),
                "lon": round(base_lon + jitter_lon, 6),
                "sog_knots": round(sog + (random.random() - 0.5), 2),
                "cog_deg": cog,
                "ts": now_iso(),
                "ops": {
                    "next_port":      port["name"],
                    "next_port_key":  port_key,
                    "next_port_lat":  port["lat"],
                    "next_port_lon":  port["lon"],
                    "eta_hours":      eta_h,
                    "fuel_pct":       st["fuel_pct"],
                    "water_pct":      st["water_pct"],
                    "holding_pct":    st["holding_pct"],
                    "provisions_days": st["provisions_days"],
                    "services_due":   _services_due(st),
                },
            }
            append_record(rec)
        if duration is not None and (time.time() - started) >= duration:
            return
        time.sleep(2.0)


# --- live mode ---------------------------------------------------------------


def live_loop(api_key: str, duration: int | None) -> None:
    try:
        import websocket  # type: ignore
    except ImportError:
        print(
            "[lakes_ingest] live mode requires websocket-client. "
            "Install: pip3 install websocket-client. Falling back to sim.",
            file=sys.stderr,
        )
        return sim_loop(duration)

    print(f"[lakes_ingest] live mode → aisstream.io; writing to {OUT}", file=sys.stderr)
    started = time.time()
    subscribe_msg = json.dumps(
        {
            "APIKey": api_key,
            "BoundingBoxes": [LAKES_BBOX],
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
        }
    )

    def on_open(ws):
        ws.send(subscribe_msg)

    def on_message(ws, raw):
        try:
            msg = json.loads(raw)
        except Exception:
            return
        meta = msg.get("MetaData", {}) or {}
        body = msg.get("Message", {}) or {}
        if "PositionReport" in body:
            p = body["PositionReport"]
            rec = {
                "kind": "ais.position",
                "source": "aisstream",
                "mmsi": meta.get("MMSI"),
                "name": (meta.get("ShipName") or "").strip(),
                "lat": p.get("Latitude"),
                "lon": p.get("Longitude"),
                "sog_knots": p.get("Sog"),
                "cog_deg": p.get("Cog"),
                "ts": meta.get("time_utc") or now_iso(),
            }
            append_record(rec)
        elif "ShipStaticData" in body:
            s = body["ShipStaticData"]
            rec = {
                "kind": "ais.static",
                "source": "aisstream",
                "mmsi": meta.get("MMSI"),
                "name": (meta.get("ShipName") or "").strip(),
                "imo": s.get("ImoNumber"),
                "type": s.get("Type"),
                "destination": (s.get("Destination") or "").strip(),
                "ts": meta.get("time_utc") or now_iso(),
            }
            append_record(rec)
        if duration is not None and (time.time() - started) >= duration:
            ws.close()

    def on_error(_ws, err):
        print(f"[lakes_ingest] ws error: {err}", file=sys.stderr)

    app = websocket.WebSocketApp(
        "wss://stream.aisstream.io/v0/stream",
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
    )
    app.run_forever(ping_interval=20, ping_timeout=10)


# --- entrypoint --------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", action="store_true", help="force sim mode")
    ap.add_argument("--duration", type=int, default=None, help="exit after N seconds")
    args = ap.parse_args()

    OUT.parent.mkdir(parents=True, exist_ok=True)

    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    if not args.sim and KEY_PATH.exists() and KEY_PATH.stat().st_size > 0:
        key = KEY_PATH.read_text().strip()
        if key and not key.startswith("#"):
            live_loop(key, args.duration)
            return 0
    sim_loop(args.duration)
    return 0


if __name__ == "__main__":
    sys.exit(main())
