/**
 * `/grafo`'s map on a PHONE, by touch: 390 × 844, Chromium with `hasTouch`.
 *
 * What only this suite checks:
 *   1. one-finger pan and two-finger pinch move the 2D map, and the page does
 *      not scroll sideways;
 *   2. a tap on a node selects it (`?entidad=`), a tap on empty space clears it;
 *   3. a tap leaves NO tooltip over the map (a touch has no hover; see
 *      `graph2d.ts`, `touchInput`);
 *   4. the same in 3D, and toggling 3D → 2D still draws the 2D map.
 *
 * ── HOW THE GESTURES ARE MADE ────────────────────────────────────────────────
 *
 * Playwright's `touchscreen` only taps, so pans and pinches go through the
 * Chrome DevTools Protocol (`Input.dispatchTouchEvent`), which is what a real
 * finger produces: touch events AND pointer events with `pointerType: 'touch'`.
 * Chromium only.
 *
 * ── HOW A NODE IS FOUND ──────────────────────────────────────────────────────
 *
 * The canvases are `aria-hidden` and expose no node positions. 2D: the canvas
 * pixels are read and a dot of the "tema" legend colour is tapped. 3D: the HTML
 * label layer places each label's bottom-centre on its node; the tap goes just
 * below one. Both are reads of what is on screen, not of app internals.
 *
 * ⚠ The map draws only entities with at least one edge. The seed below makes
 * relation rows, which a backend at or after the one-edge-per-pair change
 * turns into edges. An older backend sends no `edges`, the map stays blank,
 * and the first assertion says so.
 *
 * ⚠ 3D under headless Chromium runs on SOFTWARE WebGL: frames are slow, so the
 * 3D assertions poll instead of waiting a fixed time.
 *
 * ⚠ `trace` and `video` are off here: the sign-in types the seeded admin's
 * password, and a trace would keep it (handoff 10-21: it leaked three times).
 */

import { expect, test, devices, type CDPSession, type Page } from '@playwright/test';

import { dbAvailable, execute, insertReturning, query } from './db';
import { adminCredentials } from './env';

const db = dbAvailable();
const SHOTS = 'e2e/.artifacts/grafo-touch';

test.use({
  ...devices['iPhone 13'],
  browserName: 'chromium',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  video: 'off',
  trace: 'off',
});

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

/** A small connected graph: a hub topic, places and organisations around it. */
function seedGraph(ns: string, userId: number): number {
  const orgId = Number(
    insertReturning(`insert into organizations (name, slug) values (:'name', :'slug') returning id`, {
      // Short on purpose: a long name widens the page (see the `fixme` below).
      name: `Táctil ${ns.slice(-6)}`,
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
                 'published', 'e2e grafo táctil')
         returning id`,
        { org: orgId, user: userId, name: `${ns} doc ${i}` },
      ),
    ),
  );
  const entity = (type: string, label: string): number =>
    Number(
      insertReturning(
        `insert into graph_entities (organization_id, type, label, canonical_key)
         values (:'org', :'type', :'label', :'key') returning id`,
        { org: orgId, type, label, key: label.toLowerCase() },
      ),
    );
  const hub = entity('tema', 'Agua');
  const others = [
    entity('tema', 'Salud'),
    entity('tema', 'Escuela'),
    entity('lugar', 'Río Verde'),
    entity('lugar', 'Cerro Alto'),
    entity('organizacion', 'Cooperativa'),
    entity('evento', 'Asamblea'),
  ];
  for (const id of [hub, ...others]) {
    for (const d of docs) {
      execute(
        `insert into graph_mentions (organization_id, document_id, entity_id, occurrences)
         values (:'org', :'doc', :'ent', 1)`,
        { org: orgId, doc: d, ent: id },
      );
    }
  }
  for (const to of others) {
    execute(
      `insert into graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
       values (:'org', :'doc', :'from', :'to', 'relacionado_con')`,
      { org: orgId, doc: docs[0], from: hub, to },
    );
  }
  return orgId;
}

type Pt = { x: number; y: number };

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

async function tap(cdp: CDPSession, p: Pt) {
  await touch(cdp, 'touchStart', [p]);
  await touch(cdp, 'touchEnd', []);
}

async function pan(cdp: CDPSession, from: Pt, to: Pt, steps = 8) {
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch(cdp, 'touchMove', [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }]);
  }
  await touch(cdp, 'touchEnd', []);
}

async function pinch(cdp: CDPSession, c: Pt, from: number, to: number, steps = 8) {
  const at = (d: number) => [
    { x: c.x - d, y: c.y },
    { x: c.x + d, y: c.y },
  ];
  await touch(cdp, 'touchStart', at(from));
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', at(from + ((to - from) * i) / steps));
  await touch(cdp, 'touchEnd', []);
}

/**
 * The 2D canvas as drawn: its transform, one "tema" dot and one empty spot, in
 * page coordinates. Rows under the 2D/3D and zoom buttons are skipped.
 */
async function read2d(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=grafo-mapa] .canvas canvas');
    // Not mounted yet (the renderer loads after mount): nothing painted.
    if (!c || c.width === 0) return { k: 1, e: 0, f: 0, painted: 0, node: null, empty: null, centre: { x: 0, y: 0 } };
    const ctx = c.getContext('2d')!;
    const t = ctx.getTransform();
    const swatch = document.querySelector('[data-testid=grafo-mapa] .t-tema .swatch') as HTMLElement;
    const rgb = getComputedStyle(swatch).backgroundColor.match(/\d+/g)!.map(Number);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const ratio = c.width / c.clientWidth;
    const rect = c.getBoundingClientRect();
    const R = Math.round(14 * ratio);
    const same = (i: number) =>
      d[i + 3] === 255 && Math.abs(d[i] - rgb[0]) < 3 && Math.abs(d[i + 1] - rgb[1]) < 3 && Math.abs(d[i + 2] - rgb[2]) < 3;
    let node: { x: number; y: number } | null = null;
    let empty: { x: number; y: number } | null = null;
    for (let y = R + Math.round(50 * ratio); y < c.height - R && (!node || !empty); y += 3) {
      for (let x = R; x < c.width - R; x += 3) {
        const i = (y * c.width + x) * 4;
        // The inside of a dot, not a passing line: the pixel below matches too.
        if (!node && same(i) && same(i + 2 * c.width * 4)) node = { x: rect.left + x / ratio, y: rect.top + y / ratio };
        if (!empty) {
          let clear = true;
          for (let dy = -R; dy <= R && clear; dy += 2)
            for (let dx = -R; dx <= R && clear; dx += 2) if (d[((y + dy) * c.width + x + dx) * 4 + 3] > 0) clear = false;
          if (clear) empty = { x: rect.left + x / ratio, y: rect.top + y / ratio };
        }
      }
    }
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return {
      k: t.a,
      e: t.e,
      f: t.f,
      painted,
      node,
      empty,
      centre: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    };
  });
}

/** Whether `force-graph`'s / `3d-force-graph`'s floating tooltip shows anywhere. */
function tooltipShown(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=grafo-mapa] .float-tooltip-kap')].some(
      (el) => getComputedStyle(el).display !== 'none' && (el.textContent ?? '').trim() !== '',
    ),
  );
}

/**
 * Every element that scrolls sideways. ⚠ Not just the document: the app's
 * `main` has `overflow-x: auto`, so a too-wide child scrolls `main` while the
 * document's own `scrollWidth` still says 390.
 */
function sidewaysOverflow(page: Page) {
  return page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const ox = getComputedStyle(el).overflowX;
        const scrolls = el === document.documentElement || ox === 'auto' || ox === 'scroll';
        return scrolls && el.scrollWidth > el.clientWidth + 1 && !el.closest('nav');
      })
      .map((el) => `${el.tagName}.${String(el.className).split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`),
  );
}

const entidad = (page: Page) => new URL(page.url()).searchParams.get('entidad');

test.describe('grafo — el mapa en un teléfono, con el dedo', () => {
  test.skip(!db.ok, 'no database access; the graph is seeded by SQL (see e2e/db.ts)');

  let orgId: number;

  test.beforeAll(() => {
    const { email } = adminCredentials();
    const [admin] = query<{ id: number; is_platform_admin: boolean }>(
      `select id, is_platform_admin from users where email = :'email'`,
      { email },
    );
    if (!admin?.is_platform_admin) throw new Error(`[e2e] the seeded admin is missing or not a platform admin.`);
    orgId = seedGraph(`e2e-web-grafo-tactil-${Date.now().toString(36)}`, admin.id);
  });

  test('2D: pan, pinch, tap to select, tap empty space to clear; no sideways scroll', async ({ page }) => {
    await signIn(page);
    await page.evaluate(() => localStorage.setItem('edc.grafo.vista', '2d'));
    await page.goto(`/grafo?eco=${orgId}`);
    await expect(page.getByTestId('grafo-mapa')).toHaveAttribute('data-vista', '2d');
    await expect.poll(async () => (await read2d(page)).painted, { message: 'the 2D map drew nothing (does the backend send edges?)' }).toBeGreaterThan(0);
    const cdp = await page.context().newCDPSession(page);

    expect(await sidewaysOverflow(page), 'something scrolls sideways at 390 px').toEqual([]);

    // The buttons over the map are inside it and inside the screen.
    const stage = (await page.locator('[data-testid=grafo-mapa] .stage').boundingBox())!;
    for (const name of ['2D', '3D', 'Acercar', 'Alejar']) {
      const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(stage.x);
      expect(b.x + b.width).toBeLessThanOrEqual(Math.min(stage.x + stage.width, 390));
    }
    await page.screenshot({ path: `${SHOTS}/2d-01-initial.png` });

    const before = await read2d(page);
    const scrollY = await page.evaluate(() => window.scrollY);
    await pan(cdp, before.centre, { x: before.centre.x + 60, y: before.centre.y + 40 });
    await expect.poll(async () => (await read2d(page)).e - before.e, { message: 'one-finger pan' }).toBeGreaterThan(30);
    expect(await page.evaluate(() => window.scrollY), 'a pan on the map scrolled the page').toBe(scrollY);
    expect(entidad(page), 'a pan selected something').toBeNull();

    const panned = await read2d(page);
    await pinch(cdp, panned.centre, 30, 110);
    await expect.poll(async () => (await read2d(page)).k / panned.k, { message: 'pinch-out zoom' }).toBeGreaterThan(1.5);
    expect(entidad(page), 'a pinch selected something').toBeNull();
    expect(await tooltipShown(page), 'a tooltip shows after a pan / pinch').toBe(false);

    // Back to the whole picture, then tap a node.
    await page.getByRole('button', { name: 'Ver todo' }).tap();
    await page.waitForTimeout(500);
    const fitted = await read2d(page);
    expect(fitted.node, 'no tema dot found on the 2D canvas').not.toBeNull();
    await tap(cdp, fitted.node!);
    await expect.poll(() => entidad(page), { message: 'a tap on a node selects it' }).not.toBeNull();
    await page.waitForTimeout(300);
    expect(await tooltipShown(page), 'a tap left a tooltip over the map').toBe(false);
    await page.screenshot({ path: `${SHOTS}/2d-02-node-tapped.png` });

    const afterTap = await read2d(page);
    expect(afterTap.empty, 'no empty spot found on the 2D canvas').not.toBeNull();
    await tap(cdp, afterTap.empty!);
    await expect.poll(() => entidad(page), { message: 'a tap on empty space clears the selection' }).toBeNull();
    await page.screenshot({ path: `${SHOTS}/2d-03-cleared.png` });
  });

  test('3D: drag and pinch move the camera, tap selects and clears, 2D comes back', async ({ page }) => {
    await signIn(page);
    await page.evaluate(() => localStorage.setItem('edc.grafo.vista', '2d'));
    await page.goto(`/grafo?eco=${orgId}`);
    await expect.poll(async () => (await read2d(page)).painted).toBeGreaterThan(0);
    const cdp = await page.context().newCDPSession(page);

    await page.getByTestId('grafo-3d').tap();
    await expect(page.getByTestId('grafo-mapa')).toHaveAttribute('data-vista', '3d');
    await expect(page.locator('[data-testid=grafo-mapa] .fallback'), 'no WebGL in this browser').toHaveCount(0);
    const labels = page.locator('.labels3d .map3d-label');
    await expect(labels.first()).toBeVisible();
    const box = (await page.locator('.canvas3d').boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const where = () => labels.evaluateAll((ls) => ls.map((l) => (l as HTMLElement).style.transform).join('|'));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SHOTS}/3d-01-initial.png` });

    const w0 = await where();
    await pan(cdp, centre, { x: centre.x + 80, y: centre.y });
    await expect.poll(where, { message: 'one-finger drag orbits the 3D camera' }).not.toBe(w0);
    const w1 = await where();
    await pinch(cdp, centre, 30, 110);
    await expect.poll(where, { message: 'pinch zooms the 3D camera' }).not.toBe(w1);
    expect(entidad(page), 'a 3D gesture selected something').toBeNull();

    await page.getByRole('button', { name: 'Ver todo' }).tap();
    await page.waitForTimeout(1500);
    // A label's bottom-centre sits on its node; tap just below the one nearest the middle.
    const target = await page.evaluate(() => {
      const layer = document.querySelector('.labels3d') as HTMLElement;
      const r = layer.getBoundingClientRect();
      let best: { x: number; y: number; d: number } | null = null;
      for (const l of layer.querySelectorAll<HTMLElement>('.map3d-label')) {
        const m = l.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
        if (!m) continue;
        const x = r.left + Number(m[1]);
        const y = r.top + Number(m[2]) + 4;
        if (x < r.left + 10 || x > r.right - 10 || y < r.top + 50 || y > r.bottom - 10) continue;
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (!best || d < best.d) best = { x, y, d };
      }
      return best;
    });
    expect(target, 'no 3D label inside the map to aim at').not.toBeNull();
    await tap(cdp, target!);
    await expect.poll(() => entidad(page), { message: 'a tap on a 3D node selects it', timeout: 10_000 }).not.toBeNull();
    await page.waitForTimeout(500);
    expect(await tooltipShown(page), 'a 3D tap left a tooltip over the map').toBe(false);
    await page.screenshot({ path: `${SHOTS}/3d-02-node-tapped.png` });

    await tap(cdp, { x: box.x + 12, y: box.y + box.height - 12 });
    await expect.poll(() => entidad(page), { message: 'a tap on empty 3D space clears it', timeout: 10_000 }).toBeNull();

    await page.getByRole('button', { name: '2D', exact: true }).tap();
    await expect(page.getByTestId('grafo-mapa')).toHaveAttribute('data-vista', '2d');
    await expect(labels).toHaveCount(0);
    await expect.poll(async () => (await read2d(page)).painted, { message: '2D draws again after 3D' }).toBeGreaterThan(0);
    await page.screenshot({ path: `${SHOTS}/3d-03-back-to-2d.png` });
  });

  // ⚠ KNOWN, NOT FIXED HERE (routes/grafo/+page.svelte, another lane's file):
  // `.page` and `.stage` are grids with an implicit `auto` column, so a long
  // ecosistema name's min-content widens them past 390 px; `main` then scrolls
  // sideways and the map's "Ver todo" is cut off. Fix: give `.page`, `.stage`
  // and `.board` `grid-template-columns: minmax(0, 1fr)` below 60rem.
  // Turn this on when that lands.
  test.fixme('a long ecosistema name does not widen the page', async ({ page }) => {
    // Runs last (serial): renames the seeded ecosistema.
    execute(`update organizations set name = :'name' where id = :'id'`, {
      name: `E2E grafo táctil con un nombre largo ${Date.now().toString(36)}`,
      id: orgId,
    });
    await signIn(page);
    await page.goto(`/grafo?eco=${orgId}`);
    await expect(page.getByTestId('grafo-mapa')).toBeVisible();
    expect(await sidewaysOverflow(page)).toEqual([]);
  });
});
