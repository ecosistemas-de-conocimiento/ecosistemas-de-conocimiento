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

**Gris frío como base + un solo acento azul institucional.** Sin degradados
decorativos, sin tipografía de marca, sin hue fuerte. Es una herramienta de
lectura y consulta documental, no una app de consumo.

### Por qué

El código venía de otro producto (a prototype) y traía su identidad: rojo `#ff0044`,
naranja `#ff6b3d`, degradados de marca en botones y radiales de color en el
fondo de la página, más un `@import` a Google Fonts (Open Sans + IBM Plex Mono).
Nada de eso pertenece a esta organización, y el brief pedía algo **neutro**:
sin marca, contenido y fácil de re-marcar después.

Decisiones que se derivan de eso:

| Decisión | Razón |
| --- | --- |
| Un solo acento (azul `#245a8d`) | "Neutral" = no comprometer a la organización con una paleta que aún no elige. Un acento basta para foco, enlaces y acción primaria. |
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
luminancia relativa de WCAG 2.1, sobre los hex reales del archivo. El script
está en el scratchpad de la sesión (`verify.mjs` + `contrast.mjs`) y es
reproducible en cualquier calculadora de contraste.

Umbrales: **4.5:1** texto normal · **3:1** texto grande y bordes de controles.

### Tema claro

| Par | Ratio | |
| --- | ---: | --- |
| `ink` `#14171b` / superficie `#ffffff` | **17.98** | ✅ |
| `ink` / fondo de página `#f5f6f8` | **16.63** | ✅ |
| `ink-body` `#2c3138` / superficie | **13.10** | ✅ |
| `ink-body` / fondo de página | **12.11** | ✅ |
| `ink-soft` `#545c68` / superficie | **6.76** | ✅ |
| `ink-soft` / fondo de página | **6.25** | ✅ |
| `brand` `#245a8d` como texto / superficie | **7.19** | ✅ |
| blanco / relleno `brand` | **7.19** | ✅ |
| `accent` `#44505f` como texto / superficie | **8.21** | ✅ |
| `success` `#176c44` / superficie (y blanco encima) | **6.43** | ✅ |
| `warning` `#8a5a00` / superficie (y blanco encima) | **5.93** | ✅ |
| `danger` `#a3282c` / superficie (y blanco encima) | **7.25** | ✅ |
| `line` `#818892` / superficie (borde de control, ≥3) | **3.58** | ✅ |
| `line` / fondo de página (≥3) | **3.31** | ✅ |
| `line-strong` `#6b7280` / superficie (≥3) | **4.83** | ✅ |
| anillo de foco (85% brand) / superficie (≥3) | **5.00** | ✅ |
| `brand` sobre `brand-soft` (badge suave) | **5.98** | ✅ |
| `warning` sobre `warning-soft` (el más ajustado) | **4.57** | ✅ |

### Tema oscuro

| Par | Ratio | |
| --- | ---: | --- |
| `ink` `#f3f5f7` / fondo `#14171b` | **16.45** | ✅ |
| `ink` / `surface-strong` `#272d35` | **12.70** | ✅ |
| `ink-body` `#dde2e8` / `surface` `#1b1f25` | **12.70** | ✅ |
| `ink-body` / `surface-strong` | **10.65** | ✅ |
| `ink-soft` `#a6aeb9` / `surface-strong` | **6.20** | ✅ |
| `brand` `#6f9fd4` como texto / `surface-strong` | **5.01** | ✅ |
| `accent` `#a8b3c2` / `surface-strong` | **6.54** | ✅ |
| `success` `#4fae7c` / `surface-strong` | **5.07** | ✅ |
| `warning` `#cf9a2f` / `surface-strong` | **5.50** | ✅ |
| `danger` `#ef7c74` / `surface-strong` | **5.16** | ✅ |
| blanco / `gradient-brand` `#35709f` (botón sólido) | **5.29** | ✅ |
| blanco / `gradient-brand-hover` `#3a7aab` | **4.61** | ✅ |
| blanco / `gradient-accent` `#5c6a7d` | **5.51** | ✅ |
| blanco / `gradient-warning` `#966300` | **5.15** | ✅ |
| blanco / `gradient-danger` `#bd3e3c` | **5.36** | ✅ |
| `line` `#717b89` / `surface-strong` (≥3) | **3.24** | ✅ |
| anillo de foco / `surface` (≥3) | **4.71** | ✅ |
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

Estos son los puntos donde el sistema no puede cumplir AA solo, porque el
componente escribe el color a mano. Cada uno es un cambio de una línea.

| Archivo | Qué pasa | Arreglo |
| --- | --- | --- |
| `primitives/Badge.svelte` — `.tone-*.emphasis-solid` | `background: var(--edc-color-brand)` + `color: #ffffff`. En oscuro el tono es claro → blanco sobre claro (2.77:1). | `color: var(--edc-color-on-brand)` (y `-on-success`, `-on-warning`, `-on-danger`, `-on-accent`, `-on-neutral`). Los tokens ya existen y en claro valen `#ffffff`, así que no hay regresión. |
| `primitives/Button.svelte` — `.tone-neutral.variant-solid` | `background: var(--edc-color-ink-body)` + `color: #ffffff`. En oscuro `ink-body` es casi blanco → **1.30:1**. | `color: var(--edc-color-on-neutral)`. |
| `primitives/Button.svelte` — `.tone-success.variant-solid` | El degradado está escrito a mano (`linear-gradient(135deg, var(--edc-color-success), #44c98e)`) y no hay token `--edc-gradient-success`. | Sustituir por `background: var(--edc-color-success)` en claro; si se quiere token propio, añadir `--edc-gradient-success` siguiendo el patrón de los otros. |
| `primitives/Button.svelte`, `IconButton.svelte` | Emiten `data-interactive`, pero `tokens.css` apuntaba a `[data-edc-interactive]`. El bloque nunca hacía match: **el anillo de foco del sistema no se aplicaba**. | Ya mitigado en `tokens.css` (ahora cubre ambos nombres). Lo limpio sería unificar el atributo. |
| `apps/web/src/app.html` | `<html lang="en">` con interfaz en español. | `lang="es"`. Afecta a lectores de pantalla y a la separación silábica. |

Además: `--button-hover-color` se lee en `Button.svelte` con fallback
(`var(--button-hover-color, currentColor)`) y no lo define nadie. Es una vía de
escape intencional, no una rotura.

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
3. **Revalida los contrastes.** Cambiar el acento cambia su luminancia y
   rompe las tablas de §4. Pares mínimos a recalcular:
   - acento como texto sobre `surface` y sobre `bg`, en ambos temas
   - blanco sobre cada `--edc-gradient-*` en ambos temas
   - `line` sobre `surface` y sobre `bg`, en ambos temas (≥3)
   - anillo de foco sobre `surface` (≥3)
4. Si el acento nuevo es claro en modo claro, hay que bajar `--edc-color-on-*`
   a un tono oscuro también en `:root`, no sólo en el bloque oscuro.

Atajo útil para elegir: un color con **≥4.5:1 contra blanco** funciona a la vez
como texto sobre blanco y como fondo con texto blanco. El ratio es simétrico.

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
