# Cómo correr y desplegar Ecosistemas de Conocimiento

Guía humana. El detalle técnico vive en `infra/`.

🔴 **Nada de esto se ha probado.** No corrí `docker compose up`. No construí una sola imagen. No
desplegué nada. Todo aquí es diseño, escrito leyendo el código de este repo y la documentación de los
prototipos. Marco lo que asumí.

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

**Qué levanta:** web, backend, ai-service, audio-service, Postgres con pgvector, y Redis.

### No necesitas credenciales de nube ni GPU

- El demo arranca con `MOCK_LLM=1` y `MOCK_EMBEDDINGS=1`. ✅
- Eso significa: el modelo de lenguaje y los vectores son falsos pero deterministas.
- **Qué sí ves:** subir documentos, chat con citas, calificar respuestas 1–5, multitenencia.
- ⚠ **Qué no ves:** calidad real de respuestas. La búsqueda es ruido. No demuestres calidad en este modo.
- Para respuestas reales: pon `OPENROUTER_API_KEY` en `.env` y cambia los tres `MOCK_*` a 0.

### 🔴 El demo completo no cabe en una laptop normal

Esta es la parte incómoda. Hay tres niveles.

| nivel | qué incluye | RAM | comando |
|---|---|---|---|
| **1 — núcleo** | todo menos audio y los sidecars | ~4 GB | `docker compose up -d --wait postgres redis ai-service backend web` |
| **2 — producto** (por defecto) | + transcripción de audio | ~8 GB | `docker compose up -d --wait` |
| **3 — RAG avanzado** | + embeddings y reranking propios | ~16 GB | `docker compose --profile heavy up -d --wait` |

- ⚠ Las cifras son **estimadas**, sacadas de los límites que puse y del tamaño de los modelos. No medidas.
- 🔴 **El nivel 3 no cabe en 16 GB.** Los dos servicios de modelos cargan ~2.3 GB cada uno de forma
  permanente. Y la *construcción* de cada imagen pide ~3 GB más.
- 🟡 **Mi recomendación:** demuestra el producto en tu laptop (nivel 2) y el RAG avanzado en la caja
  `dev` del fleet. Es una división a propósito, no un parche.

### Si algo no arranca

- **La base de datos está vacía y no puedes entrar.** Revisa `EDC_ENV=local`. El código sólo siembra
  datos de demo cuando `EDC_ENV` es `local` o `dev`. Una base vacía es la reja funcionando, no una falla.
- **Las subidas se quedan en "embedding" para siempre.** `CALLBACK_SECRET` del backend tiene que ser
  idéntico al `callbackSecret` dentro de `API_KEYS` de ai-service. Es el error número uno.
- **Cambiaste un `package.json` y falta un módulo.** Los `node_modules` viven en volúmenes que sólo se
  llenan la primera vez. `docker compose down -v` y reconstruye.

### 🔴 Hoy el demo todavía no corre

Cuatro cosas faltan. Ninguna es mía, todas son cortas.

1. 🔴 **No existe `pnpm-lock.yaml` en la raíz.** Todas las imágenes usan `--frozen-lockfile`. Corre
   `pnpm install` una vez antes de construir cualquier cosa.
2. 🔴 **No existe `services/audio-service/`.** Otro agente lo está construyendo. Mientras tanto,
   levanta el nivel 1 o el nivel 2 sin ese servicio.
3. 🔴 **El proveedor de identidad no tiene llaves.** Corre `pnpm --filter @edc/backend keygen` una vez
   y pega el resultado en `infra/.env`. No hay valor por defecto y nada lo genera solo. Sin esto la app
   arranca pero no puede emitir un token.
4. ⚠ **Los paquetes de `packages/` publican desde `dist/`, y ningún Dockerfile corre `pnpm -r build`.**
   Puede que funcione por accidente o puede fallar con `ERR_MODULE_NOT_FOUND`. **No lo pude verificar.**
   Es lo primero que revisaría en la primera construcción.

✅ `apps/backend/Dockerfile` ya se arregló mientras yo escribía esto. Ya no es la imagen vieja.

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

### 🔴 La restricción que define todo: los archivos subidos viven en disco local

✅ **Verificado leyendo el código**, no asumido. Payload no tiene adaptador de S3 en este repo.

Consecuencias, en orden de cuándo te pegan:

1. **Producción no puede crecer a dos cajas.** Un documento subido por la caja A da 404 desde la caja B.
   Por eso recomiendo una sola caja de producción. No es ahorro, es la única forma correcta hoy.
2. **Necesitas un volumen persistente en `prod`.** 🔴 Sin él, cada despliegue borra todos los documentos
   subidos. Es la manera más fácil de perder datos de un cliente en este diseño.
3. **Los respaldos tienen que cubrir ese volumen**, no sólo Postgres. Un respaldo de Postgres restaura
   los renglones que describen un archivo cuyos bytes ya no existen.

🟡 **Recomendación: pospón el almacenamiento de objetos** hasta que necesites una segunda caja de
producción. Cuando lo hagas, **usa S3 administrado** (Cloudflare R2, ~$1/mes). Los prototipos
lo auto-hospedaron sólo porque su dueño puso como requisito "hardware propio". Ese requisito no es nuestro
hasta que alguien lo escriba. Les costó una evaluación de 1,591 líneas.

### Dónde corre la transcripción de audio

**Recomendación: en la caja `prod`, en CPU, con un límite duro. Cuesta ~$12/mes más** (subir `prod` de
8 GB a 16 GB).

- 🔴 **No compres una caja con GPU.** El ADR de los prototipos asumió una para exactamente
  esto y **nunca se rentó**. La suposición sobrevivió en sus planes mucho después de dejar de ser cierta.
- La transcripción es una cola, no una petición web. El navegador sube y consulta después. Nada
  bloquea al usuario.
- ⚠ **Estimado, no medido:** `faster-whisper` modelo `small` en int8 corre a ~2–4× tiempo real. Una hora
  de audio son ~15–30 minutos de reloj.
- 🔴 El límite de CPU no es opcional. Sin él, una subida larga hace que todo el producto parezca caído.
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
- 📝 **Almacenamiento de objetos.** Hasta que haga falta una segunda caja de producción.
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
8. **Quién guarda la segunda copia de la llave `APP_KEY` de Coolify.** 🔴 Sin ella, un respaldo de
   Coolify no descifra ni un secreto. No hay opción por defecto segura aquí.
9. **Quién tiene admin de Coolify.** Es root sobre todo el fleet.

### 🔧 Baratos, sólo di que sí

10. **Mover `services/ai-service/.github/workflows/` a la raíz del repo.** GitHub sólo lee workflows de
    `.github/workflows/` en la raíz. Ahí donde están, **CI no está corriendo.**
11. **Borrar `apps/backend/docker-compose.yml`.** Levanta un segundo Postgres, sin pgvector, que
    compite con el de `infra/`.
12. **Borrar `.staging-identity/`.** Es la copia de la app de identidad que ya se fusionó en
    `apps/backend`. No es parte del workspace y está excluida del build. Tiene ~300 menciones a los
    prototipos; borrar la carpeta las purga todas de un golpe.

---

## 6. Qué asumí (para que puedas revisarlo)

Otros agentes estaban editando el repo mientras yo escribía esto.

| asunción | riesgo si me equivoqué |
|---|---|
| `audio-service` expone `/health` en el puerto 8080 y toma trabajo de Redis | el healthcheck y el orden de arranque fallan |
| `audio-service` guarda pesos en `/models` y trae ffmpeg adentro | cada despliegue vuelve a descargar el modelo |
| `faster-whisper` en CPU corre a 2–4× tiempo real | la caja `prod` queda chica |
| Los precios de las cajas `cx33` (sólo el de `prod` es real) | el presupuesto se mueve |
| Que `packages/*/dist` se construye solo durante el build de cada app | `ERR_MODULE_NOT_FOUND` en la primera imagen |

✅ **Ya no son asunciones** (los verifiqué leyendo el código): el formato de `SERVICE_TOKENS`,
`ORG_KEY=demo`, la reja `EDC_ENV`, que los sidecars hornean sus pesos, y que Payload no usa S3.

**Nada fue ejecutado.** Ni un `docker build`, ni un `docker compose up`, ni un despliegue.
Los archivos que escribí son `infra/**` y este documento.

---

## 7. ⚠ Dos trampas que te van a morder en producción

- 🔴 **El botón "Rollback" de Coolify miente en un tipo de app.** En apps de tipo `dockerimage`
  reporta éxito y despliega la versión actual. El camino que sí funciona está en
  `infra/fleet/runbook.md` §4. **Escríbelo en un lugar que alcances desde el celular.** No es algo que
  quieras descubrir durante un incidente.
- 🔴 **El campo de "comando previo al despliegue" de Coolify nunca corre** cuando usas caja de
  construcción. Lo midieron en tres despliegues seguidos de producción, y falla en silencio con un
  mensaje que parece éxito. Por eso las migraciones van dentro del `CMD` de la imagen.
