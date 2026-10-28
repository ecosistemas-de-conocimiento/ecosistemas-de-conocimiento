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
| Command | `run.sh <env file> <out dir> prompts/prompt-c6d301c.txt`, run from this tree. "new" is the prompt in the checked-out tree; "old" swaps in the file through `GATE_SYSTEM_PROMPT_FILE` |
| Score | `python3 score.py <round dir>` → `score.txt` in each round |

`prompts/` holds each system prompt as the code exported it (`DETECT_SYSTEM_PROMPT`).

**How to read `score.txt`.** `kept` gives "run 1/run 2 of N": how many terms of a class survived
whole. For a `keep` class the right answer is N/N. For a `redact` class it is 0/0. `wrong` lists
the terms that went the wrong way in any run. A `hold:*` run is not published, so private terms
"kept" in it are not a leak. `hold:content` with `json-invalido` is the reply cut off at the
token cap. Old and new prompts both hit it on `staff-draft` and `q10`.

## Rounds

| Round | Start (UTC) | Load (1-min) | old prompt | new prompt | Gate code |
|---|---|---|---|---|---|
| `round1-2026-10-28T0819Z` | 08:19 | 1.7–7.0 | `30fc152` (before Q24) | the Q24 lane's tree at 08:19, inferred = `c6d301c`¹ | before this branch |
| `round2-2026-10-28` | 08:56 | 2.8–79.5 | `c6d301c` | `8c82aea` (first audit wording) | `c6d301c` |
| `round2b-2026-10-28-pre-q24` | 09:06 | 10.9–23.3 | `30fc152`, 2 texts only | — | `c6d301c` |
| `round3-2026-10-28` | 09:15 | 2.0–9.0 | `c6d301c` | `fe8c098` (final) | `fe8c098` (contraction rescue) |

¹ Inferred: the run started 08:19:23 UTC. The last commit touching the prompt, `cf44f51`, was made
08:17:11 UTC. `git diff cf44f51 c6d301c` shows no change to `src/lib/anonymise/`. The run read the
lane's working tree, so an uncommitted edit cannot be ruled out. That run's own prompt file was
not kept. Round 3's "old" column re-measures `c6d301c` from its exported text.

Round 1's driver was `round1-*/run-all.sh`. Its env loader lived in a scratch dir and is not
committed, because it pointed at the secret file.

## Results

**Public names (`q24-public`, 10 names that must stay)**, the source of "10/10 vs 2/10":

| Prompt | Kept, run 1 / run 2 | Round |
|---|---|---|
| `30fc152` (before Q24) | 2/10, 0/10 | 1 |
| `30fc152` | 0/10, 2/10 | 2b |
| `c6d301c` | 10/10, 10/10 | 1 (inferred prompt), 2, 3 |
| `8c82aea` | 10/10, 10/10 | 2 |
| `fe8c098` | 10/10, 10/10 | 3 |

**Workplace or school beside a person (`q24-workplace`)**, 3 cases. The cell shows whether the
whole phrase survived, run 1 / run 2. "leak" means the phrase stayed in clear:

| Case | `30fc152` (2b) | `c6d301c` (2, 3) | `8c82aea` (2) | `fe8c098` (3) |
|---|---|---|---|---|
| (a) "la recepcionista de la clínica dental Sonrisa Clara" | leak/leak | leak/leak | leak/leak | redacted/redacted |
| (b) "el maestro de la telesecundaria Emiliano Zapata", a small town | leak/leak | leak/leak | leak/leak | redacted/redacted |
| (c) "el director del DIF municipal de Ocuituco" | leak/leak | leak/leak | leak/leak | redacted/redacted |
| controls: "apoyo del DIF y del IMSS", "un PILARES de la alcaldía", "la UNAM" kept | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | **1/3, 0/3** |
| controls: towns Temixco, Huazulco, Tetecala kept | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | 3/3, **2/3** |

With `8c82aea` and earlier, the model returned `{"hallazgos":[]}` for this text. With `fe8c098` it
reports each institution, and also the bare "el DIF", "el IMSS" and "un PILARES de la alcaldía"
in the same text.

**"La única trabajadora social del centro de salud de San Gregorio"** (`q24-public`):

| Prompt + gate | Leak, run 1 / run 2 |
|---|---|
| `c6d301c` + `c6d301c` gate | no/no (rounds 1, 2) |
| `8c82aea` + `c6d301c` gate | no/**yes** (round 2) |
| `c6d301c` + `fe8c098` gate | no/no (round 3) |
| `fe8c098` + `fe8c098` gate | no/no (round 3) |

⚠ `c6d301c`'s prompt held a near-copy of this sentence as its example ("la única enfermera de la
clínica de San Rafael"). Its catch measures recall of that example, not the rule. The leak under
`8c82aea` was a gate bug. The model reported "el centro de salud de San Gregorio" for "del centro
de salud…", and stage 3 replaces whole words only. `fe8c098` fixes that in `gate.ts`, and
`gate.contraction.test.ts` covers it.

Other texts (`q24-classes`, `q10`, `kinship`, `xochi2`, `staff-draft`): see each round's
`score.txt`. No private term was published by a `ready` run in round 3. One over-redaction
appears with both audit prompts. In `xochi2` ("vivo en Xochitepec"), the town was redacted in
2/2 runs under `8c82aea` and 2/2 under `fe8c098`. Under `c6d301c` it was kept in 2/2, in rounds
2 and 3.
