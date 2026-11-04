# UX demo backlog

Started 2026-10-21 from the owner's own walk of dev before the CIDE/funders demo (Spanish, non-technical audience).
Scope: what shows on screen. Privacy and backend items live in the Fable audit (`plan/handoffs/AUDIT-edc-ai-2026-10-17.md`, outside the repo).
Status per item: `open` · `asked` (needs an owner decision) · `sent` (handed to an implementing session) · `done`.

| # | Screen | Problem (owner, seen on dev) | Wanted | Status |
|---|---|---|---|---|
| 1 | Ecosistema switch | Shows the text "Cambias de ecosistema, no de permisos: ves exactamente lo mismo que vería quien pertenece a él, con el mismo mínimo de documentos." | Remove the text | done |
| 2 | Document view | A document can be used in an existing conversation, but there is no way to start a NEW conversation with it | Add "start a new conversation with this document" | done |
| 3 | /grafo | The full graph is not visible; only an item's local graph shows, after clicking it | Show the whole graph on load, zoomable. Owner asks: is 3D possible with what we have? (check the graph lib; 3d-force-graph is an option) | done: 2D whole graph; 3D not built (options reported) |
| 27 | Conexiones (/grafo) | Shows the title "Cómo se conecta lo que publica tu ecosistema" and subtitle "Temas, lugares, eventos, organizaciones y personas de Organización Demo." | Remove both | done |
| 28 | Conexiones (/grafo) | Shows "Aquí solo entra lo publicado. Los borradores, incluidos los tuyos, no cuentan. Y una conexión aparece solo cuando varios documentos distintos la respaldan." | Remove the component | done |
| 29 | Conexiones (/grafo) | Shows "Hay 256 entidades que no se muestran porque aparecen en menos de 3 documentos publicados. Es a propósito: protege a quien contó algo una sola vez." | Remove the component (text only; the 3-document threshold stays unless the owner says otherwise) | done |
| 30 | Conexiones (/grafo) | Hint under the search box: "La búsqueda es por nombre. No importan los acentos ni las mayúsculas." (`lib/graph.ts:716`, `routes/grafo/+page.svelte:174`) | Hide the whole search box for the demo (it only filters entity names) | done |
| 31 | Conexiones (/grafo) | Search only matches entity names, not document text | AFTER DEMO: add full-text search that finds entities via the documents that mention them; then bring the search box back | deferred |
| 32 | Revisión | Intro text "Antes de entrar al corpus, cada documento pasa por una revisión automática que quita nombres, correos, teléfonos, CURP y domicilios. Cuando queda algo que puede identificar a una persona, el documento se detiene aquí y alguien tiene que leerlo." and "La lista no muestra el texto. Ábrelo para leerlo." | Remove the component | done |
| 33 | ALL screens | Too many instructions and explanatory paragraphs; the UI should be intuitive without reading | Sweep every screen: remove intro/explainer/hint paragraphs like #1, #27–#30, #32. Keep labels, buttons, empty states and errors (short). Run after the per-screen lanes land (touches every lane's files, like #24) | done; admin left as is (#17) |
| 34 | 🔴 Chat + Biblioteca | Owner saw real-looking personal names: in a chat answer from a Biblioteca doc, and when opening a testimonio in Biblioteca. Is anonymisation applied to the seeded corpus at all? | Investigate first (seeded corpus may bypass the anonymisation gate), then fix | done: option A; awaiting owner A/B |
| 35 | ⚠️ Chat | Asking about a document by its title returns many citations unrelated to it (extends #10) | Title-aware retrieval: when a question names a document, restrict or boost to it | done; choices marked review |
| 36 | Docs / chat attach | Texts "Todo lo que subas entra como borrador: solo tú lo ves. Puedes usarlo en el chat y publicarlo cuando esté listo." and "Elige uno. Se agrega a esta conversación sin salir de donde ya estaba: es el mismo documento en los dos lados." | Remove (rule #33) | done |
| 37 | 🔴 Chat attach | Attaching a doc to a conversation fails: `attachDoc failed Error: HTTP 400` (browser console, dev, 2026-10-21) | Fix; likely from batch 1/2 changes (#2 store action) | done |

## From the UX walkthrough agent (dev, 2026-10-21, screenshots in the session scratchpad `ux/`)

| # | Sev | Screen | Problem (seen on screen) | Likely code | Status |
|---|---|---|---|---|---|
| 4 | 🔴 | Chat | Cites the user's own question as source [1] "Conversación"; off-topic question answered from it | backend `lib/conversationIngest.ts` | asked: done per relay "documents only"; -70 quotes owner "all conversations should also go into corpus" — A (ingest, no retrieve) vs B (ingest + retrieve) pending |
| 5 | 🔴 | Chat | Pinned ("fijar") documents are not sent as context; footer claims they are | web `routes/api/generate/+server.ts`, `stores/app.svelte.ts:194` | done |
| 6 | 🔴 | First login | New sign-up with no membership sees "problemas para llegar al servidor" / "Ecosistema: No disponible" (403 read as outage); admin can't add members | web `lib/server/ecosystem.ts:130-135` | done |
| 7 | 🔴 | Conexiones | First topic crashes (Svelte duplicate key); `/grafo?entidad=78` blank page | web `components/graph/EntityPanel.svelte:125/168` (assumed) | done |
| 8 | 🔴 | Upload | Audio offered as "Voz", fails with English env-var text; "Bórralo" next to "Reintentar" | web `DocsPanel.svelte:967` | done |
| 9 | ⚠️ | Chat | 8–14 s to first words, up to 39 s; only three dots while waiting | web `Message.svelte` | done |
| 10 | ⚠️ | Chat | Jargon ("fragmentos recuperados", "contexto proporcionado"); `[n]` not links; sources collapsed; asking by title picks wrong doc | web `lib/markdown.ts`, prompt | done: title lookup via #35 |
| 11 | ⚠️ | Revisión | Counts disagree (7 vs 4), broken sentence, "no se ingirió"; common words flagged as addresses | backend `anonymise/gate.ts:374,386`, web `routes/revision/+page.svelte:114` | done |
| 12 | ⚠️ | Voz detail | PDF testimonio described as "generado a partir de un audio"; towns become "[Domicilio B]" | web `lib/biblioteca.ts:155,191` | done: towns shown |
| 13 | ⚠️ | Top nav | At 1366 px "Administración" is cut off, no scroll hint | web `PrimaryNav.svelte` | done |
| 14 | ⚠️ | Sidebar | No rename UI (`renameSession` unused); auto-title cut mid-word at 48 chars | web `app.svelte.ts:788` | done |
| 15 | ⚠️ | Mis documentos | No "descargar original"; no upload button outside a conversation | web | done |
| 16 | ⚠️ | Conexiones | Duplicate places, backwards relations, red "GRAFO FALLÓ" badge on fresh upload | backend graph extraction | partial: dedup + direction fixed; badge failures from ai-service JSON fences remain |
| 17 | ⚠️ | Admin | Investigator drafts labelled "solo tú"; model id, token paragraph, "no se pudieron procesar" shown | web admin | decided: leave as is |
| 18 | ⚠️ | Demo data | "Organización Demo", "(SIM_0249)" titles; only one ecosistema to switch to | data | done: script ready; -1e runs it after re-seed |
| 19 | 🛠️ | Sidebar | Delete icon hover-only (phone); native confirm box | web `Sidebar.svelte:157` | done |
| 20 | 🛠️ | Mis documentos | Typo "has subidoa Organización Demo" | web `documentos/+page.svelte:136` | done |
| 21 | 🛠️ | Doc card | "Fíjalo para incluirlo" while pinned; "GRAFO EN COLA" jargon | web | done |
| 22 | 🛠️ | Sign-in | No product name or logo | web | done |
| 23 | 🛠️ | Biblioteca | Language label floats mid-card, larger than PDF badge | web | done |
| 24 | 🛠️ | Phone 390 px | Titles clipped without "…"; Conexiones topic three screens down | web | done |
| 25 | 🛠️ | Sidebar | "guardado en el servidor" footer; empty "Nueva conversación" created each login (assumed) | web | done |
| 26 | 🛠️ | Upload | Fallback error "Error inesperado (HTTP n)" | web `app.svelte.ts` | done |

## Overnight choices (2026-10-21, owner asleep; rule: pick the simplest, mark for review)

- Gate infra failures (429/5xx/timeout): row stays retryable, never a Revisión hold. Unparseable model output still HOLDS. chosen: keep holding on bad output, the safe side (review)
- Dev seed pacing: ANONYMISE_DETECT_MIN_GAP_MS=2700 (≈22 detector calls/min, inferred), graph backfill only after the gate finishes. chosen (review)
- #35: an answer that cites nothing shows no sources; sources listed in citation order. chosen (review)
- #35: a title matches only with 2+ words and 12+ chars, whole words; two titles in one message pin nothing; number needed for the numbered series. chosen (review)
- #35: no retrieval filter to the matched doc, only the pin; matching reads the 100 newest published docs. chosen (review)
- #35: a testimonio title matches only for users who can see its name (uploader, platform admin); members see "Testimonio". chosen: keep it hidden (review)
- Title match: retrieval narrowed to the named doc's docId (not skipped). chosen (review)
- Town holds: code filter on the hold decision for bare town names in place context; re-gate the ~31 place-only holds with a fresh model run (~$0.03–0.07, inferred), not a free rule-only clear. chosen (review)
- Held testimonios published on dev (13) + town holds: fixed; dev repair/purge/regate commands sent to -1e. Town rule errs to holding (e.g. "La Paz" without state holds). chosen (review)
- Answer with no [n]: list top 3 retrieved passages (rerank score first), plus the title-matched doc if missing; the exact no-answer reply shows none. chosen by -1e (review)
- Cite rule overshoot: tighter CITE_RULE; first sentence = no-answer reply -> no sources (title-matched doc kept); max 7 sources. chosen by -1e (review)
- Cite-rule A/B on dev (CHAT_CITE_VARIANT A–D): winner = 0 refusals on Educación Q1/Q2, 0 sources off-topic, dengue ≤8 groups and ≤20 s; winner becomes the default in prompt.ts. chosen (review)
- Cite-rule A/B result (dev, -1e, raw: session scratchpad cite-ab.md): A kept as default; prompt tuning stopped. Educación opener "no contienen testimonios específicos…" is a faithful hedge for a thin corpus. CHAT_CITE_VARIANT stays in code, unset. chosen (review)
- asked (owner): dengue latency 4.8–58 s with 1,300–2,100-char answers and slow first token (measured on dev by -1e)
- Graph: languages and placeholders never become nodes (extraction + query filter, also in chat's graph retrieval); isolated nodes hidden in the overview only; extraction prompt left unchanged to avoid a full graph re-backfill. chosen (review)
- Graph languages/placeholders/isolated: done; dev purge: scripts/purge-graph-noise.ts (dry run, PURGE_NOISE_APPLY=1)
- #4 v2 (owner, 2026-10-21): store every turn through the gate; never cite; orient chat from earlier turns of the whole ecosistema (CHAT_ORIENT_SCOPE=ecosistema, owner's choice). In progress.
- Graph batch: thresholds 1 (env), one edge per pair, co-mentions top-8, force-graph 2D (seeded, warmup, no animation), lazy 3D "del suelo a las ideas", Esc/empty-click deselect. K=8 kept on measured frame time. chosen (review)
