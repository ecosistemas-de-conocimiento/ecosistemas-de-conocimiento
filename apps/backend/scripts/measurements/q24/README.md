# Q24 — detector prompt measurements (public names, workplaces)

Old prompt against new prompt, on **synthetic texts only**. Every input under `inputs/` was
written for these measurements. None holds real document text. The detector ran the real gate
code path (`scripts/measure-anonymise-gate.ts`).

## Provenance (all rounds)

| | |
|---|---|
| Date | 2026-10-28, times UTC (per row: `startedAt`) |
| Host | `torre` (local workstation; per row: `host`, `loadavg`) |
| Endpoint class | self-hosted OpenAI-compatible server ("Spark"), over Tailscale at `<spark-url>`. `GATE_BACKEND=spark`: **no hosted fallback**, $0 (`costUsd` 0 on every row) |
| Model | `qwen3-30b-a3b-instruct-2507` |
| Settings | `ANONYMISE_DETECT_*` read from the dev backend container's env into a mode-0600 scratch file, never printed, shredded after each round |
| Gate | `GATE_KIND=documento GATE_RUNS=2 GATE_ORG=7` (the org only labels calls), 2 runs per text and prompt |
| Command | `run.sh <env file> <out dir> <old prompt file>`, run from this tree. "new" is the prompt in the checked-out tree; "old" swaps in the file through `GATE_SYSTEM_PROMPT_FILE` |
| Score | `python3 score.py <round dir>` → `score.txt` in each round |

`prompts/` holds each system prompt as the code exported it (`DETECT_SYSTEM_PROMPT`). This README
names the four prompts as below. The file names and the labels inside `score.txt` keep older ids.

| Name here | What it is | File |
|---|---|---|
| `pre-Q24` | before Q24 | `prompts/prompt-30fc152.txt` |
| `Q24-v1` | first Q24 prompt | `prompts/prompt-c6d301c.txt` |
| `Q24-v2` | first audit wording | `prompts/prompt-8c82aea.txt` |
| `Q24-final` | final, with the contraction rescue in the gate | `prompts/prompt-fe8c098.txt` |

**How to read `score.txt`.** `kept` gives "run 1/run 2 of N": how many terms of a class survived
whole. For a `keep` class the right answer is N/N. For a `redact` class it is 0/0. `wrong` lists
the terms that went the wrong way in any run. A `hold:*` run is not published, so private terms
"kept" in it are not a leak. `hold:content` with `json-invalido` is the reply cut off at the
token cap. Old and new prompts both hit it on `staff-draft` and `q10`.

## Rounds

| Round | Start (UTC) | Load (1-min) | old prompt | new prompt | Gate code |
|---|---|---|---|---|---|
| `round1-2026-10-28T0819Z` | 08:19 | 1.7–7.0 | `pre-Q24` | the Q24 lane's tree at 08:19, inferred = `Q24-v1`¹ | before this branch |
| `round2-2026-10-28` | 08:56 | 2.8–79.5 | `Q24-v1` | `Q24-v2` | `Q24-v1` |
| `round2b-2026-10-28-pre-q24` | 09:06 | 10.9–23.3 | `pre-Q24`, 2 texts only | — | `Q24-v1` |
| `round3-2026-10-28` | 09:15 | 2.0–9.0 | `Q24-v1` | `Q24-final` | `Q24-final` (contraction rescue) |

¹ Inferred: the run started 08:19:23 UTC. The last commit touching the prompt was made 08:17:11
UTC, and a diff from it to `Q24-v1` showed no change to `src/lib/anonymise/`. The run read the
lane's working tree, so an uncommitted edit cannot be ruled out. That run's own prompt file was
not kept. Round 3's "old" column re-measures `Q24-v1` from its exported text.

Round 1's driver was `round1-*/run-all.sh`. Its env loader lived in a scratch dir and is not
committed, because it pointed at the secret file.

## Results

**Public names (`q24-public`, 10 names that must stay)**, the source of "10/10 vs 2/10":

| Prompt | Kept, run 1 / run 2 | Round |
|---|---|---|
| `pre-Q24` | 2/10, 0/10 | 1 |
| `pre-Q24` | 0/10, 2/10 | 2b |
| `Q24-v1` | 10/10, 10/10 | 1 (inferred prompt), 2, 3 |
| `Q24-v2` | 10/10, 10/10 | 2 |
| `Q24-final` | 10/10, 10/10 | 3 |

**Workplace or school beside a person (`q24-workplace`)**, 3 cases. The cell shows whether the
whole phrase survived, run 1 / run 2. "leak" means the phrase stayed in clear:

| Case | `pre-Q24` (2b) | `Q24-v1` (2, 3) | `Q24-v2` (2) | `Q24-final` (3) |
|---|---|---|---|---|
| (a) "la recepcionista de la clínica dental Sonrisa Clara" | leak/leak | leak/leak | leak/leak | redacted/redacted |
| (b) "el maestro de la telesecundaria Emiliano Zapata", a small town | leak/leak | leak/leak | leak/leak | redacted/redacted |
| (c) "el director del DIF municipal de Ocuituco" | leak/leak | leak/leak | leak/leak | redacted/redacted |
| controls: "apoyo del DIF y del IMSS", "un PILARES de la alcaldía", "la UNAM" kept | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | **1/3, 0/3** |
| controls: towns Temixco, Huazulco, Tetecala kept | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | 3/3, **2/3** |

With `Q24-v2` and earlier, the model returned `{"hallazgos":[]}` for this text. With `Q24-final` it
reports each institution, and also the bare "el DIF", "el IMSS" and "un PILARES de la alcaldía"
in the same text.

**"La única trabajadora social del centro de salud de San Gregorio"** (`q24-public`):

| Prompt + gate | Leak, run 1 / run 2 |
|---|---|
| `Q24-v1` + `Q24-v1` gate | no/no (rounds 1, 2) |
| `Q24-v2` + `Q24-v1` gate | no/**yes** (round 2) |
| `Q24-v1` + `Q24-final` gate | no/no (round 3) |
| `Q24-final` + `Q24-final` gate | no/no (round 3) |

⚠ `Q24-v1`'s prompt held a near-copy of this sentence as its example ("la única enfermera de la
clínica de San Rafael"). Its catch measures recall of that example, not the rule. The leak under
`Q24-v2` was a gate bug. The model reported "el centro de salud de San Gregorio" for "del centro
de salud…", and stage 3 replaces whole words only. `Q24-final` fixes that in `gate.ts`, and
`gate.contraction.test.ts` covers it.

Other texts (`q24-classes`, `q10`, `kinship`, `xochi2`, `staff-draft`): see each round's
`score.txt`. No private term was published by a `ready` run in round 3. One over-redaction
appears with both audit prompts. In `xochi2` ("vivo en Xochitepec"), the town was redacted in
2/2 runs under `Q24-v2` and 2/2 under `Q24-final`. Under `Q24-v1` it was kept in 2/2, in rounds
2 and 3.
