/**
 * Writes `plan/mapa-historias.md` and `plan/mapa-historias.csv` from
 * `./historias.ts`, so the maps people read and the captions the videos show
 * cannot drift apart.
 *
 * The CSV is a user-story-map grid: rows `user type`,
 * `theme`, `epic`, `user story grid:`, then bands `sprint N` / `backlog`
 * whose cells are story titles under that column's epic. Titles there are
 * lowercase with no period (`iniciar sesión`), as in those grids.
 *
 *   node --experimental-strip-types apps/web/e2e/evidencia/mapa.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAPA, type Rol, type Video } from './historias.ts';

const ROLES: readonly [Rol, string][] = [
  ['participante', 'Part.'],
  ['estudiante', 'Est.'],
  ['investigador', 'Inv.'],
  ['responsable', 'Resp.'],
  ['admin', 'Admin'],
];

const VIDEO: Record<Video, string> = { accion: '▶ acción', pantalla: '◻ pantalla', no: '— no' };

const lines = [
  '# Mapa de historias de usuario',
  '',
  'Temática → épica → historia. Generado desde `apps/web/e2e/evidencia/historias.ts`; no editar a mano.',
  '',
  'Roles: **Part.** participante (`member`) · **Est.** estudiante · **Inv.** investigador ·',
  '**Resp.** responsable (`owner`) · **Admin** administrador de la plataforma.',
  '',
  'Video: **▶ acción** se hace en la grabación · **◻ pantalla** se muestra sin dar el último paso',
  '(es definitivo o cambia datos compartidos en dev) · **— no** no se graba (requiere micrófono o una',
  'función apagada).',
  '',
];

for (const t of MAPA) {
  lines.push(`## ${t.id}. ${t.nombre}`, '');
  for (const e of t.epicas) {
    lines.push(`### ${e.id}. ${e.nombre}`, '');
    lines.push(`| # | Historia | ${ROLES.map(([, l]) => l).join(' | ')} | Video |`);
    lines.push(`|---|---|${ROLES.map(() => ':-:').join('|')}|---|`);
    for (const x of e.historias) {
      const marks = ROLES.map(([r]) => (x.roles.includes(r) ? '●' : '')).join(' | ');
      lines.push(`| ${x.id} | ${x.texto} | ${marks} | ${VIDEO[x.video]} |`);
    }
    lines.push('');
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../../plan/mapa-historias.md');
writeFileSync(out, lines.join('\n'));
console.log(out);

// ── CSV grid ──────────────────────────────────────────────────────────────────

const ACTORES: readonly [Rol, string][] = [
  ['participante', 'participante'],
  ['estudiante', 'estudiante'],
  ['investigador', 'investigador'],
  ['responsable', 'responsable de ecosistema'],
  ['admin', 'admin plataforma'],
];

/** Sprint 0 = getting in (theme A); sprint 1 = everything else the platform does today. */
const banda = (temaId: string): number => (temaId === 'A' ? 0 : 1);

const titulo = (texto: string): string => (texto.charAt(0).toLowerCase() + texto.slice(1)).replace(/\.$/, '');

interface Columna {
  actor: string;
  tema: string;
  epica: string;
  porBanda: string[][];
}

/**
 * Each story sits ONCE, under the least-privileged user type that has it: an
 * importer that keys epics by theme + label would merge the same epic under two
 * user types. A story everyone has sits
 * under participante; what only the investigador and up can do, under
 * investigador. Responsable has nothing of its own today, so no column.
 */
const actorDe = (roles: readonly Rol[]): string => ACTORES.find(([r]) => roles.includes(r))![1];

/**
 * Where a user type's own stories would land in an epic another type already
 * holds, they get an epic of their own: the importer would merge the two.
 */
const EPICA_PROPIA: Record<string, string> = {
  'B1.7': 'buscar en mi grupo',
  'C1.5': 'aportar testimonios',
  'C1.6': 'aportar testimonios',
  'F3.2': 'administrar la plataforma',
  'F4.2': 'administrar la plataforma',
};

const columnas: Columna[] = [];
for (const [, actor] of ACTORES) {
  for (const t of MAPA) {
    const porEpica = new Map<string, string[][]>();
    for (const e of t.epicas) {
      for (const x of e.historias) {
        if (actorDe(x.roles) !== actor) continue;
        const epica = EPICA_PROPIA[x.id] ?? e.nombre.toLowerCase();
        if (!porEpica.has(epica)) porEpica.set(epica, [[], []]);
        porEpica.get(epica)![banda(t.id)].push(titulo(x.texto));
      }
    }
    for (const [epica, porBanda] of porEpica) columnas.push({ actor, tema: t.nombre.toLowerCase(), epica, porBanda });
  }
}

/** A spanning header: the label on its first column, empty after, repeated when it changes. */
const encabezado = (valor: (c: Columna) => string, clave: (c: Columna) => string): string[] =>
  columnas.map((c, i) => (i > 0 && clave(columnas[i - 1]) === clave(c) ? '' : valor(c)));

const celda = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const fila = (primera: string, resto: string[]): string => [primera, ...resto].map(celda).join(',');
const vacia = (): string[] => columnas.map(() => '');

const csv = [
  fila('user type', encabezado((c) => c.actor, (c) => c.actor)),
  fila('theme', encabezado((c) => c.tema, (c) => `${c.actor}|${c.tema}`)),
  fila('epic', columnas.map((c) => c.epica)),
  fila('user story grid:', vacia()),
];
for (const [b, etiqueta] of [[0, 'sprint 0'], [1, 'sprint 1']] as const) {
  csv.push(fila(etiqueta, vacia()));
  const alto = Math.max(...columnas.map((c) => c.porBanda[b].length));
  for (let r = 0; r < alto; r++) csv.push(fila('', columnas.map((c) => c.porBanda[b][r] ?? '')));
}
csv.push(fila('backlog', vacia()));

const outCsv = resolve(here, '../../../../plan/mapa-historias.csv');
writeFileSync(outCsv, csv.join('\n') + '\n');
console.log(outCsv);
