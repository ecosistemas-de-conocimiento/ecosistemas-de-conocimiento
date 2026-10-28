import { expect, type Page } from '@playwright/test';
import { RUN_ID, archivoDePrueba, escena, ir } from './escena';

/**
 * Stories every role shares, recorded the same way in every video. Each role's
 * spec strings these together and adds its own screens.
 *
 * Model calls on dev cost money (~$0.004 a chat turn, coordinator's figure
 * 2026-10-27, quoted): a role's run asks at most two questions.
 */

/** Ecosistema to record in (org 6 on dev). Acompañamiento escolar and Traducción en salud are being retired. */
export const ECOSISTEMA = process.env.EVID_ECOSISTEMA ?? 'Prevención del dengue';

export async function elegirEcosistema(page: Page, nombre = ECOSISTEMA): Promise<void> {
  // `?conversaciones`: the full UI even for roles that land on the start screen.
  await page.goto('/?conversaciones');
  await page.waitForLoadState('networkidle');
  // Someone in ONE ecosistema gets a plain label, not a picker: nothing to choose, no story to show.
  const picker = page.locator('button[aria-haspopup="listbox"]').first();
  if (!(await picker.isVisible())) return;
  await escena(page, 'A2.1', async () => {
    await picker.click();
    await page.getByRole('listbox', { name: 'Elige un ecosistema' }).getByRole('option', { name: nombre }).click();
    await page.waitForLoadState('networkidle');
  });
}

const respuestas = (page: Page) => page.getByRole('radiogroup', { name: /Valora esta respuesta/ });

async function preguntar(page: Page, texto: string): Promise<void> {
  const antes = await respuestas(page).count();
  await page.getByTestId('composer-input').fill(texto);
  await page.getByTestId('composer-send').click();
  await expect(respuestas(page)).toHaveCount(antes + 1, { timeout: 180_000 });
}

async function renombrarActiva(page: Page, nombre: string): Promise<void> {
  const fila = page.getByTestId('session-row').filter({ has: page.locator('[aria-current], .active, [data-active="true"]') });
  const objetivo = (await fila.count()) ? fila.first() : page.getByTestId('session-row').first();
  await objetivo.hover();
  await objetivo.getByTestId('session-rename').click();
  const input = page.getByLabel('Nuevo nombre de la conversación');
  await input.fill(nombre);
  await input.press('Enter');
  await expect(page.getByTestId('session-row').filter({ hasText: nombre })).toHaveCount(1);
}

/** Chat, ratings, documents in a conversation, and Resonancias. */
export async function conversar(page: Page, pregunta: string, experiencia: string): Promise<void> {
  // Participante and estudiante land on a start screen (from 5ef35b1); other roles, and older builds, do not.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const iniciar = page.getByTestId('inicio-iniciar');
  let resonanciaHecha = false;
  if (await iniciar.isVisible()) {
    await escena(page, 'B1.0', async () => {
      await expect(iniciar).toBeEnabled();
      await iniciar.click();
      await expect(page.getByTestId('composer-input')).toBeFocused();
    });
    await escena(page, 'B1.4', () => preguntar(page, experiencia));
    await renombrarActiva(page, `${RUN_ID} resonancias`);
    resonanciaHecha = true;
  } else {
    await page.goto('/?conversaciones');
  }

  await escena(page, 'B1.1', async () => {
    await page.getByTestId('session-tab-generales').click();
    await page.getByRole('button', { name: 'Nueva conversación' }).first().click();
  });
  const entrevista = page.getByTestId('chat-entrevista');
  if (await entrevista.isVisible()) {
    await escena(page, 'B1.8', async () => {
      await entrevista.click();
      await expect(entrevista).toHaveAttribute('aria-checked', 'true');
      await page.waitForTimeout(800);
      // Back off: the question below should be answered, not interviewed.
      await entrevista.click();
    });
  }
  await escena(page, 'B1.2', () => preguntar(page, pregunta));
  await escena(page, 'B1.3', async () => {
    const fuentes = page.getByTestId('citation-sources').last();
    if (!(await fuentes.count())) return;
    await fuentes.scrollIntoViewIfNeeded();
    const enlace = fuentes.getByRole('link').first();
    if (!(await enlace.isVisible())) await page.getByText(/Fuentes consultadas/).last().click();
    if (await enlace.isVisible()) await enlace.hover();
  });
  const estrellas = respuestas(page).last();
  await escena(page, 'B2.1', () => estrellas.getByRole('radio').nth(3).click());
  await escena(page, 'B2.2', async () => {
    await page.locator('[data-testid^="message-reasons-"] button').first().click();
  });
  await escena(page, 'B2.3', () => page.locator('[data-testid^="message-unrate-"]').last().click());
  await escena(page, 'B1.5', () => renombrarActiva(page, `${RUN_ID} generales`));

  await escena(page, 'C1.1', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Subir documento/ }).first().click();
    await (await chooser).setFiles(archivoDePrueba('documento'));
    await expect
      .poll(() => page.getByLabel('Título del documento').evaluateAll((els, run) => els.some((e) => (e as HTMLInputElement).value.includes(run)), RUN_ID), { timeout: 60_000 })
      .toBe(true);
  });
  await escena(page, 'C2.4', async () => {
    await page.locator('label', { hasText: 'fijar' }).first().locator('input[type=checkbox]').check();
  });
  await escena(page, 'C1.2', async () => {
    await page.getByRole('button', { name: 'Nueva nota' }).first().click();
    await page.getByLabel('Contenido del documento').fill('Ideas para el círculo de lectura:\n\n- Leer en voz alta\n- Invitar a las abuelas');
    const titulo = page.getByLabel('Título del documento').last();
    await titulo.fill(`${RUN_ID}-nota`);
    await titulo.press('Enter');
  });

  if (!resonanciaHecha) {
    await escena(page, 'B1.4', async () => {
      await page.getByTestId('session-tab-resonancias').click();
      await page.getByRole('button', { name: 'Nueva conversación' }).first().click();
      await preguntar(page, experiencia);
    });
    await renombrarActiva(page, `${RUN_ID} resonancias`);
  }
}

/** Mis documentos, from the menu. Returns the uploaded document's row. */
export async function misDocumentos(page: Page): Promise<void> {
  await escena(page, 'A2.2', () => ir(page, 'documentos'));
  await escena(page, 'C2.1', async () => {
    await expect(page.locator('[data-testid^="owned-doc-"]', { hasText: RUN_ID }).first()).toBeVisible();
  });
  await escena(page, 'C2.2', async () => {
    await page.getByTestId('filter-sueltos').click();
    await page.waitForTimeout(800);
    await page.getByTestId('filter-all').click();
  });
  const fila = page.locator('[data-testid^="owned-doc-"]', { hasText: `${RUN_ID}-documento` }).first();
  const id = (await fila.getAttribute('data-testid'))!.replace('owned-doc-', '');
  await escena(page, 'C2.3', async () => {
    await page.getByTestId(`use-${id}`).click();
    const picker = page.getByTestId(`picker-${id}`);
    const opcion = picker.locator('option', { hasText: `${RUN_ID} resonancias` });
    await picker.selectOption({ label: (await opcion.textContent())!.trim() });
    await page.getByTestId(`attach-${id}`).click();
  });
  // Only an uploaded file has an original to download; markdown notes may not.
  if (await page.getByTestId(`download-${id}`).count()) await escena(page, 'C2.5', async () => {
    const descarga = page.waitForEvent('download');
    await page.getByTestId(`download-${id}`).click();
    await descarga;
  });
}

export async function biblioteca(page: Page, busqueda = 'escuela'): Promise<void> {
  await ir(page, 'biblioteca');
  await escena(page, 'D1.1', async () => {
    await page.getByTestId('library-search').fill(busqueda);
    await page.getByTestId('library-search').press('Enter');
    await page.waitForLoadState('networkidle');
  });
  await escena(page, 'D1.2', async () => {
    await page.locator('[data-testid^="library-filter-"]').nth(1).click();
    await page.waitForLoadState('networkidle');
  });
  await escena(page, 'D1.3', async () => {
    await page.locator('[data-testid^="library-filter-"]').first().click();
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid^="library-item-"]').first().click();
    await expect(page.getByTestId('library-document-text')).toBeVisible();
    await page.mouse.wheel(0, 500);
  });
}

export async function conexiones(page: Page, busqueda = 'escuela'): Promise<void> {
  const mapa = page.getByTestId('grafo-mapa');
  const listo = mapa.or(page.getByTestId('grafo-vacio')).or(page.getByTestId('grafo-desactivado')).first();
  await escena(page, 'D2.1', async () => {
    await ir(page, 'grafo');
    // ⚠ Measured on dev 2026-10-27 (org 6, during an ingest run): /grafo
    // intermittently rendered a 500 or a blank page, then loaded on retry.
    for (let intento = 0; intento < 3; intento++) {
      try {
        await expect(listo).toBeVisible({ timeout: 45_000 });
        return;
      } catch {
        await page.reload();
      }
    }
    await expect(listo).toBeVisible({ timeout: 45_000 });
  });
  // An ecosistema with no graph yet (or the switch off) shows its empty state; the rest needs a map.
  if (!(await mapa.count())) return;
  if (await page.getByTestId('grafo-3d').count()) {
    await escena(page, 'D2.2', async () => {
      await page.getByTestId('grafo-3d').click();
      await page.waitForTimeout(3000);
      await page.getByRole('button', { name: '2D', exact: true }).click();
    });
  }
  await escena(page, 'D2.3', () => page.getByTestId('grafo-busqueda').fill(busqueda));
  const entidad = page.locator('[data-testid^="grafo-entidad-"]').first();
  if (await entidad.count()) {
    await escena(page, 'D2.4', async () => {
      await entidad.click();
      const vecino = page.locator('[data-testid^="grafo-vecino-"]').first();
      if (await vecino.count()) await vecino.click();
    });
  }
}

/** Anything an evidence run made: this run's, and any earlier run's that died before cleanup. */
const SOBRAS = /evid-\d{13}/;

/** The run's own cleanup, recorded as the delete stories. */
export async function limpiar(page: Page): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await escena(page, 'C2.6', async () => {
    // By address, not the menu: cleanup must work from whatever page a failure left behind.
    await page.goto('/documentos');
    const filas = page.locator('[data-testid^="owned-doc-"]', { hasText: SOBRAS });
    // The list fills in after load: wait for a row or the empty state before counting.
    await expect(page.locator('[data-testid^="owned-doc-"]').or(page.getByText('Todavía no has subido')).first()).toBeVisible();
    // ⚠ Measured on dev 2026-10-27: a delete answers 200 but the row can stay on
    // screen until a reload. Trust the server, not the optimistic list.
    for (let guard = 0; (await filas.count()) && guard < 20; guard++) {
      const id = (await filas.first().getAttribute('data-testid'))!.replace('owned-doc-', '');
      const borrado = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/api/documents/${id}`));
      await page.getByTestId(`delete-${id}`).click();
      expect((await borrado).ok()).toBe(true);
      await page.reload();
      await page.waitForLoadState('networkidle');
    }
    await expect(filas).toHaveCount(0);
  });
  await escena(page, 'B1.6', async () => {
    await page.goto('/?conversaciones');
    await page.waitForLoadState('networkidle');
    for (const tab of ['generales', 'resonancias']) {
      await page.getByTestId(`session-tab-${tab}`).click();
      // The list fills in after the tab switch; counting before it does reads 0.
      await expect(page.getByTestId('session-row').first()).toBeVisible().catch(() => {});
      const filas = page.getByTestId('session-row').filter({ hasText: SOBRAS });
      while (await filas.count()) {
        const antes = await filas.count();
        await filas.first().hover();
        await filas.first().getByTestId('session-delete').click();
        await page.getByTestId('session-delete-confirm').click();
        await expect(filas).toHaveCount(antes - 1);
      }
    }
  });
}

/** Scroll a section into the frame and give it a moment on screen. */
async function mostrar(page: Page, testid: string): Promise<void> {
  const el = page.getByTestId(testid);
  if (await el.count()) await el.first().scrollIntoViewIfNeeded();
}

/** Mi investigación (estudiante). The suggestion is written, not sent: it would reach the teachers' list. */
export async function miInvestigacion(page: Page): Promise<void> {
  await escena(page, 'E1.1', async () => {
    await ir(page, 'estudiante');
    await mostrar(page, 'mis-temas');
  });
  await escena(page, 'E1.2', async () => {
    await page.getByTestId('preguntas-generar').click();
    await expect(page.getByTestId('preguntas').or(page.getByTestId('estudiante-error')).first()).toBeVisible({ timeout: 120_000 });
    await mostrar(page, 'preguntas');
  });
  await escena(page, 'E1.3', () => mostrar(page, 'companeros'));
  await escena(page, 'E1.4', () => mostrar(page, 'mis-autores'));
  await escena(page, 'E1.5', async () => {
    await mostrar(page, 'sugerir');
    await page.getByLabel('Sugerencia').fill('Me gustaría ver los autores agrupados por tema.');
  });
  await escena(page, 'E1.6', async () => {
    await mostrar(page, 'share-activity');
    await page.getByTestId('share-activity').hover();
  });
}

/** Estudiantes (investigador / responsable). Read-only. */
export async function seguimiento(page: Page): Promise<void> {
  await escena(page, 'E2.1', async () => {
    await ir(page, 'seguimiento');
    const chip = page.getByTestId('estudiantes').getByRole('link').first();
    if (await chip.count()) {
      await chip.click();
      await page.waitForLoadState('networkidle');
    }
    await mostrar(page, 'reporte');
  });
  await escena(page, 'E2.2', () => mostrar(page, 'sugerencias'));
}

/**
 * Revisión, Miembros, Ajustes, Administración. 🔴 Shown, never decided: no hold
 * is approved or rejected, no member added or re-roled, no switch saved.
 */
export async function cuidar(page: Page, opciones: { cambiarEcosistema?: string } = {}): Promise<void> {
  await escena(page, 'F1.1', async () => {
    await ir(page, 'revision');
    await mostrar(page, 'hold-queue');
  });
  const hold = page.locator('a[href^="/revision/"]').first();
  if (await hold.count()) {
    await escena(page, 'F1.2', async () => {
      await hold.click();
      await expect(page.getByTestId('hold-text').or(page.getByTestId('hold-no-text')).first()).toBeVisible();
      await page.mouse.wheel(0, 400);
    });
    await escena(page, 'F1.3', () => page.getByTestId('hold-approve').hover());
    await page.goBack();
  }
  const retirar = page.locator('[data-testid^="reject-published-"]').first();
  if (await retirar.count()) {
    await escena(page, 'F1.4', async () => {
      await retirar.scrollIntoViewIfNeeded();
      await retirar.hover();
    });
  }

  await escena(page, 'F2.1', async () => {
    await ir(page, 'miembros');
    await mostrar(page, 'miembros-list');
  });
  await escena(page, 'F2.2', async () => {
    const form = page.getByTestId('miembros-add');
    await form.scrollIntoViewIfNeeded();
    await form.locator('input[name="email"]').fill(`${RUN_ID}@ejemplo.test`);
    await form.locator('input[name="name"]').fill('Persona de ejemplo');
    await form.locator('input[name="email"]').fill('');
    await form.locator('input[name="name"]').fill('');
  });
  await escena(page, 'F2.3', async () => {
    await page.getByTestId('miembros-list').locator('select').first().hover();
  });

  await escena(page, 'F3.1', async () => {
    await ir(page, 'ajustes');
    await mostrar(page, 'ajustes-funciones');
    const switches = page.getByTestId('ajustes-funciones').locator('input[type=checkbox]');
    for (let i = 0; i < Math.min(await switches.count(), 4); i++) await switches.nth(i).hover();
  });
  if (await page.getByTestId('ajustes-plataforma').count()) {
    await escena(page, 'F3.2', async () => {
      await mostrar(page, 'ajustes-plataforma');
      await page.getByTestId('ajustes-plataforma').locator('select').hover();
    });
  }

  await escena(page, 'F4.1', () => ir(page, 'admin'));
  if (opciones.cambiarEcosistema) {
    await escena(page, 'F4.2', async () => {
      const buscar = page.getByPlaceholder('Buscar por nombre o clave…');
      if (!(await buscar.isVisible())) await page.getByRole('button', { name: /ecosistema/i }).first().click();
      await buscar.fill(opciones.cambiarEcosistema!);
      await buscar.press('Enter');
      await page.waitForLoadState('networkidle');
    });
  }
  await escena(page, 'F4.3', async () => {
    await page.getByText('Quién ha aportado').first().scrollIntoViewIfNeeded();
  });
  await escena(page, 'F4.4', async () => {
    const tipos = page.getByRole('group', { name: 'Filtrar por tipo' });
    await tipos.scrollIntoViewIfNeeded();
    await tipos.getByRole('button').nth(1).click();
    await page.waitForTimeout(1000);
    await tipos.getByRole('button').first().click();
  });
}
