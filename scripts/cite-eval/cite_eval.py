#!/usr/bin/env python3
"""Citation accuracy before/after, Spark only (Qwen3-30B-A3B-Instruct-2507). Stdlib.
  cite_eval.py PROMPTS OUT.jsonl REPEATS
Answer: system+user as built, temp 0.4, max_tokens 800 (run.py's Spark settings).
Judge: each (sentence, cited [N]) pair -> same model, temp 0, 'SI'/'NO':
does passage N (text only, no title) support the sentence? Invalid N = unsupported.
Only the part before 'Fuera de los documentos:' counts.
"""
import json, os, re, sys, time, http.client, urllib.parse
SPARK = os.environ["SPARK_URL"]; TOKEN = open(os.environ["SPARK_TOKEN_FILE"]).read().strip()
MODEL = "qwen3-30b-a3b-instruct-2507"

def chat(messages, max_tokens, temperature):
    u = urllib.parse.urlparse(SPARK)
    for attempt in range(3):
        try:
            c = http.client.HTTPConnection(u.hostname, u.port, timeout=300)
            c.request("POST", "/v1/chat/completions", json.dumps({"model": MODEL, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}),
                      {"content-type": "application/json", "authorization": f"Bearer {TOKEN}"})
            r = c.getresponse(); b = json.loads(r.read())
            if r.status != 200: raise RuntimeError(f"{r.status} {str(b)[:200]}")
            return b["choices"][0]["message"]["content"]
        except Exception as e:
            if attempt == 2: raise
            time.sleep(5)

MARK = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
def doc_part(text):
    m = re.search(r"Fuera de los documentos\W*[:\u2013\u2014-]", text, re.I)
    return text[:m.start()] if m else text

def claims(text):
    # sentence = text up to . ! ? or newline, markers included
    out = []
    for s in re.split(r"(?<=[.!?])\s+|\n+", doc_part(text)):
        nums = [int(n) for g in MARK.findall(s) for n in re.split(r"\s*,\s*", g)]
        if nums:
            out.append((MARK.sub("", s).strip(" -*#>"), sorted(set(nums))))
    return out

JUDGE_SYS = ("Eres un verificador estricto. Recibes un PASAJE de un documento y una AFIRMACIÓN. "
             "Responde SI solo si el pasaje respalda directamente la afirmación (lo dice o se sigue sin suponer nada). "
             "Si la afirmación habla de algo que el pasaje no menciona, responde NO. Responde solo SI o NO.")
def judge(claim, passage):
    a = chat([{"role": "system", "content": JUDGE_SYS},
              {"role": "user", "content": f"PASAJE:\n{passage[:6000]}\n\nAFIRMACIÓN:\n{claim}\n\n¿El pasaje respalda la afirmación? SI o NO."}], 3, 0)
    return a.strip().upper().startswith("S")

def main():
    prompts = json.load(open(sys.argv[1]))["turns"]; out = open(sys.argv[2], "a"); R = int(sys.argv[3])
    for rep in range(R):
        for t in prompts:
            for side in ("before", "after"):
                p = t[side]
                t0 = time.time()
                ans = chat([{"role": "system", "content": p["systemPrompt"]}, {"role": "user", "content": p["userPrompt"]}], 800, 0.4)
                gen = time.time() - t0
                rows = []
                for claim, nums in claims(ans):
                    for n in nums:
                        if 1 <= n <= len(p["passages"]):
                            ok = judge(claim, p["passages"][n - 1]); doc = p["docs"][n - 1]
                        else:
                            ok, doc = False, None
                        rows.append({"n": n, "ok": ok, "doc": doc, "claim": claim[:300]})
                rec = {"rep": rep, "id": t["id"], "side": side, "gen_s": round(gen, 1), "answer": ans, "cites": rows}
                out.write(json.dumps(rec, ensure_ascii=False) + "\n"); out.flush()
                print(rep, t["id"], side, f"{gen:.1f}s", f"{sum(r['ok'] for r in rows)}/{len(rows)}", flush=True)

main()
