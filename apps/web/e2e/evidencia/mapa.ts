/**
 * Writes `plan/mapa-historias.md` from `./historias.ts`, so the map people read
 * and the captions the videos show cannot drift apart.
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
