# Sistema de diseño — Ecosistemas de Conocimiento

Fuente única de tokens: [`tokens.css`](./tokens.css). Se importa una sola vez,
desde `apps/web/src/app.css`, y lo consumen tres lugares:

- `apps/web/src/lib/primitives/*.svelte`
- `apps/web/src/lib/components/*.svelte`
- `packages/chat-engine/src/svelte/*.svelte`
- (además `apps/web/tailwind.config.js`, que mapea utilidades de Tailwind a
  `var(--edc-*)`)

---

## 1. La identidad, en una línea

**Gris frío como base + un solo acento: CIRUELA APAGADA `#6d28d9`.** Sin
degradados decorativos, sin tipografía de marca. Es una herramienta de lectura y
consulta documental, no una app de consumo.

> **El acento dejó de ser un marcador de posición.** Hasta ahora era un azul
> institucional elegido sólo para no comprometer a nadie. La organización eligió
> la ciruela; el azul ya no está en el archivo.
>
> Se cambió **una sola cosa**: el bloque 1 (`--edc-ramp-accent-*`). Ningún
> componente tenía un hex escrito a mano, así que no hubo nada más que tocar.
> Los derivados (`-soft`, `-outline`, anillo de foco, tinte de selección) son
> `color-mix` y se recalcularon solos.

**Por qué ciruela y no otra cosa:** no colisiona con ningún color de estado
(rojo de error, verde de éxito, ámbar de aviso), así que una acción primaria
nunca se lee como una alerta. Y a **7.10:1 sobre blanco** —medido, §4— sirve
simultáneamente como texto sobre superficie y como relleno con texto blanco,
porque el ratio de contraste es simétrico.

### Por qué

El código venía de otro producto y traía su identidad: rojo `#ff0044`,
naranja `#ff6b3d`, degradados de marca en botones y radiales de color en el
fondo de la página, más un `@import` a Google Fonts (Open Sans + IBM Plex Mono).
Nada de eso pertenece a esta organización, y el brief pedía algo **neutro**:
sin marca, contenido y fácil de re-marcar después.

Decisiones que se derivan de eso:

| Decisión | Razón |
| --- | --- |
| Un solo acento (ciruela `#6d28d9`) | Un acento basta para foco, enlaces, acción primaria y sección actual. Antes era un azul de relleno (`#245a8d`) precisamente porque la organización aún no había elegido; ya eligió. |
| El acento oscuro NO se usa en modo oscuro | `#6d28d9` sobre `surface` da **2.33:1**. Ningún color cumple 4.5:1 contra blanco y contra casi-negro a la vez (§4). En oscuro el rol lo juegan `#a78bfa` (texto) y `#8347ee` (relleno). |
| `--edc-color-accent` es **grafito**, no un segundo color | El sistema hereda dos tonos, `brand` y `accent`. Se resolvió haciendo `accent` un neutro con énfasis, para que `tone-accent` lea como jerarquía y no como otra identidad. |
| Degradados retirados | Eran decorativos y de la marca anterior. Los tokens `--edc-gradient-*` se conservan (los consume `Button.svelte`) pero ahora son colores planos. |
| Pila de fuentes del sistema | No hay pipeline de assets ni red en tiempo de build. El `@import` a Google Fonts se eliminó: en un build sin red bloquea el render. |
| Radios más pequeños (0.25 / 0.375 / 0.5rem) | Institucional, no redondeado de app móvil. |
| Sombras planas y cortas | Se eliminó el brillo interior blanco (`inset`) que producía el efecto "glass". |
| Hover sin desplazamiento | El `translateY(-1px)` global era parte de la identidad heredada. Ahora `--edc-interactive-hover-transform: none`. |

---

## 2. Cómo está organizado el archivo

`tokens.css` tiene cinco bloques, en este orden:

1. **RAMPAS** (`--edc-ramp-*`) — los colores crudos. **Es el único bloque que
   se toca para re-marcar.**
2. **SEMÁNTICA CLARA** (`:root`) — mapea rampas a roles (`--edc-color-ink`,
   `--edc-color-brand`, …). Los componentes sólo usan estos.
3. **SEMÁNTICA OSCURA** — redefine únicamente el bloque 2.
4. **TOKENS NO CROMÁTICOS** — espacio, radio, tipografía, sombra, capas, motion.
   Iguales en ambos temas.
5. **BASE** — reset mínimo, estilos de elemento y la capa de interacción.

Regla que mantiene esto sano: **ningún componente debe usar `--edc-ramp-*`.**
Las rampas son implementación; la semántica es la API.

### Grupos de tokens

| Grupo | Prefijo | Qué es |
| --- | --- | --- |
| Rampas | `--edc-ramp-*` | Colores crudos. Interno. |
| Fondos | `--edc-color-bg*`, `--edc-color-surface*` | Página, tarjetas, superficies translúcidas. |
| Texto | `--edc-color-ink`, `-ink-body`, `-ink-soft` | Título, cuerpo, secundario. |
| Líneas | `--edc-color-line`, `-line-strong`, `-elevated-border` | Ver §4. |
| Acento y estados | `--edc-color-brand`, `-accent`, `-success`, `-warning`, `-danger` | Se usan como **texto** sobre superficie. |
| Texto sobre relleno | `--edc-color-on-*` | Color legible **encima** de un relleno del tono. Nuevo. Ver §6. |
| Rellenos sólidos | `--edc-gradient-*` | Fondo de botones sólidos. Nombre histórico, valor plano. |
| Derivados suaves | `--edc-color-*-soft`, `-outline` | `color-mix` sobre los anteriores; se recalculan solos. |
| Espacio | `--edc-space-0..16` | Paso base 0.25rem. |
| Radio | `--edc-radius-0..3`, `-pill` | |
| Tipografía | `--edc-font-*`, `--edc-text-*`, `--edc-leading-*`, `--edc-weight-*`, `--edc-tracking-*`, `--edc-measure` | |
| Sombra | `--edc-shadow-1..3`, `-hover` | |
| Capas | `--edc-z-*` | base 1 · sticky 5 · overlay 10 · popover 20 · modal 30 · toast 40 |
| Motion | `--edc-motion-*`, `--edc-ease-*` | |
| Puntos de quiebre | `--edc-breakpoint-*` | Referencia; `@media` no acepta `var()`. |

---

## 3. Claro y oscuro

El tema oscuro **sólo redefine tokens semánticos**. Nunca rampas, nunca tokens
no cromáticos.

Se cubren los tres estados posibles del usuario:

| Estado del usuario | Qué aplica |
| --- | --- |
| Sistema en claro, sin elección | `:root` (por defecto) |
| Sistema en oscuro, sin elección | `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` |
| Elección explícita | `:root[data-theme="dark"]` / `[data-theme="light"]` |

Los dos bloques oscuros están duplicados a propósito y **deben mantenerse
idénticos**: CSS no permite compartir un cuerpo de declaraciones entre un
`@media` y un selector de atributo sin capas o preprocesador.

Hoy **no hay ningún control de tema en la app** y `app.html` no escribe
`data-theme`. Con esto ya basta para seguir al sistema. Para añadir un
interruptor, sólo hace falta poner `data-theme="dark"|"light"` en `<html>`.

---

## 4. Accesibilidad — contrastes medidos

Todos los valores de abajo están **calculados**, no estimados: fórmula de
luminancia relativa de WCAG 2.1, sobre los hex reales de `tokens.css`.

🔴 **Ya no hay que confiar en esta tabla.** Antes el script vivía en el
scratchpad de una sesión, así que los números eran ciertos el día que se
escribieron y no comprobables después. Ahora la comprobación es
[`contrast.test.ts`](./contrast.test.ts): **lee este mismo `tokens.css`**, parsea
las rampas y afirma cada par. Bajar un valor por debajo de AA rompe
`pnpm --filter @edc/web test`, no la conciencia de quien revise.

Umbrales: **4.5:1** texto normal · **3:1** texto grande, bordes de controles y
anillos de foco (WCAG 1.4.11).

### Tema claro — el acento

| Par | Ratio | |
| --- | ---: | --- |
| `brand` `#6d28d9` como texto / superficie `#ffffff` | **7.10** | ✅ AAA |
| `brand` / fondo de página `#f5f6f8` | **6.57** | ✅ |
| `brand-strong` `#5b21b6` / superficie | **8.98** | ✅ AAA |
| blanco / relleno `brand` `#6d28d9` (botón primario) | **7.10** | ✅ AAA |
| blanco / relleno hover `brand-strong` `#5b21b6` | **8.98** | ✅ AAA |
| `brand` sobre `brand-soft` (badge suave) | **5.83** | ✅ |
| `brand-strong` sobre `brand-soft` (sección actual del menú) | **7.37** | ✅ AAA |
| `brand` sobre `surface-accent` `#ede9fe` | **5.98** | ✅ |
| `ink` sobre `surface-accent` (conversación abierta) | **15.14** | ✅ |
| `ink-soft` sobre `surface-accent` | **5.69** | ✅ |
| anillo de foco (85% brand) / superficie (≥3) | **5.30** | ✅ |
| anillo de foco / fondo de página (≥3) | **4.99** | ✅ |
| `brand-outline` (45% brand + `line`) / superficie (≥3) | **5.25** | ✅ |
| `brand-outline` / fondo de página (≥3) | **4.86** | ✅ |

### Tema claro — el resto (sin cambios; el re-marcado no tocó los neutros)

| Par | Ratio | |
| --- | ---: | --- |
| `ink` `#14171b` / superficie `#ffffff` | **17.98** | ✅ |
| `ink` / fondo de página `#f5f6f8` | **16.63** | ✅ |
| `ink-body` `#2c3138` / superficie | **13.10** | ✅ |
| `ink-soft` `#545c68` / superficie | **6.76** | ✅ |
| `accent` (grafito) `#44505f` / superficie | **8.21** | ✅ |
| `success` `#176c44` / superficie (y blanco encima) | **6.43** | ✅ |
| `warning` `#8a5a00` / superficie (y blanco encima) | **5.93** | ✅ |
| `danger` `#a3282c` / superficie (y blanco encima) | **7.25** | ✅ |
| `line` `#818892` / superficie (borde de control, ≥3) | **3.58** | ✅ |
| `line-strong` `#6b7280` / superficie (≥3) | **4.83** | ✅ |
| `warning` sobre `warning-soft` (el más ajustado del sistema) | **4.57** | ✅ |

### Tema oscuro — el acento

⚠ **`#6d28d9` no aparece aquí**, y no puede: sobre `surface` `#1b1f25` da
**2.33:1**. En oscuro el acento es una ciruela clara del mismo hue.

| Par | Ratio | |
| --- | ---: | --- |
| `brand` `#a78bfa` como texto / `surface` `#1b1f25` | **6.08** | ✅ |
| `brand` / `surface-strong` `#272d35` | **5.10** | ✅ |
| `brand` / fondo `#14171b` | **6.61** | ✅ |
| `brand-strong` `#c4b5fd` / `surface-strong` | **7.52** | ✅ AAA |
| blanco / `gradient-brand` `#8347ee` (botón sólido) | **5.12** | ✅ |
| blanco / `gradient-brand-hover` `#8b54f0` | **4.54** | ✅ |
| relleno `#8347ee` / `surface` (silueta del botón, ≥3) | **3.23** | ✅ |
| relleno `#8347ee` / fondo `#14171b` (≥3) | **3.51** | ✅ |
| relleno `#8347ee` / `surface-strong` (≥3) | **2.71** | ⚠ ver nota |
| `brand` sobre `brand-soft` (badge suave) | **5.02** | ✅ |
| anillo de foco (85% brand) / `surface` (≥3) | **4.77** | ✅ |
| anillo de foco / `surface-strong` (≥3) | **4.11** | ✅ |
| `brand-outline` (45% brand + `line`) / `surface` (≥3) | **4.72** | ✅ |
| `ink` `#f3f5f7` sobre `surface-accent` `#241b33` | **15.02** | ✅ |
| `ink-body` `#dde2e8` sobre `surface-accent` | **12.60** | ✅ |
| `ink-soft` `#a6aeb9` sobre `surface-accent` | **7.33** | ✅ |
| `brand` `#a78bfa` sobre `surface-accent` | **6.03** | ✅ |

⚠ **La nota del 2.71.** Un botón sólido de acento sobre `surface-strong` —el
fondo oscuro MÁS CLARO del sistema, el de una tarjeta elevada— se separa 2.71:1
de él, por debajo del 3:1 que pide WCAG 1.4.11 para la silueta de un control.
No hay salida aritmética: la misma ventana que mantiene el blanco a 4.5:1 encima
del relleno no deja margen para separarlo más de un fondo tan claro. Lo que
identifica ese botón en una tarjeta es su etiqueta blanca, que cumple en todos
lados. **El acento azul anterior tenía el mismo hueco** (`#35709f` medía 2.63:1
ahí), así que no es una regresión del re-marcado. `contrast.test.ts` afirma el
par contra `surface` y contra `bg`, y documenta esta excepción en el propio test.

### Tema oscuro — el resto (sin cambios)

| Par | Ratio | |
| --- | ---: | --- |
| `ink` `#f3f5f7` / fondo `#14171b` | **16.45** | ✅ |
| `ink` / `surface-strong` `#272d35` | **12.70** | ✅ |
| `ink-body` `#dde2e8` / `surface` `#1b1f25` | **12.70** | ✅ |
| `ink-soft` `#a6aeb9` / `surface-strong` | **6.20** | ✅ |
| `accent` (grafito) `#a8b3c2` / `surface-strong` | **6.54** | ✅ |
| `success` `#4fae7c` / `surface-strong` | **5.07** | ✅ |
| `warning` `#cf9a2f` / `surface-strong` | **5.50** | ✅ |
| `danger` `#ef7c74` / `surface-strong` | **5.16** | ✅ |
| blanco / `gradient-accent` `#5c6a7d` | **5.51** | ✅ |
| blanco / `gradient-warning` `#966300` | **5.15** | ✅ |
| blanco / `gradient-danger` `#bd3e3c` | **5.36** | ✅ |
| `line` `#717b89` / `surface-strong` (≥3) | **3.24** | ✅ |
| `success` sobre `success-soft` (el más ajustado) | **4.66** | ✅ |

### El compromiso central del tema oscuro

Un mismo color **no puede** cumplir 4.5:1 contra blanco y contra un fondo
casi negro a la vez. El máximo simultáneo posible es ~4.17:1. Es aritmética,
no una elección de gusto.

Por eso los tonos semánticos en oscuro están calibrados **como texto sobre
superficie oscura** (su uso dominante: badges suaves, botones outline/ghost,
iconos, mensajes de error), y los **rellenos sólidos usan tokens aparte**
(`--edc-gradient-*`) con tonos medios donde el blanco sigue cumpliendo AA.

---

## 5. Bordes: por qué `line` es más oscuro de lo habitual

`--edc-color-line` es el borde de **controles** — `Input`, `IconButton`,
tablas de Markdown, chips de contexto. WCAG 1.4.11 pide 3:1 para el límite
visible de un control, así que `line` está en `#818892` (3.58:1 sobre blanco),
más oscuro que una hairline típica.

Para bordes puramente decorativos (tarjetas, `<hr>`) existe
`--edc-color-elevated-border`, que es suave y **no** tiene requisito de
contraste porque no transporta información.

Si un componente usa `line` para una división decorativa, debería cambiar a
`elevated-border`.

---

## 6. Pendientes en componentes (fuera de este directorio)

✅ **Los cinco pendientes que listaba esta sección ya están arreglados** —
`Badge.svelte` y `Button.svelte` usan `--edc-color-on-*` en lugar de `#ffffff`
escrito a mano, `tone-success` usa el token de color, `tokens.css` cubre los dos
nombres del atributo interactivo, y `app.html` dice `lang="es"`. Se comprobó
leyendo los archivos, no de memoria.

Queda un punto abierto, y es de tipografía, no de color:

| Dónde | Qué pasa | Tamaño |
| --- | --- | --- |
| `components/Sidebar.svelte` (pie), `EcosystemPicker.svelte`, `DocsPanel.svelte` (aviso de borrador), `routes/biblioteca` y `routes/admin` (`.kicker`, `.hint`, chips) | Texto de 9–11px. **Medido en el navegador a 380px**, no estimado. | < 12px |

⚠ Es un problema real para el público de este producto, no una nota de estilo:
9px en una pantalla barata a plena luz no se lee. No se corrigió aquí porque
subir la escala tipográfica toca decenas de sitios y hay que volver a mirar cada
uno; es un cambio propio, con sus propias capturas.

Además: `--button-hover-color` se lee en `Button.svelte` con fallback
(`var(--button-hover-color, currentColor)`) y no lo define nadie. Es una vía de
escape intencional, no una rotura.

---

## 6 bis. Nunca señalar sólo con color

🔴 **Regla del sistema, no del componente.** Un lector daltónico y una pantalla
lavada por el sol pierden exactamente lo mismo: el matiz. Todo estado que
signifique algo lleva **una segunda señal** — una palabra, una forma o un peso.

Cómo está hoy, comprobado leyendo los componentes:

| Señal | Segunda señal | |
| --- | --- | --- |
| Sección actual del menú (`PrimaryNav`) | Barra inferior de 3px + `aria-current="page"` | ✅ ya estaba |
| Estado de publicación (borrador / publicando / publicado / fallido) | **Texto**: cada estado tiene su palabra en `$lib/publication.ts`; la insignia nunca es sólo un punto de color | ✅ ya estaba |
| Estado de ingesta (`DocsPanel`) | **Texto** en el chip | ✅ ya estaba |
| Conversación abierta (`Sidebar`) | Antes: SÓLO el tinte de fondo. Ahora: barra de acento en el borde izquierdo + negrita + `aria-current` | 🔴 arreglado aquí |
| Panel abierto en pantalla estrecha (`ChatWorkspace`) | Cursor `▾` que gira + borde de acento, además del relleno; y `aria-expanded` | ✅ nuevo, así desde el principio |

---

## 7. Cómo re-marcar para una identidad futura

1. Abre `tokens.css` y edita **sólo el bloque 1 (RAMPAS)**. En la práctica:
   - `--edc-ramp-accent-*` — el acento nuevo. Seis pasos: 700/600 para modo
     claro, 500/400 para rellenos sólidos en oscuro, 300/200 para texto en
     oscuro.
   - `--edc-ramp-neutral-*` — si el gris debe ser cálido o puro en vez de frío.
   - `--edc-ramp-graphite-*` — el neutro con énfasis.
2. Los derivados (`-soft`, `-outline`, anillo de foco) se recalculan solos:
   son `color-mix` sobre la semántica.
3. **Corre `pnpm --filter @edc/web test`.** `contrast.test.ts` lee `tokens.css`
   y vuelve a medir cada par: acento como texto sobre `surface` y `bg` en ambos
   temas, blanco sobre cada relleno sólido, la silueta del relleno contra el
   fondo, `line`, el anillo de foco y los rellenos suaves compuestos. Si algo
   baja de AA, la prueba falla y dice qué par y con qué número.
   Después actualiza las tablas de §4 con los valores nuevos.
4. Si el acento nuevo es claro en modo claro, hay que bajar `--edc-color-on-*`
   a un tono oscuro también en `:root`, no sólo en el bloque oscuro.

Atajo útil para elegir: un color con **≥4.5:1 contra blanco** funciona a la vez
como texto sobre blanco y como fondo con texto blanco. El ratio es simétrico.

⚠ **El paso más difícil es el 500 (relleno sólido en oscuro).** Vive en una
ventana estrecha: el blanco encima necesita 4.5:1 (⇒ luminancia ≤ ~0.184) y la
silueta del botón necesita 3:1 contra `surface` (⇒ luminancia ≥ ~0.141). El
violeta "natural" del siguiente paso de la rampa, `#7c3aed`, cumple lo primero
y falla lo segundo. Empieza por ahí y el resto sale solo.

⚠ **Cambiar sólo el acento no basta si el acento nuevo es CLARO en modo claro.**
En ese caso `--edc-color-on-*` tiene que bajar a un tono oscuro también en
`:root`, no sólo en el bloque oscuro. Con la ciruela no hizo falta: es oscura.

---

## 8. Renombrar el prefijo `--edc-` → `--edc-`

`--edc-` es el prefijo del producto anterior. Los nombres se conservaron a
propósito para no romper a los cuatro consumidores mientras se reescribían los
valores. El renombrado va aparte, con un codemod idempotente
(`rename-design-tokens.sh`, en el scratchpad de la sesión). Cubre
`apps/web/src/**`, `packages/chat-engine/src/**`, `apps/web/tailwind.config.js`
y el README de `chat-engine`; excluye `node_modules`, `dist` y lockfiles.

`tailwind.config.js` es obligatorio en el alcance: mapea las utilidades de
color de Tailwind a `var(--edc-*)`. Si se omite, el renombrado rompe todas
las clases de color.

### Sobre `--wp--*`

Era el namespace de `theme.json` del **editor de bloques de WordPress**,
heredado junto con el CSS del sitio anterior: 12 colores preset
(`vivid-purple`, `pale-pink`…), 12 degradados decorativos, escalas de
espaciado y fuente, y ~50 clases de utilidad `.has-*-color`.

No es identidad reutilizable ni tiene contraparte neutra: son nombres de
presets de WordPress. Se comprobó que **no había una sola referencia a `--wp--`
ni a las clases `.has-*` fuera de `tokens.css`**, y que el Markdown de la app
se renderiza con `html: false` + DOMPurify, así que esas clases no pueden
llegar nunca al DOM. Se eliminó el namespace completo en vez de renombrarlo.

Los tres tokens semánticos que dependían de él
(`--edc-color-success/warning/danger`, que aliaseaban colores preset de
WordPress) ahora tienen valores propios.
