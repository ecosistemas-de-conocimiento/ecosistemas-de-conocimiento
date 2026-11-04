# Justificación del servidor de desarrollo

## Antecedentes

Antes de solicitar el servidor de desarrollo, el proyecto contemplaba trabajar con Maya IA, una empresa mexicana de infraestructura para inteligencia artificial. Maya IA nos ofrecía acceso a una computadora con tarjeta de video (GPU) de penúltima generación. La propuesta de Maya IA cambió y la colaboración no se concretó.

Para cubrir parte de lo que esa colaboración nos iba a dar, proponemos comprar un equipo propio: una computadora dedicada que funcione como servidor de desarrollo del proyecto.

## Para qué sirve

El servidor concentra el trabajo diario de desarrollo del proyecto:

- **Editar el código y trabajar las iteraciones del proyecto.** El equipo de desarrollo programa y prueba los cambios directamente en el servidor.
- **Construir la plataforma.** El servidor genera las versiones ejecutables de la plataforma a partir del código (los *builds*).
- **Publicar versiones de prueba y demostración.** Cada cambio puede publicarse en un entorno de desarrollo para revisarlo antes de llevarlo a producción.
- **Guardar las bases de datos y los archivos** de esas versiones.
- **Respaldar la información.** El servidor guarda copias de seguridad de las bases de datos y los archivos.
- **Correr las pruebas automáticas.** Cada cambio al código se verifica con pruebas que se ejecutan solas, antes de publicarlo.
- **Mantener varios entornos a la vez.** Se pueden levantar versiones separadas de la plataforma (por ejemplo, desarrollo y demostración), cada una aislada en su propio contenedor, sin que se afecten entre sí.
- **Probar cambios a la estructura de los datos.** Las migraciones de base de datos se ensayan con datos de prueba antes de aplicarlas a la versión pública.
- **Registrar y monitorear.** El servidor guarda los registros de funcionamiento de la plataforma, que permiten detectar y corregir errores.
- **Dar acceso remoto seguro al equipo de desarrollo**, controlado por la institución.
- **Correr modelos de inteligencia artificial pequeños** con su tarjeta de video. Ver la sección siguiente.

## Ventajas de un equipo propio

El equipo es físico y queda bajo resguardo en las instalaciones del CIDE. Esto ofrece tres ventajas:

1. **Una versión del proyecto siempre disponible.** La plataforma puede usarse a pequeña escala en todo momento, sin costo de renta.
2. **Protección de datos bajo control propio.** El proyecto podrá manejar información personal. Guardarla y procesarla en un equipo que la institución controla directamente facilita la protección de datos y el control de acceso.
3. **Menor gasto en proveedores externos de IA.** Parte del procesamiento de inteligencia artificial se hace en el equipo propio, en lugar de pagarlo por uso a un proveedor.

## Uso de la tarjeta de video

Con la tarjeta de video podemos probar modelos de inteligencia artificial sin pagar por cada uso. Las pruebas se centran en dos tareas:

- **Anonimización:** quitar los datos personales de un texto antes de que salga de la institución. Así, esos datos no tienen que enviarse a proveedores externos para ser procesados.
- **Filtro de consultas:** revisar las consultas antes de enviarlas a modelos de lenguaje externos (LLM).

En la primera fase de desarrollo, el resto de la inteligencia artificial la cubre un proveedor externo.

## Uso del presupuesto

El proyecto contaba con recursos asignados a la renta de servidores. Si no se ejercen en este periodo, se pierden. Destinarlos a equipo propio convierte un gasto recurrente en un bien que permanece en la institución. Al terminar el ejercicio presupuestal, el proyecto conserva el equipo y puede mantenerse vivo sin pagar rentas.
