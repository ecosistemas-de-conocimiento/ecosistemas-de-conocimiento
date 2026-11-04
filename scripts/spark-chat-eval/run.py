#!/usr/bin/env python3
"""Run the assembled chat prompts on hosted (dev ai-service) and on the Spark.

Stdlib only. Reads prompts.json from build-prompts.ts. Writes one JSON per call.

  hosted: POST <ai>/v1/generate/stream, effortLevel standard — the exact path
          and wire dev's web uses (DeepSeek V3.1 via OpenRouter, temp 0.4, 800 out).
  spark:  POST <spark>/v1/chat/completions, stream, same system+user messages,
          temperature 0.4, max_tokens 800 (Qwen3-30B-A3B-Instruct-2507, non-thinking).
  condense (followups only): the recorded condense messages replayed on the
          Spark, temp 0.3, max_tokens 400 (ai-service `quick` profile; the
          engine's 80 is never sent). Hosted condense time comes from the
          build step's real call (a replay through ai-service would hit its cache).

Usage:
  run.py seq  PROMPTS OUT.jsonl            # each turn: hosted then Spark, one at a time
  run.py conc PROMPTS OUT.jsonl N [gate]   # N Spark answers at once (+1 gate-sized call)
Env: AI_URL, AI_KEY_FILE, SPARK_URL, SPARK_TOKEN_FILE, SPARK_SSH_HOST.
"""
import json, os, sys, time, threading, http.client, urllib.parse

AI_URL = os.environ["AI_URL"]
AI_KEY = open(os.environ["AI_KEY_FILE"]).read().strip()
SPARK_URL = os.environ["SPARK_URL"]
SPARK_TOKEN = open(os.environ["SPARK_TOKEN_FILE"]).read().strip()
SPARK_MODEL = "qwen3-30b-a3b-instruct-2507"


def _conn(url):
    u = urllib.parse.urlparse(url)
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    return cls(u.hostname, u.port, timeout=180), u.path.rstrip("/")


def _sse(resp):
    """Yield the JSON payload of each `data:` line."""
    buf = b""
    while True:
        chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(1024)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if line.startswith(b"data:"):
                data = line[5:].strip()
                if data == b"[DONE]":
                    return
                yield json.loads(data)


def hosted(turn):
    conn, base = _conn(AI_URL)
    body = {
        "unit": {
            "unitKey": f"spark-eval-{turn['id']}-{time.time_ns()}",
            "unitType": "chat",
            "input": {"userPrompt": turn["userPrompt"]},
            "systemPrompt": turn["systemPrompt"],
            "specOverride": {"promptTemplate": "{{{userPrompt}}}"},
        },
        "effortLevel": "standard",
    }
    hdr = {"authorization": f"Bearer {AI_KEY}", "x-ai-org": f"eco-{turn['org']}",
           "content-type": "application/json", "accept": "text/event-stream"}
    t0 = time.perf_counter()
    conn.request("POST", base + "/v1/generate/stream", json.dumps(body), hdr)
    resp = conn.getresponse()
    if resp.status != 200:
        return {"error": f"http {resp.status}: {resp.read()[:300]!r}", "total_s": time.perf_counter() - t0}
    ttft, text, done = None, [], None
    for ev in _sse(resp):
        if ev.get("type") == "delta":
            if ttft is None and ev.get("text"):
                ttft = time.perf_counter() - t0
            text.append(ev.get("text", ""))
        elif ev.get("type") == "done":
            done = ev
        elif ev.get("type") == "error":
            return {"error": json.dumps(ev)[:300], "total_s": time.perf_counter() - t0}
    total = time.perf_counter() - t0
    usage = (done or {}).get("usage") or {}
    return {"ttft_s": ttft, "total_s": total, "text": "".join(text),
            "out_tokens": usage.get("outputTokens"), "in_tokens": usage.get("inputTokens"),
            "model": (done or {}).get("modelUsed"), "finish": (done or {}).get("finishReason"),
            "cached": (done or {}).get("cached")}


NO_PREFIX_CACHE = False  # conc mode: re-prefill every prompt (seq already warmed the cache)


def spark_chat(messages, max_tokens, temperature, stream=True):
    conn, base = _conn(SPARK_URL)
    body = {"model": SPARK_MODEL, "messages": messages, "max_tokens": max_tokens,
            "temperature": temperature, "stream": stream}
    if NO_PREFIX_CACHE:
        body["cache_prompt"] = False
    if stream:
        body["stream_options"] = {"include_usage": True}
    hdr = {"authorization": f"Bearer {SPARK_TOKEN}", "content-type": "application/json"}
    t0 = time.perf_counter()
    conn.request("POST", base + "/v1/chat/completions", json.dumps(body), hdr)
    resp = conn.getresponse()
    if resp.status != 200:
        return {"error": f"http {resp.status}: {resp.read()[:300]!r}", "total_s": time.perf_counter() - t0}
    if not stream:
        d = json.loads(resp.read())
        return {"total_s": time.perf_counter() - t0, "text": d["choices"][0]["message"]["content"],
                "out_tokens": d.get("usage", {}).get("completion_tokens"),
                "in_tokens": d.get("usage", {}).get("prompt_tokens")}
    ttft, text, usage, finish, timings = None, [], {}, None, None
    for ev in _sse(resp):
        for ch in ev.get("choices") or []:
            piece = (ch.get("delta") or {}).get("content")
            if piece:
                if ttft is None:
                    ttft = time.perf_counter() - t0
                text.append(piece)
            finish = ch.get("finish_reason") or finish
        if ev.get("usage"):
            usage = ev["usage"]
        if ev.get("timings"):
            timings = ev["timings"]
    return {"ttft_s": ttft, "total_s": time.perf_counter() - t0, "text": "".join(text),
            "out_tokens": usage.get("completion_tokens"), "in_tokens": usage.get("prompt_tokens"),
            "finish": finish, "model": SPARK_MODEL,
            "gen_tok_s": (timings or {}).get("predicted_per_second"),
            "prompt_tok_s": (timings or {}).get("prompt_per_second")}


def spark_answer(turn):
    return spark_chat([{"role": "system", "content": turn["systemPrompt"]},
                       {"role": "user", "content": turn["userPrompt"]}], 800, 0.4)


def spark_slots():
    """Busy slots on the Spark's llama-server, via the proxy (no /slots there): ssh instead."""
    try:
        import subprocess
        out = subprocess.run(["ssh", "-o", "BatchMode=yes", os.environ["SPARK_SSH_HOST"],
                              "curl -s localhost:8180/slots"], capture_output=True, timeout=20, text=True).stdout
        return sum(1 for s in json.loads(out) if s.get("is_processing"))
    except Exception as e:  # noqa: BLE001 — informational only
        return f"unknown ({e.__class__.__name__})"


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def main():
    mode, prompts_path, out_path = sys.argv[1:4]
    turns = json.load(open(prompts_path))["turns"]
    out = open(out_path, "a")
    if mode == "seq":
        for t in turns:
            busy = spark_slots()
            rec = {"id": t["id"], "at": stamp(), "spark_busy_slots_before": busy,
                   "hosted": hosted(t), "spark": spark_answer(t)}
            if t.get("condense"):
                c = t["condense"]
                sc = spark_chat(c["messages"], 400, 0.3, stream=False)
                rec["condense"] = {"hosted_text": c["hostedText"], "hosted_total_s": c["ms"] / 1000, "spark": sc}
            out.write(json.dumps(rec, ensure_ascii=False) + "\n"); out.flush()
            h, s = rec["hosted"], rec["spark"]
            print(f"{t['id']}: hosted ttft={h.get('ttft_s')} total={h.get('total_s'):.1f} out={h.get('out_tokens')} | "
                  f"spark ttft={s.get('ttft_s')} total={s.get('total_s'):.1f} out={s.get('out_tokens')} busy={busy}", flush=True)
    elif mode == "conc":
        global NO_PREFIX_CACHE
        NO_PREFIX_CACHE = True
        n = int(sys.argv[4])
        gate = len(sys.argv) > 5 and sys.argv[5] == "gate"
        # Pick the n LARGEST prompts: worst case for prefill.
        pick = sorted(turns, key=lambda t: -len(t["systemPrompt"] + t["userPrompt"]))[:n]
        results, threads = {}, []

        def run(key, fn):
            results[key] = fn()

        for t in pick:
            threads.append(threading.Thread(target=run, args=(t["id"], lambda t=t: spark_answer(t))))
        if gate:
            # Gate-detector-sized call: ~1.1K tokens in (dev traces avg 1,127, measured), short JSON out.
            g = turns[-2]["userPrompt"][:4000]
            msgs = [{"role": "system", "content": "Devuelve en JSON la lista de nombres de personas que aparecen en el texto."},
                    {"role": "user", "content": g}]
            threads.append(threading.Thread(target=run, args=("gate", lambda: spark_chat(msgs, 400, 0.0, stream=False))))
        busy = spark_slots()
        t0 = time.perf_counter()
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        rec = {"conc": n, "gate": gate, "at": stamp(), "spark_busy_slots_before": busy,
               "wall_s": time.perf_counter() - t0,
               "results": {k: {kk: v for kk, v in r.items() if kk != "text"} for k, r in results.items()}}
        out.write(json.dumps(rec, ensure_ascii=False) + "\n"); out.flush()
        print(json.dumps(rec, indent=1))


if __name__ == "__main__":
    main()
