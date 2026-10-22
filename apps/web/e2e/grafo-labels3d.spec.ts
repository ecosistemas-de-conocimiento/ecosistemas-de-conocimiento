/**
 * `/grafo` 3D LABELS: how many show per level, and that none overlap.
 *
 * What only this suite checks: on a graph big enough to crowd (≈50 entities,
 * every level populated), the 3D view draws at most five labels per level
 * (`LABELS_3D_PER_LEVEL`, `labels3d.ts`) and no two drawn labels share pixels
 * — at the fitted view and again after an orbit, since the declutter re-runs
 * on camera moves.
 *
 * A label's level is read from its TEXT, against the seed below, so the check
 * reads what is on screen and nothing of the app's internals. Overlap uses the
 * labels' real `getBoundingClientRect`, not the app's own box estimate.
 *
 * ⚠ 3D under headless Chromium runs on SOFTWARE WebGL: frames are slow, so the
 * assertions poll and the camera gets time to settle.
 *
 * ⚠ `trace` and `video` are off: the sign-in types the seeded admin's password.
 */

import { expect, test, type Page } from '@playwright/test';

import { dbAvailable, execute, insertReturning, query } from './db';
import { adminCredentials } from './env';

const db = dbAvailable();
const SHOTS = 'e2e/.artifacts/grafo-labels3d';

test.use({ video: 'off', trace: 'off', viewport: { width: 1366, height: 900 } });
test.describe.configure({ mode: 'serial' });

/** Same levels as `MAP_LEVELS` (mapModel.ts); ≤ 22 chars so no label is cut. */
const LEVEL = { lugar: 0, organizacion: 1, evento: 2, tema: 3 } as const;
type Kind = keyof typeof LEVEL;
const SEED: Record<Kind, string[]> = {
  tema: [
    'control del dengue', 'desigualdad', 'prevención', 'pandemia', 'brigadistas',
    'agua potable', 'salud comunitaria', 'descacharrización', 'vigilancia', 'migración',
    'educación', 'género', 'clima', 'vivienda', 'nutrición', 'participación',
    'derechos humanos', 'movilidad', 'empleo informal', 'saneamiento',
  ],
  evento: [
    'feria escolar', 'jornada de limpieza', 'huracán', 'asamblea ejidal',
    'campaña de fumigación', 'foro regional', 'censo de criaderos', 'taller de salud',
  ],
  lugar: [
    'Cuernavaca', 'Morelos', 'Oaxaca', 'Guerrero', 'Huautla de Jiménez',
    'Tepoztlán', 'Cuautla', 'Jojutla', 'Yautepec', 'Puebla', 'Tlaxcala', 'Iguala',
  ],
  organizacion: [
    'App-Salud Aedes', 'centro de salud', 'Cooperativa Agua', 'Secretaría de Salud',
    'Red de Brigadas', 'Colectivo Verde',
  ],
};
const levelOf = new Map<string, number>(
  (Object.keys(SEED) as Kind[]).flatMap((k) => SEED[k].map((label) => [label, LEVEL[k]] as const)),
);

async function signIn(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/sign-in');
  await page.waitForLoadState('networkidle');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // ⚠ Blank the field before any failure artefact can snapshot it.
  await page
    .locator('input[name="password"]')
    .evaluate((el) => {
      (el as HTMLInputElement).value = '';
    })
    .catch(() => {});
  await page.waitForURL('**/');
}

/** Every entity mentioned in a few documents; relations from topics outward, deterministic. */
function seedGraph(ns: string, userId: number): number {
  const orgId = Number(
    insertReturning(`insert into organizations (name, slug) values (:'name', :'slug') returning id`, {
      name: `Etiquetas ${ns.slice(-6)}`,
      slug: ns,
    }),
  );
  const docs = [1, 2, 3, 4].map((i) =>
    Number(
      insertReturning(
        `insert into documents
           (organization_id, uploaded_by_id, name, kind, mode, content_kind,
            publication_status, extracted_text)
         values (:'org', :'user', :'name', 'markdown', 'rag-retrieve', 'documento',
                 'published', 'e2e grafo etiquetas 3d')
         returning id`,
        { org: orgId, user: userId, name: `${ns} doc ${i}` },
      ),
    ),
  );
  const ids: Record<Kind, number[]> = { tema: [], evento: [], lugar: [], organizacion: [] };
  for (const kind of Object.keys(SEED) as Kind[]) {
    for (const label of SEED[kind]) {
      ids[kind].push(
        Number(
          insertReturning(
            `insert into graph_entities (organization_id, type, label, canonical_key)
             values (:'org', :'type', :'label', :'key') returning id`,
            { org: orgId, type: kind, label, key: label.toLowerCase() },
          ),
        ),
      );
    }
  }
  const all = Object.values(ids).flat();
  all.forEach((ent, i) => {
    for (const d of docs.filter((_, j) => (i + j) % 2 === 0 || j === 0)) {
      execute(
        `insert into graph_mentions (organization_id, document_id, entity_id, occurrences)
         values (:'org', :'doc', :'ent', 1)`,
        { org: orgId, doc: d, ent },
      );
    }
  });
  const relate = (from: number, to: number, i: number) =>
    execute(
      `insert into graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
       values (:'org', :'doc', :'from', :'to', 'relacionado_con')`,
      { org: orgId, doc: docs[i % docs.length], from, to },
    );
  // Topics: lower index, more edges, so degree ranks spread out.
  ids.tema.forEach((t, i) => {
    const fan = Math.max(2, 8 - Math.floor(i / 3));
    const others = [...ids.lugar, ...ids.evento, ...ids.organizacion, ...ids.tema.filter((x) => x !== t)];
    for (let k = 0; k < fan; k++) relate(t, others[(i * 7 + k * 5) % others.length], i + k);
  });
  ids.evento.forEach((e, i) => relate(e, ids.lugar[i % ids.lugar.length], i));
  ids.organizacion.forEach((o, i) => relate(o, ids.lugar[(i * 3) % ids.lugar.length], i));
  return orgId;
}

/** Drawn labels: per level counts and the overlapping pairs, from what is on screen. */
function readLabels(page: Page) {
  return page.evaluate((levels) => {
    const shown = [...document.querySelectorAll<HTMLElement>('.labels3d .map3d-label')].filter(
      (l) => l.checkVisibility() && l.getBoundingClientRect().width > 0,
    );
    const perLevel: Record<string, number> = {};
    const unknown: string[] = [];
    for (const l of shown) {
      const lv = levels[l.textContent ?? ''];
      if (lv === undefined) unknown.push(l.textContent ?? '');
      else perLevel[lv] = (perLevel[lv] ?? 0) + 1;
    }
    const boxes = shown.map((l) => ({ t: l.textContent, r: l.getBoundingClientRect() }));
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
          overlaps.push(`${boxes[i].t} × ${boxes[j].t}`);
      }
    return { total: shown.length, perLevel, unknown, overlaps };
  }, Object.fromEntries(levelOf));
}

test.describe('grafo 3D — cuántas etiquetas por nivel, sin encimarse', () => {
  test.skip(!db.ok, 'no database access; the graph is seeded by SQL (see e2e/db.ts)');

  let orgId: number;

  test.beforeAll(() => {
    const { email } = adminCredentials();
    const [admin] = query<{ id: number; is_platform_admin: boolean }>(
      `select id, is_platform_admin from users where email = :'email'`,
      { email },
    );
    if (!admin?.is_platform_admin) throw new Error(`[e2e] the seeded admin is missing or not a platform admin.`);
    orgId = seedGraph(`e2e-web-grafo-etiquetas-${Date.now().toString(36)}`, admin.id);
  });

  test('at most five labels per level, none overlapping, before and after an orbit', async ({ page }) => {
    test.setTimeout(5 * 60 * 1000);
    await signIn(page);
    await page.evaluate(() => localStorage.setItem('edc.grafo.vista', '3d'));
    await page.goto(`/grafo?eco=${orgId}`);
    await expect(page.getByTestId('grafo-mapa')).toHaveAttribute('data-vista', '3d');
    await expect(page.locator('[data-testid=grafo-mapa] .fallback'), 'no WebGL in this browser').toHaveCount(0);
    await expect.poll(async () => (await readLabels(page)).total, { timeout: 60_000 }).toBeGreaterThan(0);
    // The fit animates; let it land.
    await page.waitForTimeout(3000);

    const fitted = await readLabels(page);
    console.log(`[labels3d] fitted: ${JSON.stringify(fitted)}`);
    await page.screenshot({ path: `${SHOTS}/01-fitted.png` });
    expect(fitted.unknown, 'a label not in the seed').toEqual([]);
    for (const n of Object.values(fitted.perLevel)) expect(n).toBeLessThanOrEqual(5);
    expect(fitted.overlaps).toEqual([]);
    // Every level shows something: the per-level split, not a global top-N.
    expect(Object.keys(fitted.perLevel).length).toBeGreaterThanOrEqual(3);

    // Orbit: drag across the canvas with the mouse.
    const box = (await page.locator('.canvas3d').boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + i * 18, c.y + i * 6);
    await page.mouse.up();
    // Move the pointer off the map: a hover would add a forced label.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(2000);

    const orbited = await readLabels(page);
    console.log(`[labels3d] orbited: ${JSON.stringify(orbited)}`);
    await page.screenshot({ path: `${SHOTS}/02-orbited.png` });
    for (const n of Object.values(orbited.perLevel)) expect(n).toBeLessThanOrEqual(5);
    expect(orbited.overlaps).toEqual([]);
  });
});
