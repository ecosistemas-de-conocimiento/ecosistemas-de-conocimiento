/**
 * `/grafo` — the published graph of one ecosistema, driven in a real browser.
 *
 * What only this suite checks (G-4 in `plan/auditoria-ia-2026-10-17.md`):
 *   1. the lists render what the backend's graph SQL lets through — the
 *      minimum-support threshold and the published-only rule, run on Postgres;
 *   2. `?lengua=` narrows the panel's document list, and a testimonio never
 *      survives the filter (the lengua index only counts `documento`);
 *   3. a platform admin's `?eco=` survives clicking an entity.
 *
 * ── WHY THE GRAPH IS SEEDED BY SQL ───────────────────────────────────────────
 *
 * The graph is written by the extraction job, which is a model call. Under the
 * fake provider it extracts nothing, so a real upload cannot produce graph
 * rows here. This suite therefore makes its OWN ecosistema, documents and
 * `graph_*` rows by SQL (same escape hatch as `revision.spec.ts`, `e2e/db.ts`),
 * and touches nothing else.
 *
 * 🔴 THE ASSERTIONS ARE ON WHAT THE APP DERIVES, NOT ON THE SEED. The seed is
 * built so that every number on screen is the result of a rule:
 *   · "Agua" has mentions in 4 published documentos, 1 published testimonio and
 *     1 DRAFT. The page must say 5, not 6 — the draft is excluded.
 *   · "Lugar raro" has 2 published mentions plus 1 draft. Counting the draft
 *     would put it at the threshold (3); the page must hide it and say
 *     "Hay 1 entidad que no se muestra".
 *   · Lengua facets count documentos only: the testimonio is stamped tsotsil
 *     too, and the facet must still say 2.
 *
 * ⚠ The threshold is the backend default, 3 (`GRAPH_MIN_SUPPORT_DEFAULT`,
 * `apps/backend/src/lib/graph/queries.ts`). A stack that sets
 * `GRAPH_MIN_SUPPORT` to something else fails the hidden-count assertion, and
 * the failure names the number it saw.
 *
 * ⚠ Copy is written out, not imported from `$lib/graph.ts` — importing would
 * make the test agree with the app by construction. Same rule as
 * `revision.spec.ts`.
 */

import { expect, test, type Page } from '@playwright/test';

import { dbAvailable, execute, insertReturning, query } from './db';
import { adminCredentials } from './env';

const db = dbAvailable();

if (!db.ok) {
  console.error(
    `\n[e2e] grafo: SKIPPED — ${db.reason}\n` +
      '      The graph can only be seeded by SQL under the fake provider. See e2e/db.ts.\n',
  );
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
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

interface Seed {
  orgId: number;
  orgName: string;
  agua: number;
  escuela: number;
  raro: number;
  /** Published documento names, by lengua. */
  tsotsil: string[];
  mixe: string;
  sinLengua: string;
  draft: string;
}

function seedGraph(ns: string, userId: number): Seed {
  const orgName = `E2E grafo ${ns}`;
  const orgId = Number(
    insertReturning(
      `insert into organizations (name, slug) values (:'name', :'slug') returning id`,
      { name: orgName, slug: ns },
    ),
  );

  const doc = (
    name: string,
    contentKind: 'documento' | 'testimonio',
    status: 'published' | 'draft',
    lengua: string | null,
  ): number =>
    Number(
      insertReturning(
        `insert into documents
           (organization_id, uploaded_by_id, name, kind, mode, content_kind,
            publication_status, extracted_text, lengua)
         values
           (:'org', :'user', :'name', 'markdown', 'rag-retrieve', :'kind',
            :'status', 'e2e grafo fixture', nullif(:'lengua', ''))
         returning id`,
        { org: orgId, user: userId, name, kind: contentKind, status, lengua: lengua ?? '' },
      ),
    );

  const names = {
    d1: `${ns} doc tsotsil uno`,
    d2: `${ns} doc tsotsil dos`,
    d3: `${ns} doc mixe`,
    d4: `${ns} doc sin lengua`,
    d5: `${ns} doc borrador`,
  };
  const d1 = doc(names.d1, 'documento', 'published', 'tsotsil');
  const d2 = doc(names.d2, 'documento', 'published', 'tsotsil');
  const d3 = doc(names.d3, 'documento', 'published', 'mixe');
  const d4 = doc(names.d4, 'documento', 'published', null);
  // Stamped tsotsil on purpose: the lengua index must ignore a testimonio anyway.
  const t1 = doc(`${ns} testimonio`, 'testimonio', 'published', 'tsotsil');
  const d5 = doc(names.d5, 'documento', 'draft', 'tsotsil');

  const entity = (type: string, label: string, key: string): number =>
    Number(
      insertReturning(
        `insert into graph_entities (organization_id, type, label, canonical_key)
         values (:'org', :'type', :'label', :'key') returning id`,
        { org: orgId, type, label, key },
      ),
    );
  const agua = entity('tema', 'Agua', 'agua');
  const escuela = entity('organizacion', 'Escuela comunitaria', 'escuela comunitaria');
  const raro = entity('lugar', 'Lugar raro', 'lugar raro');

  const mention = (documentId: number, entityId: number) =>
    execute(
      `insert into graph_mentions (organization_id, document_id, entity_id, occurrences)
       values (:'org', :'doc', :'ent', 1)`,
      { org: orgId, doc: documentId, ent: entityId },
    );
  for (const d of [d1, d2, d3, d4, t1, d5]) mention(d, agua);
  for (const d of [d1, d2, d3]) mention(d, escuela);
  for (const d of [d1, d2, d5]) mention(d, raro);

  for (const d of [d1, d2, d3]) {
    execute(
      `insert into graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
       values (:'org', :'doc', :'from', :'to', 'relacionado_con')`,
      { org: orgId, doc: d, from: agua, to: escuela },
    );
  }

  return {
    orgId,
    orgName,
    agua,
    escuela,
    raro,
    tsotsil: [names.d1, names.d2],
    mixe: names.d3,
    sinLengua: names.d4,
    draft: names.d5,
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('grafo — lo que el grafo publicado deja ver', () => {
  test.skip(!db.ok, 'no database access; see the banner above');

  let seed: Seed;

  test.beforeAll(() => {
    const { email } = adminCredentials();
    const [admin] = query<{ id: number; is_platform_admin: boolean }>(
      `select id, is_platform_admin from users where email = :'email'`,
      { email },
    );
    if (!admin) throw new Error(`[e2e] ${email} is not in the users table.`);
    if (!admin.is_platform_admin) {
      throw new Error(`[e2e] ${email} is not a platform admin; ?eco= is admin-only.`);
    }
    seed = seedGraph(`e2e-web-grafo-${Date.now().toString(36)}`, admin.id);
  });

  test('the lists show what clears the threshold over published documents only', async ({
    page,
  }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto(`/grafo?eco=${seed.orgId}`);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The subtitle naming the ecosistema is gone (backlog #27); the switcher names it.
    await expect(page.locator('p.name')).toHaveText(seed.orgName);

    const agua = page.getByTestId(`grafo-entidad-${seed.agua}`);
    const escuela = page.getByTestId(`grafo-entidad-${seed.escuela}`);
    await expect(agua).toBeVisible();
    await expect(escuela).toBeVisible();

    // 🔴 Published-only: 4 documentos + 1 testimonio, the draft not counted.
    await expect(agua).toContainText('aparece en 5 documentos');
    await expect(escuela).toContainText('aparece en 3 documentos');

    // 🔴 Threshold: 2 published mentions is below 3, so it is held back. The
    // sentence that used to report it is gone (backlog #29); the gate is not.
    await expect(page.getByTestId(`grafo-entidad-${seed.raro}`)).toHaveCount(0);
    await expect(page.getByText('Lugar raro')).toHaveCount(0);
    await expect(page.getByTestId('grafo-conteo')).toHaveText('2 entidades');

    // Lengua facets count published documentos only: not the testimonio, not the draft.
    const lenguas = page.getByTestId('grafo-lenguas');
    await expect(lenguas.getByRole('link', { name: 'tsotsil · 2 documentos' })).toBeVisible();
    await expect(lenguas.getByRole('link', { name: 'mixe · 1 documento' })).toBeVisible();
  });

  test('?eco= survives clicking an entity, and is what scopes the page', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);

    // Control: without ?eco= the admin sees their own ecosistema, not the seeded one.
    await page.goto('/grafo');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId(`grafo-entidad-${seed.agua}`)).toHaveCount(0);

    await page.goto(`/grafo?eco=${seed.orgId}`);
    await page.getByTestId(`grafo-entidad-${seed.agua}`).click();

    await page.waitForURL((url) => url.searchParams.get('entidad') === String(seed.agua));
    const url = new URL(page.url());
    expect(url.searchParams.get('eco')).toBe(String(seed.orgId));

    // Still the seeded ecosistema, and the panel describes the clicked entity.
    // The subtitle naming the ecosistema is gone (backlog #27); the switcher names it.
    await expect(page.locator('p.name')).toHaveText(seed.orgName);
    await expect(page.getByRole('heading', { level: 2, name: 'Agua', exact: true })).toBeVisible();
    await expect(page.getByTestId(`grafo-entidad-${seed.agua}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The edge to the escuela has 3 published documents behind it, so it is shown.
    await expect(page.getByTestId(`grafo-vecino-${seed.escuela}`)).toBeVisible();
  });

  test('?lengua= narrows the panel documents, and drops the testimonio', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto(`/grafo?eco=${seed.orgId}&entidad=${seed.agua}`);

    const docs = page.locator('a.doc-link');
    // Unfiltered: every PUBLISHED mention — 4 documentos and the testimonio.
    await expect(docs).toHaveCount(5);
    await expect(page.locator('a.doc-link', { hasText: seed.draft })).toHaveCount(0);
    await expect(page.locator('a.doc-link', { hasText: 'Testimonio' })).toHaveCount(1);

    await page
      .getByTestId('grafo-lenguas')
      .getByRole('link', { name: 'tsotsil · 2 documentos' })
      .click();
    await page.waitForURL((u) => u.searchParams.get('lengua') === 'tsotsil');

    const url = new URL(page.url());
    expect(url.searchParams.get('eco')).toBe(String(seed.orgId));
    expect(url.searchParams.get('entidad')).toBe(String(seed.agua));

    await expect(docs).toHaveCount(2);
    for (const name of seed.tsotsil) {
      await expect(page.locator('a.doc-link', { hasText: name })).toHaveCount(1);
    }
    await expect(page.locator('a.doc-link', { hasText: seed.mixe })).toHaveCount(0);
    await expect(page.locator('a.doc-link', { hasText: seed.sinLengua })).toHaveCount(0);
    // 🔴 The testimonio row says tsotsil too; it must not survive the filter.
    await expect(page.locator('a.doc-link', { hasText: 'Testimonio' })).toHaveCount(0);

    // The lists are NOT narrowed: lengua filters documents, never the graph.
    await expect(page.getByTestId('grafo-conteo')).toHaveText('2 entidades');
  });
});
