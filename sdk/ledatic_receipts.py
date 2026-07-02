#!/usr/bin/env python3
"""ledatic_receipts — signed, beacon-anchored receipts for any artifact.

Everyone else's AI says "trust me". This says "check me".

A receipt binds an artifact's SHA-256 to a public entropy-beacon pulse and a
timestamp, signed with YOUR Ed25519 key. Verification is fully offline — no
server, no account, no trust in Ledatic required.

Two grades:
  BARE     (free, offline)  — your signature over {digest, pulse, time}.
  ANCHORED (1 credit)       — additionally carries a Ledatic witness
           counter-signature: "we observed digest D at pulse N at time T".
           Backdate-proof and non-repudiable. Needs LEDATIC_SDK_API_KEY.

Usage:
  python3 ledatic_receipts.py keygen [key.hex]
  python3 ledatic_receipts.py pubkey [key.hex]
  python3 ledatic_receipts.py sign   <artifact> [out.json] [--anchor]
  python3 ledatic_receipts.py verify <artifact> <receipt.json> [--check-beacon]

Exit codes (scriptable, same as the Rail reference SDK):
  0 ok / 2 no api key / 3 out of credits / 4 unreachable / 5 digest mismatch
  6 bad signature / 7 key error / 8 pulse mismatch (forgery) / 9 unverifiable
  10 bad witness block

Env:
  LEDATIC_SDK_KEY         signing key file (default ~/.ledatic/sdk/key.hex)
  LEDATIC_SDK_API_KEY     lsk_… key for --anchor (buy at ledatic.org/receipts)
  LEDATIC_BEACON_URL      default https://ledatic.org/entropy/pulse
  LEDATIC_ANCHOR_URL      default https://ledatic.org/attest/witness
  LEDATIC_WITNESS_PUBKEY  pinned witness pubkey override (rotation/tests)

Dependency: `pip install cryptography` (Ed25519). Everything else is stdlib.
"""

import hashlib
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.request

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

__version__ = "0.1.0"

BEACON_URL = os.environ.get("LEDATIC_BEACON_URL", "https://ledatic.org/entropy/pulse")
ANCHOR_URL = os.environ.get("LEDATIC_ANCHOR_URL", "https://ledatic.org/attest/witness")
# Pinned Ledatic witness pubkey. Anchored receipts are checked against THIS
# constant, never against a pubkey carried inside the receipt (else forgeable).
WITNESS_PUBKEY = os.environ.get(
    "LEDATIC_WITNESS_PUBKEY",
    "45ad2e2d671eab439f1e201b9b52bc40803c3f09fd2553d1e751e4a9afe768a7",
)
DEFAULT_KEY = os.environ.get(
    "LEDATIC_SDK_KEY", os.path.expanduser("~/.ledatic/sdk/key.hex")
)
UA = {"User-Agent": f"ledatic-receipts/{__version__}"}


# ── crypto helpers ────────────────────────────────────────────────────────

def _seed_to_priv(seed_hex: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))


def _pubkey_hex(seed_hex: str) -> str:
    pub = _seed_to_priv(seed_hex).public_key()
    return pub.public_bytes(Encoding.Raw, PublicFormat.Raw).hex()


def _sign_hex(seed_hex: str, msg: bytes) -> str:
    return _seed_to_priv(seed_hex).sign(msg).hex()


def _verify(pubkey_hex: str, msg: bytes, sig_hex: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(pubkey_hex)).verify(
            bytes.fromhex(sig_hex), msg
        )
        return True
    except (InvalidSignature, ValueError):
        return False


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── key management ────────────────────────────────────────────────────────

def load_or_create_key(path: str = DEFAULT_KEY) -> str:
    if os.path.exists(path):
        seed = open(path).read().strip()
        if len(seed) == 64:
            return seed
        raise SystemExit(f"key file {path} is malformed (want 64 hex chars)")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    seed = Ed25519PrivateKey.generate().private_bytes(
        Encoding.Raw, PrivateFormat.Raw, NoEncryption()
    ).hex()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w") as f:
        f.write(seed + "\n")
    return seed


# ── beacon / anchor HTTP ──────────────────────────────────────────────────

def _get_json(url: str, timeout: int = 10):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_beacon(url: str = BEACON_URL) -> dict:
    return _get_json(url)


def anchor_witness(api_key: str, sha256: str, pulse_id: int, value_hex: str) -> dict:
    """POST the binding to the metered witness endpoint. Returns the witness
    block fields, or raises SystemExit with the SDK exit codes."""
    req = urllib.request.Request(
        ANCHOR_URL,
        data=json.dumps(
            {"sha256": sha256, "pulse_id": pulse_id, "value_hex": value_hex}
        ).encode(),
        headers={"content-type": "application/json", "x-sdk-key": api_key, **UA},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 402:
            print("anchor refused: out of credits (top up at ledatic.org/receipts)")
            raise SystemExit(3)
        if e.code == 401:
            print("anchor refused: invalid API key")
            raise SystemExit(2)
        print(f"anchor error: HTTP {e.code}")
        raise SystemExit(4)
    except (urllib.error.URLError, TimeoutError):
        print(f"anchor unreachable: {ANCHOR_URL}")
        raise SystemExit(4)


# ── canonical messages (MUST match the Rail SDK + worker byte-for-byte) ───

def receipt_message(digest: str, pulse_id, value_hex: str, created_at) -> bytes:
    return f"ledatic-receipt|v1|{digest}|{pulse_id}|{value_hex}|{created_at}".encode()


def witness_message(digest: str, pulse_id, value_hex: str, witnessed_at) -> bytes:
    return f"attest|v1|{digest}|{pulse_id}|{value_hex}|{witnessed_at}".encode()


# ── sign / verify (library API) ───────────────────────────────────────────

def sign(artifact: str, key_path: str = DEFAULT_KEY, anchor: bool = False) -> dict:
    """Build a receipt dict for `artifact`. anchor=True adds the Ledatic
    witness counter-signature (1 credit, needs LEDATIC_SDK_API_KEY)."""
    digest = sha256_file(artifact)
    size = os.path.getsize(artifact)
    pulse = fetch_beacon()
    pid, vhex = pulse["pulse_id"], pulse["value_hex"]

    seed = load_or_create_key(key_path)
    pubkey = _pubkey_hex(seed)
    created_at = int(time.time())
    sig = _sign_hex(seed, receipt_message(digest, pid, vhex, created_at))

    receipt = {
        "kind": "ledatic.receipt",
        "version": 1,
        "artifact": {
            "name": os.path.basename(artifact),
            "size_bytes": size,
            "sha256": digest,
        },
        "beacon": {
            "url": BEACON_URL,
            "pulse_id": pid,
            "value_hex": vhex,
            "timestamp_utc": pulse.get("timestamp_utc", ""),
        },
        "signer": {"alg": "ed25519", "pubkey_hex": pubkey, "pk_fp": pubkey[:16]},
        "sig": sig,
        "created_at": created_at,
    }

    if anchor:
        api_key = os.environ.get("LEDATIC_SDK_API_KEY", "")
        if not api_key:
            print("anchor requested (--anchor) but LEDATIC_SDK_API_KEY is not set")
            print("  buy a key at https://ledatic.org/receipts")
            raise SystemExit(2)
        w = anchor_witness(api_key, digest, pid, vhex)
        receipt["witness"] = {
            "alg": "ed25519",
            "pk_fp": w["pk_fp"],
            "witnessed_at": w["witnessed_at"],
            "sig": w["sig"],
        }
    return receipt


def verify(artifact: str, receipt: dict, check_beacon: bool = False) -> int:
    """Verify a receipt against an artifact. Returns 0 on success; nonzero
    SDK exit codes on failure (5/6/8/9/10). Fully offline unless check_beacon."""
    want = receipt["artifact"]["sha256"]
    have = sha256_file(artifact)
    if have != want:
        print(f"BAD  digest mismatch: file={have} receipt={want}")
        return 5

    pid = receipt["beacon"]["pulse_id"]
    vhex = receipt["beacon"]["value_hex"]
    msg = receipt_message(want, pid, vhex, receipt["created_at"])
    if not _verify(receipt["signer"]["pubkey_hex"], msg, receipt["sig"]):
        print("BAD  signature")
        return 6
    print(
        f"ok   artifact={receipt['artifact']['name']}  pulse_id={pid}"
        f"  pk_fp={receipt['signer']['pk_fp']}"
    )

    wit = receipt.get("witness")
    if wit:
        pin = WITNESS_PUBKEY
        if wit.get("pk_fp", "") != pin[:16]:
            print(
                f"BAD  witness key mismatch: receipt pk_fp={wit.get('pk_fp')}"
                f"  pinned={pin[:16]}"
            )
            return 10
        wmsg = witness_message(want, pid, vhex, wit["witnessed_at"])
        if not _verify(pin, wmsg, wit["sig"]):
            print("BAD  witness signature (forged or altered witness block)")
            return 10
        print(f"  +  Ledatic-witnessed at {wit['witnessed_at']} (pk_fp {wit['pk_fp']})")

    if check_beacon:
        try:
            chain = _get_json(f"{BEACON_URL}/{pid}")
        except Exception:
            print(f"     membership UNVERIFIABLE: {BEACON_URL}/{pid} unreachable")
            return 9
        if chain.get("pulse_id") != pid:
            print("     membership UNVERIFIABLE: endpoint returned wrong pulse")
            return 9
        if chain.get("value_hex") == vhex:
            print(f"     membership ok: pulse {pid} matches the public chain")
        else:
            print(
                f"BAD  membership mismatch: chain={chain.get('value_hex')}"
                f"  receipt={vhex}"
            )
            return 8
    return 0


# ── CLI ───────────────────────────────────────────────────────────────────

def _usage() -> int:
    print(__doc__.strip())
    return 0


def main(argv) -> int:
    if len(argv) < 1:
        return _usage()
    cmd, rest = argv[0], argv[1:]

    if cmd == "keygen":
        path = rest[0] if rest else DEFAULT_KEY
        if os.path.exists(path) and len(open(path).read().strip()) == 64:
            print(f"refusing: key already exists at {path}")
            print("  (delete it yourself to rotate — rotating invalidates every"
                  " receipt signed with the old key)")
            return 1
        seed = load_or_create_key(path)
        pub = _pubkey_hex(seed)
        print(f"key:    {path}")
        print(f"pubkey: {pub}")
        print(f"pk_fp:  {pub[:16]}")
        return 0

    if cmd == "pubkey":
        path = rest[0] if rest else DEFAULT_KEY
        if not os.path.exists(path):
            print(f"no key at {path} (run: keygen)")
            return 1
        print(_pubkey_hex(open(path).read().strip()))
        return 0

    if cmd == "sign":
        anchor = "--anchor" in rest
        pos = [a for a in rest if a != "--anchor"]
        if not pos:
            return _usage()
        artifact = pos[0]
        out = pos[1] if len(pos) > 1 else artifact + ".receipt.json"
        key_path = pos[2] if len(pos) > 2 else DEFAULT_KEY
        receipt = sign(artifact, key_path, anchor=anchor)
        with open(out, "w") as f:
            json.dump(receipt, f, indent=2)
            f.write("\n")
        extra = (
            f"  + witnessed at {receipt['witness']['witnessed_at']}"
            if "witness" in receipt
            else ""
        )
        print(
            f"receipt: {out}  pk_fp={receipt['signer']['pk_fp']}"
            f"  pulse_id={receipt['beacon']['pulse_id']}{extra}"
        )
        return 0

    if cmd == "verify":
        check = "--check-beacon" in rest
        pos = [a for a in rest if a != "--check-beacon"]
        if len(pos) < 2:
            return _usage()
        with open(pos[1]) as f:
            receipt = json.load(f)
        return verify(pos[0], receipt, check_beacon=check)

    return _usage()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
