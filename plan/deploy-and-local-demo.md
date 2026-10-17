# Cómo correr y desplegar Ecosistemas de Conocimiento

Guía humana. El detalle técnico vive en `infra/`.

🔴 **Casi nada de esto se ha probado.** No corrí `docker compose up`. No construí una sola imagen. No
desplegué nada. Lo que sí corrí es `docker compose config`, que sólo dice que el archivo se lee bien.

✅ **Una excepción, y la marco donde aparece:** el almacén de archivos (RustFS) sí lo bajé, lo levanté
en un puerto de prueba y lo probé de verdad — crear bucket, subir, bajar, rotar llaves, la consola.
Después lo apagué y borré su volumen. Todo lo que diga ✅ **medido** sobre él es real. Lo demás sigue
siendo diseño, escrito leyendo el código de este repo.
Marco lo que asumí.

---

## 1. Correr el demo en tu máquina

**El comando:**

```
cd infra
cp .env.example .env
docker compose up -d --wait
```

Luego abres:

- `http://localhost:3000` — el producto
- `http://localhost:3002/admin` — el panel de Payload (también es el proveedor de identidad)

Entras con el correo y la contraseña que dejaste en `SEED_ADMIN_EMAIL` y `SEED_ADMIN_PASSWORD`.

Y si quieres ver los archivos guardados con tus propios ojos:

- `http://localhost:45411/rustfs/console/` — la consola del almacén de archivos.
  ⚠ **La parte final de la dirección hace falta.** Si entras a `http://localhost:45411` a secas te
  contesta con un error XML que parece que está roto. No lo está. ✅ Probado.

**Qué levanta:** web, backend, ai-service, Postgres con pgvector, Redis, **RustFS** (el almacén de
archivos), y **tres contenedores de audio** (no uno):

- `rustfs` — guarda los archivos que sube la gente. Es un almacén compatible con S3, o sea que habla
  el mismo idioma que Amazon S3 sin ser Amazon. Consola en `http://localhost:45411/rustfs/console/`.
- `audio-service` — la API. Recibe la subida, la guarda en disco y encola. No carga el modelo.
- `audio-service-worker` — transcribe. Es el contenedor pesado, el que tiene el modelo en RAM.
- `audio-service-callbacks` — entrega el webhook firmado de vuelta al backend.

🔴 **Si dejas fuera `audio-service-callbacks` no se rompe nada visible y se rompe el producto
completo.** La transcripción sí termina bien. No aparece ningún error, en ningún lado. Simplemente el
aviso nunca se entrega, el backend nunca se entera de que el texto existe, y el documento se queda sin
quedar listo. Para siempre.

### No necesitas GPU; necesitas una llave de modelo, o el proveedor falso

- 🔴 `MOCK_LLM`, `MOCK_EMBEDDINGS` y `MOCK_LLM_STREAM` ya no existen en ai-service. Si alguno está
  encendido, ai-service se niega a arrancar. Bórralos de tu `.env`.
- **Respuestas reales:** pon `OPENROUTER_API_KEY` en `infra/.env`. Es el único camino que cuesta dinero.
- **Modo falso, gratis:** descomenta el bloque del proveedor falso en `infra/.env`
  (`COMPOSE_PROFILES=fake` y tres variables; ver `infra/.env.example`). Arranca el servicio
  `fake-provider`, solo de pruebas, y ai-service corre su código real contra él.
- **Qué sí ves en modo falso:** subir documentos, chat con citas, calificar respuestas 1–5, multitenencia.
- ⚠ **Qué no ves:** calidad real de respuestas. Cada respuesta empieza con `[FAKE-PROVIDER TEST DATA]`.
  No demuestres calidad en este modo.

### 🔴 Los tres niveles, y qué cuesta de verdad el audio

⚠ **Corrijo aquí lo que yo mismo escribí antes.** La versión anterior de esta sección decía dos cosas
falsas. Decía que el audio era un problema de RAM. No lo es. Y decía que el nivel 3 "no cabe en 16 GB".
Sí cabe. Las corrijo, no las defiendo.

Lo que el audio cuesta de verdad es **CPU, reloj de pared, disco y tiempo de construcción**. La RAM es
justo el recurso que a este stack le sobra.

| nivel | qué incluye | RAM residente | comando |
|---|---|---|---|
| **1 — núcleo** | todo menos audio y los sidecars, **incluido el almacén de archivos** | ~0.9 GB | `docker compose up -d --wait postgres redis rustfs ai-service backend web` |
| **2 — producto** (por defecto) | + los tres contenedores de audio | ~2.0 GB en reposo, ~2.9 GB transcribiendo | `docker compose up -d --wait` |
| **3 — RAG avanzado** | + embeddings y reranking propios | ~7.1 GB | `docker compose --profile heavy up -d --wait` |

- ⚠ Todas las cifras son **estimadas**, sacadas de los límites que puse y del tamaño de los modelos.
  Ninguna está medida en este stack. ✅ **Una sola excepción:** el almacén de archivos consume
  **102 MB en reposo**, y ese número sí lo medí con el contenedor corriendo.

- El nivel 2 asume `WHISPER_MODEL=small`. Cabe en 8 GB y va cómodo en 16 GB.
- El nivel 3 con ~7 GB residentes **sí cabe en 16 GB en Linux.** Lo que de verdad duele son otras dos
  cosas:
  - 🔴 **Las construcciones, no la ejecución.** `bge-m3` y `rerank` piden ~3 GB de RAM cada uno mientras
    construyen su modelo, y el horneado de whisper pide ~2 GB.
  - 🔴 **En Docker Desktop (macOS/Windows) la memoria asignada a la VM es un techo duro**, y su valor por
    defecto suele ser 8 GB. Debajo de eso el nivel 3 muere por falta de memoria — y el mensaje habla del
    contenedor, no de la VM, así que buscas en el lugar equivocado. Sube ese número primero.
- 🟡 **Mi recomendación:** demuestra el producto en tu laptop (nivel 2) y el RAG avanzado en la caja
  `dev` del fleet. Es una división a propósito, no un parche.

### ☁ Por qué el almacén de archivos está en el nivel 1 y no es opcional

⚠ Fue una decisión real, con costo de los dos lados. Sube el nivel 1 en ~100 MB.

- **Subir archivos es el producto.** Esto es un repositorio de contenidos. Un nivel que no puede
  recibir un archivo no es un demo reducido: es otro producto. En el nivel 3 viven cosas que hacen la
  búsqueda *mejor*; el almacén hace que la subida *exista*. No van en la misma bolsa.
- 🔴 **Y la razón que decidió:** si lo pongo detrás de un interruptor opcional, quedan **dos
  interruptores que tienen que estar de acuerdo** — el del contenedor y el de las variables que lee
  el backend. Apagas uno y no el otro, y el backend queda apuntando a un almacén que nadie prendió.
  Este stack ya tiene tres casos así documentados (el secreto de callback, el modelo de whisper, el
  reranking) y en los tres la solución fue dejar **un solo interruptor**. Agregar un cuarto por
  100 MB es mal negocio a cualquier precio.
- 🔧 **El interruptor único que sí queda:** comenta las cinco líneas `S3_*` en `infra/.env` y el
  backend vuelve a guardar en disco local, como antes.

### 🔴 RustFS es para tu laptop y para `dev`. No para stage ni para producción.

Esto no es un pendiente que se me olvidó: es una decisión, y la escribo aquí para que no parezca un
descuido dentro de seis meses.

- Pasa todas las pruebas de funcionamiento. ✅ Lo probé de verdad: crear bucket, subir, bajar, borrar.
- Y falla en todo lo demás: **25 vulnerabilidades en 8 meses** (7 de gravedad crítica), **todas** sus
  versiones marcadas como "prelanzamiento", y reportes abiertos de **pérdida silenciosa de datos** en
  la configuración de un solo disco, que es justo la nuestra.
- En una laptop y en `dev` todo lo que guarda se puede volver a generar. En producción sería la única
  copia de la grabación de alguien. Ahí la cuenta no sale.
- **Qué usará stage y producción: está sin decidir**, y es la decisión #8 en la lista de abajo. La
  recomendación es S3 administrado (Cloudflare R2, ~$1/mes).
### 🔴 Cómo se siente de verdad un demo de audio en vivo

Esto es lo que hay que saber antes de prometerle un demo a alguien.

La transcripción en CPU corre aproximadamente **en tiempo real**. No "suficientemente rápido": en tiempo
real.

- ⚠ **Estimado, no medido:** `WHISPER_MODEL=small` (el valor por defecto local) corre a ~2–4× tiempo real
  en ~4 núcleos. Una grabación de 10 minutos termina en ~3–5 minutos.
- ⚠ **Estimado, no medido:** `WHISPER_MODEL=large-v3-turbo` (el valor por defecto del propio servicio, y
  el del fleet) corre a ~1× tiempo real. Una grabación de 10 minutos tarda ~10 minutos. Vas a estar ahí
  parado, esperando.

🟡 **Mi recomendación, dicha como recomendación: no demuestres un archivo de 10 minutos en vivo.**

- Ten a la mano una **grabación de prueba en español de 60 a 90 segundos**. Una sola voz, audio limpio, y
  una transcripción que puedas leer en pantalla.
- Con `small` termina en bastante menos de un minuto.
- Y demuestra exactamente el mismo camino: subida → cola → transcripción → callback firmado → documento
  listo → el chat RAG citándolo. No estás enseñando una versión reducida.
- Para algo más largo: **súbelo antes de la reunión** y enseña el documento ya terminado. Nada se está
  falseando al hacer eso. La transcripción es una cola asíncrona *por diseño*, precisamente porque es
  lenta.

🔴 **Lo que no debes hacer:** arrancar una transcripción larga frente a un público y ponerte a hablar
encima. El worker se lleva todos los núcleos que le permitas (`AUDIO_CPUS`, 4 por defecto) y la interfaz
que estás demostrando se pone lenta mientras corre. Eso se lee como una falla del producto. No lo es.

⚠ **La primera construcción del audio tarda ~10 minutos** y descarga los pesos del modelo (~250 MB con
`small`). Necesita red. Después de eso, cada arranque de contenedor funciona sin internet. **Constrúyelo
el día anterior, no durante el demo.**

### Si algo no arranca

- **La base de datos está vacía y no puedes entrar.** Revisa `EDC_ENV=local`. El código sólo siembra
  datos de demo cuando `EDC_ENV` es `local` o `dev`. Una base vacía es la reja funcionando, no una falla.
- **Las subidas se quedan en "embedding" para siempre.** `CALLBACK_SECRET` del backend tiene que ser
  idéntico al `callbackSecret` dentro de `API_KEYS` de ai-service. Es el error número uno.
- **Cambiaste un `package.json` y falta un módulo.** Los `node_modules` viven en volúmenes que sólo se
  llenan la primera vez. `docker compose down -v` y reconstruye.
- **El audio se transcribe pero el documento nunca queda listo.** Hay dos causas, y las dos son
  silenciosas: (a) el contenedor `audio-service-callbacks` no está corriendo; (b) `CALLBACK_SECRET` no
  coincide con el `callbackSecret` que va dentro de `API_KEYS` de audio-service. Hoy
  `infra/docker-compose.yml` **arma ese JSON a partir de la única variable `CALLBACK_SECRET`**, así que
  ya no pueden separarse. Si ves esto, sospecha primero de (a).
- 🔴 **El contenedor `rustfs` dice que está sano y las subidas fallan igual.** No es contradicción:
  su chequeo de salud **sólo prueba que el proceso está prendido**. Contesta "ok, listo" aunque el
  almacén no sirva. ✅ Lo medí: contesta `{"status":"ok","ready":true}` sobre un almacén vacío que
  nunca ha tenido un bucket. La prueba de verdad es pedirle el bucket real, y eso vive en la ruta de
  salud del backend, no aquí. ⚠ **No pongas un monitor apuntando a la salud de `rustfs`**: te daría
  luz verde durante una caída total.
- **Las subidas fallan con "no such bucket".** El bucket **no lo crea el docker-compose**, y RustFS
  no tiene ninguna variable de entorno que lo cree. ✅ Verificado contra el contenedor corriendo. Lo
  crea el backend al arrancar, y lo hace cada vez, a propósito.
- **Las subidas fallan con "InvalidAccessKeyId" después de cambiar una llave.** Cambiar
  `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` en `.env` sí rota la llave del almacén ✅ (lo probé),
  pero pide **reiniciar el contenedor**, no sólo guardar el archivo.
- **Borraste el volumen y ahora nada autentica.** `docker compose down -v` borra los archivos **y
  todas las credenciales** del almacén. Vuelven a crearse solas al arrancar el backend. Si no
  vuelven, revisa que el paso de aprovisionamiento corra en **cada** arranque y no una sola vez.
- **Cambiaste `WHISPER_MODEL` y el contenedor no arranca.** Los pesos están horneados dentro de la imagen
  y en ejecución el contenedor no tiene red (`HF_HUB_OFFLINE=1`). Cambiar de modelo pide
  `docker compose build audio-service`, no un reinicio.

### 🔴 Hoy el demo todavía no corre

Tres de las cinco cosas que faltaban ya se resolvieron. Quedan dos pendientes. Ninguna es mía, todas
son cortas.

1. ✅ **`pnpm-lock.yaml` ya existe en la raíz.** Era el bloqueo número uno; todas las imágenes usan
   `--frozen-lockfile` y ahora sí lo pueden satisfacer. Resuelto.
2. ✅ **`services/audio-service/` ya existe**, y `infra/docker-compose.yml` ya está reconciliado contra
   el servicio real: los tres contenedores, el volumen compartido, los pesos horneados. Leído de su
   código, no supuesto. Resuelto.
3. 🔴 **El proveedor de identidad no tiene llaves.** Corre `pnpm --filter @edc/backend keygen` una vez
   y pega el resultado en `infra/.env`. No hay valor por defecto y nada lo genera solo. Sin esto la app
   arranca pero no puede emitir un token.
4. ⚠ **Los paquetes de `packages/` publican desde `dist/`, y ningún Dockerfile corre `pnpm -r build`.**
   Puede que funcione por accidente o puede fallar con `ERR_MODULE_NOT_FOUND`. **No lo pude verificar.**
   Es lo primero que revisaría en la primera construcción.
5. ✅ **`apps/backend` ya usa `AUDIO_SERVICE_URL` y `AUDIO_SERVICE_API_KEY`**
   (`apps/backend/src/lib/audioClient.ts:45-68`) y su ruta de callback maneja los eventos
   `transcribe.*` (`apps/backend/src/app/api/ai-service/callback/route.ts`). Leído en el código el
   2026-10-17. El camino del producto (subir en la interfaz → documento listo) existe.

✅ `apps/backend/Dockerfile` ya se arregló mientras yo escribía esto. Ya no es la imagen vieja.

### 🔴 Stack local: después de reconstruir, mueve los datos de IA a una org por ecosistema

Desde el cambio a una org de ai-service por ecosistema, el backend manda `X-AI-Org: eco-<id>` y
ai-service lo trata como la org `edc-eco-<id>` (`apps/backend/src/lib/aiClient.ts:20,60-61`, leído en
el código). Los corpus que ya tenías siguen en la org vieja, `demo`. **Si reconstruyes las imágenes y
no mueves los datos, la búsqueda regresa vacía:** el chat contesta sin citas y nada falla en voz alta.

⚠ Al revés también engaña. Con imágenes viejas, `X-AI-Org: eco-2` regresó los corpus de eco-1, y los 16
corpus estaban en la org `demo` (medido en la auditoría IA del 2026-10-17). Si ves eso, tus imágenes son
anteriores al cambio.

Pasos, con el stack local arriba (contenedor `edc-postgres-1`, usuario `edc`, base `edc_ai`):

1. Reconstruye: `cd infra && docker compose up -d --build --wait`.
2. Para las subidas y la ingesta mientras corre el script.
3. **Prueba en seco.** Hace todo dentro de una transacción, imprime los conteos y hace rollback:

   ```bash
   docker exec -i edc-postgres-1 psql -U edc -d edc_ai -v ON_ERROR_STOP=1 \
     < scripts/ai-org-per-ecosystem.sql
   ```

4. Revisa los conteos. El script se niega si una org destino ya tiene un corpus con el mismo nombre;
   eso se resuelve a mano.
5. **Aplica**, con `-v apply=1`:

   ```bash
   docker exec -i edc-postgres-1 psql -U edc -d edc_ai -v ON_ERROR_STOP=1 -v apply=1 \
     < scripts/ai-org-per-ecosystem.sql
   ```

6. Comprueba: una pregunta en el chat de cada ecosistema debe traer citas de ese ecosistema y de
   ningún otro.

El encabezado de `scripts/ai-org-per-ecosystem.sql` explica qué mueve, qué no mueve y por qué.

---

## 2. Cómo se ve el fleet, y por qué

Detalle completo en `infra/fleet/topology.md`.

### Cuatro cajas, no seis

| caja | para qué | RAM | ~USD/mes |
|---|---|---|---|
| `control` | Coolify + construcción de imágenes | 8 GB | ~12 |
| `prod` | producción: web, backend, ai, audio | 16 GB | ~18.50 |
| `nonprod` | dev y stage juntos | 8 GB | ~12 |
| `data` | Postgres y Redis. **Nada de código de app.** | 8 GB | ~12 |

**≈ $55 USD/mes** más ~$3 de respaldos y alertas.

- ⚠ Sólo el precio de `prod` es citado. Los otros los inferí.
- ⚠ **Hetzner puede facturar 2.4× a 2.7× menos que su catálogo.** El número real será menor.
- Tenemos 4 servicios y un producto sin usuarios.

**Por qué `data` no se fusiona con `prod`:** todo lo que guarda estado vive en una caja que no corre
código. Así puedes reconstruir, cambiar de tamaño o reemplazar `prod` sin tocar un byte de datos. Es la
única pieza de su topología que no recortaría.

**Variante de 3 cajas (~$48/mes):** quitas `nonprod` y usas el demo local como ambiente de desarrollo.
🟡 Defendible antes del lanzamiento. Lo que pierdes es un lugar donde equivocarte barato. El demo local
no ensaya Coolify, ni TLS, ni el pipeline de construcción — y ahí es justo donde viven las fallas
conocidas de este stack.

### 🔴 Dónde viven los archivos subidos — cambió en `dev`, sigue igual en producción

Antes esta sección decía "los archivos viven en disco local, en todos lados". Hoy es medio cierto.

**Qué cambió: el audio.** La gente sube PDF, DOCX **y grabaciones**, y una grabación pesa entre 10 y
100 veces lo que un PDF. El disco local ya era la restricción más grande del diseño; el audio lo
volvió inviable, empezando por la laptop. Por eso `dev` ya guarda en un almacén de objetos.

| ambiente | dónde van los archivos |
|---|---|
| tu laptop | ✅ RustFS |
| `dev` | ✅ RustFS, en la caja `data` |
| `stage` | 🔴 disco local todavía |
| `prod` | 🔴 disco local todavía |

**En `stage` y `prod` siguen vivas las tres consecuencias de siempre:**

1. **Producción no puede crecer a dos cajas.** Un documento subido por la caja A da 404 desde la caja B.
   Por eso recomiendo una sola caja de producción. No es ahorro, es la única forma correcta hoy.
2. **Necesitas un volumen persistente en `prod`.** 🔴 Sin él, cada despliegue borra todos los documentos
   subidos. Es la manera más fácil de perder datos de un cliente en este diseño.
3. **Los respaldos tienen que cubrir ese volumen**, no sólo Postgres. Un respaldo de Postgres restaura
   los renglones que describen un archivo cuyos bytes ya no existen.

🟡 **Recomendación, y la ajusto en vez de cambiarla: pospón el almacenamiento de objetos en `stage` y
`prod`** hasta que necesites una segunda caja de producción. Cuando lo hagas, **usa S3 administrado**
(Cloudflare R2, ~$1/mes). Sólo un requisito de "hardware propio" justificaría auto-hospedarlo.
Ese requisito no es nuestro hasta que alguien lo escriba.

⚠ **Por qué en `dev` sí y ahora, si en producción digo que esperes.** Son dos argumentos distintos y
vale la pena no confundirlos. Posponerlo en producción es sobre **riesgo con datos que no se pueden
perder**. Correrlo en `dev` es sobre **ejercitar el código de S3 todos los días** en vez de el día de
la migración. La falla más cara que tuvieron ellos con esto no fue del almacén: fueron **dos pedazos
de código que seguían leyendo del disco** después de prender S3 — uno daba error 502 y el otro
**borraba imágenes de las exportaciones sin avisar**. Eso se encuentra usándolo a diario, y de
ninguna otra forma.

⚠ **Costo real de dejar la decisión #9 abierta:** hoy `stage` **no ensaya** el almacén que usará
producción. Y `stage` existe justamente para ensayar. Es la razón para cerrarla antes del primer
despliegue a stage que toque archivos, no después.

### 🔴 El hueco de los respaldos del almacén: las credenciales

El volumen de RustFS guarda **dos cosas distintas**: los archivos, y la lista de usuarios y llaves de
acceso. Suena a detalle y no lo es.

- 🔴 **Restaurar el volumen recupera los archivos y NO recupera una lista de llaves usable.** Te
  devuelve las llaves que existían el día del respaldo. Una llave rotada después vuelve muerta, y la
  app queda autenticándose contra una lista que **retrocedió en silencio**. Se ve como "el almacén
  está roto", horas después de dar la restauración por terminada.
- ✅ **La solución no es un respaldo mejor: es que el aprovisionamiento se pueda repetir.** El backend
  vuelve a crear el bucket y su usuario **en cada arranque**, así que un almacén restaurado, borrado o
  a medias se acomoda solo. 🔴 Lo que hay que cuidar es esa propiedad: si alguien lo "optimiza" a un
  contenedor de inicio que corre una sola vez, este párrafo se convierte en una caída.
- 🔴 **Y el archivo de llaves está en texto plano.** Copiar ese volumen es copiar todas las
  credenciales que ha emitido. Cífralo, o no hagas la copia. Es también por qué **no respaldamos el
  almacén de `dev`**: su contenido se puede regenerar, y una copia sin cifrar vale menos que el riesgo.

### Dónde corre la transcripción de audio

**Recomendación: en la caja `prod`, en CPU, con concurrencia 1 y un límite duro. Sin caja con GPU.
Cuesta ~$12/mes más.** ✅ Esa recomendación no cambia.

🔴 **Lo que sí cambia es la razón de subir de `cx33` a `cx43`, y la diferencia importa:** es por
**número de vCPU, no por RAM.** Los tres contenedores de audio juntos ocupan ~1.7 GB en reposo y ~2.8 GB
en su pico, que cabe de sobra en 8 GB. `cx33` trae 4 vCPU compartidos y `cx43` trae 8 — y la CPU es lo
que la transcripción de verdad consume. Mismo dinero, mejor razón.

- 🔴 **No compres una caja con GPU.**
  ✅ El servicio está construido en CPU por diseño, y pasar a GPU son dos
  variables (`WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=float16`) si algún día aparece una. No nos
  estamos cerrando la puerta.
- La transcripción es una cola, no una petición web. El navegador sube y consulta después. Nada
  bloquea al usuario.
- ⚠ **Estimado, no medido:** `faster-whisper` modelo `small` en int8 corre a ~2–4× tiempo real. Una hora
  de audio son ~15–30 minutos de reloj. El modelo por defecto del fleet, `large-v3-turbo`, corre a
  ~1× tiempo real: una hora de audio es ~una hora de reloj.
- 🔴 El límite de CPU no es opcional. Sin él, una subida larga hace que todo el producto parezca caído.
- 🔴 **En el fleet son tres aplicaciones de Coolify por ambiente, no una.** Con 3 ambientes son **18
  aplicaciones, no 12.** Es la consecuencia directa de que audio-service sean tres procesos.
- 🟡 El almacenamiento persistente de Coolify se define **por aplicación**, pero la API y el worker de
  transcripción tienen que **compartir** un mismo volumen en `/var/lib/audio-service`. Si eso no se puede
  hacer, usa el build pack de Docker Compose de Coolify para audio-service. Detalle en
  `infra/fleet/env-manifests.md` §4.
- 🟡 **Alternativa que descarté:** una API de transcripción administrada. Es más barata a bajo volumen.
  La descarté porque pediste un demo sin credenciales de nube, y porque las grabaciones son lo más
  sensible que maneja este producto. **Vale la pena volver a preguntarlo si el volumen crece.**

---

## 3. Respaldos: el número real

Detalle en `infra/fleet/backups.md`.

**Fase 1, desde el día uno, ~$3/mes:** volcado nocturno de Postgres, sincronización horaria del volumen
de archivos, ambos cifrados y fuera de Hetzner.

| objetivo | valor |
|---|---|
| **Cuántos datos puedes perder (RPO)** | **0 a 24 horas** |
| **Cuánto tarda volver (RTO), en horario laboral** | ~1 a 2 horas |
| **RTO de madrugada** | 🔴 **hasta 13 horas** |

🔴 **Lee ese último renglón otra vez.** La tecnología aporta ~40 minutos. El resto es una persona
despertándose. **No puedes prometer mejor que tu tiempo de detección.**

- Sus tiempos de detección medidos, antes de tener monitoreo: un backend en ciclo de fallas **27 horas**,
  una caja usando swap **6 días**, una caída total del producto **20 horas**.
- **Fase 2 (+$2/mes):** archivado continuo de WAL. Baja el RPO a **≤5 minutos** y te deja rebobinar a
  30 segundos antes de una migración mala. Eso es lo que un volcado nocturno no puede hacer.
- 🔴 **Un respaldo sin prueba de restauración no es un respaldo.** Un ensayo antes de lanzar, y uno cada
  trimestre.

⚠ **Trampa que casi nadie ve:** si Postgres restaura a hace 5 minutos y los archivos a hace 60, tienes
una base de datos que apunta a archivos que no existen. Peor que un retroceso limpio. Hay tres salidas;
están en el documento.

---

## 4. Lo que se deja fuera a propósito

- 📝 **Alta disponibilidad.** Primero respaldos y alertas. Dos hechos: **la replicación no es respaldo** (un standby replica
  fielmente un `DROP TABLE`), y **un failover que nadie ve es una trampa** — te deja en una sola caja sin
  protección y la *segunda* falla ya no se sobrevive.
- 📝 **Almacenamiento de objetos en `stage` y producción.** Hasta que haga falta una segunda caja de
  producción. ✅ En tu laptop y en `dev` **ya está puesto** (RustFS). 🔴 Que `dev` esté verde **no
  cierra** este pendiente — el motor de stage y producción sigue sin decidirse (decisión #8).
- 📝 **Los sidecars de RAG avanzado** (`bge-m3`, `rerank`) en el fleet. Existen y funcionan; están
  apagados por defecto.
- 📝 **Caja dedicada de construcción.** Es lo primero que se separa cuando las builds estorben.
- 📝 **Métricas y logs auto-hospedados.** Regla que no se rompe: **lo que te avisa no puede correr en la
  infraestructura que vigila.**
- 📝 **Publicar un número de uptime.** Mide dos o tres meses primero.

---

## 5. 🟡 Decisiones que necesito de ti

Ordenadas por lo que bloquean.

### 🔴 Bloquean cualquier aprovisionamiento

0. 🔴 **Falta la migración base de Payload.** `apps/backend/src/migrations/` está vacío. Hoy el esquema
   se crea con "push", que está bien en tu laptop y es peligroso en producción. **Cortar esa migración
   base es requisito del primer despliegue a stage**, no trabajo posterior. Ahora todos los ambientes
   están vacíos, que es la única ventana para hacerlo limpio. Se cierra con el primer usuario real.
   Son cuatro cambios que van juntos; están en `infra/fleet/env-manifests.md` §6.
1. **El dominio.** Todo sale de ahí: URLs, certificados, orígenes CORS. Necesito el dominio raíz y el
   esquema por ambiente (`app.` / `stage.` / `dev.`, o lo que prefieras).
2. **Región.** El fleet anterior estaba en Helsinki. ⚠ **Si estos datos deben residir en México** por la
   reforma de privacidad de 2025, hay que preguntarlo **ahora**, no después de comprar cajas. Hetzner no
   tiene región mexicana.

### 🟡 Decisiones reales

3. **3 cajas o 4.** $12/mes contra tener un lugar donde ensayar. → **Recomiendo 4.**
4. **Techo de presupuesto.** $48 / $55 / $95 compran cantidades visiblemente distintas de resiliencia.
5. **Compromiso de uptime.** 99% son 7.2 h/mes de caída; 99.9% son 43 minutos. ⚠ Con un equipo de una
   persona, una falla nocturna puede pasar 12+ horas sin verse. → **Recomiendo no prometer nada todavía.**
6. **Transcripción propia o administrada.** Costo contra custodia de las grabaciones.
   → **Recomiendo propia, en CPU.**
7. **Destino de los respaldos:** B2 o R2. → **Recomiendo R2**, gratis a nuestro volumen.
8. 🔴 **Qué almacén de archivos usan `stage` y producción.** RustFS se queda en tu laptop y en `dev`,
   y no sube de ahí. → **Recomiendo S3 administrado (Cloudflare R2)**, ~$1/mes y cero mantenimiento.
   La alternativa auto-hospedada es Garage, y sólo tiene sentido **si existe un requisito escrito de
   hardware propio**. ⚠ Es tuya y no mía porque el disparador es una pregunta de política —
   soberanía y custodia de datos —, no una técnica. ⚠ Mientras siga abierta, `stage` no ensaya el
   almacén de producción.
9. **Quién guarda la segunda copia de la llave `APP_KEY` de Coolify.** 🔴 Sin ella, un respaldo de
   Coolify no descifra ni un secreto. No hay opción por defecto segura aquí.
10. **Quién tiene admin de Coolify.** Es root sobre todo el fleet.

### 🔧 Baratos, sólo di que sí

11. **Mover `services/ai-service/.github/workflows/` a la raíz del repo.** GitHub sólo lee workflows de
    `.github/workflows/` en la raíz. Ahí donde están, **CI no está corriendo.**
12. **Borrar `apps/backend/docker-compose.yml`.** Levanta un segundo Postgres, sin pgvector, que
    compite con el de `infra/`.

---

## 6. Qué asumí (para que puedas revisarlo)

Otros agentes estaban editando el repo mientras yo escribía esto.

| asunción | riesgo si me equivoqué |
|---|---|
| Los precios de las cajas `cx33` (sólo el de `prod` es real) | el presupuesto se mueve |
| Que `packages/*/dist` se construye solo durante el build de cada app | `ERR_MODULE_NOT_FOUND` en la primera imagen |
| Que `apps/backend` va a usar los nombres `AUDIO_SERVICE_URL` / `AUDIO_SERVICE_API_KEY` de `plan/audio-ingest-integration.md` §3.5 | si ese agente elige otros nombres, hay que cambiar dos renglones de `infra/docker-compose.yml` |
| 🔴 Que `apps/backend` va a leer `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, y que **si faltan las cinco** vuelve a guardar en disco local | es un acuerdo con el agente que está escribiendo esa parte, no algo que leí en el código: **hoy `apps/backend` todavía no tiene adaptador de S3**. Si elige otros nombres, cambian `infra/.env.example` §7 y dos bloques de comentario |
| 🔴 Que el paso que crea el bucket y el usuario corre en **cada arranque** del backend | si corre una sola vez, un volumen restaurado o borrado deja el almacén sin credenciales y nadie lo repara solo |

**Las de audio ya no son asunciones.** Leí el servicio. Esto es lo que salió, incluido lo que tenía mal:

- ✅ **`audio-service` expone `/health` en el puerto 8080 y toma trabajo de Redis.** Correcto,
  verificado.
- ⚠ **"`audio-service` guarda pesos en `/models` y trae ffmpeg adentro" — mitad equivocado.** ffmpeg sí
  va dentro de la imagen ✅. Pero **no hay volumen `/models`**: los pesos se hornean dentro de la imagen a
  propósito, y un volumen ahí se quedaría con la versión vieja después de reconstruir. Corregido.
- ⚠ **"`faster-whisper` en CPU corre a 2–4× tiempo real" — cierto sólo para `small`.** El valor por
  defecto del servicio, `large-v3-turbo`, corre a ~1× tiempo real.

✅ **Ya no son asunciones** (los verifiqué leyendo el código): el formato de `SERVICE_TOKENS`,
`ORG_KEY=demo`, la reja `EDC_ENV`, y que los sidecars hornean sus pesos.

⚠ **Una que se quedó vieja y la corrijo:** este documento decía "verificado: Payload no usa S3". Era
cierto y sigue siendo cierto **hoy**, pero ya no es la meta. El adaptador de S3 está en camino, en el
archivo de otro agente. Mientras no aterrice, `rustfs` levanta, contesta bien, guarda un almacén vacío,
y **todas las subidas siguen yendo al disco local**. No está roto: está a medio conectar, a propósito,
para no tener que editar el compose dos veces.

**Qué sí ejecuté, y qué no.** Corrí `docker compose config` sobre las tres variantes — base, base con la
capa `dev`, y `--profile heavy` — y las tres se leen sin error. También verifiqué en la configuración
resuelta que el mismo `CALLBACK_SECRET` llega al backend, a ai-service y a los tres contenedores de
audio. No corrí `docker build`, ni `docker compose up`, ni un despliegue. Los archivos que escribí son
`infra/**` y este documento.

✅ **Y sí levanté el almacén de archivos de verdad**, en un puerto de prueba, no dentro del stack.
Bajé `rustfs/rustfs:1.0.0-rc.1`, lo corrí, y esto es lo que salió — todo medido, nada supuesto:

| lo que probé | resultado |
|---|---|
| crear bucket, subir archivo, bajarlo, pedir el bucket | ✅ todo 200, con firma S3 normal |
| pedir un bucket que no existe | ✅ 404, o sea que la app puede distinguir los dos casos |
| crear un bucket que ya existe | ✅ 200, no error — el aprovisionamiento se puede repetir sin trucos |
| cambiar la llave raíz y reiniciar sobre el mismo volumen | ✅ la llave nueva sirve, la vieja queda muerta |
| la consola | ✅ carga, pero en `/rustfs/console/`, no en la raíz |
| su ruta de salud sobre un almacén vacío | 🔴 contesta `"ok"` y `"ready":true`. **Miente.** |
| memoria en reposo, sin límite puesto | ✅ 102 MB |

Después lo apagué y borré su volumen. ⚠ **Lo que NO probé:** cómo se porta con archivos de 100 MB o
con varias subidas al mismo tiempo, ni el problema #2573 de memoria creciente, ni el mensaje de
"cluster incompleto" que reportan para esta versión exacta en un solo nodo. Los tres están anotados en
`infra/fleet/runbook.md` §8 para que se reconozcan y no se investiguen desde cero.

---

## 7. ⚠ Dos trampas que te van a morder en producción

- 🔴 **El botón "Rollback" de Coolify miente en un tipo de app.** En apps de tipo `dockerimage`
  reporta éxito y despliega la versión actual. El camino que sí funciona está en
  `infra/fleet/runbook.md` §4. **Escríbelo en un lugar que alcances desde el celular.** No es algo que
  quieras descubrir durante un incidente.
- 🔴 **El campo de "comando previo al despliegue" de Coolify nunca corre** cuando usas caja de
  construcción. Lo midieron en tres despliegues seguidos de producción, y falla en silencio con un
  mensaje que parece éxito. Por eso las migraciones van dentro del `CMD` de la imagen.
