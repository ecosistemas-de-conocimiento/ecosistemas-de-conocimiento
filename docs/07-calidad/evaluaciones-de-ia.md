# Evaluaciones de IA

- **Versión:** 1.2
- **Fecha:** 2026-11-10
- **Estado:** vigente
- **Fuentes:** `apps/web/src/lib/server/evals/` (`runner.ts`, `score.ts`, `judge.ts`), `apps/backend/src/eval/RESULTS.md`, `plan/adr-corpus-graph.md` §19, `plan/spark-chat-eval-2026-10-26.md`, `scripts/spark-chat-eval/`, `scripts/cite-eval/`, mensaje de commit del 2026-10-28, `apps/backend/scripts/measurements/q24/README.md`, `plan/spark-ai-adopcion.md`, resultados de la corrida del 2026-10-29 para los ecosistemas 6, 7 y 8 (fuera del repo), kit diferencial de la compuerta (kit3) y sus corridas del 2026-11-07 y del 2026-11-10 (fuera del repo, en la carpeta de trabajo de la flota), `plan/orchestration/auditoria-2026-11-10/revision-ola4.md` (fuera del repositorio).

## Para quién es y qué responde

Este documento es para el equipo del proyecto, para revisores institucionales y para quien vaya a cambiar un prompt, un modelo o la compuerta de anonimización. Responde: qué se mide de la IA de Ecosistemas de Conocimiento (EDC), con qué herramienta y con qué método; qué resultados hay, con su fecha y procedencia; cuánto costó medir; qué tan confiables son esas cifras; y qué conviene hacer después.

La estrategia general de pruebas, que no mide calidad sino que el código hace lo que dice, está en [Estrategia de pruebas](estrategia-de-pruebas.md). La arquitectura de la IA (modelos, flujos, proveedores) está en [Pila de IA](../03-arquitectura/pila-de-ia.md).

## 1. Qué se evalúa

EDC hace con IA cuatro cosas cuya calidad importa: responder preguntas citando el acervo, recuperar los fragmentos correctos para esa respuesta, construir el grafo de conexiones y ocultar datos personales antes de publicar (la compuerta de anonimización). Cada herramienta de evaluación cubre una parte.

| Herramienta | Dónde vive | Qué mide | Cuándo se usó |
|---|---|---|---|
| Panel de evaluaciones `/admin/evals` | `apps/web/src/lib/server/evals/`, `apps/web/src/routes/admin/evals/` | Soporte de citas, rechazos correctos, posición del documento esperado (hit@k), fuga y sobre-redacción de la compuerta, estilo de respuesta | Desde el 2026-10-28; corridas registradas del 2026-10-29 |
| Arnés GraphRAG | `apps/backend/src/eval/` (`run.ts`, `score.ts`) | Si el grafo mejora las respuestas: recall mecánico contra el manifiesto del corpus | 2026-09-05, 2026-09-08 y 2026-10-17 (dev) |
| Arnés de recuperación | `apps/backend/src/eval/retrieval.ts` | MRR y recall@k de dense contra hybrid, con y sin rerank | 2026-10-17 |
| `spark-chat-eval` | `scripts/spark-chat-eval/` | Chat hospedado contra chat en el DGX Spark: latencia, concurrencia, marcadores, juez ciego | 2026-10-26 |
| `cite-eval` | `scripts/cite-eval/` | Soporte de citas antes y después de un cambio de prompt | 2026-10-28 |
| Q24 del detector | `apps/backend/scripts/measurements/q24/` | Prompt viejo contra prompt nuevo del detector de datos personales, con textos sintéticos | 2026-10-28 |
| Compuerta a escala de documento | `plan/spark-ai-adopcion.md` §1 | Costo, llamadas y nombres encontrados en documentos largos | 2026-10-17 |
| Kit diferencial de la compuerta (kit3) | fuera del repo, en la carpeta de trabajo de la flota | Si un cambio de código hace que la compuerta deje pasar algo que antes ocultaba: 26 516 casos, versión base contra versión nueva, sin modelo | 2026-11-04, 2026-11-07 y 2026-11-10 (sección 9) |

Glosario mínimo para leer las tablas:

- **RAG** (generación con recuperación): el modelo responde con fragmentos del acervo que se le pasan en el prompt, y los cita con `[N]`.
- **Dense**: búsqueda por similitud de vectores (embeddings). **Hybrid**: dense más búsqueda por palabras clave en español, fusionadas.
- **Rerank**: un segundo modelo reordena los fragmentos encontrados antes de pasarlos al chat.
- **MRR** (rango recíproco medio): 1 dividido entre la posición del primer resultado correcto, promediado. 1.0 es perfecto.
- **Recall@k**: proporción de casos en que lo correcto aparece entre los primeros k.
- **Juez LLM**: un modelo que califica la salida de otro modelo.
- **Compuerta** (gate): el paso que detecta y oculta datos personales en testimonios y documentos marcados para anonimizar.

## 2. Panel de evaluaciones `/admin/evals`

### 2.1 Qué es

Es parte de la Etapa 1: está en `main` y en dev desde el 2026-10-29 (migración `20261029_060304_evals`, citado de `infra/fleet/edc-1.md` §4zzzz). Es una página solo para el administrador de la plataforma. Guarda por ecosistema un conjunto de ítems de evaluación (`eval-items`) de dos clases y corre ese conjunto bajo demanda. Cada corrida queda como un registro `eval-runs` con estado, resultados por ítem, métricas, costo, modelos usados y commit.

- **Ítems `pregunta`:** una pregunta, los documentos que deberían salir citados y si la respuesta correcta es rechazar (decir que el acervo no lo cubre).
- **Ítems `privacidad`:** un texto sintético con términos marcados como `privado` (deben ocultarse) o `publico` (deben quedar).

### 2.2 Metodología

Leído en `apps/web/src/lib/server/evals/runner.ts`, `score.ts` y `judge.ts`, 2026-10-30.

1. **Ruta de producción, no una copia.** Cada pregunta es un turno real por `POST /api/generate` en modo síncrono: los mismos corpus, condensación, expansión de la consulta, recuperación, rerank, grafo, armado del prompt y generación que el turno de una persona. Corre en una conversación Generales que el backend abre solo para esa corrida y borra al terminar, lo que también retira sus turnos del acervo.
2. **Privacidad por la compuerta real.** Cada ítem de privacidad pasa por la compuerta de producción del backend (`/api/evals/gate`), que devuelve un veredicto por término y nunca el texto.
3. **Juez.** Usa el modelo de chat hospedado en el nivel `quick`, por el cliente de ai-service del propio ecosistema. El prompt del juez de citas es el mismo de `scripts/cite-eval/cite_eval.py`: estricto, responde SI o NO, ve el pasaje sin título y con un tope de 6000 caracteres.
4. **Costo al ecosistema.** Todas las llamadas se cargan al presupuesto del ecosistema en ai-service.
5. **Una corrida a la vez** por proceso web, y un arranque por ecosistema a la vez. Si el proceso se reinicia, la corrida se marca fallida y su conversación se borra.

### 2.3 Métricas

| Métrica | Cómo se calcula (`score.ts`, `aggregate`) | Lectura |
|---|---|---|
| `citationSupport` | Afirmaciones respaldadas entre afirmaciones juzgadas. Una afirmación es una oración con `[N]`, una por número citado, solo de la parte anterior a "Fuera de los documentos:". Máximo 8 por respuesta | Más alto es mejor |
| `refusalAccuracy` | Preguntas donde rechazar o no rechazar fue lo correcto, entre todas las preguntas. Se reportan aparte `falseRefusals` y `missedRefusals` | Más alto es mejor |
| `hit@1`, `hit@3`, `hit@5` | Preguntas con documento esperado cuyo primer documento esperado aparece entre las primeras k fuentes numeradas | Más alto es mejor |
| `leakRate` | Términos `privado` que sobrevivieron, entre términos `privado`, solo en ítems que terminaron `ready` (publicables) | Más bajo es mejor; debe ser 0 |
| `overRedaction` | Términos `publico` que se ocultaron, entre términos `publico`, en ítems `ready` | Más bajo es mejor |
| `holds` | Ítems de privacidad que la compuerta retuvo para revisión humana | Informativo. Una retención no es fuga |
| `styleShown` | Respuestas donde un juez decide que se nota el estilo pedido por el ecosistema | Solo aplica si el ecosistema tiene estilo |

Dos detalles de diseño que cambian la lectura:

- Un ítem retenido (`hold`) no cuenta para `leakRate`, porque no se publica. Si la compuerta retiene todo, la fuga es 0 aunque el detector no haya encontrado nada.
- ai-service guarda en caché los prompts idénticos durante unos minutos. Una segunda corrida inmediata puede devolver las mismas respuestas sin costo (citado del encabezado de `runner.ts`).

### 2.4 Resultados del 2026-10-29

Tres corridas en dev, entre 21:50 y 22:09 UTC (medido: campos `startedAt` y `finishedAt` de los resultados de la corrida del 2026-10-29, leídos el 2026-10-30). Chat y juez: `deepseek/deepseek-chat-v3.1`. Compuerta: `qwen3-30b-a3b-instruct-2507` en el Spark con respaldo hospedado.

| Ecosistema | Preguntas | hit@1 | hit@3 | hit@5 | citationSupport | refusalAccuracy | leakRate | overRedaction | Retenidos | Costo | Duración |
|---|---:|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| 6 Prevención del dengue | 10 | 0.75 | 1.0 | 1.0 | 0.945 (55 afirmaciones) | 1.0 | **1.0** (3 de 3) | 0 (0 de 6) | 1 de 2 | $0.042 | 5 min 43 s |
| 7 Discapacidad | 10 | 0.875 | 1.0 | 1.0 | 0.811 (53) | 0.9 (1 rechazo fallido) | 0 (0 de 10) | 0.667 (2 de 3) | 1 de 2 | $0.041 | 5 min 53 s |
| 8 Semiosis práctica | 10 | 0.5 | 0.75 | 0.875 | 0.921 (63) | 1.0 | 0 (0 de 5) | 0 (0 de 9) | 0 de 1 | $0.043 | 6 min 41 s |

`styleShown` solo aplica a Discapacidad, el único ecosistema con estilo de respuesta: 1.0 sobre 8 respuestas (medido, resultados de la corrida del 2026-10-29, ecosistema 7). Las preguntas con documento esperado fueron 8 por ecosistema.

Los nombres de los ecosistemas por número vienen de la revisión de contexto del proyecto y de los seeds; la asignación de ids 6, 7 y 8 no se consultó en la base (inferido).

### 2.5 Hallazgo a investigar: fuga total en el ecosistema 6

En la corrida del ecosistema 6, el ítem de privacidad 12 terminó en `ready`, es decir, publicable, con sus tres términos privados intactos (medido, resultados de la corrida del 2026-10-29, ecosistema 6, leído el 2026-10-30). Los tres términos son frases de lugar de trabajo junto a una persona: una clínica dental con nombre propio, una telesecundaria con nombre propio y el DIF de un municipio pequeño. Los seis términos públicos del mismo ítem sí quedaron, como debían.

Por qué importa: es exactamente el caso que la medición Q24 del 2026-10-28 dice que el prompt final del detector ya oculta en 2 de 2 corridas, y que los prompts anteriores dejaban pasar (sección 7). La corrida del 2026-10-29 se hizo sobre una versión que ya incluye ese prompt.

Hipótesis, ninguna verificada:

1. El contenedor que corrió la compuerta usaba un prompt anterior.
2. El respaldo hospedado contestó en lugar del Spark y se comporta distinto.
3. La regla de figuras públicas (`keepPublicFigures`) del ecosistema conservó esas frases.
4. El comparador de la evaluación no reconoce la forma en que se ocultaron.

Hasta aclararlo, la compuerta no debe describirse como probada para lugares de trabajo. Ver la recomendación 1.

### 2.6 Lectura de los demás números

- **Sobre-redacción de Discapacidad, 2 de 3.** La compuerta ocultó dos términos que debían quedar. Con 3 términos públicos, cada uno pesa un tercio.
- **hit@1 de Semiosis, 0.5.** El documento esperado salió primero en la mitad de las preguntas con documento esperado. Ese ecosistema tiene trabajos de estudiantes con temas cercanos entre sí (inferido de `seed/semiosisDemo.ts`), lo que puede explicar la dispersión; no se investigó.
- **citationSupport entre 0.81 y 0.95.** Lo juzga el mismo modelo que responde (ver limitaciones).

## 3. GraphRAG: ¿el grafo mejora las respuestas?

### 3.1 Metodología

`apps/backend/src/eval/run.ts` genera respuestas reales a 20 preguntas (10 locales, sobre un documento; 10 globales, sobre patrones entre documentos) en dos brazos: plano (solo recuperación por vectores) y con grafo. Tres repeticiones por pregunta y brazo, 120 generaciones por corrida. La calificación es **mecánica**: las etiquetas esperadas se buscan como texto en la respuesta y salen de `MANIFEST.csv` del corpus sintético, no de un juez. El documento lo justifica: un modelo que califica un grafo construido por la misma familia de modelos sería el instrumento equivocado (citado de `RESULTS.md`).

Regla de lectura: se compara dentro de una misma corrida, nunca entre corridas. El brazo plano dio 0.430 global en la primera y 0.461 en la segunda con las mismas preguntas; esa diferencia es muestreo del modelo.

> Corrección del 2026-10-16 registrada en `RESULTS.md`: la columna que esas corridas llaman "precisión de citas" es en realidad **precisión de recuperación**. Mide cuántos de los cerca de 5 documentos puestos en el prompt contienen un dato, no qué citó el modelo. Su piso es 0.20. Las dos corridas no se pueden recalificar con la métrica corregida.

### 3.2 Corrida 1, 2026-09-05 (`20260905060010`)

Medido, citado de `RESULTS.md` y `plan/adr-corpus-graph.md` §19. 191 documentos, umbral de soporte del grafo en 3. Costo: $0.14.

| Clase | Brazo | Recall medio | Precisión de recuperación | Latencia media |
|---|---|---:|---:|---:|
| Local | plano | 0.967 | 0.380 | 8.5 s |
| Local | grafo | 0.978 | 0.380 | 7.4 s |
| Global | plano | 0.430 | 0.680 | 14.0 s |
| Global | grafo | 0.414 | 0.649 | 15.4 s |

Conclusión registrada: no hubo ganancia global medible. El grafo cambió la respuesta en 2 de 20 preguntas, costó 11 % más por llamada, y 6 de 10 preguntas globales no encontraron ninguna entidad semilla.

### 3.3 Corrida 2, 2026-09-08 (`20260908091626`)

Mismo arnés. El único cambio fue el sembrador de entidades (`seedEntitiesForQuery` en `lib/graph/queries.ts`).

| Clase | Brazo | Recall medio | Precisión de recuperación | Latencia |
|---|---|---:|---:|---:|
| Local | plano | 0.978 | 0.380 | 8.5 s |
| Local | grafo | 0.989 | 0.364 | 11.4 s |
| Global | plano | 0.461 | 0.680 | 12.6 s |
| Global | grafo | **0.733** | 0.691 | 17.2 s |

- Recall global de 0.461 a 0.733, una mejora relativa de 59 %. Por pregunta: mejor en 5, peor en 2, igual en 13.
- Las cuatro ganancias grandes (G01, G03, G04, G10) son las preguntas que antes no sembraban ninguna entidad y ahora siembran ocho.
- Costo: 26 % más por llamada. El tramo del grafo pasó de una mediana de 78 ms a 388 ms.
- No se movieron G05 (lenguas) ni G07 (comunidad de origen). Esas las responde la columna `documents.lengua`, no el grafo.
- G09 perdió 0.11; n=1, en observación.

### 3.4 Corrida 3, 2026-10-17, en edc-1 dev (`20261017195542`, `20261017203514`)

Mismo arnés (`run.ts`, brazos plano y grafo, 3 repeticiones), 19 preguntas, 163 documentos publicados de dev, con expansión de la pregunta; una corrida con rerank y otra con `--no-rerank`. Measured por otra sesión el 2026-10-17; citado de `RESULTS.md` («Answer-level rerank arms on edc-1 dev»), no vuelto a medir.

| Clase | Brazo | Recall con rerank | Recall sin rerank |
|---|---|---:|---:|
| Local | plano | 0.951 | 0.963 |
| Global | plano | 0.598 | 0.472 |
| Global | grafo | **0.720** | 0.669 |

- Con rerank, el grafo sube el recall global de 0.598 a 0.720; sin rerank, de 0.472 a 0.669.
- Corpus, entorno y número de preguntas distintos a las corridas 1 y 2: no se compara con ellas.

## 4. Recuperación: dense contra hybrid, con y sin rerank

### 4.1 Metodología

`apps/backend/src/eval/retrieval.ts` envía las mismas peticiones que el chat envía para el corpus publicado, con topK 5, y mide la posición del documento objetivo. Solo recuperación: no se genera respuesta. Tres conjuntos de etiquetas: 10 preguntas locales y 10 globales del arnés, y `local-all`, 189 preguntas de un solo documento generadas para cada documento publicado con nombre único.

- Medición 3: 2026-10-17, 19:34 a 20:15 UTC, ai-service local, corpus `eco-1` con 191 documentos publicados. Costo: solo embeddings de consulta.
- Medición 4: 2026-10-17, 20:56 a 21:11 UTC, ai-service desechable con rerank `Qwen/Qwen3-Reranker-0.6B` en DeepInfra, sobre una copia de la base. Costo de rerank: cerca de $0.03 (inferido en `RESULTS.md` de 211 llamadas a $0.000123 medidos en una llamada representativa, más 209 menores).

### 4.2 Resultados

Medido, citado de `RESULTS.md` (mediciones 3 y 4). MRR@5:

| Etiquetas | n | dense | dense + rerank | hybrid | hybrid + rerank |
|---|---:|---:|---:|---:|---:|
| Arnés local | 10 | **0.950** | 0.875 | 0.475 | 0.600 |
| Arnés global | 10 | 0.720 | **0.925** | 0.733 | 0.750 |
| `local-all` | 189 | 0.936 | **0.955** | 0.503 | 0.688 |

Recall@5 en `local-all`: dense 0.989, dense + rerank 1.000, hybrid 0.698, hybrid + rerank 0.698.

Conclusiones registradas:

- Hybrid reduce a la mitad el MRR de un solo documento (0.94 a 0.50 en 189 preguntas). Por eso `CHAT_RETRIEVAL_MODE=dense` es el valor por defecto.
- Dense con rerank es el mejor brazo en el conjunto grande: mejor en 18 preguntas, peor en 13, igual en 158.
- En las 10 globales, el rerank sube el MRR de 0.720 a 0.925. Con n=10 es una pista, no un hallazgo.
- El rerank agrega entre 0.3 y 0.9 s por recuperación, medidos con carga variable en la máquina.
- Una sesión aparte midió el rerank a nivel de respuesta en dev (19 preguntas, 3 repeticiones): recall global plano 0.598 con rerank contra 0.472 sin él; con grafo, 0.720 contra 0.669 (citado de `RESULTS.md`, no vuelto a medir; tabla en §3.4).

## 5. Chat en el DGX Spark: `spark-chat-eval`

### 5.1 Pregunta y metodología

¿Pueden la respuesta del chat y la condensación de preguntas correr en el modelo local del DGX Spark (Qwen3-30B-A3B) en lugar del modelo hospedado (DeepSeek V3.1 por OpenRouter)? El objetivo es que el texto de las personas no salga a proveedores externos.

Método (citado de `plan/spark-chat-eval-2026-10-26.md`, medido el 2026-10-26 entre 01:13 y 01:33 UTC):

1. `build-prompts.ts` arma 22 prompts con código de producción, a partir del historial de chat de dev más 4 turnos escritos para la prueba. Los dos modelos reciben prompts idénticos byte por byte.
2. `run.py seq` llama a cada lado de uno en uno; `run.py conc` prueba concurrencia en el Spark.
3. `check.py` hace revisiones mecánicas: marcadores `[n]` válidos, caracteres de otros alfabetos, palabras en inglés.
4. Un revisor ciego (un modelo Claude Opus con esfuerzo medio) ve cada par como A y B en orden barajado y califica de 1 a 5 en cuatro ejes.

### 5.2 Latencia, secuencial

| Lado | Primer token, mediana | Primer token, p90 | Total, mediana | Total, p90 | Tokens de salida, mediana |
|---|---:|---:|---:|---:|---:|
| Hospedado (DeepSeek V3.1) | 2.45 s | 6.28 s | 12.6 s | 47.9 s | 177 |
| Spark (Qwen3-30B-A3B) | 2.17 s | 2.42 s | 7.2 s | 13.4 s | 297 |

- Velocidad de generación: 55.3 tokens por segundo en el Spark contra 8.9 en el hospedado. El documento advierte que esa noche OpenRouter estaba lento; el historial de dev muestra respuestas de 5.1 s en promedio (citado de `spark-ai-adopcion.md`).
- Condensación: mediana 4.64 s hospedado contra 1.27 s en el Spark.

### 5.3 Concurrencia en el Spark

El servidor tiene 4 ranuras de 16 384 tokens cada una, compartidas con la compuerta.

| Carga | Primer token | Total | Tokens por segundo por flujo |
|---|---|---|---|
| 1 chat | 2.96 s | 13.6 s | 53 |
| 2 chats | 3.2 a 5.8 s | 18.6 a 23.5 s | 22 a 33 |
| 3 chats y una llamada de compuerta | 4.8 a 9.8 s | 20.8 a 27.7 s; compuerta 10.1 s | 18 a 30 |
| 4 chats y una llamada de compuerta | 4.7 a 12.6 s | 17.9 a 29.8 s; compuerta 9.8 s | 14 a 27 |

### 5.4 Calidad

Revisión mecánica sobre las 44 respuestas (medido): 0 marcadores `[n]` inválidos en ambos lados. Qwen abre un párrafo "Fuera de los documentos:" en 13 de 17 turnos de respuesta; el hospedado en 6 de 17.

Juez ciego (una sola pasada de un solo juez, por eso el documento lo marca como inferido):

| Modelo | Citas | Fidelidad | Fluidez | Reglas | Preferido |
|---|---:|---:|---:|---:|---|
| Hospedado (DeepSeek V3.1) | 4.09 | 4.27 | 4.82 | 3.91 | 11 |
| Spark (Qwen3-30B-A3B) | 3.00 | 3.59 | 4.64 | 3.41 | 6, más 5 empates |

El juez consideró claramente peor a Qwen en 9 turnos y al hospedado en 2. Los fallos de Qwen: detalles inventados, palabras de un documento atribuidas a otras personas, el bloque de "conversaciones anteriores" usado como fuente, y documentos ajenos citados dentro del relato de una persona.

### 5.5 Veredicto registrado

- Condensación en el Spark: viable.
- Respuesta del chat en el Spark: todavía no. Siguiente paso propuesto: ajustar el prompt para Qwen y repetir; si la brecha sigue, probar gpt-oss-120b.
- Costo de la prueba: menos de $0.02 (inferido en el documento a partir de las estimaciones por llamada de `resolve.ts`).

## 6. Soporte de citas antes y después: `cite-eval`

### 6.1 Metodología

`scripts/cite-eval/` no tiene README. Su diseño y resultados están en un mensaje de commit del 2026-10-28 (leído el 2026-10-30). El cambio evaluado: cada fuente numerada del prompt empieza con "Título: …", para que el modelo relacione mejor cada afirmación con su `[N]`.

- 16 turnos de respuesta del arnés del 2026-10-26, 3 repeticiones por lado, antes y después.
- Recuperación contra el ai-service de dev, con embeddings y rerank en el Spark.
- Respuesta y juez: Qwen3-30B-A3B en el Spark. El juez responde SI o NO a "¿el pasaje N respalda esta oración?", con temperatura 0. Sin llamadas pagadas.

### 6.2 Resultados

| Medida | Antes | Después |
|---|---|---|
| Citas respaldadas | 258 de 373 = 69.2 % (por repetición 75, 69 y 65 %) | 212 de 299 = 70.9 % (75, 65 y 71 %) |
| Turnos de Discapacidad (A6, A7, F4, F5) | 73 de 95 = 77 % | 64 de 70 = 91 % |
| `[N]` inválidos | 0 | 0 |
| Respuestas sin `[N]` | 3 de 48 | 4 de 48 |

Lectura del propio commit: el cambio global cae dentro de la dispersión entre repeticiones, así que no hay cambio medible en total. El juez es el mismo modelo que responde, y en el lado "después" cada `[N]` lleva más texto, lo que puede favorecerlo.

Desde el 2026-10-28, el prompt de este juez es el que usa `/admin/evals` (sección 2.2).

## 7. Detector de datos personales: Q24

### 7.1 Metodología

Citado de `apps/backend/scripts/measurements/q24/README.md`. El 2026-10-28, en la estación de trabajo local, con Qwen3-30B-A3B en el Spark y `GATE_BACKEND=spark` (sin respaldo hospedado, $0). Prompt viejo contra prompt nuevo del detector, por el código real de la compuerta, solo con textos sintéticos escritos para la medición. Dos corridas por texto y prompt, en tres rondas. Un script (`score.py`) cuenta cuántos términos de cada clase sobrevivieron completos.

### 7.2 Resultados

| Caso | Prompt antes de Q24 | Prompt final |
|---|---|---|
| 10 nombres públicos que deben quedar | 2 de 10 y 0 de 10 | 10 de 10 en ambas corridas |
| 3 lugares de trabajo junto a una persona, que deben ocultarse | se filtraron los 3 en ambas corridas | ocultos los 3 en ambas corridas |
| Instituciones genéricas de control ("apoyo del DIF y del IMSS", "un PILARES de la alcaldía", "la UNAM"), que deben quedar | 3 de 3 | **1 de 3 y 0 de 3** |
| Municipios de control, que deben quedar | 3 de 3 | 3 de 3 y **2 de 3** |

El prompt final corrigió los nombres públicos y los lugares de trabajo, pero empezó a ocultar instituciones genéricas y un municipio. Es un intercambio: menos fuga, más sobre-redacción.

## 8. Compuerta a escala de documento

Citado de `plan/spark-ai-adopcion.md` §1, medido el 2026-10-17 con el detector hospedado:

| Documento | Llamadas al detector | Costo | Tiempo | Nombres encontrados |
|---|---:|---|---|---|
| 1 195 palabras | 11 | $0.0065 a $0.0077 | no registrado | 20 de 20 |
| 4 866 palabras | 42 | $0.024 | 82 s | no registrado |

Con verificación de 3 pasadas (`ANONYMISE_VERIFY_ROUNDS=3`), un nombre completo pasó en 2 de 12 corridas sobre el texto de 4 866 palabras (citado de `infra/.env.example`, medido 2026-10-18 en el stack local con modelo real). Por eso el valor por defecto es 1 pasada que solo juzga, y cualquier resto retiene el documento.

## 9. Kit diferencial de la compuerta (kit3)

### 9.1 Qué es

Una batería de 26 516 casos en 20 conjuntos: casos escritos a mano, prosa, intentos de inyección y textos generados al azar con semillas fijas (medido el 2026-11-07, contando cada conjunto). Cada caso pasa por la compuerta de dos versiones del código, la base y la nueva, y el kit compara las salidas. Cuenta `leak-at-head`: casos donde la versión nueva deja visible algo que la base ocultaba. Es determinista: `main` contra sí mismo da 0 diferencias, y una versión nueva falsa con un nombre restituido da `leak-at-head 1` (medido el 2026-11-07 en la estación de trabajo).

Vive fuera del repositorio, en la carpeta de trabajo de la flota del equipo de desarrollo, con sus sumas `SHA256SUMS`. No corre en ningún ciclo automático.

**Qué no mide.** Corre la compuerta con un detector vacío: sin modelo, sin autores y sin interruptores. Mide las etapas estructural y determinista, no la etapa del modelo. Un `leak-at-head 0` no dice nada de los nombres que solo detecta el modelo. Tampoco cubre permisos, API ni grafo.

### 9.2 Resultados del 2026-11-10

Medido en la estación de trabajo del equipo de desarrollo (16 núcleos), el 2026-11-10; horas de México (UTC−6). Corrió junto con otras suites: la carga promedio al arrancar la corrida de las 11:56 era 13.4 (1 min) y 8.7 (15 min). Citado de los totales de cada corrida (`res/TOTAL`) y de `plan/orchestration/auditoria-2026-11-10/revision-ola4.md` (fuera del repositorio).

| Corrida | Base contra nueva | Casos | `leak-at-head` | Más redactado | Texto distinto |
|---|---|---:|---:|---:|---:|
| Ola 2, 01:35 | `a84baacf` contra `6ca9c92c` | 26 516 | 2 | 0 | 2 |
| Ola 4, carril F, 11:56 | `6a880e01` contra la rama del carril | 26 516 | 0 | 1 | 1 |
| Ola 4, 12:36 | `367c2698` (dev) contra `58078b7f` | 26 516 | 0 | 1 | 1 |
| Ola 4, 13:11 y 13:28 | `f764ee7f` contra `2dda9a8b` y contra `ccce6281` | 26 516 cada una | 0 | 1 | 1 |
| Ola 4, 13:42 | `0bfe8ceb` contra `0400099a` | 26 516 | 0 | 1 | 1 |

Lectura:

- Las 2 "fugas" de la ola 2 las revisó la auditoría independiente del mismo día: en esos casos la versión nueva redacta más, no menos (citado de `plan/orchestration/2026-11-09-edc.md`, fuera del repositorio). No son fugas.
- Las corridas de la ola 4 no encontraron ningún caso que la base ocultara y la versión nueva dejara ver. La única diferencia es un caso más redactado.
- La revisión de la ola 4 encontró aparte, con sondas propias, fechas que la compuerta todavía no oculta ("3 de Mayo del 90", el primer día de un rango). Eso no es una regresión que kit3 detecte: la base tampoco las ocultaba.

## 10. Costos de evaluar

| Evaluación | Costo | Procedencia |
|---|---|---|
| `/admin/evals`, una corrida por ecosistema | $0.041 a $0.043; estimado previo $0.083 | medido, resultados de la corrida del 2026-10-29 |
| GraphRAG, corrida 1 (120 generaciones) | $0.14 | citado de `adr-corpus-graph.md` §19 |
| Rerank en la medición 4 de recuperación | cerca de $0.03 | inferido en `RESULTS.md` |
| `spark-chat-eval` | menos de $0.02 | inferido en el documento |
| `cite-eval` y Q24 | $0 en dinero; tiempo del Spark prestado | citado de un mensaje de commit del 2026-10-28 y del README de Q24 |

Dos advertencias sobre estos costos:

- El costo de `/admin/evals` no incluye todo. Las llamadas al Spark y el rerank registran $0 o nada en ai-service (citado del encabezado de `runner.ts` y de la revisión de la pila de IA del 2026-10-30).
- Cada corrida se carga al presupuesto mensual del ecosistema, que por defecto es $5 (citado de `infra/fleet/env-manifests.md`). Unas 100 corridas agotarían el mes de un ecosistema (inferido de $0.042 por corrida, sin contar el uso normal).

## 11. Limitaciones

1. **El juez es el mismo modelo, o de la misma familia, que responde.** En `/admin/evals` el juez y el chat son DeepSeek V3.1. En `cite-eval` ambos son Qwen. Un juez así tiende a aprobar su propio estilo de afirmación. El arnés GraphRAG evita el problema con calificación mecánica.
2. **Muestras pequeñas.** 10 preguntas por ecosistema en `/admin/evals`, con 2 o 3 ítems de privacidad y entre 3 y 10 términos por clase. Un solo término mueve `overRedaction` en 33 puntos en Discapacidad. Las 10 globales del arnés de recuperación son una pista.
3. **Una sola pasada.** Las corridas del 2026-10-29 son una por ecosistema. El juez ciego de `spark-chat-eval` es una sola pasada de un solo juez. Solo GraphRAG y `cite-eval` repiten 3 veces.
4. **Datos sintéticos.** Todo se midió sobre el corpus sintético de `corpus-generativo` y textos escritos para medir. No hay medición con testimonios reales.
5. **Mediciones con carga variable.** Varias latencias se tomaron con otras sesiones usando la misma máquina; los documentos lo dicen y piden leer la magnitud, no los dígitos.
6. **Resultados fuera del control de versiones.** Los resultados de la corrida del 2026-10-29 y kit3 están fuera del repo.
7. **No hay corridas de `/admin/evals` más recientes registradas** que las del 2026-10-29 (leído en `infra/fleet/edc-1.md` hasta §4zzzzzzzz y en este documento).

## 12. Recomendaciones

1. **Investigar el `leakRate` 1.0 del ecosistema 6** antes de afirmar que la compuerta oculta lugares de trabajo. Revisar qué prompt y qué backend (Spark o respaldo) atendieron la llamada, si `keepPublicFigures` estaba encendido y cómo compara el evaluador. Repetir el ítem 12 al menos tres veces.
2. **Cambiar el juez a un modelo distinto del que responde**, o añadir calificación mecánica donde haya etiquetas, y registrar el modelo del juez en cada resultado (ya se guarda en `models.judge`).
3. **Repetir cada corrida al menos 3 veces** y reportar la dispersión, como hacen GraphRAG y `cite-eval`.
4. **Ampliar los conjuntos**: más ítems de privacidad por ecosistema, con lugares de trabajo, instituciones genéricas y figuras públicas, para medir el intercambio que mostró Q24.
5. **Versionar los resultados**: llevar a git los resultados de la corrida del 2026-10-29 y `plan/spark-chat-eval-2026-10-26.md`, y escribir el README de `scripts/cite-eval/`. Llevar kit3 al repositorio, con su corredor, para que cualquier cambio de la compuerta lo pueda correr.
6. **Volver a medir GraphRAG con la métrica de citas corregida** (`citationPrecision` y `citationRecall` desde los `[n]` de la respuesta), con el umbral de soporte vigente, que es 1 y no 3.
7. **Repetir `spark-chat-eval` después de ajustar el prompt para Qwen**, como propone su veredicto.
8. **Separar el presupuesto de evaluaciones** del presupuesto de uso del ecosistema, para que medir no compita con usar.

## Referencias

- `apps/web/src/lib/server/evals/runner.ts`, `score.ts`, `judge.ts`, `types.ts`
- `apps/web/src/routes/admin/evals/`
- `apps/backend/src/collections/EvalItems.ts`, `EvalRuns.ts`
- `apps/backend/src/eval/RESULTS.md`, `run.ts`, `retrieval.ts`, `score.ts`
- `plan/adr-corpus-graph.md` §19
- `plan/spark-chat-eval-2026-10-26.md`, `scripts/spark-chat-eval/`
- `scripts/cite-eval/`
- `apps/backend/scripts/measurements/q24/README.md`
- `plan/spark-ai-adopcion.md`
- `infra/.env.example`
- [Estrategia de pruebas](estrategia-de-pruebas.md)
- [Pila de IA](../03-arquitectura/pila-de-ia.md)
- [Protección de datos](../06-privacidad-y-seguridad/proteccion-de-datos.md)
- [Registro de riesgos](../01-proyecto/registro-de-riesgos.md)
