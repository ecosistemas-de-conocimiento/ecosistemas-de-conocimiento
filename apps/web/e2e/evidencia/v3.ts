import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import { abrirConexiones, leerFuentes, preguntar, renombrarActiva, seguirChip, tarjeta } from './comun';
import { RUN_ID, abrirPanel, cerrarPanel, escena } from './escena';
import { consentInPanel } from '../consent';

/**
 * The V3 stories (owner plan via coordinator, 2026-10-28). Each `*.v3.spec.ts`
 * strings these together; V1/V2 specs skip themselves under `EVID_VIDEO=v3`
 * and the V3 specs skip under anything else (`soloV3` / `nuncaEnV3`).
 *
 * Model calls on dev cost money (quoted, coordinator 2026-10-27/28): a chat
 * turn ~$0.004, an upload through the gate and the graph ~$0.002.
 */

export const ES_V3 = process.env.EVID_VIDEO === 'v3';

/** Call at the top of a V3 spec file: its tests run only when recording V3. */
export function soloV3(): void {
  test.skip(!ES_V3, 'solo con EVID_VIDEO=v3');
}

/** Call at the top of a V1/V2 spec file: a V3 run records only the V3 videos. */
export function nuncaEnV3(): void {
  test.skip(ES_V3, 'EVID_VIDEO=v3 graba los *.v3.spec.ts');
}

/** A new conversation in one tab (B1.1's steps, no caption of its own). */
export async function nuevaConversacion(page: Page, tab: 'generales' | 'resonancias'): Promise<void> {
  await abrirPanel(page, 'conversations');
  await page.getByTestId(`session-tab-${tab}`).click();
  await page.getByRole('button', { name: 'Nueva conversación' }).first().click();
  await cerrarPanel(page);
}

/**
 * The answer just given, read from its top: the question scrolled to the top
 * of the chat, a pause, then down to the rating row under the answer.
 * Cosmetic: a miss here never fails the run.
 */
export async function leerRespuesta(page: Page, pregunta: string): Promise<void> {
  await page
    .getByText(pregunta, { exact: true })
    .last()
    .evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    .catch(() => {});
  await page.waitForTimeout(2500);
  await page
    .getByRole('radiogroup', { name: /Valora esta respuesta/ })
    .last()
    .evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'smooth' }))
    .catch(() => {});
}

// ── (1) Conexiones in Semiosis práctica ────────────────────────────────────

/**
 * The count line, a topic's panel, and a connection a note's `[[enlace]]` made.
 *
 * ⚠ The UI has NO marker for a wikilink edge. A seed is one `relacionado_con`
 * edge from the note's title to each link target (backend
 * `lib/graph/wikilinks.ts`), read in the panel as "se relaciona con"
 * (apps/web `lib/graph.ts` relationLabel), and the model writes that type too.
 * So the pair is PINNED when the coordinator has one from dev:
 *   EVID_V3_TEMA    label of the topic to open (the note's title)
 *   EVID_V3_VECINO  label of the neighbour (the link target)
 *   EVID_V3_TEMA_ID optional: the topic's entity id, opened by URL (beyond the 1,500 cap)
 * Without them: the first topic, and its first "se relaciona con" neighbour.
 */
export async function conexionesV3(page: Page): Promise<void> {
  const mapa = page.getByTestId('grafo-mapa');
  await abrirConexiones(page);
  if (!(await mapa.count())) throw new Error('Conexiones no mostró el mapa: sin grafo o apagado en este ecosistema');

  await escena(page, 'D2.5', async () => {
    const conteo = page.getByTestId('grafo-conteo');
    await conteo.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    // "1,500 de 2,345 entidades" when capped, "84 entidades" when not.
    await expect(conteo).toHaveText(/^[\d,]+ (de [\d,]+ )?entidad(es)?$/);
    console.log(`[conexiones] conteo: ${(await conteo.textContent())?.trim()}`);
  });

  const temaFijo = process.env.EVID_V3_TEMA?.trim();
  const vecinoFijo = process.env.EVID_V3_VECINO?.trim();
  if (!temaFijo || !vecinoFijo) {
    console.warn('[conexiones] EVID_V3_TEMA / EVID_V3_VECINO sin definir: la conexión mostrada puede no venir de un [[enlace]]');
  }
  // The search box exists only with GRAPH_SEARCH_ENABLED (routes/grafo/+page.svelte).
  if (temaFijo && (await page.getByTestId('grafo-busqueda').count())) {
    await escena(page, 'D2.3', () => page.getByTestId('grafo-busqueda').fill(temaFijo));
  }

  let etiqueta = '';
  await escena(page, 'D2.6', async () => {
    const temas = page.locator('section[aria-labelledby="grafo-lista-tema"] [data-testid^="grafo-entidad-"]');
    const tema = temaFijo
      ? page.locator('[data-testid^="grafo-entidad-"]').filter({
          has: page.locator('.row-label', { hasText: new RegExp(`^${escaparRegex(temaFijo)}$`, 'i') }),
        }).first()
      : temas.first();
    // A list shows 12 rows, then "Mostrar N más" (EntityLists.svelte PREVIEW).
    if (temaFijo && !(await tema.isVisible())) {
      const mas = page.locator('section[aria-labelledby="grafo-lista-tema"]').getByRole('button', { name: /^Mostrar \d+ más$/ });
      if (await mas.count()) await mas.click();
    }
    // ⚠ A new entity (the student note's title) can sit outside the view's 1,500
    // cap; /grafo?eco=&entidad= loads it directly (grafo/+page.server.ts,
    // fetchGraphEntity). EVID_V3_TEMA_ID: its id, read by the coordinator.
    const temaId = process.env.EVID_V3_TEMA_ID?.trim();
    if (temaId && temaFijo) {
      const eco = new URL(page.url()).searchParams.get('eco') ?? process.env.EVID_V3_ECO_ID ?? '8';
      await page.goto(`/grafo?eco=${eco}&entidad=${temaId}`);
      etiqueta = temaFijo;
    } else {
      await expect(tema).toBeVisible();
      etiqueta = ((await tema.locator('.row-label').textContent()) ?? '').trim();
      await tema.click();
    }
    // The panel opens beside the map with the topic's name as its heading (EntityPanel.svelte).
    await expect(page.getByRole('heading', { level: 2, name: etiqueta, exact: true })).toBeVisible();
    await page.locator('.col-panel').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    console.log(`[conexiones] tema: ${etiqueta}`);
  });

  const vecinos = page.locator('[data-testid^="grafo-vecino-"]');
  const vecino = vecinos
    .filter({ has: page.locator('.rel', { hasText: /^se relaciona con$/ }) })
    .filter(vecinoFijo ? { has: page.locator('.rel-label', { hasText: new RegExp(`^${escaparRegex(vecinoFijo)}$`, 'i') }) } : {})
    .first();
  if (!(await vecino.count())) {
    if (vecinoFijo) throw new Error(`"${etiqueta}" no tiene a "${vecinoFijo}" como "se relaciona con"`);
    console.warn(`[conexiones] "${etiqueta}" no tiene vecinos "se relaciona con": D2.7 no se graba`);
    return;
  }
  await escena(page, 'D2.7', async () => {
    await vecino.scrollIntoViewIfNeeded();
    await vecino.click();
    // With a neighbour selected the list is the edge's evidence (EntityPanel.svelte docsTitle).
    const titulo = page.getByRole('heading', {
      level: 3,
      name: /^(Documentos que sustentan esta conexión|Documentos donde aparecen los dos)$/,
    });
    await expect(titulo).toBeVisible();
    await titulo.scrollIntoViewIfNeeded();
    const nota = page.locator('.col-panel a[href^="/biblioteca/"]').first();
    if (await nota.count()) await nota.hover();
    console.log(`[conexiones] vecino: ${((await vecino.locator('.rel-label').textContent()) ?? '').trim()}`);
  });
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A Generales question about the whole corpus (B1.9), with its sources. */
export async function panoramaDelCorpus(page: Page, pregunta: string): Promise<void> {
  await page.goto('/?conversaciones');
  await page.waitForLoadState('networkidle');
  await escena(page, 'B1.1', () => nuevaConversacion(page, 'generales'));
  await escena(page, 'B1.9', async () => {
    await preguntar(page, pregunta);
    await leerRespuesta(page, pregunta);
  });
  await escena(page, 'B1.3', () => leerFuentes(page));
  await renombrarActiva(page, `${RUN_ID} panorama`);
}

// ── (3) A spreadsheet in a conversation ────────────────────────────────────

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The xlsx `hoja.py` built (`correr.sh` passes its path). Named with the run
 * id so cleanup finds it on /documentos.
 */
function hojaDePrueba(): { name: string; mimeType: string; buffer: Buffer } {
  const path = process.env.EVID_HOJA_XLSX ?? resolve(import.meta.dirname, '.videos/_hoja/casos-dengue.xlsx');
  return { name: `${RUN_ID}-casos-dengue.xlsx`, mimeType: XLSX_MIME, buffer: readFileSync(path) };
}

/**
 * Upload the spreadsheet into a new Generales conversation (pinned there by
 * default: `POST /api/sessions/[id]/documents`, `defaultPinned: true`), wait
 * until it is `listo`, then ask about its numbers.
 *
 * 🔴 A participant's upload is gated, then auto-published (backend
 * `lib/autoPublish.ts`): the fixture is invented data, and cleanup deletes it.
 * A hold ("en revisión") fails the run: the chat could not read the sheet.
 */
export async function hojaDeCalculo(page: Page, pregunta: string): Promise<void> {
  await page.goto('/?conversaciones');
  await page.waitForLoadState('networkidle');
  await escena(page, 'B1.1', () => nuevaConversacion(page, 'generales'));
  await escena(page, 'C1.7', async () => {
    await abrirPanel(page, 'documents');
    const respuesta = page.waitForResponse(
      (r: Response) => /\/api\/sessions\/[^/]+\/documents$/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 120_000 },
    );
    const chooser = page.waitForEvent('filechooser');
    // "Subir documento" or "Subir documento o audio": the label depends on the audio switch.
    await page.getByRole('button', { name: /^Subir documento/ }).first().click();
    await consentInPanel(page);
    await (await chooser).setFiles(hojaDePrueba());
    const res = await respuesta;
    expect(res.ok(), `subida de la hoja: HTTP ${res.status()}`).toBe(true);
    const id = String(((await res.json()) as { doc: { id: string | number } }).doc.id);
    const card = tarjeta(page, id);
    await card.scrollIntoViewIfNeeded();
    const estado = await seguirChip(card, /^(listo|en revisión)/i, 'hoja');
    if (/revisión/i.test(estado)) throw new Error('la hoja quedó en revisión: el chat no puede leerla');
  });
  await cerrarPanel(page);
  await escena(page, 'B1.10', async () => {
    await preguntar(page, pregunta);
    await leerRespuesta(page, pregunta);
  });
  await renombrarActiva(page, `${RUN_ID} hoja`);
}

// ── (4) The ecosistema's answer style ──────────────────────────────────────

/** One Generales question and one Resonancias experience, each read through. */
export async function estiloDeRespuesta(page: Page, pregunta: string, experiencia: string): Promise<void> {
  await page.goto('/?conversaciones');
  await page.waitForLoadState('networkidle');
  await escena(page, 'B1.1', () => nuevaConversacion(page, 'generales'));
  await escena(page, 'B4.1', async () => {
    await preguntar(page, pregunta);
    await leerRespuesta(page, pregunta);
  });
  await escena(page, 'B1.3', () => leerFuentes(page));
  await renombrarActiva(page, `${RUN_ID} generales`);

  await escena(page, 'B4.2', async () => {
    await nuevaConversacion(page, 'resonancias');
    await preguntar(page, experiencia);
    await leerRespuesta(page, experiencia);
  });
  await renombrarActiva(page, `${RUN_ID} resonancias`);
}
