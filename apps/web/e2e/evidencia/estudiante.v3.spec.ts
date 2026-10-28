import { expect, test, type Page } from '@playwright/test';
import { elegirEcosistema } from './comun';
import { cerrarSesion, escena, iniciarSesion, instalarSubtitulos, ir } from './escena';
import { soloV3 } from './v3';

soloV3();

const ECO = process.env.EVID_ECOSISTEMA_ESTUDIANTE ?? 'Semiosis práctica';

/**
 * Open one of Mis temas in Conexiones (feat/estudiante-links: `tema-link` →
 * /grafo?entidad=<id>&eco=<org>, which opens that topic's panel).
 *
 * ⚠ A topic that only a DRAFT mentions has no node in the published graph and
 * opens an empty panel (coordinator, 2026-10-28). Try chips until one opens a
 * panel headed with its own name; give up after a few.
 */
async function abrirUnTema(page: Page): Promise<void> {
  const chips = page.getByTestId('tema-link');
  const total = Math.min(await chips.count(), 4);
  for (let i = 0; i < total; i++) {
    const nombre = ((await chips.nth(i).textContent()) ?? '').trim();
    await chips.nth(i).click();
    await page.waitForURL('**/grafo**');
    const panel = page.getByRole('heading', { name: nombre, exact: true });
    if (await panel.isVisible({ timeout: 20_000 }).catch(() => false)) {
      await panel.scrollIntoViewIfNeeded();
      return;
    }
    await page.goBack();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }
}

/**
 * V3 (2), estudiante1 in Semiosis práctica (org 8): the redesigned view's
 * links — a topic into the graph, and a classmate's page with the topics you
 * share and a work they published. Read-only: nothing is created.
 */
test('estudiante', async ({ page }) => {
  await instalarSubtitulos(page, 'Estudiante');
  await iniciarSesion(page, 'estudiante');
  await elegirEcosistema(page, ECO);

  await escena(page, 'E1.1', () => ir(page, 'estudiante'));
  await escena(page, 'E1.7', () => abrirUnTema(page));

  await escena(page, 'E1.3', async () => {
    await ir(page, 'estudiante');
    await page.getByTestId('tab-companeros').click();
    await page.getByTestId('companero-link').first().click();
    await expect(page.getByTestId('companero-nombre')).toBeVisible();
    await page.getByTestId('companero-temas').scrollIntoViewIfNeeded();
  });
  await escena(page, 'E1.8', async () => {
    await page.getByTestId('companero-trabajos').scrollIntoViewIfNeeded();
    const trabajo = page.getByTestId('companero-trabajo-link').first();
    if (await trabajo.count()) await trabajo.hover();
  });
  await page.getByTestId('companero-volver').click();

  await cerrarSesion(page);
});

/**
 * V3 (2), second half — STUB until "Publicar cambios" (feat/app-notes-graph)
 * is on main. Expected flow, estudiante1 in org 8:
 *   C1.2  Escribir una nota (titled `${RUN_ID}-nota`, with one or two
 *         `[[enlaces]]` to topics the graph already has);
 *   C3.2  Publicar mi nota (DocsPanel `publish-<id>`, on main since 9dc40b2);
 *   E1.1  Ver mis temas (the note's topics appear);
 *   C3.3  Publicar los cambios de mi nota (edit, "Publicar cambios");
 *   cleanup: `limpiar(page)` in `finally`.
 * Cost (inferred from 9dc40b2's message): each Publicar ≈ 1 gate run + draft
 * embed + graph windows + publish re-embed, ~$0.002 per document (quoted).
 */
test.fixme('estudiante nota', async () => {
  // TODO(V3-2): implement once "Publicar cambios" is on main.
});
