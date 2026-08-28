# Hecho

Plan de anonimización y Voces documentado
Corregido: panel de Payload sin estilos
Admin ve todos los ecosistemas sin ser miembro
Seguridad: un admin podía asignarse membresía a cualquier ecosistema
Flujo de audio visible: subida, transcripción, publicación
Selector de ecosistema visible en la barra lateral
Vista de admin Contribuciones con selector y buscador
Citas muestran el nombre del documento
Chat con RAG e inferencia real, respuestas con citas
Puertos movidos fuera del rango de los prototipos
Quitar valoración
Motivos predefinidos de calificación con opción Otro
Valoración de respuestas de 1 a 5 estrellas
Corregido: pruebas que fallaban al azar
Stemming en español para el corpus
Corregido: sin límite de tamaño de subida en el servidor
Corregido: borrar un documento dejaba su contenido buscable
Corregido: frontend leía una variable de entorno inexistente
Corregido: selector de ecosistema inservible para admin
Corregido: toda subida de archivo devolvía 403 por CSRF
Corregido: publicar una nota markdown quedaba trabado para siempre
Corregido: toda modificación de documento devolvía 400
Corregido: pruebas de ai-service peleaban puerto con el demo
Seguridad: el harness de pruebas podía borrar la base de otro proyecto
Corregido: la app no hidrataba tras iniciar sesión
Corregido: extracción y transcripción leían de disco tras mover a S3
Corregido: la ingesta fallaba en silencio
Suite E2E de frontend con video y pausa de 350ms
Suite E2E de backend contra el stack vivo
Corregido: el backend corría pnpm dentro de la imagen y fallaba
Corregido: ai-service no arrancaba sin llave en el demo
Archivos servidos a través de la app, nunca por URL firmada
Almacenamiento de objetos con RustFS
Seguridad: cualquiera podía inyectar documentos en la sesión de otro
Selector de ecosistema con cambio y limpieza de estado
Cortar baseline de migración y pasar todo a migraciones
Subida de audio con transcripción automática en español
Seguridad: escalación apuntando un documento al archivo privado de otro
Seguridad: cualquiera podía leer o borrar archivos de otro ecosistema
Subida de documentos PDF y DOCX con ingesta a RAG
Modelo de ecosistemas con corpus compartido y borradores privados
Identidad fusionada dentro del backend de Payload
Monorepo completo: FE, backend, ai-service, audio-service, packages

# Abierto

Definir alcance del grafo del corpus
Campos de Voces: sujeto, en nombre de, nivel de consentimiento
Rol Investigador que sube documentos y Voces a nombre de otras personas
Ingesta de conversaciones al publicar los borradores citados
Marcar turnos del asistente en metadata
Anonimización de conversaciones antes de entrar al corpus
Decidir si las Voces son anónimas, seudónimas o atribuidas por defecto
Decidir si el scrub de anonimización corre local o en modelo externo
Vista de biblioteca con documentos y voces publicados del ecosistema
Liberar el modelo de whisper cuando está inactivo
Subir transcripción a GPU
Métricas de chat para admin: duración, tokens y costo
Editar la transcripción antes de publicarla
Traducir al español el panel de documentos y la página de error
Decidir qué hacer con el audio de prueba, es un fragmento de tu junta real
Limpiar los 90 ecosistemas y 130 usuarios de prueba
Resolver el tope de gasto compartido entre ecosistemas
Definir color de acento de la identidad visual
Aprobar fleet de 4 cajas a 55 dólares al mes
Decidir object storage para stage y prod
Commitear los 2 documentos de asesoría en el repo de los prototipos
Rotar 5 credenciales de los prototipos, una es llave viva en origin/main
