import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { RUN_ID, abrirPanel, archivoDePrueba, cerrarPanel, escena, ir } from './escena';

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
  // On a phone the picker lives in the conversations drawer.
  const picker = page.locator('button[aria-haspopup="listbox"]').first();
  if (!(await picker.count())) return;
  await escena(page, 'A2.1', async () => {
    await abrirPanel(page, 'conversations');
    await picker.click();
    await page.getByRole('listbox', { name: 'Elige un ecosistema' }).getByRole('option', { name: nombre }).click();
    await page.waitForLoadState('networkidle');
    await cerrarPanel(page);
  });
}

export const respuestas = (page: Page) => page.getByRole('radiogroup', { name: /Valora esta respuesta/ });

export async function preguntar(page: Page, texto: string): Promise<void> {
  const antes = await respuestas(page).count();
  await page.getByTestId('composer-input').fill(texto);
  await page.getByTestId('composer-send').click();
  await expect(respuestas(page)).toHaveCount(antes + 1, { timeout: 180_000 });
}

export async function renombrarActiva(page: Page, nombre: string): Promise<void> {
  await abrirPanel(page, 'conversations');
  const fila = page.getByTestId('session-row').filter({ has: page.locator('[aria-current], .active, [data-active="true"]') });
  const objetivo = (await fila.count()) ? fila.first() : page.getByTestId('session-row').first();
  await objetivo.hover();
  await objetivo.getByTestId('session-rename').click();
  const input = page.getByLabel('Nuevo nombre de la conversación');
  await input.fill(nombre);
  await input.press('Enter');
  await expect(page.getByTestId('session-row').filter({ hasText: nombre })).toHaveCount(1);
  await cerrarPanel(page);
}

/** The last answer's sources, opened, with the pointer on the first one. No-op without sources. */
export async function leerFuentes(page: Page): Promise<void> {
  const fuentes = page.getByTestId('citation-sources').last();
  if (!(await fuentes.count())) return;
  await fuentes.scrollIntoViewIfNeeded();
  // The list starts collapsed (chat-engine CitationCard): open it so the
  // sources' titles are on screen, then point at the first one.
  const abrir = fuentes.getByTestId('citation-sources-toggle');
  if ((await abrir.count()) && (await abrir.getAttribute('aria-expanded')) !== 'true') await abrir.click();
  await fuentes.scrollIntoViewIfNeeded();
  // Each source's title is a button that opens its card; the card holds the
  // "Abrir documento" link (the list's own link is hidden: Message.svelte).
  const fuente = fuentes.getByTestId('citation-source-link').first();
  await expect(fuente).toBeVisible();
  await fuente.hover();
  const abrirDoc = page.getByTestId('citation-cards').last().getByTestId('citation-open').first();
  console.log(
    `[fuentes] ${await fuentes.getByTestId('citation-source').count()} fuentes, ` +
      `${await page.getByTestId('citation-cards').last().getByTestId('citation-open').count()} con enlace`,
  );
  if (await abrirDoc.isVisible()) await abrirDoc.hover();
}

/** Chat, ratings, documents in a conversation, and Resonancias. */
export async function conversar(page: Page, pregunta: string, experiencia: string): Promise<void> {
  // Participante and estudiante land on a start screen; other roles, and older builds, do not.
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
    await abrirPanel(page, 'conversations');
    await page.getByTestId('session-tab-generales').click();
    await page.getByRole('button', { name: 'Nueva conversación' }).first().click();
    await cerrarPanel(page);
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
  await escena(page, 'B1.3', () => leerFuentes(page));
  const estrellas = respuestas(page).last();
  await escena(page, 'B2.1', () => estrellas.getByRole('radio').nth(3).click());
  await escena(page, 'B2.2', async () => {
    await page.locator('[data-testid^="message-reasons-"] button').first().click();
  });
  await escena(page, 'B2.3', () => page.locator('[data-testid^="message-unrate-"]').last().click());
  await escena(page, 'B1.5', () => renombrarActiva(page, `${RUN_ID} generales`));

  await escena(page, 'C1.1', async () => {
    await abrirPanel(page, 'documents');
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
    // fix/markdown-rendering: a note may open on its preview; open the editor first.
    const editar = page.locator('[data-testid^="note-edit-open-"]').last();
    if (await editar.isVisible().catch(() => false)) await editar.click();
    await page.getByLabel('Contenido del documento').fill('Ideas para la faena de limpieza:\n\n- Revisar patios y azoteas\n- Tapar tambos y cubetas');
    const titulo = page.getByLabel('Título del documento').last();
    await titulo.fill(`${RUN_ID}-nota`);
    await titulo.press('Enter');
  });
  await cerrarPanel(page);

  if (!resonanciaHecha) {
    await escena(page, 'B1.4', async () => {
      await abrirPanel(page, 'conversations');
      await page.getByTestId('session-tab-resonancias').click();
      await page.getByRole('button', { name: 'Nueva conversación' }).first().click();
      await cerrarPanel(page);
      await preguntar(page, experiencia);
    });
    await renombrarActiva(page, `${RUN_ID} resonancias`);
  }
}

/**
 * The corpus recording the journey suite uploads (`apps/web/e2e/fixtures`,
 * built by `scripts/corpus-fixtures.sh`, gitignored). `correr.sh` passes the
 * MAIN checkout's folder as EVID_FIXTURES_DIR: a worktree has no copy.
 */
function audioDePrueba(): { name: string; mimeType: string; buffer: Buffer } {
  const dir = process.env.EVID_FIXTURES_DIR ?? join(import.meta.dirname, '../fixtures');
  const { audio } = JSON.parse(readFileSync(join(dir, 'fixtures.json'), 'utf8')) as {
    audio: { file: string; mimeType: string };
  };
  return { name: `${RUN_ID}-audio${extname(audio.file)}`, mimeType: audio.mimeType, buffer: readFileSync(join(dir, audio.file)) };
}

/** Audio documents this run uploaded, by id. Cleanup checks they are gone. */
const audiosDeLaCorrida = new Set<string>();

/** The next upload into a conversation; its id is kept for cleanup the moment it answers. */
async function esperarSubida(page: Page, accion: () => Promise<void>): Promise<string> {
  const respuesta = page.waitForResponse(
    (r: Response) => /\/api\/sessions\/[^/]+\/documents$/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await accion();
  const res = await respuesta;
  expect(res.ok(), `subida de audio: HTTP ${res.status()}`).toBe(true);
  const id = String(((await res.json()) as { doc: { id: string | number } }).doc.id);
  audiosDeLaCorrida.add(id);
  return id;
}

/** One card in the documents drawer, by document id (`detach-<id>` is on every attached card). */
export function tarjeta(page: Page, id: string): Locator {
  return page
    .getByTestId('panel-documents')
    .locator('div.bg-surface-strong.shadow-1')
    .filter({ has: page.getByTestId(`detach-${id}`) });
}

/**
 * Wait until the card's ingest chip says `done`, logging every state it passes
 * through with the elapsed time (the run's own measure of the pipeline).
 */
export async function seguirChip(card: Locator, done: RegExp, etiqueta: string, timeoutMs = 8 * 60_000): Promise<string> {
  const chip = card.locator('.chip.ingest-pending, .chip.ingest-ready, .chip.ingest-failed');
  const t0 = Date.now();
  let ultimo = '';
  while (Date.now() - t0 < timeoutMs) {
    const texto = (await chip.count()) ? ((await chip.first().textContent()) ?? '').trim() : '';
    if (texto && texto !== ultimo) {
      console.log(`[${etiqueta}] +${Math.round((Date.now() - t0) / 1000)}s → ${texto}`);
      ultimo = texto;
    }
    if (/^error/i.test(texto)) throw new Error(`${etiqueta}: la ingesta falló (${((await card.textContent()) ?? '').replace(/\s+/g, ' ')})`);
    if (done.test(texto)) return texto;
    await card.page().waitForTimeout(500);
  }
  throw new Error(`${etiqueta}: el chip no llegó a ${done} en ${timeoutMs / 1000}s (último: ${ultimo || 'ninguno'})`);
}

/**
 * Audio, in the conversation `conversar` left open (the renamed `generales`):
 * upload a recording, show its transcript corrected (not saved), then dictate.
 *
 * ⚠ The mic is Chromium's fake capture device playing a WAV (`movil` project
 * in the config). ⚠ A participant's audio is filed as a `testimonio` and may
 * auto-publish once the gate clears it (owner decision 2026-10-28); cleanup
 * deletes it with the rest.
 */
export async function audio(page: Page): Promise<void> {
  let id = '';
  await escena(page, 'C1.3', async () => {
    await abrirPanel(page, 'documents');
    id = await esperarSubida(page, async () => {
      const chooser = page.waitForEvent('filechooser');
      // The name says audio upload is on for this ecosistema.
      await page.getByRole('button', { name: 'Subir documento o audio' }).first().click();
      await (await chooser).setFiles(audioDePrueba());
    });
    const card = tarjeta(page, id);
    await card.scrollIntoViewIfNeeded();
    // A transcript exists from `transcrito` on; `en revisión` is a held draft.
    await seguirChip(card, /^(transcrito|listo|en revisión)/i, 'audio-subido');
  });

  await escena(page, 'C1.4', async () => {
    const card = tarjeta(page, id);
    const abrir = card.getByRole('button', { name: 'Mostrar u ocultar el documento' });
    if ((await abrir.getAttribute('aria-expanded')) !== 'true') await abrir.click();
    await card.getByTestId(`transcript-tab-${id}`).click();
    await expect(card.getByTestId(`transcript-text-${id}`)).toBeVisible();
    await card.getByTestId(`transcript-text-${id}`).scrollIntoViewIfNeeded();
    // 🔴 Shown, not saved. A participant's recording auto-publishes the moment
    // its ingest lands, and only a draft transcript may change: the save
    // answered 409 `already_published` (dev, 2026-10-28, doc 1017, ~37 s after
    // upload). The UI still offered the button, its 30 s poll not yet caught up.
    const corregir = card.getByTestId(`edit-transcript-${id}`);
    if (!(await corregir.isVisible())) return;
    await corregir.click();
    const editor = card.getByTestId(`transcript-editor-${id}`);
    // One word: the speaker's town, written out in full (SIM_0015 opens in Juchitán).
    const texto = await editor.inputValue();
    const m = /juchit[aá]n/i.exec(texto) ?? /\p{L}{5,}/u.exec(texto)!;
    const nueva = /juchit/i.test(m[0]) ? 'Juchitán de Zaragoza' : m[0].toUpperCase();
    await editor.evaluate((el, [a, b]) => (el as HTMLTextAreaElement).setSelectionRange(a, b), [m.index, m.index + m[0].length]);
    await editor.focus();
    await page.keyboard.type(nueva, { delay: 60 });
    await card.getByTestId(`save-transcript-${id}`).hover();
    await page.waitForTimeout(1200);
    await card.getByRole('button', { name: 'Cancelar', exact: true }).click();
  });
  await cerrarPanel(page);

  await escena(page, 'B3.1', async () => {
    const vivo = page.getByTestId('live-text');
    const grabacion = await esperarSubida(page, async () => {
      await page.getByTestId('mic-start').click();
      await expect(page.getByTestId('mic-clock')).toBeVisible();
      // A real word, not the '…' placeholder (`MicButton` shows it until the first slice).
      await expect(vivo).toHaveText(/\p{L}{4,}/u, { timeout: 30_000 });
      await page.waitForTimeout(10_000);
      await page.getByTestId('mic-stop').click();
      await expect(vivo).toHaveCount(0);
      // The last live line lands in the composer, ready to send (not sent: no model call).
      await expect(page.getByTestId('composer-input')).toHaveValue(/\p{L}{4,}/u);
    });
    await abrirPanel(page, 'documents');
    const card = tarjeta(page, grabacion);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await seguirChip(card, /./, 'grabacion', 60_000);
  });
  await cerrarPanel(page);
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
  // The document's own anonymisation screen. 🔴 Shown, not saved: no switch is
  // toggled (a change re-runs the gate on the document).
  await escena(page, 'C1.6', async () => {
    await page.getByTestId(`anon-link-${id}`).click();
    await page.waitForURL((u) => u.pathname === `/documentos/${id}/anonimizacion`);
    await expect(page.getByTestId('anon-title')).toBeVisible();
    await expect(page.getByTestId('anon-status')).toBeVisible();
    const switches = page.getByTestId('anon-form').locator('[data-testid^="anon-switch-"]');
    await expect(switches.first()).toBeVisible();
    for (let i = 0; i < (await switches.count()); i++) await switches.nth(i).hover();
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/documentos');
  });
}

export async function biblioteca(page: Page, busqueda: string): Promise<void> {
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

/** D2.1: Conexiones from the menu, until the map (or its empty state) is on screen. */
export async function abrirConexiones(page: Page): Promise<void> {
  const listo = page.getByTestId('grafo-mapa').or(page.getByTestId('grafo-vacio')).or(page.getByTestId('grafo-desactivado')).first();
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
}

export async function conexiones(page: Page, busqueda: string): Promise<void> {
  const mapa = page.getByTestId('grafo-mapa');
  await abrirConexiones(page);
  // An ecosistema with no graph yet (or the switch off) shows its empty state; the rest needs a map.
  console.log(`[grafo] mapa: ${await mapa.count()}, vacío: ${await page.getByTestId('grafo-vacio').count()}, apagado: ${await page.getByTestId('grafo-desactivado').count()}`);
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
  console.log(`[grafo] entidades tras buscar "${busqueda}": ${await page.locator('[data-testid^="grafo-entidad-"]').count()}`);
  if (await entidad.count()) {
    await escena(page, 'D2.4', async () => {
      await entidad.click();
      const vecino = page.locator('[data-testid^="grafo-vecino-"]').first();
      if (await vecino.count()) await vecino.click();
    });
  }
}

/**
 * Anything an evidence run made: this run's, and any earlier run's that died
 * before cleanup. On /documentos it also matches a document by the conversation
 * it is used in ("Se usa en: evid-… generales"): that is how the audio uploads,
 * whose titles the system writes, are found. Only an evidence run makes those
 * conversations.
 */
const SOBRAS = /evid-\d{13}/;

/**
 * Conversations a run made but never renamed (it failed before B1.5) keep the
 * spec's first message as their title. Only conversations match this, never
 * documents, and only in the evidence accounts' own lists: the same question
 * typed by a real person in another account is out of reach.
 */
const CONVERSACIONES_SOBRANTES = new RegExp(
  [
    SOBRAS.source,
    '^¿Qué hacen las familias para acompañar',
    '^¿Qué hacen los vecinos para eliminar criaderos',
    '^¿Cómo se organizó el comité contra el dengue',
    '^¿Qué iniciativas comunitarias aparecen',
    '^¿Qué colonia tuvo más casos confirmados',
    '^En mi colonia (hacemos un círculo|los sábados revisamos)',
  ].join('|'),
);

/**
 * The run's own cleanup, recorded as the delete stories. `documentos: false`
 * for a run that uploads nothing (V3 investigador, Discapacidad): no
 * "Eliminar un documento." caption over an empty list.
 */
export async function limpiar(page: Page, opciones: { documentos?: boolean } = {}): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  if (opciones.documentos !== false) await escena(page, 'C2.6', async () => {
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
    // The audio uploads carry a generated title, not the run id: they matched
    // above through "Se usa en: evid-… generales" on their row. Check by id.
    for (const id of audiosDeLaCorrida) await expect(page.getByTestId(`owned-doc-${id}`)).toHaveCount(0);
  });
  await escena(page, 'B1.6', async () => {
    await page.goto('/?conversaciones');
    await page.waitForLoadState('networkidle');
    await abrirPanel(page, 'conversations');
    for (const tab of ['generales', 'resonancias']) {
      await page.getByTestId(`session-tab-${tab}`).click();
      // The list fills in after the tab switch; counting before it does reads 0.
      await expect(page.getByTestId('session-row').first()).toBeVisible().catch(() => {});
      const filas = page.getByTestId('session-row').filter({ hasText: CONVERSACIONES_SOBRANTES });
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
  /**
   * The redesigned view (design/estudiante) puts Compañeros, Autores, Sugerir
   * and Privacidad behind tabs and hides the inactive panels. Click the tab
   * when it exists; the older single-page view has none.
   */
  const pestana = async (id: string) => {
    const tab = page.getByTestId(`tab-${id}`);
    if (await tab.count()) await tab.click();
  };
  await escena(page, 'E1.1', async () => {
    await ir(page, 'estudiante');
    await mostrar(page, 'mis-temas');
  });
  await escena(page, 'E1.2', async () => {
    await page.getByTestId('preguntas-generar').click();
    await expect(page.getByTestId('preguntas').or(page.getByTestId('estudiante-error')).first()).toBeVisible({ timeout: 120_000 });
    await mostrar(page, 'preguntas');
  });
  await escena(page, 'E1.3', async () => {
    await pestana('companeros');
    await mostrar(page, 'companeros');
  });
  await escena(page, 'E1.4', async () => {
    await pestana('autores');
    await mostrar(page, 'mis-autores');
  });
  await escena(page, 'E1.5', async () => {
    await pestana('sugerir');
    await mostrar(page, 'sugerir');
    await page.getByLabel('Sugerencia').fill('Me gustaría ver los autores agrupados por tema.');
  });
  await escena(page, 'E1.6', async () => {
    await pestana('privacidad');
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
export async function cuidar(
  page: Page,
  opciones: { cambiarEcosistema?: string; colasDeRevision?: readonly string[] } = {},
): Promise<void> {
  await escena(page, 'F1.1', async () => {
    await ir(page, 'revision');
    await mostrar(page, 'hold-queue');
  });
  /**
   * 🔴 The queue only, never a held document's text. Each card already says
   * why the gate stopped it ("quedaron N datos que podrían identificar a
   * alguien"); opening it would put the very data it flagged on screen
   * (coordinator ruling 2026-10-28). Cards are hovered, never clicked, so no
   * decision is ever one tap away. `colasDeRevision`: other ecosistemas'
   * queues to show, by the name on the switcher.
   */
  const tarjetas = async () => {
    const cards = page.getByTestId('hold-queue').locator('a[href^="/revision/"]');
    for (let i = 0; i < Math.min(await cards.count(), 3); i++) await cards.nth(i).hover();
  };
  console.log(`[revision] tarjetas en la cola: ${await page.getByTestId('hold-queue').locator('a[href^="/revision/"]').count()}`);
  if (await page.getByTestId('hold-queue').locator('a[href^="/revision/"]').count()) {
    await escena(page, 'F1.2', tarjetas);
  }
  for (const nombre of opciones.colasDeRevision ?? []) {
    const chip = page.getByRole('navigation', { name: 'Elegir ecosistema' }).getByRole('link', { name: nombre });
    if (!(await chip.count())) continue;
    await escena(page, 'F1.2', async () => {
      await chip.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await mostrar(page, 'hold-queue');
      await tarjetas();
    });
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

  // /ajustes is tabbed (routes/ajustes/secciones.ts): inactive panels are
  // hidden, so each tab is opened first. Publicación holds the ecosistema's
  // anonymisation defaults. Hovered, never toggled.
  await escena(page, 'F3.1', async () => {
    await ir(page, 'ajustes');
    await mostrar(page, 'ajustes-funciones');
    for (const tabId of ['conversacion', 'grafo', 'publicacion', 'estudiantes']) {
      const tab = page.getByTestId(`ajustes-tab-${tabId}`);
      if (!(await tab.count())) continue;
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const switches = page.locator(`#panel-${tabId} [data-testid^="ajustes-switch-"]`).filter({ visible: true });
      await expect(switches.first()).toBeVisible();
      for (let i = 0; i < Math.min(await switches.count(), 5); i++) await switches.nth(i).hover();
    }
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
