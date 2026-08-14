#!/usr/bin/env python3
"""Smoke test for rerank-service.

Waits for /health to report the model READY (would have caught the pre-hardening
bug where /health said "ok" before the model was loaded), then sends one real
/rerank request and validates the response against the exact shape the ai-service
rerank client parses (src/services/ai/rerank/rerank-client.ts):

    200  { model, results: [ { index, relevance_score } ] }   # index into documents

Also checks the model actually reranks (the relevant document must win) so a
constant-score stub would fail.

Usage:
    python smoke_test.py [BASE_URL]        # default http://localhost:8000
    SMOKE_URL=http://host:8000 python smoke_test.py
    HEALTH_TIMEOUT_S=300 python smoke_test.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("SMOKE_URL", "http://localhost:8000")).rstrip("/")
HEALTH_TIMEOUT_S = float(os.getenv("HEALTH_TIMEOUT_S", "300"))


def _fail(msg: str):
    print(f"SMOKE FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def _get(path: str, timeout: float = 5.0):
    req = urllib.request.Request(BASE_URL + path, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read() or b"{}")


def _post(path: str, body: dict, timeout: float = 120.0):
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


def check_rerank():
    print("[2/2] POST /rerank ...")
    documents = [
        "To reset your password, open Settings > Security.",   # 0 — relevant
        "Our office is open Monday to Friday.",                 # 1
        "The mitochondria is the powerhouse of the cell.",      # 2
    ]
    try:
        status, body = _post("/rerank", {
            "model": "baai/bge-reranker-v2-m3",
            "query": "how do I reset my password?",
            "documents": documents,
            "top_n": 2,
        })
    except urllib.error.HTTPError as e:
        _fail(f"/rerank returned HTTP {e.code}: {e.read()[:200]!r}")
    except Exception as e:  # noqa: BLE001
        _fail(f"/rerank request errored: {e}")

    if status != 200:
        _fail(f"/rerank status {status}, expected 200")
    if not isinstance(body.get("results"), list):
        _fail(f"results is not a list: {body!r}")
    results = body["results"]
    if not results:
        _fail("results empty")
    if len(results) > 2:
        _fail(f"top_n=2 not honored: got {len(results)} results")

    scores = []
    for r in results:
        if not isinstance(r.get("index"), int):
            _fail(f"result index not int: {r!r}")
        if not (0 <= r["index"] < len(documents)):
            _fail(f"result index {r['index']} out of range")
        if not isinstance(r.get("relevance_score"), (int, float)):
            _fail(f"relevance_score not a number: {r!r}")
        if not (0.0 <= r["relevance_score"] <= 1.0):
            _fail(f"relevance_score {r['relevance_score']} outside 0..1 (normalize=True expected)")
        scores.append(r["relevance_score"])

    if scores != sorted(scores, reverse=True):
        _fail(f"results not sorted by relevance_score desc: {scores}")
    if results[0]["index"] != 0:
        _fail(f"reranker did not rank the relevant doc first (got index {results[0]['index']}) "
              f"— model may be stubbed/broken: {results!r}")

    print(f"      ok: top={results[0]}, scores={scores}")


if __name__ == "__main__":
    wait_ready()
    check_rerank()
    print("SMOKE PASS")
