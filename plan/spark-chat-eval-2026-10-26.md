# Chat answer + condense on the Spark — test, 2026-10-26

**Question.** Can EDC's chat answer (#8) and the condense rewrite (#6) in `plan/spark-ai-adopcion.md`
run on the DGX Spark's Qwen3-30B-A3B instead of the hosted model? The goal is to keep raw chat text
(members' questions, live-mic transcripts) away from outside providers.

**Test only.** No deployed env, Coolify config or ai-service routing changed. The harness lives in
`scripts/spark-chat-eval/`. Raw outputs are in the session scratchpad and were not committed.

## Verdict

- **Condense on the Spark: viable.** It is faster (median 1.3 s against 4.6 s). The rewrites are
  usable but longer and need one prompt fix (below).
- **Chat answer on the Spark: not viable as it is today.** It is faster and the Spanish is fluent,
  and every `[n]` marker is valid. But a blind review judged Qwen's answer clearly worse in 9 of 22
  turns and hosted's in 2. The gap is in faithfulness and citation support:
  - invented details;
  - documents' words attributed to the wrong people;
  - text from the "conversaciones anteriores" orientation block used as a source;
  - other people's documents cited inside a person's own story.
- **Next step.** Tune the prompt for Qwen and re-run this harness. If the gap stays, try
  gpt-oss-120b on the Spark (`spark-ai-adopcion.md` §2.7).

## Setup (measured 2026-10-26, 19:13–19:33 CST = 01:13–01:33 UTC)

| Item | Value |
|---|---|
| Hosted | dev ai-service `/v1/generate/stream`, `effortLevel: standard` → `deepseek/deepseek-chat-v3.1` via OpenRouter, temp 0.4, 800 out (`services/ai-service/src/services/registry/resolve.ts:122-129`; model confirmed in dev `traces`). Called from the workstation through an SSH tunnel to the dev ai-service container |
| Spark | `Qwen3-30B-A3B-Instruct-2507` Q8_0, llama.cpp `b1-a37cc46`, through the token proxy `<spark-url>` over Tailscale. Non-thinking model (Instruct-2507). Same system and user messages, temp 0.4, `max_tokens` 800, streamed |
| Condense | hosted: the real `quick` call made while the prompts were assembled (temp 0.3, 400 max; the engine's `maxTokens: 80` is never sent). Spark: the same messages replayed, temp 0.3, 400 max, not streamed |
| Prompts | 22 turns from dev's own chat history plus 4 written for the test (`turns.ts`). Each prompt was assembled by `build-prompts.ts` with production code: `prepareTurn`, web `prompt.ts` (cite variant E, the dev default), `turnMode`, chunk fence, orientation block, rerank policy, against dev's ai-service corpora (`eco-1/3/6/7`) |
| Prompt gaps vs a live dev turn | no GraphRAG block, no query expansion, no title pin, no attached documents. The summary names only the ecosistema. These change which chunks appear, not the comparison: both models got byte-identical prompts |
| Spark load | 0 busy llama slots before every sequential call (`/slots`, measured). GPU 0 % between calls; 66 GB RAM free. No gate jobs observed |

## Latency — sequential, one call at a time (measured, 22 turns each side)

| Side | TTFT median | TTFT p90 | Total median | Total p90 | Output tokens median | Max input tokens |
|---|---|---|---|---|---|---|
| Hosted (DeepSeek V3.1) | 2.45 s | 6.28 s | 12.6 s | 47.9 s | 177 | 5,830 |
| Spark (Qwen3-30B-A3B) | 2.17 s | 2.42 s | 7.2 s | 13.4 s | 297 | 5,948 |

- Hosted generation ran at a median 8.9 tok/s in this window (range 7.2–200, `measured`, output
  tokens ÷ time after the first token). The worst case was A6: 675 tokens in 91.9 s. Dev's history
  shows streams averaging 5.1 s (`quoted`, `spark-ai-adopcion.md` #8). Read the hosted column as one
  slow evening on OpenRouter, not as typical.
- Spark generation ran at a median 55.3 tok/s (`measured`, llama.cpp `timings`). Its TTFT carries
  prefill of ~4–6K tokens. The shared system-prompt prefix was cached across turns. A cold prompt
  (no cache) takes 2.96 s TTFT at 5.8K tokens (`measured`, conc run 1).
- Totals by kind, median: answers 16.8 s hosted vs 7.3 s Spark; follow-ups 31.9 s vs 8.2 s;
  interview 6.6 s vs 4.0 s (`measured`).
- Qwen writes longer answers: a median of 297 tokens against 177.

**Condense** (6 follow-ups + 2 interview turns with history): hosted median 4.64 s (max 21.7 s);
Spark median 1.27 s (max 2.29 s) (`measured`).

## Concurrency on the Spark (measured, `cache_prompt: false`, largest prompts ~5.8–5.9K tokens)

| Load | TTFT range | Total range | Per-stream tok/s |
|---|---|---|---|
| 1 chat | 2.96 s | 13.6 s | 53 |
| 2 chats | 3.2–5.8 s | 18.6–23.5 s | 22–33 |
| 3 chats + 1 gate-sized call (1,144 in, 16 out) | 4.8–9.8 s | 20.8–27.7 s; gate 10.1 s | 18–30 |
| 4 chats + 1 gate-sized call (5 requests, 4 slots) | 4.7–12.6 s | 17.9–29.8 s; gate 9.8 s | 14–27 |

- llama-server runs `-c 65536 --parallel 4`, so **each slot has 16,384 tokens** (`measured`,
  `/slots`). The largest prompt was 5,948 input tokens; adding 800 output still fits with room to
  spare. Dev's hosted average is 5,352 input tokens (`measured`, dev `traces`, `stream:chat`).
- A fifth concurrent request waits for a free slot. The gate detector shares these slots. Under
  3 chats a gate call took ~10 s against well under 1 s alone (`inferred` from the 16-token output).
  The gate's `ANONYMISE_DETECT_CONCURRENCY=1` and 2.7 s gap keep it to one slot.

## Quality

Mechanical checks (`check.py`, measured over all 44 answers):

- **Citation markers: 0 invalid on either side.** Every `[n]` pointed to a passage in the prompt.
- No CJK or Cyrillic characters, and no English stop-words, in any Qwen answer.
- Interview turns (5 per side): both asked exactly one question and used no lists or headings.
- "Fuera de los documentos:" paragraph: Qwen 13 of 17 answer-mode turns, hosted 6 of 17. Qwen
  reaches for general knowledge even when the passages cover the question.

Concrete examples:

1. **A10, off-topic** ("¿Cuál es la capital de Francia?"). Qwen answered only `París.`, which breaks
   the variant-E rule that this case must start with "Fuera de los documentos:". Hosted kept the
   lead but opened with what the documents lack, which the same rule forbids.
2. **T2, interview** (a mother telling her pandemic-homework story). Qwen's acknowledgement carries
   `[2, 3, 4]`, so other people's documents get cited inside her story. The interview prompt
   forbids citing while the person only tells. T5 shows the same thing: Qwen put `[1]` on facts she
   had told it herself. Hosted cited nothing in any interview reply.
3. **A9, partial coverage** (how families remove mosquito breeding sites). Hosted said the documents
   do not cover it and stopped. Qwen gave the grounded facts (23 criaderos, a water truck every
   15 days; both verified in the passages) and the structural cause, then a general-knowledge
   paragraph. That is more useful, but it cites all five passages in one group.
4. **Condense.** Qwen's rewrites are longer, full questions. On T3 and T4 it folded the person's
   own story into the search query, and on T4 it turned the query into a question addressed to
   the person. Hosted's T4 rewrite was also poor: a 600-character keyword dump.

### Blind scoring

One reviewer (an Opus subagent, medium effort) saw each pair as A/B in a seeded shuffle. It had the
system prompt and the exact user turn and was not told which model wrote which answer. It scored
1–5 on four axes and picked a preference. The key was applied afterwards (`blind_key.json`). This
is one LLM judge's reading, so treat it as `inferred`, not ground truth. The judge did keyword-check
each disputed claim against the passages.

| Model | Citations | Faithfulness | Fluency | Rule-following | Preferred |
|---|---|---|---|---|---|
| Hosted (DeepSeek V3.1) | 4.09 | 4.27 | 4.82 | 3.91 | 11 |
| Spark (Qwen3-30B-A3B) | 3.00 | 3.59 | 4.64 | 3.41 | 6 (5 ties) |

Clearly worse, according to the judge:

- **Qwen, 9 turns.**
  - A2: listed languages taken from the orientation block, which is not a source.
  - A7: an unsupported claim cited to [2].
  - A8: cited all five passages; its general-knowledge paragraph only lists what is missing.
  - F3: put the field workers' words in the families' mouths.
  - F4: invented "hospitales" and "pantallas de transporte" and cited them to the wrong passages.
  - F5: opened with what the documents do not say, which the rules forbid.
  - T1: wrote "[conversaciones anteriores]" as a citation and invented a "brigadista o conserje".
  - T2: cited documents inside the mother's story.
  - T3: put an attachment name in brackets and contradicted the user (she said "el doctor ni se
    dio cuenta").
- **Hosted, 2 turns.**
  - A9: the forbidden "Los documentos no mencionan…" opening.
  - F6: invented "tlapaneco" and "registro civil", and dropped the English word "often" into the
    Spanish.

Both models broke the "at most three numbers per group" rule and reused wording from the
orientation block (A4–A6, A8). These are prompt and retrieval issues common to both models, not
Spark-specific ones.

## What a switch would take

1. **ai-service per-tier endpoint.** Chat completions use one global
   `CHAT_COMPLETIONS_URL` (`services/ai-service/src/config/env.ts:237`, read once at
   `router/adapters/openrouter.ts:44`). The router hard-codes `openrouter`
   (`router/router.ts:92`). Pointing the URL at the Spark moves every tier and every product on
   this ai-service, graph extraction included. It also sends the OpenRouter key to the Spark as the
   bearer (`quoted`, `spark-ai-adopcion.md` §3). The ai-service change needs a per-tier (or
   per-surface) base URL, model and key, so that `standard`/`quick` for `surface: chat` go to the
   Spark. Alternative: EDC calls the Spark directly from `apps/web`, bypassing ai-service for
   generation, as the gate does. That loses ai-service budget, traces and the `systemPromptApplied`
   check.
2. **Query expansion (#7) moves too.** It sends the member's question to the `quick` tier. Moving
   only condense and the answer still leaks the raw question.
3. **Fallback decision.** Today ai-service has no cross-provider fallback (`quoted`, §3). A hosted
   fallback when the Spark is down would send raw text out again, which defeats the purpose. The
   privacy-consistent choice is fail-closed: show "the assistant is unavailable". The Spark is
   borrowed, has no supervisor (tmux), and does not come back after a reboot on its own (`quoted`,
   memory note).
4. **Prompt tuning for Qwen**, then re-run this harness (`build-prompts.ts` → `run.py seq` → `check.py` + blind pass):
   - interview: forbid `[n]` unless the person asked a direct question;
   - variant E: an explicit off-topic example with the exact lead;
   - discourage the general-knowledge paragraph when the passages already answer;
   - repeat in the user turn that the orientation block is not a source;
   - condense: "return only a search query; never address the person".
   If faithfulness stays below hosted, test gpt-oss-120b (~59 GiB; it fits beside the current
   models, `quoted` §2.8).
5. **Capacity.** 4 slots shared with the gate. Two or three simultaneous chats take TTFT to 5–10 s
   and slow the gate to ~10 s per call. Fine for dev and demo load. Real use needs more slots or
   gate jobs scheduled off-peak (`inferred`).
6. **Ownership.** The box belongs to another org (`quoted`, memory note). Owner sign-off on chat
   text hosted there is the same open question as for testimony.

## Reproduce

```sh
# 1. dumps (edc-1, dev postgres): messages(id, role, content) and organizations(id, name, description) as json_agg
# 2. tunnel: ssh -fN -L 45591:<dev ai-service container ip>:3000 root@<edc-1-ip>
# 3. rebuild chat-engine core: packages/chat-engine/node_modules/.bin/tsc -p packages/chat-engine/tsconfig.core.json
EVAL_AI_URL=http://localhost:45591 EVAL_AI_KEY_FILE=… EVAL_MESSAGES=… EVAL_ORGS=… EVAL_OUT=prompts.json \
  apps/web/node_modules/.bin/tsx scripts/spark-chat-eval/build-prompts.ts
AI_URL=http://localhost:45591 AI_KEY_FILE=… SPARK_URL=<spark-url> SPARK_TOKEN_FILE=… \
  python3 -I scripts/spark-chat-eval/run.py seq prompts.json seq.jsonl
python3 -I scripts/spark-chat-eval/run.py conc prompts.json conc.jsonl 3 gate
python3 -I scripts/spark-chat-eval/check.py prompts.json seq.jsonl blind.json
```

The hosted run made 22 standard and 8 quick calls on dev's eco orgs. At the profile estimate that
is under $0.02 (`inferred`, `resolve.ts` per-call estimates).
