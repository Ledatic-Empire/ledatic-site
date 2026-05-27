#!/usr/bin/env python3.11
"""
Lakes AI proxy — exposes a thin localhost HTTP API the Cloudflare Tunnel
forwards from lakes-fleet.ledatic.org to Mini, which then talks to Studio's
122B over the TB mesh.

Endpoints:
  POST /ai/ask    {"question": "..."}  → {"answer": "...", "elapsed_s": F}
  POST /ai/brief  (no body)             → triggers brief generation
  GET  /health                           → {"ok": true}

Auth: every request needs header
  x-lakes-token: <contents of ~/.ledatic/lakes_fleet_token>

Listens on localhost:9110. cloudflared (signal-feed tunnel) routes
lakes-fleet.ledatic.org → http://localhost:9110.

For the Phase 5 v1 the answer call is single-turn: we synthesize a SQL-derived
context bundle into the prompt and let the 122B answer in one pass. Tool-loop
can layer in later.
"""
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME      = Path.home()
DB_PATH   = HOME / ".ledatic" / "lakes" / "lakes.db"
TOKEN_F   = HOME / ".ledatic" / "lakes_fleet_token"
LLM_URL   = "http://10.42.0.2:8082/v1/chat/completions"
LLM_MODEL = "/Users/user/models/Qwen3.5-122B-A10B-heretic-v2-2.34bit-msq"
LISTEN    = ("127.0.0.1", 9110)

ASK_SYSTEM = (
    "You are the on-shore operations analyst for a Great Lakes shipping fleet "
    "viewer. You answer the user's question using ONLY the context block "
    "below — never fabricate vessels, port calls, or details that aren't in "
    "the context. If the answer isn't in the context, say so plainly. Use the "
    "vessel/port names exactly as they appear. Reply in two short paragraphs "
    "or fewer. No headers, no bullet lists, no preamble — just the answer."
)


def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def build_context(conn: sqlite3.Connection) -> str:
    """Compact representation of fleet state for inclusion in prompts."""
    lines = []

    total_active = conn.execute(
        "SELECT COUNT(DISTINCT mmsi) FROM positions WHERE ts > datetime('now', '-24 hours')"
    ).fetchone()[0]
    lines.append(f"Active vessels (last 24h): {total_active}")

    # Currently underway (last 2h, sog > 4kt)
    moving = conn.execute(
        """
        SELECT v.name, v.destination, pos.sog, pos.cog, pos.lat, pos.lon, pos.ts,
               v.type
        FROM vessels v
        JOIN (SELECT mmsi, MAX(ts) AS max_ts FROM positions
              WHERE ts > datetime('now', '-2 hours') GROUP BY mmsi) m
          ON m.mmsi = v.mmsi
        JOIN positions pos ON pos.mmsi = v.mmsi AND pos.ts = m.max_ts
        WHERE v.name IS NOT NULL AND pos.sog > 4.0
        ORDER BY pos.sog DESC LIMIT 30
        """
    ).fetchall()
    if moving:
        lines.append("")
        lines.append("Currently underway (vessel — destination — speed):")
        for v in moving:
            dest = v["destination"] or "—"
            lines.append(f"- {v['name']} — {dest} — {v['sog']:.1f} kt")

    # In-port right now (open port calls)
    in_port = conn.execute(
        """
        SELECT v.name AS vessel, p.name AS port, pc.arrived_at
        FROM port_calls pc
        JOIN vessels v ON v.mmsi = pc.mmsi
        JOIN ports p   ON p.key = pc.port_key
        WHERE pc.departed_at IS NULL AND v.name IS NOT NULL
        ORDER BY pc.arrived_at DESC LIMIT 30
        """
    ).fetchall()
    if in_port:
        lines.append("")
        lines.append("In port right now (vessel — port — arrived):")
        for c in in_port:
            lines.append(f"- {c['vessel']} — {c['port']} — {c['arrived_at']}")

    # Recent closed port calls
    closed = conn.execute(
        """
        SELECT v.name AS vessel, p.name AS port, pc.arrived_at, pc.departed_at, pc.dwell_min
        FROM port_calls pc
        JOIN vessels v ON v.mmsi = pc.mmsi
        JOIN ports p   ON p.key = pc.port_key
        WHERE pc.departed_at > datetime('now', '-24 hours') AND v.name IS NOT NULL
        ORDER BY pc.departed_at DESC LIMIT 20
        """
    ).fetchall()
    if closed:
        lines.append("")
        lines.append("Completed port calls (last 24h, vessel — port — dwell minutes):")
        for c in closed:
            dw = c["dwell_min"] if c["dwell_min"] is not None else "?"
            lines.append(f"- {c['vessel']} — {c['port']} — {dw} min")

    return "\n".join(lines)


def call_llm(question: str, ctx: str, max_tokens: int = 600) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": ASK_SYSTEM},
            {"role": "user", "content": f"Context:\n\n{ctx}\n\nQuestion: {question}"},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
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


# ─── HTTP handler ────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "lakes-ai-proxy/1"

    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self) -> bool:
        token = self.headers.get("x-lakes-token", "")
        expected = TOKEN_F.read_text().strip()
        return bool(token) and token == expected

    def log_message(self, fmt, *args):
        sys.stderr.write("[lakes_ai_proxy] " + fmt % args + "\n")

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "name": "lakes-ai-proxy"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth_ok():
            return self._json(401, {"error": "unauthorized"})
        ln = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(ln) if ln > 0 else b"{}"
        try:
            req = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad json"})

        if self.path == "/ai/ask":
            q = (req.get("question") or "").strip()
            if not q or len(q) > 500:
                return self._json(400, {"error": "question must be 1-500 chars"})
            t0 = time.monotonic()
            try:
                conn = open_db()
                ctx = build_context(conn)
                answer = call_llm(q, ctx)
            except (urllib.error.URLError, OSError) as e:
                return self._json(502, {"error": f"llm: {e}"})
            elapsed = time.monotonic() - t0
            return self._json(200, {
                "answer": answer.strip(),
                "context_chars": len(ctx),
                "elapsed_s": round(elapsed, 1),
            })

        self._json(404, {"error": "not found"})


def main() -> None:
    if not DB_PATH.exists():
        sys.exit(f"[lakes_ai_proxy] db missing: {DB_PATH}")
    if not TOKEN_F.exists():
        sys.exit(f"[lakes_ai_proxy] token missing: {TOKEN_F}")

    httpd = ThreadingHTTPServer(LISTEN, Handler)
    print(f"[lakes_ai_proxy] listening on http://{LISTEN[0]}:{LISTEN[1]}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
