/**
 * `/grafo` 3D HEIGHT SELECTOR (`zAxis.ts`): what the height means.
 *
 * What only this suite checks, on a seeded single ecosistema:
 *   - the selector shows in 3D only, offers the four single-view options
 *     ("Ecosistemas compartidos" is combined-view only) and starts on Tipo;
 *   - a choice is remembered per view kind (`edc.grafo.altura.una`) across a
 *     reload, and changing it keeps the 3D labels apart (no overlaps);
 *   - at 390 px with touch it fits inside the map, is at least 44 px tall and
 *     overlaps neither the 2D/3D nor the zoom buttons.
 *
 * ⚠ 3D under headless Chromium runs on SOFTWARE WebGL: frames are slow, so the
 * assertions poll. ⚠ `trace` and `video` are off: the sign-in types the
 * seeded admin's password.
 */

import { expect, test, type Page } from '@playwright/test';

import { dbAvailable, execute, insertReturning, query } from './db';
import { adminCredentials } from './env';

const db = dbAvailable();
const KEY = 'edc.grafo.altura.una';

test.use({ video: 'off', trace: 'off' });
test.describe.configure({ mode: 'serial' });

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

/** Two clusters of topics and places, joined by one relation: enough for every option to differ. */
function seedGraph(ns: string, userId: number): number {
  const orgId = Number(
    insertReturning(`insert into organizations (name, slug) values (:'name', :'slug') returning id`, {
      name: `Altura ${ns.slice(-6)}`,
      slug: ns,
    }),
  );
  const docs = [1, 2, 3].map((i) =>
    Number(
      insertReturning(
        `insert into documents
           (organization_id, uploaded_by_id, name, kind, mode, content_kind,
            publication_status, extracted_text)
         values (:'org', :'user', :'name', 'markdown', 'rag-retrieve', 'documento',
                 'published', 'e2e grafo altura')
         returning id`,
        { org: orgId, user: userId, name: `${ns} doc ${i}` },
      ),
    ),
  );
  const entity = (type: string, label: string) =>
    Number(
      insertReturning(
        `insert into graph_entities (organization_id, type, label, canonical_key)
         values (:'org', :'type', :'label', :'key') returning id`,
        { org: orgId, type, label, key: label.toLowerCase() },
      ),
    );
  const clusters = [
    { tema: ['dengue', 'fumigación', 'criaderos'], lugar: ['Cuautla', 'Jojutla'] },
    { tema: ['escuela', 'maestros', 'lectura'], lugar: ['Oaxaca', 'Huautla'] },
  ].map((c) => [...c.tema.map((l) => entity('tema', l)), ...c.lugar.map((l) => entity('lugar', l))]);
  clusters.flat().forEach((ent, i) => {
    for (const d of docs.slice(0, 1 + (i % 3))) {
      execute(
        `insert into graph_mentions (organization_id, document_id, entity_id, occurrences)
         values (:'org', :'doc', :'ent', 1)`,
        { org: orgId, doc: d, ent },
      );
    }
  });
  const relate = (from: number, to: number) =>
    execute(
      `insert into graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
       values (:'org', :'doc', :'from', :'to', 'relacionado_con')`,
      { org: orgId, doc: docs[0], from, to },
    );
  for (const c of clusters) for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) relate(c[i]!, c[j]!);
  relate(clusters[0]![0]!, clusters[1]![0]!);
  return orgId;
}

async function open3d(page: Page, orgId: number): Promise<void> {
  await page.evaluate(() => localStorage.setItem('edc.grafo.vista', '3d'));
  await page.goto(`/grafo?eco=${orgId}`);
  await expect(page.getByTestId('grafo-mapa')).toHaveAttribute('data-vista', '3d');
  await expect(page.locator('[data-testid=grafo-mapa] .fallback'), 'no WebGL in this browser').toHaveCount(0);
  await expect.poll(() => page.locator('.labels3d .map3d-label:not([hidden])').count(), { timeout: 60_000 }).toBeGreaterThan(0);
}

/** Pairs of visible 3D labels whose real boxes overlap. */
function overlaps(page: Page) {
  return page.evaluate(() => {
    const r = [...document.querySelectorAll<HTMLElement>('.labels3d .map3d-label')]
      .filter((l) => l.checkVisibility() && l.getBoundingClientRect().width > 0)
      .map((l) => ({ t: l.textContent, r: l.getBoundingClientRect() }));
    const out: string[] = [];
    for (let i = 0; i < r.length; i++)
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i]!.r;
        const b = r[j]!.r;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`${r[i]!.t} × ${r[j]!.t}`);
      }
    return out;
  });
}

test.describe('grafo 3D — selector de altura', () => {
  test.skip(!db.ok, 'no database access; the graph is seeded by SQL (see e2e/db.ts)');

  let orgId: number;

  test.beforeAll(() => {
    const { email } = adminCredentials();
    const [admin] = query<{ id: number; is_platform_admin: boolean }>(
      `select id, is_platform_admin from users where email = :'email'`,
      { email },
    );
    if (!admin?.is_platform_admin) throw new Error(`[e2e] the seeded admin is missing or not a platform admin.`);
    orgId = seedGraph(`e2e-web-grafo-altura-${Date.now().toString(36)}`, admin.id);
  });

  test('desktop: four options, Tipo first, choice remembered, labels apart', async ({ page }) => {
    test.setTimeout(5 * 60 * 1000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await open3d(page, orgId);

    const select = page.getByTestId('grafo-altura');
    await expect(select).toBeVisible();
    await expect(select).toHaveAttribute('title', 'Altura');
    await expect(select.locator('option')).toHaveText(['Tipo', 'Frecuencia', 'Centralidad', 'Comunidad']);
    await expect(select).toHaveValue('tipo');

    await select.selectOption('comunidad');
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('comunidad');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1500);
    expect(await overlaps(page)).toEqual([]);

    await page.reload();
    await expect(page.getByTestId('grafo-mapa')).toHaveAttribute('data-vista', '3d');
    await expect(page.getByTestId('grafo-altura')).toHaveValue('comunidad');

    await page.getByRole('button', { name: '2D' }).click();
    await expect(page.getByTestId('grafo-altura')).toHaveCount(0);
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('390 px: fits inside the map, 44 px tall, clear of the other buttons', async ({ page }) => {
      test.setTimeout(5 * 60 * 1000);
      await signIn(page);
      await open3d(page, orgId);
      const select = page.getByTestId('grafo-altura');
      await expect(select).toBeVisible();

      const stage = (await page.locator('[data-testid=grafo-mapa] .stage').boundingBox())!;
      const box = (await select.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(stage.x);
      expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width);
      expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height);
      for (const other of ['.modes', '.controls']) {
        const o = (await page.locator(`[data-testid=grafo-mapa] ${other}`).boundingBox())!;
        const meets = box.x < o.x + o.width && o.x < box.x + box.width && box.y < o.y + o.height && o.y < box.y + box.height;
        expect(meets, `selector overlaps ${other}`).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await select.selectOption('frecuencia');
      await expect(select).toHaveValue('frecuencia');
    });
  });
});
