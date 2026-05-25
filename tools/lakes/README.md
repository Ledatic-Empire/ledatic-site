# Lakes — AIS pipeline + signed-batch publisher

Live, attested vessel traffic for the Great Lakes. Powers the
password-gated demo at <https://ledatic.org/greatlakes>.

## Components

| File | Role |
|---|---|
| `lakes_ingest.py` | Python WebSocket bridge to `aisstream.io`. Falls back to sim mode (6 named lakers with decaying consumables) when no API key is present. Appends one JSON record per line to `~/.ledatic/lakes/ais.jsonl`. The only non-Rail component — retire when Rail stdlib gains WebSocket. |
| `lakes_attest_publisher.sh` | Mirrors the proven `frame_attest_publisher.sh` pattern. Every tick: atomic-rotate `ais.jsonl` → `~/.ledatic/lakes/batches/<batch_id>.jsonl`, sha256 it, witness via `fleet0` Ed25519, write `<batch_id>.attestation.json`. With `--publish`, also PUTs four keys to `/greatlakes/ais/` on ledatic.org (dated batch + dated attestation + `latest` aliases for both). |
| `launchagents/com.ledatic.lakes_ingest.plist` | KeepAlive=true. Always-running ingest. |
| `launchagents/com.ledatic.lakes_attest.plist` | StartInterval=30s. Sign + publish each batch. |

## Files on disk (runtime, not in repo)

- `~/.ledatic/lakes/ais.jsonl` — live append target (rotated every tick)
- `~/.ledatic/lakes/batches/<batch_id>.{jsonl,attestation.json}` — signed history
- `~/.ledatic/lakes/batches/latest.{jsonl,attestation.json}` — symlinks to most recent
- `~/.ledatic/lakes/aisstream_key` — drop your free [aisstream.io](https://aisstream.io) key here (chmod 600) to switch from sim → live. **Zero code change** required.

## Install LaunchAgents

```bash
cp tools/lakes/launchagents/com.ledatic.lakes_*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ledatic.lakes_ingest.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ledatic.lakes_attest.plist
launchctl list | grep ledatic.lakes        # confirm both running
```

Restart after edits:
```bash
launchctl bootout    gui/$(id -u)/com.ledatic.lakes_attest
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.ledatic.lakes_attest.plist
```

Logs:
```bash
tail -f ~/.ledatic/lakes/ingest.log ~/.ledatic/lakes/attest.log
```

## Worker secret (one-time, before the demo is reachable)

```bash
wrangler secret put GREATLAKES_PASS    # pick any password
# or CF dashboard → Workers → Settings → Variables and Secrets
```

Without `GREATLAKES_PASS`, `/greatlakes` returns `503 demo not configured` —
the page is structurally locked away by default.

## Deploy the page

```bash
CF_TOKEN=$(cat ~/Desktop/rings) ../../deploy.sh greatlakes.html
```

Single-file form skips `deploy_all` (which would push every `*.html`,
including any in-progress merge conflicts elsewhere in the tree).

## Verify a signed batch (any third party, no auth)

The data path is gated, so the verifier needs Basic auth too:

```bash
PASS=...                  # the password you set above
curl -sf -u demo:$PASS https://ledatic.org/greatlakes/ais/latest.jsonl              -o /tmp/b.jsonl
curl -sf -u demo:$PASS https://ledatic.org/greatlakes/ais/latest.attestation.json   -o /tmp/b.att.json
curl -sf https://ledatic.org/attest/verify.sh -o /tmp/v.sh && chmod +x /tmp/v.sh
/tmp/v.sh /tmp/b.jsonl /tmp/b.att.json
# → ok artifact=lakes/ais/<batch_id>.jsonl pulse_id=… pk_fp=cac5f21a70564aeb
```
