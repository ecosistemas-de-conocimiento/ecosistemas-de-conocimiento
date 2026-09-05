# 09 — "Conexiones" or "Grafo" in the nav

**Blocked on:** 🟡 owner's word preference. Two constants either way.
**Owns:** `apps/web/src/lib/nav.ts`, `apps/web/src/lib/graph.ts`.

## State

The nav entry for `/grafo` reads **"Conexiones"**, not "Grafo". The route itself
is unchanged.

## Why it was done that way

`nav.ts` states its own rule: plain Spanish nouns, no jargon, for readers who do
not have that vocabulary. *Grafo* is a mathematics term. This matches the
product's stated mission — plain language and flat UX for educationally
marginalised users — so the label was chosen to follow the rule already written
in that file rather than to express a preference.

## If the owner wants "Grafo"

Two constants, and they must move together or the click and the landing page
disagree:

1. the label in `NAV_ITEMS` — `apps/web/src/lib/nav.ts`
2. `GRAPH_KICKER` — `apps/web/src/lib/graph.ts`

Tests assert the copy; update them in the same change.

## Worth a moment

⚠ This is small but it is the kind of decision that sets a precedent. If "Grafo"
wins here, the rule in `nav.ts` is weaker than it reads, and the next person
choosing a label has no guidance. Either outcome is fine; the rule and the labels
should agree afterwards.
