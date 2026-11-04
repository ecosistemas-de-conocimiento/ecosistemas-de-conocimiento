#!/usr/bin/env python3
"""Mechanical checks + latency stats over run.py's seq output.

  check.py PROMPTS SEQ.jsonl [BLIND_OUT.json]

Per answer: [n] markers that point outside the turn's numbered passages,
marker groups, CJK/Cyrillic characters (a known Qwen leak), English
stop-words, the "Fuera de los documentos:" lead (cite variant E), and for
interview turns: question count and headings/lists (the prompt forbids both).
With BLIND_OUT it also writes a shuffled A/B pack for blind scoring, plus the
key that maps A/B back to hosted/Spark.
"""
import json, random, re, statistics, sys

prompts = {t["id"]: t for t in json.load(open(sys.argv[1]))["turns"]}
rows = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]

MARK = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯Ѐ-ӿ]")
EN = re.compile(r"\b(the|and|with|however|which|this is)\b", re.I)


def passages(prompt):
    return sorted({int(n) for n in re.findall(r"\[(\d+)\]\s*<fuente", prompt)})


def check(turn, text):
    ok = set(passages(turn["userPrompt"]))
    groups = MARK.findall(text or "")
    nums = [int(n) for g in groups for n in re.split(r"\s*,\s*", g)]
    bad = sorted({n for n in nums if n not in ok})
    r = {"groups": len(groups), "bad_marks": bad, "cjk": len(CJK.findall(text or "")),
         "en": len(EN.findall(text or "")), "chars": len(text or ""),
         "gk_lead": "Fuera de los documentos:" in (text or "")}
    if turn["mode"] == "interview":
        r["questions"] = (text or "").count("?")
        r["md"] = bool(re.search(r"^\s*(#|[-*] |\d+\. )", text or "", re.M))
    return r


def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


lat = {"hosted": {"ttft": [], "total": [], "out": [], "in": []}, "spark": {"ttft": [], "total": [], "out": [], "in": []}}
print("| id | mode | in tok (spark) | hosted ttft/total/out | spark ttft/total/out | hosted checks | spark checks |")
print("|---|---|---|---|---|---|---|")
blind = []
for r in rows:
    t = prompts[r["id"]]
    cells = []
    for side in ("hosted", "spark"):
        x = r[side]
        if "error" in x:
            cells.append(f"ERROR {x['error'][:60]}")
            continue
        lat[side]["ttft"].append(x.get("ttft_s")); lat[side]["total"].append(x.get("total_s"))
        lat[side]["out"].append(x.get("out_tokens")); lat[side]["in"].append(x.get("in_tokens"))
        cells.append(f"{x.get('ttft_s') or 0:.2f}/{x['total_s']:.1f}/{x.get('out_tokens')}")
    chk = [json.dumps(check(t, r[s].get("text")), ensure_ascii=False) for s in ("hosted", "spark")]
    print(f"| {r['id']} | {t['mode']} | {r['spark'].get('in_tokens')} | {cells[0]} | {cells[1]} | {chk[0]} | {chk[1]} |")
    pair = [("hosted", r["hosted"].get("text", "")), ("spark", r["spark"].get("text", ""))]
    random.Random(r["id"]).shuffle(pair)
    blind.append({"id": r["id"], "mode": t["mode"], "question": t["userMessage"],
                  "systemPrompt": t["systemPrompt"], "userPrompt": t["userPrompt"],
                  "A": pair[0][1], "B": pair[1][1], "_key": {"A": pair[0][0], "B": pair[1][0]}})

print()
print("| side | ttft median | ttft p90 | total median | total p90 | out tok median | in tok max |")
print("|---|---|---|---|---|---|---|")
for side, d in lat.items():
    f = lambda v: "n/a" if v is None else f"{v:.2f}"
    print(f"| {side} | {f(pct(d['ttft'],.5))} | {f(pct(d['ttft'],.9))} | {f(pct(d['total'],.5))} | {f(pct(d['total'],.9))} | "
          f"{f(pct(d['out'],.5))} | {max([x for x in d['in'] if x] or [0])} |")

cond = [r for r in rows if r.get("condense")]
if cond:
    print("\n| id | hosted condense | spark condense | hosted s | spark s |\n|---|---|---|---|---|")
    for r in cond:
        c = r["condense"]
        print(f"| {r['id']} | {c['hosted_text']} | {c['spark'].get('text', c['spark'].get('error'))} | "
              f"{c['hosted_total_s']:.2f} | {c['spark']['total_s']:.2f} |")

if len(sys.argv) > 3:
    json.dump(blind, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
