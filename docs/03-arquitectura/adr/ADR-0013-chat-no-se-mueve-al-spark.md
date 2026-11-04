# ADR-0013. La respuesta del chat no se mueve al Spark por ahora

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** **rechazada por ahora** (mover la respuesta); viable sin desplegar (mover el condense)
- **Fecha de la decisión:** 2026-10-26
- **Quién decidió:** el equipo de desarrollo midió y emitió el veredicto; el responsable de desarrollo conserva la decisión de volver a intentarlo
- **Fuentes:** `plan/spark-chat-eval-2026-10-26.md`; `scripts/spark-chat-eval/`; `plan/spark-ai-adopcion.md` §2.7 y §3

**Para quién es y qué responde.** Para quien proponga alojar el chat en hardware propio. Responde qué se midió al probar la respuesta del chat en el DGX Spark, por qué no se adoptó y qué haría falta para volver a intentarlo.

## Contexto

El plan de adopción del Spark ([ADR-0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md)) dejaba la respuesta del chat alojada en todas sus fases. Aun así, las preguntas de los miembros y las transcripciones del micrófono en vivo son texto crudo que sale a OpenRouter. La prueba del 2026-10-26 preguntó si la respuesta (#8 del inventario) y el condense (#6, la reescritura de la pregunta de seguimiento) podían correr en el Spark con Qwen3-30B-A3B en lugar del modelo alojado, DeepSeek V3.1.

**Montaje de la prueba** (medido el 2026-10-26, citado de `plan/spark-chat-eval-2026-10-26.md`):

- 22 turnos: historia real de chat de dev más 4 escritos para la prueba.
- Cada prompt se armó con el código de producción (`prepareTurn`, variante de cita E, bloque de orientación, rerank) contra los corpus de dev.
- Los dos modelos recibieron prompts idénticos byte por byte, temperatura 0.4, 800 tokens de salida.
- Sin cambios en ningún entorno desplegado.

## Resultados

| Medida (22 turnos por lado) | Alojado (DeepSeek V3.1) | Spark (Qwen3-30B-A3B) |
|---|---|---|
| Tiempo al primer token, mediana | 2.45 s | 2.17 s |
| Tiempo total, mediana | 12.6 s | 7.2 s |
| Condense, mediana | 4.64 s | 1.27 s |
| Marcadores `[n]` inválidos | 0 | 0 |

El documento advierte que esa noche OpenRouter iba lento, alrededor de 8.9 tokens por segundo.

**Calidad.** Una revisión ciega (un solo juez, por eso cuenta como inferida) juzgó la respuesta de Qwen claramente peor en 9 de 22 turnos y la alojada en 2. Fidelidad media: 3.59 para Qwen contra 4.27 para el alojado. Fallas observadas en Qwen:

- detalles inventados;
- palabras de un documento atribuidas a otras personas;
- texto del bloque de orientación ("conversaciones anteriores") usado como fuente, contra la regla de [ADR-0011](ADR-0011-chat-con-recuperacion-densa-y-rerank.md);
- documentos de otras personas citados dentro de la historia de alguien.

**Capacidad.** El Spark tiene 4 ranuras de 16 384 tokens compartidas con el gate. Con 3 chats simultáneos, el primer token tardó de 4.8 a 9.8 s y una llamada del gate subió a unos 10 s (medido).

## Decisión

- **Respuesta del chat en el Spark: no**, tal como está hoy.
- **Condense en el Spark: viable**, con un ajuste de prompt. No se desplegó.
- **Siguiente paso registrado:** ajustar el prompt para Qwen y repetir el arnés. Si la brecha de fidelidad sigue, probar gpt-oss-120b en el Spark.

## Alternativas consideradas

| Alternativa | Por qué no se adoptó |
|---|---|
| Mover la respuesta igual, por privacidad | La fidelidad y el soporte de citas bajan de forma medible |
| Mover solo condense y respuesta | La expansión de consulta también manda la pregunta cruda; moverla exige el mismo cambio |
| Llamar al Spark desde `apps/web` sin pasar por ai-service | Pierde presupuesto, trazas y la verificación `systemPromptApplied` |

## Consecuencias

- Las preguntas de los miembros siguen saliendo a un proveedor alojado. Si la regla de privacidad las cubre es la pregunta abierta 6 del plan del Spark.
- Para cambiar de opinión hace falta, según §"What a switch would take":
  1. un cambio en ai-service para tener URL, modelo y llave por nivel de esfuerzo, porque `CHAT_COMPLETIONS_URL` es global;
  2. mover también la expansión de consulta;
  3. decidir la falla: un respaldo alojado anularía el propósito; lo coherente es mostrar "el asistente no está disponible";
  4. más ranuras o agendar el gate fuera de horas pico;
  5. aprobación del responsable de desarrollo para alojar texto de chat en una máquina de otra organización.
- El arnés quedó en el repo (`scripts/spark-chat-eval/`) para repetir la prueba.

## Referencias

- [ADR-0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md).
- [Evaluaciones de IA](../../07-calidad/evaluaciones-de-ia.md).
- [Pila de IA](../pila-de-ia.md).
