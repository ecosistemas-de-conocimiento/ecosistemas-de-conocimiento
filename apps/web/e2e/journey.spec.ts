import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminCredentials, fixturesDir } from './env';

/**
 * ONE coherent journey through the live stack, in a real browser, recorded.
 *
 * Sign in → read the ecosistema → chat → rate the answer (mouse, then
 * keyboard) → upload a PDF → upload a Spanish recording and watch it
 * transcribe → publish → ask a question that cites the material → sign out.
 *
 * ## Rules this file follows
 *
 * 1. **Nothing is mocked.** Every assertion is about what the running stack
 *    actually painted. `MOCK_LLM=1` makes the ANSWER TEXT a deterministic stub,
 *    so nothing here asserts on wording — only that an answer arrives, renders,
 *    and can be rated and cited.
 * 2. **Everything created is namespaced** `e2e-fe-<timestamp>`. A backend E2E
 *    suite hits the same database concurrently. Nothing is ever deleted.
 * 3. **Selectors come from the components**, not from guesswork:
 *    `role="radiogroup"` / `role="radio"` from `primitives/StarRating.svelte`,
 *    `data-testid="composer-input"` / `composer-send` from `Composer.svelte`,
 *    `data-testid^="publish-"` and the `.chip.ingest-*` / `.pub-badge` classes
 *    from `DocsPanel.svelte`, `data-testid="citation-sources"` from the
 *    chat-engine `CitationCard`. The literal Spanish strings below are the
 *    exported constants in `$lib/publication.ts` and `$lib/ingest.ts`.
 * 4. **No step is weakened to get green.** A failure here is a finding.
 */

const RUN_ID = `e2e-fe-${Date.now()}`;

/** Copy that must appear verbatim — see `$lib/publication.ts`. */
const DRAFT_BADGE = 'Borrador · solo tú';
const PUBLISHING_BADGE = 'Publicando…';
const PUBLISHED_BADGE = 'Publicado';
const PUBLISH_FAILED_BADGE = 'No se pudo publicar';

/** Copy that must appear verbatim — see `$lib/ingest.ts`. */
const TRANSCRIPT_PROVENANCE_LABEL = 'Transcripción automática';

interface Sample {
  text: string;
  at: number;
}

/**
 * Sample a locator's trimmed text on an interval and record every DISTINCT
 * value it passes through, until `done` matches or the deadline expires.
 *
 * This is how the ingest and publication state machines are observed: the UI
 * moves `transcribing → transcribed → ready` on its own poll schedule, and a
 * plain `expect(...).toBeVisible()` on the final state alone would silently
 * skip the intermediate ones. Recording the sequence is what lets the run
 * REPORT what the pipeline did, not merely whether it finished.
 */
async function observeStates(
  locator: Locator,
  done: (text: string) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<{ seen: Sample[]; texts: string[]; settled: boolean; elapsedMs: number }> {
  const started = Date.now();
  const interval = opts.intervalMs ?? 500;
  const seen: Sample[] = [];
  let settled = false;
  while (Date.now() - started < opts.timeoutMs) {
    let text = '';
    try {
      if ((await locator.count()) > 0) {
        text = ((await locator.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
      }
    } catch {
      /* mid-render detach — sample again */
    }
    if (text && seen[seen.length - 1]?.text !== text) {
      seen.push({ text, at: Date.now() });
      console.log(`[${opts.label}] +${Date.now() - started}ms → ${text}`);
    }
    if (text && done(text)) {
      settled = true;
      break;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return {
    seen,
    texts: seen.map((s) => s.text),
    settled,
    elapsedMs: Date.now() - started,
  };
}

// ── locator helpers ────────────────────────────────────────────────────────

/**
 * Every star-rating group on screen — one per settled assistant answer.
 *
 * `MessageRating.svelte` names it "Valora esta respuesta, de 1 a 5 estrellas";
 * that accessible name is the contract `StarRating.svelte` documents, so it is
 * what we key off rather than a class.
 */
function ratingGroups(page: Page): Locator {
  return page.getByRole('radiogroup', {
    name: 'Valora esta respuesta, de 1 a 5 estrellas',
  });
}

/** One star, by the accessible name `optionLabel` builds. */
function star(group: Locator, n: number): Locator {
  return group.getByRole('radio', {
    name: n === 1 ? '1 estrella' : `${n} estrellas`,
    exact: true,
  });
}

/** The documents aside, found by its own heading rather than layout position. */
function docsPanel(page: Page): Locator {
  return page
    .locator('aside')
    .filter({ has: page.getByRole('heading', { name: 'Documentos' }) });
}

/**
 * One document card. `DocsPanel.svelte` gives the card no test id, so this
 * keys off the class list it actually renders. Cards appear in the order the
 * store pushed them (`s.docs.push`), i.e. upload order.
 */
function docCard(page: Page, index: number): Locator {
  return docsPanel(page).locator('div.bg-surface-strong.shadow-1').nth(index);
}

/** The publication badge inside one card (`.pub-badge`, `role="status"`). */
function pubBadge(card: Locator): Locator {
  return card.locator('.pub-badge');
}

/** The ingest chip inside one card (`.chip.ingest-*`). */
function ingestChip(card: Locator): Locator {
  return card.locator('.chip.ingest-pending, .chip.ingest-ready, .chip.ingest-failed');
}

/** Expand a document card if it is not already expanded. */
async function ensureExpanded(card: Locator): Promise<void> {
  const toggle = card.getByRole('button', { name: 'Mostrar u ocultar el documento' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test('journey: sign in → chat → rate → upload → transcribe → publish → cite → sign out', async ({
  page,
}, testInfo) => {
  const { email, password } = adminCredentials();

  // `confirm()` guards the publish action (and carries the transcript
  // warning). Accept every dialog; nothing in this journey deletes anything.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });

  // Surface browser-side failures — no Svelte component in this repo had ever
  // been rendered in a test before this file, so a console error is a finding
  // in its own right.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // Network-level record of the publish call, so the report can say whether
  // the badge moved before or after the server answered.
  const publishCalls: { url: string; status: number; at: number }[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/publish')) {
      publishCalls.push({ url: res.url(), status: res.status(), at: Date.now() });
    }
  });

  const note = (type: string, description: string): void => {
    testInfo.annotations.push({ type, description });
    console.log(`[${type}] ${description}`);
  };

  // ── 1. Sign in ───────────────────────────────────────────────────────────
  await test.step('sign in through the real form', async () => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // ⚠ Playwright's failure artefacts (`error-context.md`) capture an
    // accessibility snapshot that INCLUDES input values, so a failed sign-in
    // writes the seeded password to disk in plaintext. Blank the DOM value now
    // that the request is on the wire; the component already read it into its
    // own `$state`, so this changes nothing about the submission. The
    // `.catch()` covers the happy path, where we have already navigated away.
    await page
      .locator('input[name="password"]')
      .evaluate((el) => {
        (el as HTMLInputElement).value = '';
      })
      .catch(() => {});

    await page.waitForURL('**/');
    // The app is client-rendered (SSR is off for the main route), so "signed
    // in" means the hydrated shell is on screen, not merely that the URL moved.
    await expect(page.getByRole('heading', { name: 'Conversaciones' })).toBeVisible();

    // 🔴 DEFECT, ASSERTED SOFTLY SO THE REST OF THE JOURNEY STILL RUNS.
    //
    // `routes/+layout.svelte` calls `app.hydrateFromServer()` from `onMount`,
    // gated on `isAuthRoute`. That layout is SHARED by `/sign-in` and `/`, so
    // it mounts exactly once — on `/sign-in`, where the gate is true — and the
    // `goto('/')` at the end of the sign-in handler is a CLIENT-SIDE
    // navigation that never remounts it. Hydration therefore never runs for
    // anyone who signs in through the form: the first screen after signing in
    // shows "Cargando…" for the ecosistema, an empty conversation list, a
    // disabled upload button and "Sin chat seleccionado", until the user
    // reloads by hand. It only works if you arrive at `/` on a full page load
    // with the cookie already set.
    const loading = page.locator('[data-ecosystem-picker]').getByText('Cargando…');
    await expect
      .soft(
        loading,
        'the app did not hydrate after a client-side sign-in — see routes/+layout.svelte: ' +
          'onMount() gates hydrateFromServer() on isAuthRoute, and the shared root layout ' +
          'never remounts across goto("/")',
      )
      .toHaveCount(0, { timeout: 15_000 });

    // The workaround a real user is forced into today. Everything after this
    // point tests the app as it behaves once it HAS hydrated.
    if (await loading.count()) {
      note('workaround', 'reloading by hand because sign-in left the app unhydrated');
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Conversaciones' })).toBeVisible();
    }
  });

  // ── 2. The ecosistema picker ─────────────────────────────────────────────
  //
  // The brief said the database holds ONE membership, in which case the picker
  // must show a NAME and no control. That is asserted below — but the shape is
  // read off the live app rather than assumed, because a concurrent backend
  // E2E suite shares this database and can add memberships to the same user
  // mid-run. Either shape is a legitimate thing to assert; guessing which one
  // is on screen is not.
  await test.step('the ecosistema picker shows what the memberships actually justify', async () => {
    const picker = page.locator('[data-ecosystem-picker]');
    await expect(picker).toBeVisible();
    await expect(picker.getByText('Ecosistema', { exact: true })).toBeVisible();

    // `ecosystemsReady` settles asynchronously; wait it out.
    await expect(picker.getByText('Cargando…')).toHaveCount(0);
    await expect(picker.getByText('No disponible')).toHaveCount(0);
    await expect(picker.getByText('Ninguno')).toHaveCount(0);

    // The one sentence that explains what the tenant boundary means. Present
    // in BOTH shapes — the reason the control exists, said where the choice is.
    await expect(
      picker.getByText('Lo que publiques aquí lo ve este ecosistema.'),
    ).toBeVisible();

    const chooser = picker.locator('[aria-haspopup="listbox"]');
    const many = (await chooser.count()) > 0;

    if (!many) {
      // 🔴 ONE membership ⇒ NO chooser. `EcosystemPicker.svelte` renders a
      // plain <p title={name}> in that branch. Assert the ABSENCE, because "a
      // dropdown with one option" is exactly what that component refuses to be.
      await expect(picker.locator('[role="listbox"]')).toHaveCount(0);
      const name = picker.locator('p[title]');
      await expect(name).toHaveCount(1);
      const ecosystemName = ((await name.textContent()) ?? '').trim();
      expect(ecosystemName.length).toBeGreaterThan(0);
      note('ecosistema', `single membership, no chooser: "${ecosystemName}"`);
      return;
    }

    // More than one membership ⇒ a real chooser, and it must list them all.
    await chooser.click();
    const options = picker.getByRole('option');
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
    const names = (await options.allTextContents()).map((t) =>
      t.replace(/[✓\s]+/g, ' ').trim(),
    );
    note('ecosistema', `${count} memberships: ${names.join(' | ')}`);
    // Exactly one is marked as current.
    await expect(picker.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);

    // Switch to the seeded demo tenant and stay there for the rest of the run:
    // the other ecosistemas belong to a concurrent suite that may delete them.
    const demo = options.filter({ hasText: 'Organización Demo' });
    await expect(demo).toHaveCount(1);
    await demo.click();
    await expect(picker.getByText('Cambiando de ecosistema…')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(picker.getByText('Organización Demo').first()).toBeVisible();
  });

  // ── 3. A chat session, a message, an answer ──────────────────────────────
  const question = `${RUN_ID} ¿qué acuerdos hay registrados en el ecosistema?`;

  await test.step('create a session, send a message, get an answer', async () => {
    await page.getByRole('button', { name: 'Nueva conversación' }).first().click();
    await expect(page.getByRole('heading', { name: 'Nueva conversación' })).toBeVisible();

    await page.getByTestId('composer-input').fill(question);
    await page.getByTestId('composer-send').click();

    // The user's turn renders immediately (optimistic).
    await expect(page.getByText(question).first()).toBeVisible();

    // An answer has ARRIVED and SETTLED when the rating control appears:
    // `Message.svelte` renders it only for an assistant turn that is not
    // pending, not errored, and carries a server-issued id. That is a far
    // stronger signal than any text assertion — and `MOCK_LLM=1` makes the
    // text a stub, so its wording is deliberately never asserted.
    await expect(ratingGroups(page)).toHaveCount(1, { timeout: 120_000 });

    // The session auto-titles from the first message, so it is namespaced too.
    await expect(page.getByRole('heading', { name: RUN_ID })).toBeVisible();
  });

  // ── 4. Rate the answer, then re-rate it ──────────────────────────────────
  await test.step('rate the answer 4 stars, then re-rate it to 2', async () => {
    const group = ratingGroups(page).last();
    const row = group.locator('..');
    await expect(row).toContainText('¿Te sirvió esta respuesta?');

    await star(group, 4).click();
    await expect(star(group, 4)).toHaveAttribute('aria-checked', 'true');
    await expect(group).not.toHaveAttribute('aria-busy', 'true');
    await expect(row).toContainText('Tu valoración');

    // Re-rate. ONE rating per message: the second write updates the same row,
    // so star 4 must go back OFF rather than both staying lit.
    await star(group, 2).click();
    await expect(star(group, 2)).toHaveAttribute('aria-checked', 'true');
    await expect(star(group, 4)).toHaveAttribute('aria-checked', 'false');
    await expect(group).not.toHaveAttribute('aria-busy', 'true');
    // The polite live region reports the NEW value.
    await expect(row).toContainText('Valoración guardada: 2 de 5.');
  });

  // ── 9. Keyboard accessibility on the star rating ─────────────────────────
  // (Out of numerical order on purpose: it operates on the same rating.)
  await test.step('the star rating is operable from the keyboard', async () => {
    const group = ratingGroups(page).last();

    // Roving tabindex: the group is ONE tab stop, and it sits on the committed
    // value (2, from the step above).
    await expect(star(group, 2)).toHaveAttribute('tabindex', '0');
    await expect(star(group, 5)).toHaveAttribute('tabindex', '-1');

    await star(group, 2).focus();
    await expect(star(group, 2)).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(star(group, 3)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(star(group, 5)).toBeFocused();

    // 🔴 THE CONTRACT: arrows MOVE FOCUS ONLY. Selection must NOT follow focus
    // here — every selection is a network write, and walking 2→5 would fire
    // three of them. So after three arrow presses the committed value is
    // still 2.
    await expect(star(group, 5)).toHaveAttribute('aria-checked', 'false');
    await expect(star(group, 2)).toHaveAttribute('aria-checked', 'true');

    // Enter commits the focused star.
    await page.keyboard.press('Enter');
    await expect(star(group, 5)).toHaveAttribute('aria-checked', 'true');
    await expect(star(group, 2)).toHaveAttribute('aria-checked', 'false');
    await expect(group).not.toHaveAttribute('aria-busy', 'true');

    // Home/End are part of the same mapping (`starMoveForKey`), and they are
    // focus-only too.
    await page.keyboard.press('Home');
    await expect(star(group, 1)).toBeFocused();
    await expect(star(group, 1)).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('End');
    await expect(star(group, 5)).toBeFocused();
  });

  await test.step('the rating survives a reload — one row, not three', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Conversaciones' })).toBeVisible();

    // Re-select OUR session by its auto-title: hydration activates whichever
    // session the backend lists first, which need not be this one.
    await page.locator('nav').getByText(RUN_ID).first().click();

    await expect(ratingGroups(page)).toHaveCount(1, { timeout: 60_000 });
    const group = ratingGroups(page).last();
    await expect(star(group, 5)).toHaveAttribute('aria-checked', 'true');
  });

  // ── 5. Upload a document; it must read as a draft ────────────────────────
  const pdfName = `${RUN_ID}-acta.pdf`;

  await test.step('upload a PDF and confirm it reads as a draft', async () => {
    const panel = docsPanel(page);
    await expect(panel).toBeVisible();
    // The standing explanation at the top of the panel, not only per card.
    await expect(panel.getByText('Todo lo que subas entra como')).toBeVisible();

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      panel.getByRole('button', { name: 'Subir documento o audio' }).click(),
    ]);
    await chooser.setFiles({
      name: pdfName,
      mimeType: 'application/pdf',
      buffer: readFileSync(join(fixturesDir, 'acta-ecosistema.pdf')),
    });

    const card = docCard(page, 0);
    await expect(card).toBeVisible({ timeout: 60_000 });

    // 🔴 The badge is deliberately VISIBLE TEXT, not a tooltip: someone who has
    // to hover to learn nobody else can see their document will not hover.
    await expect(pubBadge(card)).toHaveText(DRAFT_BADGE);
    await expect(card.getByText(DRAFT_BADGE)).toBeVisible();
  });

  await test.step('the PDF finishes ingesting', async () => {
    const card = docCard(page, 0);
    const states = await observeStates(
      ingestChip(card),
      (t) => t === 'listo' || t === 'error',
      { timeoutMs: 4 * 60_000, label: 'pdf-ingest' },
    );
    note(
      'pdf-ingest',
      `${states.texts.join(' → ') || '(no chip ever appeared)'} in ${Math.round(states.elapsedMs / 1000)}s`,
    );
    // SOFT, so one run reports the whole journey instead of stopping at the
    // first broken link. The failure is still recorded and still fails the run.
    if (states.texts.includes('error')) {
      const detail = ((await card.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      note('pdf-ingest-failure', detail);
      expect.soft(false, `PDF ingest FAILED. The card says: ${detail}`).toBe(true);
      return;
    }
    expect
      .soft(
        states.settled,
        `PDF ingest never reached "listo"; saw: ${states.texts.join(' → ') || '(nothing)'}`,
      )
      .toBe(true);
    if (states.settled) await expect(card.locator('.chip.ingest-ready')).toHaveText('listo');
  });

  // ── 6. Upload the Spanish recording and watch it through to ready ────────
  const audioName = `${RUN_ID}-junta.mp3`;
  let audioElapsedMs = 0;

  await test.step('upload a 45s Spanish recording and watch it transcribe', async () => {
    const panel = docsPanel(page);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      panel.getByRole('button', { name: 'Subir documento o audio' }).click(),
    ]);
    await chooser.setFiles({
      name: audioName,
      mimeType: 'audio/mpeg',
      buffer: readFileSync(join(fixturesDir, 'es-clip.mp3')),
    });

    const card = docCard(page, 1);
    await expect(card).toBeVisible({ timeout: 60_000 });

    // 🔴 THE ASR MITIGATION, on the card and not in a tooltip.
    await expect(card.getByText(TRANSCRIPT_PROVENANCE_LABEL)).toBeVisible({
      timeout: 60_000,
    });
    // An audio upload is a draft like any other.
    await expect(pubBadge(card)).toHaveText(DRAFT_BADGE);

    // Watch the pipeline. Budget: transcription was measured at ~9 s, but the
    // client's own poll schedule is 2 s, 5 s, then 30 s for audio, so the UI
    // can legitimately lag the backend by half a minute per hop.
    const states = await observeStates(
      ingestChip(card),
      (t) => t === 'listo' || t === 'error',
      { timeoutMs: 8 * 60_000, label: 'audio-ingest' },
    );
    audioElapsedMs = states.elapsedMs;
    note(
      'audio-ingest',
      `${states.texts.join(' → ') || '(no chip ever appeared)'} in ${Math.round(states.elapsedMs / 1000)}s`,
    );

    if (states.texts.includes('error')) {
      const detail = ((await card.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      note('audio-ingest-failure', detail);
      expect.soft(false, `audio ingest FAILED. The card says: ${detail}`).toBe(true);
      return;
    }
    expect
      .soft(
        states.settled,
        `audio never reached "listo"; saw: ${states.texts.join(' → ') || '(nothing)'}`,
      )
      .toBe(true);
    // The honest-wait state has to have been on screen: it is the copy that
    // keeps a long job from looking broken.
    expect
      .soft(
        states.texts.some((s) => s.startsWith('transcribiendo')),
        `never saw a "transcribiendo…" state; saw: ${states.texts.join(' → ')}`,
      )
      .toBe(true);

    if (!states.settled) return;
    await expect(card.locator('.chip.ingest-ready')).toHaveText('listo');
    await ensureExpanded(card);
    await expect(card.getByText('Transcripción lista.')).toBeVisible();
  });

  // ── 7. Publish, and confirm the UI stops calling it private ──────────────
  await test.step('publish a document and confirm the UI stops calling it private', async () => {
    // Whichever upload actually reached `ready` — `publishGate` only offers the
    // button for an ingested document, so this search IS the gate's verdict.
    //
    // 🔴 RESOLVED TO A POSITION, ONCE, AND NOT KEPT AS A `filter({ has: publish })`
    // LOCATOR. Playwright re-evaluates a filter on every query, and `publishGate`
    // WITHDRAWS the publish button the instant the status leaves `draft`. A
    // locator defined by that button therefore stops matching the card at the
    // exact moment this step starts watching it: `observeStates` then samples an
    // element that no longer resolves, records nothing, and reports "the badge
    // never moved" for a publish that in fact completed. Measured — the document
    // read `published` in the database while the run was still waiting.
    //
    // Cards never reorder (`app.svelte.ts` appends with `s.docs.push`) and
    // nothing in this journey deletes one, so an index is stable for the rest of
    // the step.
    const allCards = docsPanel(page).locator('div.bg-surface-strong.shadow-1');
    const cardCount = await allCards.count();
    let publishableIndex = -1;
    for (let i = 0; i < cardCount; i += 1) {
      if (await allCards.nth(i).locator('[data-testid^="publish-"]').count()) {
        publishableIndex = i;
        break;
      }
    }
    const card = docCard(page, publishableIndex < 0 ? 0 : publishableIndex);
    if (publishableIndex < 0) {
      expect
        .soft(
          false,
          'no document could be published: neither upload reached "listo", so `publishGate` ' +
            'offered no button. See the ingest failures above.',
        )
        .toBe(true);
      return;
    }

    const title = await card.locator('input[aria-label="Título del documento"]').inputValue();
    note('publishing', title);

    const publish = card.locator('[data-testid^="publish-"]');
    await expect(publish).toContainText('Publicar en mi ecosistema');

    // Still private at the moment of the click.
    await expect(pubBadge(card)).toHaveText(DRAFT_BADGE);
    const clickedAt = Date.now();
    await publish.click();
    // The `confirm()` gate fired and named the document (auto-accepted above).
    expect(
      dialogs.some((d) => d.includes(title)),
      `no confirm() naming ${title}; dialogs seen: ${JSON.stringify(dialogs)}`,
    ).toBe(true);

    // Publishing is deliberately NOT optimistic — the badge only ever moves to
    // what the SERVER reported, so a real pending state is expected here and
    // the budget is generous.
    const states = await observeStates(
      pubBadge(card),
      (t) => t === PUBLISHED_BADGE || t === PUBLISH_FAILED_BADGE,
      { timeoutMs: 6 * 60_000, intervalMs: 250, label: 'publish' },
    );
    const firstPublished = states.seen.find((s) => s.text === PUBLISHED_BADGE);
    const serverAnsweredAt = publishCalls[0]?.at;
    note(
      'publish',
      `${states.texts.join(' → ') || '(no badge)'} in ${Math.round(states.elapsedMs / 1000)}s; ` +
        `POST /publish → ${publishCalls.map((c) => c.status).join(',') || 'none observed'} ` +
        `after ${serverAnsweredAt ? serverAnsweredAt - clickedAt : '?'}ms`,
    );

    if (states.texts.includes(PUBLISH_FAILED_BADGE)) {
      const detail = ((await card.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      note('publish-failure', detail);
      expect.soft(false, `publish FAILED. The card says: ${detail}`).toBe(true);
      return;
    }
    expect
      .soft(
        states.settled,
        `publish never settled; saw: ${states.texts.join(' → ') || '(nothing)'}`,
      )
      .toBe(true);
    if (!states.settled) return;

    // Non-optimism, stated as a fact about time rather than about wording: the
    // UI cannot have said "Publicado" before the server's answer landed.
    if (firstPublished && serverAnsweredAt) {
      expect(
        firstPublished.at,
        'the badge read "Publicado" BEFORE the publish response arrived — that is ' +
          'an optimistic visibility claim, which this flow must never make.',
      ).toBeGreaterThanOrEqual(serverAnsweredAt);
    }
    // Every state the badge passed through must be one the model defines.
    const legal = [DRAFT_BADGE, PUBLISHING_BADGE, PUBLISHED_BADGE, PUBLISH_FAILED_BADGE];
    expect(
      states.texts.filter((t) => !legal.includes(t)),
      `publication badge showed a state outside the model: ${states.texts.join(' → ')}`,
    ).toEqual([]);

    // The UI stops calling it private.
    await expect(pubBadge(card)).toHaveText(PUBLISHED_BADGE);
    await expect(card.getByText(DRAFT_BADGE)).toHaveCount(0);
    await expect(card.getByText('solo tú')).toHaveCount(0);
    await expect(card.locator('[data-testid^="publish-"]')).toHaveCount(0);
    await expect(card.getByText('Ya está publicado en tu ecosistema.')).toBeVisible();
  });

  // ── 8. Ask a question that cites the uploaded material ───────────────────
  await test.step('ask about the uploaded material and get a citation', async () => {
    // Names material from BOTH uploads — the acta's verification keyword and
    // the recording — so the question is answerable from whichever of the two
    // actually made it into a corpus.
    const cited =
      `${RUN_ID} ¿qué dice el acta sobre NUBELIRIO y el presupuesto participativo, ` +
      'y qué se acordó en la grabación de la junta?';
    await page.getByTestId('composer-input').fill(cited);
    await page.getByTestId('composer-send').click();

    // Two settled answers now; the second rating control appearing IS this
    // turn settling.
    await expect(ratingGroups(page)).toHaveCount(2, { timeout: 180_000 });

    // The engine's CitationCard. `citation-sources` is the "Fuentes
    // consultadas" block it renders whenever the turn's provenance carried a
    // chunk. Soft, because "no citation" here is a downstream symptom of an
    // ingest that never produced any chunks to cite — reported, not fatal.
    const sourcesBlock = page.getByTestId('citation-sources').first();
    await expect
      .soft(sourcesBlock, 'the answer rendered with NO citation block')
      .toBeVisible({ timeout: 60_000 });
    if (await sourcesBlock.isVisible().catch(() => false)) {
      // 🔴 THE LIST STARTS COLLAPSED, AND THAT IS THE APP'S CHOICE, NOT A BUG.
      // `components/Message.svelte` passes `collapsibleSources` to the engine's
      // `CitationCard` and does NOT pass `sourcesOpenByDefault`, so what renders
      // first is a toggle reading "Fuentes consultadas (N)" — the count is
      // visible, the passages are one click away, and the chat stays readable.
      // A test that asserts the `<li>`s without pressing that button is
      // asserting a different product. Press it, the way a reader does.
      const toggle = sourcesBlock.getByTestId('citation-sources-toggle');
      if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
      }
      await expect(page.getByTestId('citation-source').first()).toBeVisible();
      const sources = await page.getByTestId('citation-source').allTextContents();
      note('citations', sources.map((s) => s.replace(/\s+/g, ' ').trim()).join(' | '));
    }
  });

  // ── 10. Sign out ─────────────────────────────────────────────────────────
  await test.step('sign out', async () => {
    await page.getByRole('button', { name: 'cerrar sesión' }).click();
    await page.waitForURL('**/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  note(
    'audio-ready-after',
    `${Math.round(audioElapsedMs / 1000)}s browser-observed (includes the client's own 2s/5s/30s poll lag)`,
  );
  if (consoleErrors.length) {
    note('console-errors', `${consoleErrors.length}: ${consoleErrors.slice(0, 10).join(' | ')}`);
  }
});
