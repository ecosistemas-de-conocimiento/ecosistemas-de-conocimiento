#!/usr/bin/env python3
"""Smoke test for bge-m3-service.

Waits for /health to report the model READY (would have caught the pre-hardening
bug where /health said "ok" before the model was loaded), then sends one real
/embed request and validates the response against the exact shape the ai-service
sparse client parses (src/services/ai/embeddings/sparse-embed.ts):

    200  { model, dense: number[][], sparse: [ { indices: number[], values: number[] } ] }

Checks the sparse contract end-to-end: parallel indices/values, 0-based token ids
in [0, SPARSE_DIM) so the +1 shift in toSparsevecLiteral stays within the column
width, and a non-empty sparse vector (a constant/empty stub would fail). Dense is
validated as 1024-dim when present (default), tolerating BGE_M3_RETURN_DENSE=false.

Usage:
    python smoke_test.py [BASE_URL]        # default http://localhost:8000
    SMOKE_URL=http://host:8000 python smoke_test.py
    HEALTH_TIMEOUT_S=300 python smoke_test.py
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("SMOKE_URL", "http://localhost:8000")).rstrip("/")
HEALTH_TIMEOUT_S = float(os.getenv("HEALTH_TIMEOUT_S", "300"))
# Mirror ai-service env.SPARSE_DIM default; the +1-shifted index must stay < DIM.
SPARSE_DIM = int(os.getenv("SPARSE_DIM", "250002"))
DENSE_DIM = int(os.getenv("DENSE_DIM", "1024"))


def _fail(msg: str):
    print(f"SMOKE FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def _get(path: str, timeout: float = 5.0):
    req = urllib.request.Request(BASE_URL + path, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read() or b"{}")


def _post(path: str, body: dict, timeout: float = 180.0):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE_URL + path, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read() or b"{}")


def wait_ready():
    print(f"[1/2] waiting for {BASE_URL}/health to report ready (<= {HEALTH_TIMEOUT_S:.0f}s) ...")
    deadline = time.time() + HEALTH_TIMEOUT_S
    while time.time() < deadline:
        try:
            status, body = _get("/health")
            if status == 200 and body.get("ready") is True:
                print(f"      ready: {body}")
                return
        except (urllib.error.URLError, urllib.error.HTTPError, ConnectionError, OSError):
            pass
        time.sleep(2)
    _fail(f"/health never became ready within {HEALTH_TIMEOUT_S:.0f}s")


def check_embed():
    print("[2/2] POST /embed ...")
    inputs = ["Section 16 disclosure duties", "office hours"]
    try:
        status, body = _post("/embed", {"model": "baai/bge-m3", "input": inputs})
    except urllib.error.HTTPError as e:
        _fail(f"/embed returned HTTP {e.code}: {e.read()[:200]!r}")
    except Exception as e:  # noqa: BLE001
        _fail(f"/embed request errored: {e}")

    if status != 200:
        _fail(f"/embed status {status}, expected 200")

    dense = body.get("dense")
    sparse = body.get("sparse")
    if not isinstance(dense, list) or len(dense) != len(inputs):
        _fail(f"dense not a list of length {len(inputs)}: {type(dense)}")
    if not isinstance(sparse, list) or len(sparse) != len(inputs):
        _fail(f"sparse not a list of length {len(inputs)}: {type(sparse)}")

    for i, dv in enumerate(dense):
        if not isinstance(dv, list):
            _fail(f"dense[{i}] not a list")
        # Present-by-default; empty only when BGE_M3_RETURN_DENSE=false.
        if dv and len(dv) != DENSE_DIM:
            _fail(f"dense[{i}] is {len(dv)}-dim, expected {DENSE_DIM}")

    for i, sv in enumerate(sparse):
        idx = sv.get("indices")
        val = sv.get("values")
        if not isinstance(idx, list) or not isinstance(val, list):
            _fail(f"sparse[{i}] indices/values not both lists: {sv!r}")
        if len(idx) != len(val):
            _fail(f"sparse[{i}] indices({len(idx)}) / values({len(val)}) length mismatch")
        if not idx:
            _fail(f"sparse[{i}] is empty — model may be stubbed/broken")
        for t, w in zip(idx, val):
            if not isinstance(t, int) or not (0 <= t < SPARSE_DIM):
                _fail(f"sparse[{i}] token id {t} out of [0,{SPARSE_DIM}) — breaks the +1 sparsevec shift")
            if not isinstance(w, (int, float)) or not math.isfinite(w):
                _fail(f"sparse[{i}] weight not finite: {w!r}")

    print(f"      ok: dense[0] dim={len(dense[0]) if dense[0] else 0}, "
          f"sparse nnz per input={[len(s['indices']) for s in sparse]}")


if __name__ == "__main__":
    wait_ready()
    check_embed()
    print("SMOKE PASS")
