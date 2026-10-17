/**
 * ¿QUÉ DESCARTARÍA ESTA POLÍTICA? — medición contra el corpus real, sin gastar
 * en extracción y sin cambiar absolutamente nada.
 *
 *     set -a && . infra/.env && set +a
 *     export DATABASE_URI="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_HOST_PORT/edc_backend"
 *     cd apps/backend && GRAPH_POLICY_ORG=1 payload run src/lib/graph/policy.cli.ts
 *
 * Variables:
 *     GRAPH_POLICY_ORG=1              🔴 OBLIGATORIA. Un solo ecosistema.
 *     GRAPH_POLICY_REQUIRE_NAME=...   simula OTRA política, sólo para esta
 *                                     medición (ver abajo).
 *     GRAPH_MIN_SUPPORT=3             umbral con el que se calcula "visible".
 *
 * ── PARA QUÉ SIRVE ─────────────────────────────────────────────────────────
 *
 * {@link GRAPH_SHAPE_POLICY} en `extract.ts` decide qué tipos de entidad
 * exigen un nombre propio. Cambiarla es una decisión de criterio documental, y
 * quien la tome debería poder ver el costo ANTES de gastar horas de extracción.
 * Este script contesta "¿cuántos nodos y cuáles se perderían?" leyendo el grafo
 * que ya existe.
 *
 * 🔴 NO ESCRIBE NADA. Sólo `find`. No hay un solo `update` ni `delete` aquí, y
 * no debe haberlo: correrlo tiene que ser una decisión sin consecuencias.
 *
 * 🔴 TAMPOCO CAMBIA LA VISTA. La política se aplica al ESCRIBIR el grafo. Lo
 * que este script imprime es una simulación: hasta que no se suba
 * `GRAPH_PROMPT_VERSION` y se corra el backfill, la vista muestra lo mismo de
 * siempre.
 *
 * ── SIMULAR OTRA POLÍTICA SIN TOCAR EL CÓDIGO ─────────────────────────────
 *
 *     GRAPH_POLICY_ORG=1 GRAPH_POLICY_REQUIRE_NAME=lugar,organizacion,persona,evento \
 *       payload run src/lib/graph/policy.cli.ts
 *
 * Lista de tipos separados por coma: los que exigirían nombre propio. Sirve
 * para contestar "¿y si también se lo exigimos a los eventos?" antes de editar
 * `GRAPH_SHAPE_POLICY`. ⚠ Sólo afecta a ESTA medición.
 *
 * ── 🔴 POR QUÉ ES UN ARCHIVO APARTE ────────────────────────────────────────
 *
 * El mismo motivo que `backfill.cli.ts` documenta a detalle: `payload run`
 * reescribe `process.argv` y llama a `process.exit(0)` en cuanto el `import()`
 * resuelve, así que un script sólo funciona si nada lo importa y usa
 * `await` de nivel superior.
 */
import { getPayload } from 'payload'
import config from '@payload-config'

import { GRAPH_SHAPE_POLICY, GRAPH_WORD_CLASSES, policyRejects } from './extract'
import { GRAPH_ENTITY_TYPES, type GraphEntityType } from './types'
import { GRAPH_MIN_SUPPORT_DEFAULT } from './queries'

const organizationId = process.env.GRAPH_POLICY_ORG?.trim()
if (!organizationId) {
  // 🔴 Nunca sin ecosistema. Ninguna consulta del grafo corre sin un
  // `organization_id` explícito, ni siquiera una de sólo lectura (ADR §6).
  console.error('Falta GRAPH_POLICY_ORG. Ejemplo: GRAPH_POLICY_ORG=1')
  process.exit(1)
}

const minSupportRaw = Number(process.env.GRAPH_MIN_SUPPORT)
const minSupport =
  Number.isFinite(minSupportRaw) && minSupportRaw >= 0
    ? Math.floor(minSupportRaw)
    : GRAPH_MIN_SUPPORT_DEFAULT

/** La política vigente, o la que se pidió simular. */
const override = process.env.GRAPH_POLICY_REQUIRE_NAME?.trim()
const overrideTypes = override
  ? new Set(
      override
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    )
  : null

if (overrideTypes) {
  const unknown = [...overrideTypes].filter(
    (t) => !(GRAPH_ENTITY_TYPES as readonly string[]).includes(t),
  )
  if (unknown.length > 0) {
    console.error(
      `GRAPH_POLICY_REQUIRE_NAME nombra tipos que no existen: ${unknown.join(', ')}\n` +
        `Tipos válidos: ${GRAPH_ENTITY_TYPES.join(', ')}`,
    )
    process.exit(1)
  }
}

const requiresName = (type: GraphEntityType): boolean =>
  overrideTypes ? overrideTypes.has(type) : GRAPH_SHAPE_POLICY[type].requiresProperName

const payload = await getPayload({ config })

// --- Sólo lectura, y siempre acotado al ecosistema ------------------------
// ⚠ `select` NO ES OPTIMIZACIÓN, ES BLINDAJE. Sin él Payload pide TODAS las
// columnas, así que este script se cae si el código conoce una columna que la
// base todavía no tiene — que es exactamente el estado de una migración
// pendiente. Un script de diagnóstico tiene que funcionar precisamente
// entonces. (Medido: `documents.tema` existe en el config y no en la base.)
const entities = await payload.find({
  collection: 'graphEntities',
  where: { organization: { equals: organizationId } },
  select: { type: true, label: true },
  limit: 0,
  depth: 0,
  overrideAccess: true,
})

const mentions = await payload.find({
  collection: 'graphMentions',
  where: { organization: { equals: organizationId } },
  select: { entity: true, document: true },
  limit: 0,
  depth: 0,
  overrideAccess: true,
})

const publishedDocs = await payload.find({
  collection: 'documents',
  where: {
    and: [
      { organization: { equals: organizationId } },
      { publicationStatus: { equals: 'published' } },
    ],
  },
  select: {},
  limit: 0,
  depth: 0,
  overrideAccess: true,
})

const relationId = (raw: unknown): string | null => {
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw)
  if (raw && typeof raw === 'object' && 'id' in raw) {
    return relationId((raw as { id: unknown }).id)
  }
  return null
}

const publishedIds = new Set(publishedDocs.docs.map((d) => String((d as { id: unknown }).id)))

/** entityId → cuántos documentos PUBLICADOS distintos la mencionan (ADR §7.3). */
const supportByEntity = new Map<string, Set<string>>()
for (const raw of mentions.docs) {
  const m = raw as { entity?: unknown; document?: unknown }
  const entityId = relationId(m.entity)
  const documentId = relationId(m.document)
  if (!entityId || !documentId || !publishedIds.has(documentId)) continue
  const seen = supportByEntity.get(entityId) ?? new Set<string>()
  seen.add(documentId)
  supportByEntity.set(entityId, seen)
}

interface Row {
  id: string
  type: GraphEntityType
  label: string
  support: number
  dropped: boolean
}

const rows: Row[] = entities.docs.map((raw) => {
  const e = raw as { id: unknown; type: GraphEntityType; label: string }
  const id = String(e.id)
  return {
    id,
    type: e.type,
    label: e.label,
    support: supportByEntity.get(id)?.size ?? 0,
    // La misma función que aplica la extracción: la simulación no puede
    // divergir de la regla.
    dropped: policyRejects(e.type, e.label, requiresName),
  }
})

// --- Informe ---------------------------------------------------------------

const line = (s = '') => console.log(s)
const pct = (n: number, of: number) => (of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`)

line()
line('═'.repeat(78))
line('  POLÍTICA DE FORMA DEL GRAFO — SIMULACIÓN')
line(`  ecosistema ${organizationId} · umbral de visibilidad: ${minSupport} documentos`)
if (overrideTypes) {
  line(`  ⚠ SIMULANDO otra política: exigen nombre → ${[...overrideTypes].join(', ')}`)
  line('    (GRAPH_SHAPE_POLICY en el código NO se modificó)')
}
line('═'.repeat(78))

for (const type of GRAPH_ENTITY_TYPES) {
  const rule = GRAPH_SHAPE_POLICY[type]
  const ofType = rows.filter((r) => r.type === type)
  const droppedOfType = ofType.filter((r) => r.dropped)
  const simulated = overrideTypes ? requiresName(type) : rule.requiresProperName

  line()
  line(`── ${type.toUpperCase()} ${'─'.repeat(Math.max(0, 70 - type.length))}`)
  line(`   ¿exige nombre propio?  ${simulated ? 'SÍ' : 'NO'}${
    overrideTypes && simulated !== rule.requiresProperName
      ? `   ⚠ simulado (en el código: ${rule.requiresProperName ? 'SÍ' : 'NO'})`
      : ''
  }`)
  line(`   regla      ${rule.rule}`)
  if (rule.excludes.length > 0) {
    line(`   excluye    ${rule.excludes.join(', ')} (ver GRAPH_WORD_CLASSES)`)
  }
  line(`   por qué    ${wrap(rule.rationale, 'por qué    '.length)}`)
  line(`   costo      ${wrap(rule.cost, 'costo      '.length)}`)
  line(
    `   → medido ahora: descartaría ${droppedOfType.length} de ${ofType.length} ` +
      `(${pct(droppedOfType.length, ofType.length)})`,
  )
}

const dropped = rows.filter((r) => r.dropped)

line()
line('── CLASES DE PALABRA CON OTRO SITIO ' + '─'.repeat(42))
for (const [name, cls] of Object.entries(GRAPH_WORD_CLASSES)) {
  line(`   ${name}: ${cls.rule}`)
  line(`     ${wrap(cls.cost, 5)}`)
}
const visible = rows.filter((r) => r.support >= minSupport)
const visibleDropped = visible.filter((r) => r.dropped)

line()
line('═'.repeat(78))
line('  TOTALES')
line('═'.repeat(78))
line(`  entidades en el grafo            ${rows.length}`)
line(`  descartadas por la política      ${dropped.length} (${pct(dropped.length, rows.length)})`)
line(`  visibles hoy (≥${minSupport} documentos)      ${visible.length}`)
line(
  `  de ésas, se descartarían         ${visibleDropped.length} ` +
    `(${pct(visibleDropped.length, visible.length)})`,
)

if (visibleDropped.length > 0) {
  line()
  line('  Las que desaparecerían de la vista, de mayor a menor:')
  for (const r of [...visibleDropped].sort((a, b) => b.support - a.support)) {
    line(`    ${String(r.support).padStart(4)} doc  ${r.type.padEnd(13)} ${r.label}`)
  }
}

line()
line('  🔴 No se cambió nada. Esta es una simulación sobre el grafo actual.')
line('     Para aplicarla hay que subir GRAPH_PROMPT_VERSION y re-extraer:')
line('     GRAPH_BACKFILL_ORG=1 payload run src/lib/graph/backfill.cli.ts')
line()

/** Envuelve un párrafo largo para que quepa en la terminal, con sangría. */
function wrap(text: string, indent: number): string {
  const width = 78 - indent
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      out.push(current)
      current = word
      continue
    }
    current = current ? `${current} ${word}` : word
  }
  if (current) out.push(current)
  return out.join(`\n${' '.repeat(indent)}`)
}
