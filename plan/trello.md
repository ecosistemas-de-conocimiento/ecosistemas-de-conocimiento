# Hecho

Base: monorepo, identidad en Payload, ecosistemas con corpus compartido y borradores privados
Puertos fuera del rango de otros servicios, stemming en español en el corpus
Archivos: subida PDF y DOCX, audio con transcripción, RustFS, servidos por la app
Flujo de audio visible de subida a publicación, sin texto explicativo
Chat: RAG real con citas por nombre, valoración de 1 a 5 con motivos y aviso
Selector de ecosistema en la barra lateral, con cambio y limpieza de estado
Admin: ve todos los ecosistemas, Contribuciones con selector y buscador
Seguridad: cerrados 4 huecos de acceso entre ecosistemas, sesiones y archivos
Pruebas: suites E2E, sin fallos al azar, sin choque de puertos ni borrar otra base
Corregidos 13 errores de subida, ingesta, publicación, hidratación y estilos
Grafo del corpus y GraphRAG, con vista /grafo y semillas por categoría
Plan de anonimización y Voces, corregido con tus notas
Gate de anonimización antes del corpus, con estado de espera
Voces siempre anónimas, sin guardar de quién son
Rol Investigador que sube documentos y Voces a nombre de otras personas
Ingesta de conversaciones turno por turno, con turnos del asistente marcados
Cada fragmento marcado como documento, testimonio o conversación
Biblioteca del ecosistema con documentos y voces publicados
Editar la transcripción antes de publicarla
Métricas de chat para admin: totales del ecosistema por endpoint de agregados
Español en sign-in, sign-up, errores de auth, DegradedBanner y página de error
Mis documentos, y borrar una conversación de verdad
Color de acento: ciruela, y chat usable en teléfono
Demo sembrado con los 250 documentos del corpus
Lengua y tema guardados en cada documento
Migraciones colapsadas a una sola baseline
Decidido: RustFS como almacenamiento en todos los entornos
Decidido: una caja propia de EDC en Hetzner, sólo dev y staging
Compose único que Coolify puede desplegar

# Abierto

Activar reranker DeepInfra
Reescritura de preguntas antes de buscar
Org por ecosistema en ai-service (en curso), resuelve el tope de gasto compartido
Desplegar dev y staging en la caja de EDC; compose listo, deploy sin confirmar
Grafo local: no es mock, 672 entidades reales (medido en la auditoría IA, 2026-10-17); ¿falta re-extraer?
Re-correr el eval de GraphRAG con la métrica de citas nueva
Decidir qué hacer con `evento` en el grafo
Correr el script de reparación de documentos `pending`
Decidir dónde corre el scrub en prod; modelo externo aceptado sólo en desarrollo
Métricas de chat por tokens; hoy sólo costo, ai-service no separa por ecosistema
Subir transcripción a GPU
Liberar el modelo de whisper cuando está inactivo
Decidir qué hacer con el audio de prueba, es un fragmento de tu junta real
Limpiar los 90 ecosistemas y 130 usuarios de prueba
Commitear los 2 documentos de asesoría en el repo externo
Rotar 5 credenciales compartidas, una es llave viva en origin/main
