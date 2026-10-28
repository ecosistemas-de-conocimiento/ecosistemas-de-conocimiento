import { expect, test } from '@playwright/test';
import { soloV3 } from './v3';
import { cerrarSesion, escena, iniciarSesion, instalarSubtitulos, ir } from './escena';

soloV3();

/**
 * V3 (5) — the redesigned /ajustes (design/ajustes), walked as the PLATFORM
 * ADMIN (coordinator ruling 2026-10-28: the only role that sees every tab,
 * the platform-only switches and the answer styles).
 *
 * 🔴 View only. Nothing is saved: switches and style fields are hovered, never
 * toggled or typed into, and no "Guardar" is pressed. Inactive tabs are hidden,
 * so each scene clicks its tab first (`ajustes-tab-<id>`, ids from
 * routes/ajustes/secciones.ts).
 *
 * Ecosistema: Discapacidad (org 7), whose answer style is set (V3 item 4).
 */
const ECO = process.env.EVID_ECOSISTEMA_AJUSTES ?? 'Discapacidad';
const TABS_DE_FUNCIONES = ['conversacion', 'grafo', 'publicacion', 'estudiantes'] as const;

test('admin', async ({ page }) => {
  await instalarSubtitulos(page, 'Administración');
  await iniciarSesion(page, 'admin');
  await ir(page, 'ajustes');
  const eco = page.getByRole('navigation', { name: 'Elegir ecosistema' }).getByRole('link', { name: ECO });
  if (await eco.count()) {
    await eco.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  await escena(page, 'F3.1', async () => {
    for (const id of TABS_DE_FUNCIONES) {
      const tab = page.getByTestId(`ajustes-tab-${id}`);
      if (!(await tab.count())) continue;
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const switches = page.locator(`#panel-${id} [data-testid^="ajustes-switch-"]`);
      for (let i = 0; i < Math.min(await switches.count(), 3); i++) await switches.nth(i).hover();
      await page.waitForTimeout(900);
    }
  });

  await escena(page, 'F3.3', async () => {
    await page.getByTestId('ajustes-tab-estilo').click();
    const estilo = page.getByTestId('ajustes-estilo');
    await expect(estilo).toBeVisible();
    const campos = estilo.locator('[data-testid^="ajustes-estilo-"]');
    for (let i = 0; i < Math.min(await campos.count(), 3); i++) {
      await campos.nth(i).scrollIntoViewIfNeeded();
      await campos.nth(i).hover();
    }
  });

  const plataforma = page.getByTestId('ajustes-plataforma');
  if (await plataforma.count()) {
    await escena(page, 'F3.2', async () => {
      await plataforma.scrollIntoViewIfNeeded();
      await plataforma.locator('select').first().hover();
    });
  }

  await cerrarSesion(page);
});
