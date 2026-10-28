import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def acc(rs):
    c = [x for r in rs for x in r["cites"]]
    ok = sum(x["ok"] for x in c); return ok, len(c)
for side in ("before", "after"):
    rs = [r for r in rows if r["side"] == side]
    ok, n = acc(rs)
    per_rep = []
    for rep in sorted({r["rep"] for r in rs}):
        o, k = acc([r for r in rs if r["rep"] == rep]); per_rep.append(f"{o}/{k}={o/k:.0%}" if k else "-")
    inval = sum(1 for r in rs for x in r["cites"] if x["doc"] is None)
    nocite = sum(1 for r in rs if not r["cites"])
    disc = acc([r for r in rs if r["id"] in ("A6", "A7", "F4", "F5")])
    gen = sorted(r["gen_s"] for r in rs)
    print(f"{side}: {ok}/{n} = {ok/n:.1%} supported | per rep {per_rep} | invalid [N] {inval} | answers with no [N] {nocite}/{len(rs)} | Discapacidad turns {disc[0]}/{disc[1]} | gen median {gen[len(gen)//2]}s")
print("\nper turn (supported/cites, all reps):")
by = collections.defaultdict(dict)
for t in sorted({r["id"] for r in rows}, key=lambda s: (s[0], int(s[1:]))):
    b = acc([r for r in rows if r["id"] == t and r["side"] == "before"]); a = acc([r for r in rows if r["id"] == t and r["side"] == "after"])
    print(f"  {t}: before {b[0]}/{b[1]}  after {a[0]}/{a[1]}")
