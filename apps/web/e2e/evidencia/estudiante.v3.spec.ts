import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { elegirEcosistema, limpiar, renombrarActiva, tarjeta } from './comun';
import { RUN_ID, abrirPanel, cerrarPanel, cerrarSesion, escena, iniciarSesion, instalarSubtitulos, ir } from './escena';
import { nuevaConversacion, soloV3 } from './v3';

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

// ── (2b) A note, published, then its changes published ─────────────────────

/**
 * The note's title becomes a graph entity: its [[enlaces]] seed
 * "se relaciona con" edges from it to the linked temas (coordinator,
 * 2026-10-28), and the investigador video then opens it in Conexiones
 * (EVID_V3_TEMA = this title). So it is a readable title, not evid-…; cleanup
 * still finds the note through its conversation, `${RUN_ID} nota`, which
 * /documentos shows on the row ("Se usa en: …").
 */
const NOTA = process.env.EVID_V3_NOTA_TITULO ?? 'Los emojis como signos';

/** EVID_CONSERVAR_NOTA=1 keeps the note for the investigador video; sweep it after with `EVID_LIMPIAR=estudiante … limpieza`. */
const CONSERVAR = process.env.EVID_CONSERVAR_NOTA === '1';
const CONVERSACION = `${RUN_ID} nota`;

/**
 * The note. ≥ 200 characters (backend `lib/studentNotes.ts` MIN_NOTE_CHARS, or
 * "Publicar" skips it as too short), no private person or place (the gate
 * would hold or redact it), and two `[[enlaces]]` to topics the seeded
 * Semiosis trabajos write about (`seed/fixtures/semiosisTrabajos.ts` TEMAS)
 * but estudiante1's own trabajos do not (índice, interpretante, semiosis
 * infinita, mediatización, publicidad): a NEW chip in Mis temas is then the
 * note's doing. A link seeds the graph only onto a node that already exists
 * and only when its word is in the text (`lib/graph/wikilinks.ts`, org 8 is in
 * `WIKILINK_SEED_ORGS`).
 */
const TEXTO = [
  'Los emojis del chat de mi familia funcionan como un pequeño sistema de signos.',
  'Siguiendo a Saussure, cada emoji se comporta como un [[signo lingüístico]]: une una forma visible con un significado, y su valor depende de los otros emojis disponibles.',
  'El pulgar arriba no significa lo mismo cuando al lado existe el corazón.',
  'También hay [[enunciación]]: quien manda un emoji deja una marca de sí mismo en el mensaje y se dirige a alguien en particular.',
].join(' ');

/** The sentence "Publicar cambios" adds; step 5 looks for it in the shared copy. No names, so the gate leaves it whole. */
const AGREGADO = 'Cuando el emoji llega sin texto, el contexto de la conversación hace de interpretante.';

/** Mis temas' labels on /estudiante (empty while there are none). */
async function misTemas(page: Page): Promise<string[]> {
  const lista = page.getByTestId('mis-temas');
  if (!(await lista.count())) return [];
  return (await lista.locator('li').allTextContents()).map((t) => t.trim()).filter(Boolean);
}

/**
 * Follow the note's card from "Publicar" to "Publicado", logging every state
 * of the publication badge and the ingest chip with the elapsed time (the
 * run's own measure of gate → ingest → graph → auto-publish).
 *
 * 🔴 A hold ("en revisión") or a rejection fails the run: nothing publishes it
 * without a reviewer, so waiting longer would only hide that.
 */
async function seguirPublicacion(card: Locator, etiqueta: string, timeoutMs: number): Promise<void> {
  const badge = card.locator('.pub-badge');
  const chip = card.locator('.chip.ingest-pending, .chip.ingest-ready, .chip.ingest-failed');
  const leer = async (l: Locator) => ((await l.count()) ? ((await l.first().textContent()) ?? '').replace(/\s+/g, ' ').trim() : '');
  const t0 = Date.now();
  let ultimo = '';
  while (Date.now() - t0 < timeoutMs) {
    const pub = await leer(badge);
    const ingesta = await leer(chip);
    const estado = `${pub || '—'} / ${ingesta || '—'}`;
    if (estado !== ultimo) {
      console.log(`[${etiqueta}] +${Math.round((Date.now() - t0) / 1000)}s → ${estado}`);
      ultimo = estado;
    }
    if (/^(error|rechazado)/i.test(ingesta) || /No se pudo publicar/.test(pub)) {
      throw new Error(`${etiqueta}: la nota no se publicó (${estado})`);
    }
    if (/en revisión/i.test(ingesta)) throw new Error(`${etiqueta}: la nota quedó en revisión; sin revisor no se publica`);
    if (pub === 'Publicado') return;
    await card.page().waitForTimeout(1000);
  }
  throw new Error(`${etiqueta}: no llegó a "Publicado" en ${timeoutMs / 1000}s (último: ${ultimo || 'ninguno'})`);
}

/** The note's card, open on its editor. */
async function abrirNota(page: Page, id: string): Promise<Locator> {
  const card = tarjeta(page, id);
  await card.scrollIntoViewIfNeeded();
  const abrir = card.getByRole('button', { name: 'Mostrar u ocultar el documento' });
  if ((await abrir.getAttribute('aria-expanded')) !== 'true') await abrir.click();
  return card;
}

/** Press the card's publish button (`publish-<id>`) and accept the native confirm. */
async function publicar(page: Page, card: Locator, id: string, etiqueta: RegExp): Promise<void> {
  const boton = card.getByTestId(`publish-${id}`);
  await expect(boton).toHaveText(etiqueta, { timeout: 30_000 });
  // `publishConfirmCopy`: "Vas a compartir … ¿Continuar?". `once`, and a
  // swallowed second accept: `limpiar` registers its own dialog handler.
  page.once('dialog', (d) => void d.accept().catch(() => {}));
  const respuesta = page.waitForResponse(
    (r: Response) => r.request().method() === 'POST' && r.url().endsWith(`/api/documents/${id}/publish`),
    { timeout: 60_000 },
  );
  await boton.click();
  const res = await respuesta;
  expect(res.ok(), `publicar la nota: HTTP ${res.status()}`).toBe(true);
}

/**
 * V3 (2), second half, estudiante1 in Semiosis práctica (org 8): write a note
 * with two `[[enlaces]]`, publish it, see its topics in Mis temas, edit it,
 * publish the changes, and read the new sentence in the library.
 *
 * 🔴 STEP 5'S PROOF. /biblioteca/<id> (`$lib/server/biblioteca.ts`
 * `documentText`) shows a gated document's `redactedText`, and a student's note
 * is always gated (`anonymise: true`). That column changes ONLY when the
 * revision is promoted (backend `lib/studentNotes.ts`, the swap that also sets
 * `processed_body`), and it is the same row and text every member of the
 * ecosistema reads there. So the author reading the new sentence in the
 * library is reading what the classmates read, not her own editor. A second
 * account was the alternative: estudiante2's classmate page lists estudiante1
 * only when they share a topic (none today), so it would not stay simple.
 *
 * Cost (quoted, 9dc40b2 / v3.ts: ~$0.002 a document through gate + ingest +
 * graph + publish): two "Publicar" runs on new text, ~$0.004 (inferred).
 * Timeouts: 10 min for each publish, 8 min for the topics (owner plan via
 * coordinator, 2026-10-28: gate + ingest + auto-publish and the graph
 * extraction each take minutes on dev). One pass, no retries.
 */
test('estudiante nota', async ({ page }) => {
  test.setTimeout(45 * 60_000);
  await instalarSubtitulos(page, 'Estudiante');
  await iniciarSesion(page, 'estudiante');
  let id = '';
  try {
    await elegirEcosistema(page, ECO);

    // Mis temas before the note, to tell its topics from the ones already there.
    let antes: string[] = [];
    await escena(page, 'E1.1', async () => {
      await ir(page, 'estudiante');
      await page.getByTestId('mis-temas').or(page.getByTestId('temas-pendientes')).or(page.getByTestId('temas-vacio')).first().waitFor();
      antes = await misTemas(page);
      console.log(`[temas] antes (${antes.length}): ${antes.join(', ')}`);
      // backend `topicsByUser` returns 30 at most: a full list can push a one-document topic out.
      if (antes.length >= 30) console.warn('[temas] Mis temas ya muestra 30: un tema nuevo puede no caber');
    });

    // 1. A new conversation, renamed first so cleanup finds it whatever fails after.
    await page.goto('/?conversaciones');
    await page.waitForLoadState('networkidle');
    await escena(page, 'B1.1', () => nuevaConversacion(page, 'generales'));
    await renombrarActiva(page, CONVERSACION);

    await escena(page, 'C1.2', async () => {
      await abrirPanel(page, 'documents');
      const creada = page.waitForResponse(
        (r: Response) => /\/api\/sessions\/[^/]+\/documents$/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 60_000 },
      );
      await page.getByRole('button', { name: 'Nueva nota' }).first().click();
      const res = await creada;
      expect(res.ok(), `nueva nota: HTTP ${res.status()}`).toBe(true);
      id = String(((await res.json()) as { doc: { id: string | number } }).doc.id);
      const card = await abrirNota(page, id);
      const titulo = card.getByLabel('Título del documento');
      await titulo.fill(NOTA);
      await titulo.press('Enter');
      await card.getByLabel('Contenido del documento').fill(TEXTO);
    });

    // 2. Publicar → gate → draft ingest → graph → auto-publish.
    await escena(page, 'C3.2', async () => {
      const card = tarjeta(page, id);
      await publicar(page, card, id, /Publicar en mi ecosistema/);
      await seguirPublicacion(card, 'nota', 10 * 60_000);
    });
    await cerrarPanel(page);

    // 3. Mis temas shows a topic it did not have. The graph extraction can land
    // after "Publicado": reload every 20 s, the caption holding, up to 8 min.
    await escena(page, 'E1.1', async () => {
      await ir(page, 'estudiante');
      const t0 = Date.now();
      let ahora: string[] = [];
      for (;;) {
        ahora = await misTemas(page);
        const nuevos = ahora.filter((t) => !antes.includes(t));
        if (nuevos.length) {
          console.log(`[temas] +${Math.round((Date.now() - t0) / 1000)}s nuevos: ${nuevos.join(', ')}`);
          await page.getByTestId('mis-temas').scrollIntoViewIfNeeded();
          return;
        }
        if (Date.now() - t0 > 8 * 60_000) break;
        await page.waitForTimeout(20_000);
        await page.reload();
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      }
      throw new Error(`Mis temas no mostró ningún tema nuevo de la nota en 8 min (antes: ${antes.join(', ') || 'ninguno'}; ahora: ${ahora.join(', ') || 'ninguno'})`);
    });

    // 4. Back to the note: one more sentence, then "Publicar cambios".
    await page.goto('/?conversaciones');
    await page.waitForLoadState('networkidle');
    await abrirPanel(page, 'conversations');
    await page.getByTestId('session-tab-generales').click();
    await page.getByTestId('session-row').filter({ hasText: CONVERSACION }).getByRole('button', { name: CONVERSACION, exact: true }).click();
    await cerrarPanel(page);
    const editado = `${TEXTO} ${AGREGADO}`;
    await escena(page, 'C3.3', async () => {
      await abrirPanel(page, 'documents');
      const card = await abrirNota(page, id);
      const cuerpo = card.getByLabel('Contenido del documento');
      await expect(cuerpo).toHaveValue(TEXTO);
      // One `fill`, not typed: `slowMo` (350 ms an action) would spend ~30 s on the sentence.
      await cuerpo.fill(editado);
      // ⚠ No on-card state follows it: while it runs the button is gone and the
      // badge stays "Publicado" (peers keep the old version). The store polls
      // GET /api/documents/<id> until `processedBody` is the text it sent
      // (`app.svelte.ts` pollNoteChanges), then toasts "Cambios publicados".
      // Wait on that same read.
      const t0 = Date.now();
      const listo = page.waitForResponse(
        async (r: Response) =>
          r.request().method() === 'GET' &&
          r.url().endsWith(`/api/documents/${id}`) &&
          r.ok() &&
          ((await r.json().catch(() => null)) as { processedBody?: unknown } | null)?.processedBody === editado,
        { timeout: 10 * 60_000 },
      ).then(() => true, () => false);
      await publicar(page, card, id, /Publicar cambios/);
      if (!(await listo)) {
        throw new Error('"Publicar cambios": el texto nuevo no se publicó en 10 min (¿la revisión quedó en revisión o rechazada?)');
      }
      console.log(`[cambios] +${Math.round((Date.now() - t0) / 1000)}s publicados`);
      await expect(page.getByText('Cambios publicados')).toBeVisible({ timeout: 10_000 }).catch(() => {});
      await expect(card.locator('.pub-badge')).toHaveText('Publicado');
    });
    await cerrarPanel(page);

    // 5. The shared copy carries the new sentence (see the header for why this is what peers read).
    await escena(page, 'D1.3', async () => {
      await page.goto(`/biblioteca/${id}`);
      const texto = page.getByTestId('library-document-text');
      await expect(texto).toContainText(AGREGADO, { timeout: 60_000 });
      await texto.scrollIntoViewIfNeeded();
    });
  } catch (error) {
    console.error('Falló el recorrido:', error);
    await page.screenshot({ path: test.info().outputPath('antes-de-limpiar.png') });
    throw error;
  } finally {
    // The note (published or not: /documentos deletes it, and its revision, the normal way) and the conversation.
    if (CONSERVAR) console.log(`Nota "${NOTA}" conservada (EVID_CONSERVAR_NOTA=1): bórrala luego con la limpieza del estudiante.`);
    else await limpiar(page);
  }
  await cerrarSesion(page);
});
