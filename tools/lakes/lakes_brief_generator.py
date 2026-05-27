#!/usr/bin/env python3.11
"""
Daily Great Lakes brief generator.

Reads current state from ~/.ledatic/lakes/lakes.db, assembles a compact context
summary, calls the 122B at Studio (10.42.0.2:8082, mlx_lm.server), and PUTs the
result as JSON to ledatic.org/greatlakes/data/brief.json.

The main page fetches this and renders it at the top.
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
LLM_URL   = "http://10.42.0.2:8082/v1/chat/completions"
LLM_MODEL = "/Users/user/models/Qwen3.5-122B-A10B-heretic-v2-2.34bit-msq"
PUT_URL   = "https://ledatic.org/greatlakes/data/brief.json"

SYSTEM = (
    "You are a maritime operations analyst writing a concise daily brief for "
    "the Great Lakes shipping operator's dashboard. Write in plain, punchy "
    "prose. Two short paragraphs maximum. Lead with the most useful fact. "
    "Mention vessel names exactly as given. No bullet lists, no headers, no "
    "preamble — just the brief."
)


def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def gather_context(conn: sqlite3.Connection) -> dict:
    active = conn.execute(
        "SELECT COUNT(DISTINCT mmsi) FROM positions WHERE ts > datetime('now', '-24 hours')"
    ).fetchone()[0]

    calls_24h = conn.execute(
        "SELECT COUNT(*) FROM port_calls WHERE arrived_at > datetime('now', '-24 hours')"
    ).fetchone()[0]

    recent_calls = conn.execute(
        """
        SELECT v.name AS vessel, p.name AS port, pc.arrived_at, pc.departed_at, pc.dwell_min
        FROM port_calls pc
        JOIN vessels v ON v.mmsi = pc.mmsi
        JOIN ports p   ON p.key = pc.port_key
        WHERE pc.arrived_at > datetime('now', '-24 hours') AND v.name IS NOT NULL
        ORDER BY pc.arrived_at DESC
        LIMIT 12
        """
    ).fetchall()

    notable = conn.execute(
        """
        SELECT v.name AS vessel, v.destination, v.draught, v.type,
               pos.sog, pos.cog, pos.lat, pos.lon
        FROM vessels v
        JOIN (
          SELECT mmsi, MAX(ts) AS max_ts FROM positions
          WHERE ts > datetime('now', '-2 hours')
          GROUP BY mmsi
        ) m ON m.mmsi = v.mmsi
        JOIN positions pos ON pos.mmsi = v.mmsi AND pos.ts = m.max_ts
        WHERE v.name IS NOT NULL AND v.imo IS NOT NULL AND v.imo > 0
          AND pos.sog > 5.0
        ORDER BY pos.sog DESC
        LIMIT 12
        """
    ).fetchall()

    return {
        "active_vessels": active,
        "calls_24h": calls_24h,
        "recent_calls": [dict(r) for r in recent_calls],
        "notable_moving": [dict(r) for r in notable],
    }


def render_context_text(ctx: dict) -> str:
    lines = [
        f"Snapshot: {ctx['active_vessels']} vessels active in the last 24 hours, "
        f"{ctx['calls_24h']} port calls in that window.",
        "",
    ]
    if ctx["recent_calls"]:
        lines.append("Recent port calls:")
        for c in ctx["recent_calls"]:
            status = "in port" if not c["departed_at"] else f"departed (dwell {c['dwell_min']}m)"
            lines.append(f"- {c['vessel']} → {c['port']} ({status})")
        lines.append("")
    if ctx["notable_moving"]:
        lines.append("Notable vessels currently underway (last 2h):")
        for v in ctx["notable_moving"]:
            dest = f" → {v['destination']}" if v["destination"] else ""
            lines.append(f"- {v['vessel']}{dest} at {v['sog']:.1f} kt")
    return "\n".join(lines)


def call_llm(prompt: str) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user",   "content": prompt},
        ],
        "max_tokens": 600,
        "temperature": 0.5,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        LLM_URL, data=body, method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        d = json.loads(resp.read())
    return d["choices"][0]["message"].get("content") or ""


def put_brief(payload: dict, token: str) -> tuple[int, str]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(
        PUT_URL, data=body, method="PUT",
        headers={
            "x-beacon-token": token,
            "content-type": "application/json",
            "user-agent": "lakes-brief-generator/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read(64).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(128).decode(errors="replace")


def main() -> None:
    if not TOKEN_F.exists():
        sys.exit(f"[lakes_brief] beacon token missing: {TOKEN_F}")
    token = TOKEN_F.read_text().strip()

    t0 = time.monotonic()
    conn = open_db()
    ctx = gather_context(conn)
    ctx_text = render_context_text(ctx)

    prompt = (
        f"Write a two-paragraph operations brief for the Great Lakes fleet "
        f"based on the snapshot below. Maximum 110 words. Use the vessel and "
        f"port names exactly as given. No bullet points or headers.\n\n{ctx_text}"
    )

    print("[lakes_brief] generating brief…", file=sys.stderr)
    try:
        content = call_llm(prompt)
    except (urllib.error.URLError, OSError, KeyError) as e:
        sys.exit(f"[lakes_brief] llm call failed: {e}")

    payload = {
        "kind": "lakes.brief",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": LLM_MODEL.split("/")[-1],
        "content": content.strip(),
        "context": {
            "active_vessels": ctx["active_vessels"],
            "calls_24h":      ctx["calls_24h"],
        },
    }
    status, body = put_brief(payload, token)
    elapsed = time.monotonic() - t0
    print(
        f"[lakes_brief] put {status} in {elapsed:.1f}s, "
        f"content chars={len(content)}, ctx_active={ctx['active_vessels']}, "
        f"ctx_calls={ctx['calls_24h']}",
        flush=True,
    )
    if status != 200:
        print(f"[lakes_brief] put failed body: {body}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
