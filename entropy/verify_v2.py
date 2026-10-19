#!/usr/bin/env python3
"""verify_v2.py: check Ledatic entropy beacon pulses (format 2) with nothing but public data.

Usage:
  verify_v2.py --url https://ledatic.org            # the newest 50 pulses, key fetched too
  verify_v2.py --url https://ledatic.org --from 9100000 --count 500
  verify_v2.py --file pulses.json --key beacon_v2.pub.pem
  verify_v2.py --dir ./archive --last 43200 --key beacon_v2.pub.pem

For every format 2 pulse it rebuilds the canonical message (spec: /entropy/spec), checks
that SHA-256 of it is value_hex, checks the operator's Ed25519 signature, checks that
prev_value_hex is the previous pulse's value_hex, and checks that SHA-256(local_random)
matches the previous pulse's precommit. Exit 0 when everything holds, 1 on the first
failure class found, 2 when the input could not be read.

Standard library only. Uses the `cryptography` package for signatures when it is
installed and falls back to the RFC 8032 reference arithmetic otherwise.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.request

UNCOMMITTED, FRAME_REPEAT, FORMAT_CHANGE = 16, 2, 32
SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")

# RFC 8032 section 6 reference verification, used only without `cryptography`.
P = 2**255 - 19
Q = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, -1, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def _recover_x(y, sign):
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, -1, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    return P - x if (x & 1) != sign else x


def _add(a, b):
    e1 = (a[1] - a[0]) * (b[1] - b[0]) % P
    e2 = (a[1] + a[0]) * (b[1] + b[0]) % P
    c = 2 * a[3] * b[3] * D % P
    d = 2 * a[2] * b[2] % P
    e, f, g, h = e2 - e1, d - c, d + c, e2 + e1
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s, pt):
    acc = (0, 1, 1, 0)
    while s:
        if s & 1:
            acc = _add(acc, pt)
        pt = _add(pt, pt)
        s >>= 1
    return acc


def _decompress(b):
    y = int.from_bytes(b, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)


_GY = 4 * pow(5, -1, P) % P
_G = (_recover_x(_GY, 0), _GY, 1, _recover_x(_GY, 0) * _GY % P)


def _ref_verify(pub, msg, sig):
    if len(pub) != 32 or len(sig) != 64:
        return False
    a, r = _decompress(pub), _decompress(sig[:32])
    s = int.from_bytes(sig[32:], "little")
    if a is None or r is None or s >= Q:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % Q
    lhs, rhs = _mul(s, _G), _add(r, _mul(h, a))
    return (lhs[0] * rhs[2] - rhs[0] * lhs[2]) % P == 0 and (lhs[1] * rhs[2] - rhs[1] * lhs[2]) % P == 0


def make_verifier(pub):
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        key = Ed25519PublicKey.from_public_bytes(pub)

        def check(msg, sig):
            try:
                key.verify(sig, msg)
                return True
            except InvalidSignature:
                return False
        return check, "cryptography"
    except ImportError:
        return (lambda msg, sig: _ref_verify(pub, msg, sig)), "rfc8032-reference"


def load_pubkey(pem):
    der = base64.b64decode("".join(ln for ln in pem.strip().splitlines() if "-----" not in ln))
    if len(der) != 44 or not der.startswith(SPKI_PREFIX):
        raise ValueError("not an Ed25519 SubjectPublicKeyInfo")
    return der[12:], hashlib.sha256(der).hexdigest()[:16]


def canonical(r):
    f = r["frame"]
    lines = ["ledatic-beacon/2", r["pulse_id"], r["unix_ms"], r["prev_value_hex"], f["digest"],
             f["run_frame"], f["epoch_seed"], f["epoch_frame"], r["local_random_hex"],
             r["precommit_hex"], r["external"], r["status"]]
    return "".join(f"{x}\n" for x in lines).encode()


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ledatic-verify-v2"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def verify(records, check, key_id):
    """Walk records in pulse order. Returns (counts, failures)."""
    n = {"pulses": 0, "v1": 0, "v2": 0, "hash": 0, "sig": 0, "links": 0, "precommits": 0,
         "uncommitted": 0, "gaps_in_input": 0}
    fails = []

    def fail(kind, pid, why):
        fails.append((kind, pid, why))

    prev = None
    for r in sorted(records, key=lambda x: x["pulse_id"]):
        pid = r["pulse_id"]
        n["pulses"] += 1
        consecutive = prev is not None and pid == prev["pulse_id"] + 1
        if prev is not None and not consecutive:
            n["gaps_in_input"] += 1
        if consecutive:
            n["links"] += 1
            if r["prev_value_hex"] != prev["value_hex"]:
                fail("link", pid, "prev_value_hex is not the previous pulse's value_hex")
        if r.get("version") != 2:
            n["v1"] += 1
            prev = r
            continue
        n["v2"] += 1
        msg = canonical(r)
        if hashlib.sha256(msg).hexdigest() == r["value_hex"]:
            n["hash"] += 1
        else:
            fail("hash", pid, "SHA-256(canonical message) != value_hex")
        if r.get("key_id") != key_id:
            fail("key", pid, f"key_id {r.get('key_id')} is not the published key {key_id}")
        try:
            sig_ok = check(msg, base64.b64decode(r["signature"]))
        except (ValueError, TypeError):
            sig_ok = False
        if sig_ok:
            n["sig"] += 1
        else:
            fail("signature", pid, "Ed25519 signature does not verify")
        if r["status"] & UNCOMMITTED:
            n["uncommitted"] += 1
        if consecutive:
            if prev.get("version") == 2:
                if not r["status"] & UNCOMMITTED:
                    n["precommits"] += 1
                    if hashlib.sha256(bytes.fromhex(r["local_random_hex"])).hexdigest() != prev["precommit_hex"]:
                        fail("precommit", pid, "SHA-256(local_random) != previous precommit_hex")
                if (r["frame"]["digest"] == prev["frame"]["digest"]) != bool(r["status"] & FRAME_REPEAT):
                    fail("status", pid, "FRAME_REPEAT bit disagrees with the digests")
            elif not r["status"] & FORMAT_CHANGE:
                fail("status", pid, "follows a format 1 pulse without FORMAT_CHANGE")
        prev = r
    return n, fails


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="beacon base URL, e.g. https://ledatic.org")
    src.add_argument("--file", help="JSON array of pulse records")
    src.add_argument("--dir", help="local archive directory (b<id/100000>/<id>.json)")
    ap.add_argument("--key", help="operator public key PEM (default: fetched from --url)")
    ap.add_argument("--from", dest="start", type=int, help="first pulse id (with --url or --dir)")
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--last", type=int, help="the newest N pulses (--dir)")
    ap.add_argument("-q", action="store_true", help="summary only")
    a = ap.parse_args()

    try:
        if a.key:
            with open(a.key) as fh:
                pem = fh.read()
        elif a.url:
            pem = fetch(a.url.rstrip("/") + "/entropy/v2/key").decode()
        else:
            raise ValueError("--key is required without --url")
        pub, key_id = load_pubkey(pem)
        if a.file:
            with open(a.file) as fh:
                records = json.load(fh)
        elif a.url:
            base = a.url.rstrip("/")
            if a.start is None:
                records = json.loads(fetch(base + "/entropy/pulse/log"))
            else:
                records = [json.loads(fetch(f"{base}/entropy/pulse/{i}")) for i in range(a.start, a.start + a.count)]
        else:
            root = os.path.expanduser(a.dir)
            if a.start is None:
                newest = max(int(b[1:]) for b in os.listdir(root) if b[1:].isdigit())
                top = max(int(f[:-5]) for f in os.listdir(f"{root}/b{newest}") if f[:-5].isdigit())
                a.start = top - (a.last or a.count) + 1
                a.count = a.last or a.count
            records = []
            for i in range(a.start, a.start + a.count):
                path = f"{root}/b{i // 100000}/{i}.json"
                if os.path.exists(path):
                    with open(path) as fh:
                        records.append(json.load(fh))
    except (OSError, ValueError, KeyError) as e:
        print(f"INCONCLUSIVE: could not read input: {e}")
        return 2

    check, how = make_verifier(pub)
    n, fails = verify(records, check, key_id)
    print(f"key {key_id} via {how}")
    print(" ".join(f"{k}={v}" for k, v in n.items()))
    kinds = sorted({k for k, _, _ in fails})
    for kind in kinds:
        first = next(f for f in fails if f[0] == kind)
        print(f"FAIL {kind}: {sum(1 for f in fails if f[0] == kind)} pulse(s), first {first[1]}: {first[2]}")
    if n["pulses"] == 0 or (n["v2"] and n["sig"] == 0):
        print("VERDICT=FAIL nothing was verified")
        return 1
    print("VERDICT=PASS" if not fails else "VERDICT=FAIL")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
