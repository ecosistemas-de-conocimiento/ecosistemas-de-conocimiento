# Rama `hasta-2026-10-28`

Esta rama reúne el trabajo hecho hasta el 28 de octubre de 2026.

Su base es `727bb808`, el último commit integrado el 28 de octubre. Sobre ella se agregaron los
commits escritos el 28 o antes que se integraron después:

| SHA | Asunto |
|---|---|
| `1e313e16` | fix(anonymise): additive byline passes; every author after ";" "\|" "," redacted |
| `bbd02990` | fix(anonymise): byline passes in one linear pass; years, stray noncharacters |
| `078e7ddf` | test(anonymise): pin mutants M22 and M32 of the additive byline passes |
| `4d10ac0f` | fix(anonymise): linear author split and edge trims; pin four leaking mutants |
| `d1412643` | feat(anonymise): keep a documento's own byline authors (owner ruling R60) |
| `d3666918` | fix(anonymise): R60 keeps only the uploader, never a name read from a byline |
| `a2457699` | docs(infra): edc-1 §4y — dev on the DGX Spark (audio, gate detector, rerank); audio worker starts after the API |
| `b6198f52` | fix(web): Mis temas fills in without a reload |
| `27472097` | fix(ajustes): a retired ecosistema is never the default nor a chip |
| `42e83419` | fix(biblioteca): full-width cards and reader; back keeps the list's place |
| `66cb8ede` | fix(web): chat answers show progress and open their sources; the app starts on a fresh composer |
| `41212024` | Merge branch 'main' into fix/ux-chat |
| `b5b523d3` | docs(infra): edc-1 §4zzz — dev deploy 127b21a |
| `587d0a37` | feat(evals): /admin/evals — platform-admin evals dashboard with real runs (copia de `ad199f46`) |

Por eso los merges y la copia tienen fecha del 2026-11-10, y los commits conservan su fecha de autor
original.
