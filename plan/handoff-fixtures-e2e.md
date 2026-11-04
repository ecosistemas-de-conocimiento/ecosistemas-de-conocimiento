# Handoff — corpus-backed e2e fixtures

Estado al 2026-08-28. Este documento existe porque el contexto se perdió una vez;
es la versión escrita, no la memoria de nadie.

## De dónde salen los fixtures

Todo fixture de subida en e2e viene de **`../corpus-generativo`**, un repo
SEPARADO (`github.com/furenku/corpus-generativo`): 250 documentos sintéticos en
español mexicano, regenerables con `gen_corpus.py` semilla 445, y `MANIFEST.csv`
como su tabla de verdad.

🔴 **Nunca se copia ni se vendorea.** Se lee en su lugar, en `../corpus-generativo`,
y se puede apuntar a otro sitio con `CORPUS_DIR`. Un corpus regenerado es sólo
volver a correr los scripts.

## Las tres piezas que construyen los fixtures

- **`scripts/corpus-voices.sh`** — Piper TTS, voz `es_MX-claude-high`
  (alternativa `es_MX-ald-medium`). Crea un venv y cachea 63MB de modelo en
  `.cache/piper`. ~14x tiempo real en CPU, gratis y sin red. Escribe
  `media/voces/*.m4a` como AAC mono 16kHz.
- **`scripts/lib/txt_to_pdf.py`** — escritor de PDF sin dependencias. Helvetica +
  WinAnsiEncoding con transliteración cp1252, offsets de xref calculados,
  determinista byte a byte, pagina bien (verificado con el documento de 564
  palabras del corpus).
- **`scripts/corpus-fixtures.sh`** — arma un `.pdf`, un `.docx` y un `.m4a` más un
  manifiesto `fixtures.json`, y los deja en **ambos** `apps/backend/e2e/fixtures/`
  y `apps/web/e2e/fixtures/`.

Los dos directorios de fixtures y `.cache/` están en `.gitignore`: los fixtures se
**construyen**, no se commitean.

## Qué se elige, y cómo

Selección determinista, tomada de rebanadas **disjuntas** del corpus:

| tipo | regla | pieza actual | marcador |
|---|---|---|---|
| pdf | primer `*_testimonio_larga.txt` | SIM_0055 | Octavio Islas Bermúdez |
| docx | primer `*_carta_presentacion_*.docx` | SIM_0004 | Beatriz Olvera Ponce |
| audio | primer m4a de `media/voces` (de `*_testimonio_media.txt`) | SIM_0015, 55.2s, `audio/x-m4a` | Herminio Valdés Colín |

Los marcadores son **nombres de sujeto**, únicos entre los 250 documentos.

## 🔴 El contrato

- **Nada dentro de `e2e/` puede tener escrito a mano un nombre de archivo, un MIME
  o un marcador.** Se leen de `apps/backend/e2e/support/fixtures.ts` o
  `apps/web/e2e/fixtures.ts`.
- **Llama a `fixtures()` dentro de `beforeAll` o del cuerpo de un test, nunca en el
  módulo.** Lanza excepción si los fixtures no están construidos, y estas suites son
  `describe.skipIf(stackDown)` — una llamada arriba del todo rompe un skip legítimo.
- La entrada de audio trae `markerIsAssertable: false`. **Nunca afirmes su marcador
  como texto**: Whisper no deletrea un nombre propio hablado de forma confiable.

## Qué se retiró

`e2e-sample.pdf`, `acta-ecosistema.pdf`, `es-clip.mp3` (una grabación de 45s
commiteada sin procedencia) y los canarios sin sentido `ZANAHORIA-E2E-BACKEND` y
`NUBELIRIO`.

Actualizados: `apps/backend/e2e/{documents,audio,storage}.e2e.ts` y
`apps/web/e2e/journey.spec.ts`. `TESTING.md` documenta todo esto.

## Cobertura que apareció de paso

- **`kind: 'docx'` nunca se había ejercido de punta a punta.** Difiere del camino
  del PDF en una línea (mammoth en vez de unpdf) y ahora tiene su propio bloque
  `describe` con su propio mundo.
- La aserción de duración de audio va contra el manifiesto ±2s, no contra un `>30`
  mágico.
- El content-type servido por storage se afirma contra lo que guardó la **fila** de
  media, no contra lo que subimos — así la política de normalización de MIME de
  Payload no puede aparecer como una falla de storage.
- Las aserciones de marcador releen el `extractedText` sin truncar, porque
  `docState` recorta a 200 caracteres.

## Verificado (medido)

`pnpm typecheck` 0 errores en los seis workspaces. `pnpm test` 1,959 pasando, 0
fallando. Los marcadores de PDF y DOCX sobreviven a los extractores **reales**
(unpdf, mammoth). La generación de PDF es idéntica byte a byte en 3 corridas.
`audio/x-m4a` está en `MEDIA_MIME_TYPES` (`Media.ts`) y en `ACCEPTED_MIME_TYPES` de
audio-service.

## ⚠ No verificado

- ~~**Las suites e2e mismas.**~~ Ya corrieron: 2026-08-29 contra el stack local, y
  2026-10-17 contra un stack aislado con el proveedor falso (anonymisation, holds,
  tenancy, documents, testimonyRead y grafo pasan; audio, identity y ratings fallan,
  causa sin investigar). Cifras citadas de `TESTING.md`, que dice cómo se midieron.
- El tiempo de transcripción del clip nuevo de 55.2s. La cifra vieja de "~9s para
  45s" se midió contra el clip retirado, y cada comentario lo dice.

## Dejado en paz a propósito — no lo "arregles" sin decidirlo

- **`services/ai-service/src/eval/fixtures/`** se queda sin dominio. Su propio
  encabezado explica por qué: un fixture que codifica el tema de un consumidor
  mete ese dominio de contrabando en un servicio compartido.
- **`services/audio-service/scripts/make-fixtures.sh`** se queda en espeak-ng. Su
  test mide recall de palabras de contenido contra voz deliberadamente robótica,
  que es el caso más difícil.

## Abierto

1. ✅ **CERRADO (2026-08-29).** El seed ya carga los 250 documentos del corpus:
   `apps/backend/src/seed/{corpusSource,corpus,review}.ts`. Medido: 250 documentos
   en 4.29 s, segunda corrida en 76 ms sin duplicar.
   ⚠ La **ingesta viene apagada** (`SEED_CORPUS_INGEST=1` para prenderla): la
   biblioteca se ve llena y el asistente no recupera nada hasta que la prendes.
2. **La voz de Piper suena robótica.** Aceptada por ahora. Una grabación real sigue
   siendo el fixture que falta, y `TESTING.md` lo dice.
