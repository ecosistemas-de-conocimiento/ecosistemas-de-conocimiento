# Ecosistemas de Conocimiento (EDC)

**Ecosistemas de Conocimiento (EDC)** es la plataforma de software del proyecto SECIHTI IH-2025-I-445 del CIDE. Su marco conceptual es el **Repositorio de Voces y Resonancias**, «un sistema de doble flujo»: recibe contribuciones situadas de las personas de cada ecosistema (**voces**) y, con el acervo acumulado, devuelve al campo materiales que esas comunidades revisan y corrigen (**resonancias**).

Un **ecosistema** es un grupo de personas en torno a un fenómeno social, como el dengue o la discapacidad, con su propio acervo, temas, miembros y funciones. La plataforma permite aportar documentos, audio y notas; pasa cada testimonio por una compuerta de anonimización; ofrece un chat que responde con citas al acervo, una biblioteca y un grafo de conexiones.

Más contexto: [Visión y alcance](docs/01-proyecto/vision-y-alcance.md).

## Estado

- **Etapa 1: prototipo y prueba de concepto.** Con corpus sintético muestra que el núcleo es viable: captura, compuerta de anonimización, acervo por ecosistema y resonancia con citas.
- **La entrega** es la etiqueta [`etapa-1`](https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento/tree/etapa-1): la Etapa 1 con correcciones, al 2026-11-12. La rama [`etapa-1-281026`](https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento/tree/etapa-1-281026) guarda la foto del 2026-10-28, sin correcciones.
- **En línea** en el entorno de desarrollo: <https://dev.ecosistemasdeconocimiento.com>.
- **La Etapa 2 sigue en desarrollo**, en la rama `etapa-2`.

Cierre de la etapa: [docs/00-cierre-etapa-1.md](docs/00-cierre-etapa-1.md). Toda la documentación: [docs/README.md](docs/README.md).

## Qué hay en el repo

| Carpeta | Qué contiene |
|---|---|
| `apps/web` | La web en SvelteKit: todas las vistas y el BFF, la única capa que llama el navegador |
| `apps/backend` | Payload 3 sobre Next 15: el dominio, los permisos, la compuerta de anonimización, el grafo y la identidad (JWT) |
| `services/ai-service` | Motor de IA y RAG agnóstico del dominio: ingesta, embeddings, recuperación, generación y presupuesto |
| `services/audio-service` | Transcripción de audio en Python (faster-whisper) |
| `packages/*` | `ai-client`, `chat-engine` e `identity-client`: el cliente de ai-service, el turno de chat RAG y la verificación de sesiones |
| `infra/` | Docker Compose del stack local, `.env.example`, imagen de Postgres con pgvector y manifiestos del servidor |
| `scripts/` | Fixtures del corpus, demos de ecosistemas y evaluaciones |
| `docs/` | La documentación del proyecto, en español |

## Replicabilidad

Se puede levantar en local con Node 22 o mayor (26 para ai-service), pnpm 9.15.4 y Docker con Compose. El stack local trae Postgres con pgvector, Redis y RustFS como almacenamiento S3. Los pasos están en la [Guía del desarrollador](docs/08-manuales/guia-del-desarrollador.md) §2 y §3.

Lo que depende de fuera:

| Pieza | En dev | En local |
|---|---|---|
| Modelos de chat, grafo y embeddings | OpenRouter, con retención cero (ZDR) | Una llave propia de OpenRouter, o el proveedor falso del perfil `fake`: cuesta $0, pero sus respuestas no tienen sentido |
| Transcripción, detector de anonimización, embeddings y rerank | Un DGX Spark prestado por otra organización, sin arranque automático ni supervisión | No hay Spark. El audio corre con Whisper local (perfil `audio`); el detector usa un modelo hospedado; el rerank va apagado |
| Respaldo de embeddings y rerank | DeepInfra | No se usa |
| Llaves de firma, secretos y llaves de proveedores | Fuera del repo | Las generas tú; `infra/.env.example` solo trae marcadores |
| Corpus sintético de arranque | Cargado | Vive en un repo hermano, `corpus-generativo`, privado por ahora; sin él la biblioteca queda vacía |

Con el proveedor falso, la plataforma arranca, se entra y se sube material, pero el chat, el grafo y el detector responden sin sentido: para ver resultados reales hace falta la llave de OpenRouter. Sin el Spark, el entorno de desarrollo pierde el audio y el micrófono en vivo. Detalle en [Infraestructura y entornos](docs/05-infraestructura/infraestructura-y-entornos.md) §4.

Los datos de prueba del repo son sintéticos.

## Contribuciones

Es un prototipo de investigación. Por ahora no se aceptan contribuciones externas ni se da soporte; los issues y pull requests no se atienden.

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).

## Privacidad

El repo no contiene datos personales reales, y la plataforma anonimiza los testimonios antes de publicarlos. Ver [docs/06-privacidad-y-seguridad/](docs/06-privacidad-y-seguridad/).

---

<sub>El desarrollo se apoyó en agentes de programación con IA, bajo la revisión del responsable de desarrollo.</sub>
