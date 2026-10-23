/**
 * THE HOLD DECISION PATH, IN A BROWSER.
 *
 * When the anonymisation gate refuses a document it HOLDS it, and someone with
 * `holds:review` opens `/revision`, reads the refused text on `/revision/[id]`,
 * and either approves it into the ecosistema's corpus or rejects it forever.
 * That path answered 500 until recently, so nothing above the unit tests had
 * ever run against it.
 *
 * ── WHAT THIS ADDS OVER THE OTHER TWO LAYERS ─────────────────────────────────
 *
 * `src/lib/holds.test.ts` pins the copy and the highlight arithmetic against
 * strings. `apps/backend/e2e/holds.e2e.ts` pins the three HTTP routes and the
 * audit row. Neither can say that a person can actually DO this: that the queue
 * renders, that the highlights land on the identifiers on screen, that the
 * two-step confirmation really withholds the submit until the second press, and
 * that approving redirects to a queue the document has left.
 *
 * ── 🔴 IT DECIDES ONLY ON A HOLD IT MADE ITSELF ──────────────────────────────
 *
 * A decision is terminal and a hold cannot be created through the API, so this
 * file seeds its own (see `e2e/db.ts` for the whole argument). The hand-made
 * review fixture in the shared dev database is READ by the "does not touch"
 * test at the bottom and never pressed.
 *
 * ⚠ Reviewer = the seeded admin. They are a platform admin, so `/revision`
 * opens on their own ecosistema and they carry `holds:review` there as its
 * owner. Same account `journey.spec.ts` uses; no second set of credentials.
 */

import { expect, test, type Page } from '@playwright/test';

import { dbAvailable, insertReturning, query } from './db';
import { adminCredentials, backendUrl } from './env';

// ── the seeded hold ──────────────────────────────────────────────────────────

/**
 * What the gate refused, and the two identifiers it says survived.
 *
 * ⚠ THE OFFSETS ARE COMPUTED FROM THE STRING, never typed in. `anonymisation_
 * survivors` holds `{start,end}` offsets that must land exactly on the
 * identifiers inside `held_text`, and doing that arithmetic by eye is how the
 * hand-made fixture ended up highlighting the wrong characters on the first
 * attempt. The assertion below then reads the highlights back OFF THE PAGE, so
 * a wrong offset fails here rather than misleading a reviewer in production.
 */
const HELD_TEXT =
  'Mi nombre es [Persona A] y vivo en [Domicilio A]. Mi hija Lupita estudia cerca. ' +
  'Si necesitan algo me marcan al 55 4821 9930.';

/**
 * A phrase that exists ONLY in the seeded document's `extractedText` — the raw
 * upload. Nothing in the app's own copy contains it, which is what makes "the
 * original never reaches the review page" a checkable claim.
 */
const ORIGINAL_SENTINEL = 'me ayudo con los papeles';
const ORIGINAL_TEXT = `Yo llegue a [Domicilio 1] en 2019. Mi hermana Lupita ${ORIGINAL_SENTINEL}.`;

const SURVIVORS = [
  { text: 'Lupita', type: 'persona' },
  { text: '55 4821 9930', type: 'contacto' },
];

function survivorSpans() {
  return SURVIVORS.map(({ text, type }) => {
    const start = HELD_TEXT.indexOf(text);
    if (start < 0) throw new Error(`"${text}" is not in HELD_TEXT — the fixture is incoherent`);
    return { start, end: start + text.length, type };
  });
}

// ── copy, quoted from `src/lib/holds.ts` ─────────────────────────────────────
//
// ⚠ Written out rather than imported. These are the strings a PERSON reads, and
// importing the constant would make the test agree with the app by
// construction — it would still pass if every sentence were replaced with the
// wrong one. The unit tests import; an e2e assertion on visible text should not.

const APPROVE_LABEL = 'Aprobar y agregar a la biblioteca';
const REJECT_LABEL = 'Rechazar y borrar el texto retenido';
const APPROVE_CONFIRM = '¿Aprobar este documento y dejar que entre a la biblioteca?';
const REJECT_CONFIRM = '¿Rechazar este documento y borrar el texto retenido?';
const APPROVED_TOAST = 'Aprobado. El documento va a entrar a la biblioteca.';
const NOT_A_REVIEWER =
  'Esta sección es para quien revisa los documentos que la anonimización detuvo.';

const db = dbAvailable();

if (!db.ok) {
  console.error(
    `\n[e2e] revision: SKIPPED — ${db.reason}\n` +
      '      A hold cannot be created through the API, and this suite refuses to\n' +
      "      spend somebody else's fixture instead. See e2e/db.ts.\n",
  );
}

/** Sign in through the real form and land on the review queue. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // ⚠ Blank the field before any failure artefact can snapshot it — Playwright's
  // `error-context.md` records input VALUES. Same guard as `journey.spec.ts`.
  await page
    .locator('input[name="password"]')
    .evaluate((el) => {
      (el as HTMLInputElement).value = '';
    })
    .catch(() => {});
  await page.waitForURL('**/');
}

test.describe.configure({ mode: 'serial' });

test.describe('revisión — el camino de la decisión', () => {
  test.skip(!db.ok, 'no database access; see the banner above');

  let heldId: number;
  let orgId: number;
  let ns: string;

  test.beforeAll(() => {
    const { email } = adminCredentials();

    // The reviewer's own ecosistema, found through their membership rather than
    // assumed to be id 1 — a reseeded stack renumbers everything.
    const [who] = query<{ user_id: number; organization_id: number }>(
      `select m.user_id, m.organization_id
         from memberships m join users u on u.id = m.user_id
        where u.email = :'email'
        order by m.id limit 1`,
      { email },
    );
    if (!who) throw new Error(`[e2e] ${email} has no membership to seed a hold into.`);
    orgId = who.organization_id;

    ns = `e2e-web-${Date.now().toString(36)}`;

    // 🔴 Inserted directly because the gate's own columns are `gateWritesOnly`
    // and no API caller may set them. Everything else is left at its column
    // default, so this row is an ordinary draft document that happens to be
    // held — which is exactly what the gate produces.
    heldId = Number(
      insertReturning(
        `insert into documents
           (organization_id, uploaded_by_id, name, kind, mode, content_kind,
            publication_status, extracted_text,
            anonymisation_status, anonymisation_error, anonymisation_report,
            held_text, anonymisation_survivors)
         values
           (:'org', :'user', :'name', 'markdown', 'rag-retrieve', 'testimonio',
            'draft', :'original',
            'held', :'err', :'report'::jsonb,
            :'held', :'survivors'::jsonb)
         returning id`,
        {
          org: orgId,
          user: who.user_id,
          name: `${ns} hold fixture`,
          original: ORIGINAL_TEXT,
          err: 'verify: La verificacion encontro 2 datos que todavia identifican a una persona.',
          report: JSON.stringify({ stage: 'verify', removed: { persona: 1, contacto: 1 } }),
          held: HELD_TEXT,
          survivors: JSON.stringify(survivorSpans()),
        },
      ),
    );
  });

  // ── the queue ──────────────────────────────────────────────────────────────

  test('the queue lists the hold, and shows no text on the way past', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto('/revision');

    await expect(page.getByRole('heading', { name: 'Documentos retenidos' })).toBeVisible();

    const row = page.getByTestId('hold-queue').locator('li', { has: page.getByRole('link') })
      .filter({ has: page.locator(`a[href="/revision/${heldId}"]`) });
    await expect(row).toHaveCount(1);

    // 🔴 THE PRIVACY CONTRACT OF THE LIST. A reviewer sees this page before
    // deciding they are the right person to read the document, so the queue
    // must not leak the text — nor the uploader's own title, which is why the
    // link says `Testimonio retenido` and not the row's `name`.
    await expect(row.getByRole('link')).toHaveText('Testimonio retenido');
    const queueText = (await page.getByTestId('hold-queue').textContent()) ?? '';
    expect(queueText).not.toContain('Lupita');
    expect(queueText).not.toContain('55 4821 9930');
    expect(queueText).not.toContain(ns);

    // It says the count without saying what was found.
    await expect(row).toContainText('2 datos señalados');
  });

  // ── the document ───────────────────────────────────────────────────────────

  test('the detail page highlights exactly the identifiers the gate flagged', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto(`/revision/${heldId}`);

    await expect(page.getByTestId('hold-title')).toHaveText('Testimonio retenido');

    // 🔴 THE HIGHLIGHTS ARE THE WHOLE POINT OF THE PAGE. `{start,end}` offsets
    // that are off by even one character tell a reviewer that a harmless word
    // is the thing still identifying someone. Read back off the rendered DOM.
    const marks = page.getByTestId('hold-text').locator('mark');
    await expect(marks).toHaveText(SURVIVORS.map((s) => s.text));

    // The reviewer is reading the REDACTION, never the upload. `extractedText`
    // is the raw text as it arrived, and it must not be anywhere on this page.
    //
    // ⚠ Probed with a SENTENCE out of the original, not with a placeholder like
    // `[Domicilio 1]`. The page's own notice explains the placeholders BY NAME
    // ("aparecen como [Persona 1], [Domicilio 1] o [Dato omitido]"), so a
    // placeholder-shaped probe matches the help text and fails on copy that is
    // doing exactly the right thing.
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toContain(ORIGINAL_SENTINEL);
    expect(body).toContain('[Persona A]');

    // 🔴 THE CATEGORIES ARE NAMED IN PLAIN SPANISH, NEVER AS MACHINE LABELS.
    // The detector's own vocabulary is `persona` / `contacto`; a reviewer is
    // told "Nombre de una persona" and "Teléfono o correo". Asserted as the
    // EXACT chip list rather than as an absence, because `persona` is a
    // substring of its own Spanish label and "does not contain" can never
    // separate the two.
    await expect(page.getByTestId('hold-survivors').locator('li')).toHaveText([
      'Nombre de una persona · 1',
      'Teléfono o correo · 1',
    ]);
  });

  /**
   * 🔴 THE CONFIRMATION MUST ACTUALLY WITHHOLD THE DECISION. Both first-press
   * buttons are `type="button"`: they only reveal the consequence. If either
   * ever became a submit, one stray click would put unredacted text into a
   * shared corpus that has no per-document delete.
   */
  test('one press explains the consequence; it does not decide', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto(`/revision/${heldId}`);

    await page.getByTestId('hold-approve').click();
    await expect(page.getByTestId('hold-confirm-approve')).toContainText(APPROVE_CONFIRM);
    await expect(page.getByTestId('hold-confirm-approve')).toContainText(
      'Queda registrado que tú lo aprobaste',
    );
    // Still on the document, and still held.
    await expect(page).toHaveURL(new RegExp(`/revision/${heldId}$`));

    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('hold-confirm-approve')).toHaveCount(0);

    // The same for the destructive half, whose sentence has to be blunter.
    await page.getByTestId('hold-reject').click();
    await expect(page.getByTestId('hold-confirm-reject')).toContainText(REJECT_CONFIRM);
    await expect(page.getByTestId('hold-confirm-reject')).toContainText('Esto no se puede deshacer.');
    await page.getByRole('button', { name: 'Cancelar' }).click();

    // Nothing moved: the row is still held after all that pressing.
    const [row] = query<{ anonymisation_status: string }>(
      `select anonymisation_status from documents where id = :'id'`,
      { id: heldId },
    );
    expect(row.anonymisation_status).toBe('held');
  });

  test('editing the text retracts the highlights, and says why', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto(`/revision/${heldId}`);

    await page.getByRole('button', { name: 'Corregir el texto' }).click();
    const editor = page.getByTestId('hold-editor');
    await expect(editor).toHaveValue(HELD_TEXT);

    await editor.fill(HELD_TEXT.replace('Lupita', '[Persona B]'));

    // ⚠ The offsets described the text as it was SHOWN. Once the reviewer edits
    // it they point at the wrong characters, so the app drops them rather than
    // drawing marks that have quietly stopped being true.
    await expect(page.getByTestId('hold-stale')).toContainText(
      'ya no marcamos dónde estaban los datos',
    );
    await expect(page.getByTestId('hold-text')).toHaveCount(0);
  });

  // ── the decision ───────────────────────────────────────────────────────────

  /**
   * 🔴 TERMINAL, AND THE TEST THIS FILE EXISTS FOR. It runs last, and only ever
   * against the row seeded in `beforeAll`.
   */
  test('approving releases the corrected text and empties the queue', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);
    await page.goto(`/revision/${heldId}`);

    const corrected = HELD_TEXT.replace('Lupita', '[Persona B]').replace(
      '55 4821 9930',
      '[Teléfono omitido]',
    );

    await page.getByRole('button', { name: 'Corregir el texto' }).click();
    await page.getByTestId('hold-editor').fill(corrected);
    await page.locator('#hold-note').fill('e2e: quité el nombre y el teléfono que quedaron.');

    await page.getByTestId('hold-approve').click();
    await page
      .getByTestId('hold-confirm-approve')
      .getByRole('button', { name: APPROVE_LABEL })
      .click();

    // The redirect names the outcome in the URL, and the queue says it in words.
    await page.waitForURL('**/revision?hecho=approved');
    await expect(page.getByTestId('hold-done')).toHaveText(APPROVED_TOAST);

    // 🔴 The document has LEFT the queue. A decided hold that still appears is
    // an invitation to decide it twice.
    await expect(page.locator(`a[href="/revision/${heldId}"]`)).toHaveCount(0);

    // ── and in Postgres ──────────────────────────────────────────────────
    const [row] = query<{
      anonymisation_status: string;
      redacted_text: string | null;
      held_text: string | null;
      anonymisation_survivors: unknown;
    }>(
      `select anonymisation_status, redacted_text, held_text, anonymisation_survivors
         from documents where id = :'id'`,
      { id: heldId },
    );
    expect(row.anonymisation_status).toBe('approved');
    // 🔴 The REVIEWER'S text is what will be embedded, not the gate's output.
    expect(row.redacted_text).toBe(corrected);
    // The refused text existed only for the review, and is gone.
    expect(row.held_text).toBeNull();
    expect(row.anonymisation_survivors).toBeNull();

    // The audit row names a person, and it is written for real.
    const [audit] = query<{ decision: string; text_edited: boolean; note: string | null }>(
      `select decision, text_edited, note from anonymisation_reviews where document_id = :'id'`,
      { id: heldId },
    );
    expect(audit.decision).toBe('approved');
    expect(audit.text_edited).toBe(true);
    expect(audit.note).toContain('e2e:');
  });

  test('a decided document can no longer be opened', async ({ page }) => {
    const { email, password } = adminCredentials();
    await signIn(page, email, password);

    /**
     * ⚠ NOT ASSERTED AS AN HTTP 404, AND THAT IS NOT AN OVERSIGHT.
     * `src/routes/+layout.ts` sets `ssr = false` for the whole app (only
     * `/sign-in` and `/sign-up` opt back in), so every page route answers with
     * a 200 shell and the server `load` reaches the browser as data. Measured:
     * `/revision/<decided id>`, `/revision/<id that never existed>` and their
     * `__data.json` companions ALL return 200 — the `error(404)` from
     * `notFound()` is rendered, never transmitted as a status.
     *
     * So the observable contract here is the PAGE, and that is what is checked:
     * the code, the sentence, and the way back.
     */
    await page.goto(`/revision/${heldId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('main')).toContainText('404');
    // 🔴 The sentence must not claim the document never existed — a reviewer who
    // just decided it would read that as data loss.
    await expect(page.getByText('No encontramos este documento retenido.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver a la lista' })).toBeVisible();
  });

  // ── the gate on the section itself ─────────────────────────────────────────

  /**
   * `member` does not carry `holds:review`. The backend already refuses them —
   * `apps/backend/e2e/holds.e2e.ts` proves that on the wire. What only a browser
   * can show is that they are told so on a page, and that the nav does not
   * advertise a section they cannot open.
   */
  test('someone without holds:review is refused, and is not offered the section', async ({
    page,
  }) => {
    const { email, password } = adminCredentials();

    // Provisioned through the backend's own REST API by the admin: sign-up is
    // closed (UX backlog #6), exactly as `world.ts` does it.
    const login = await fetch(`${backendUrl}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const adminToken = (await login.json()).token as string;

    const memberEmail = `${ns}-member@e2e.local`;
    const memberPassword = `E2e-${Math.random().toString(36).slice(2)}-Aa1`;
    const created = await fetch(`${backendUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${adminToken}` },
      body: JSON.stringify({
        email: memberEmail,
        password: memberPassword,
        displayName: 'E2E revisión member',
      }),
    });
    const memberId = (await created.json()).doc.id as number;

    await fetch(`${backendUrl}/api/memberships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${adminToken}` },
      body: JSON.stringify({ user: memberId, organization: orgId, role: 'member' }),
    });

    await signIn(page, memberEmail, memberPassword);

    // Asserted on the rendered page, not on a status — see the note on the 404
    // test above for why `ssr = false` makes the status meaningless here.
    await page.goto('/revision');
    await expect(page.locator('main')).toContainText('403');
    await expect(page.getByText(NOT_A_REVIEWER)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al chat' })).toBeVisible();

    // …and the way in was never shown to them.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Revisión' })).toHaveCount(0);
  });

  // ── the fixture this suite must not spend ──────────────────────────────────

  /**
   * ⚠ A GUARD, NOT A FEATURE TEST. There is a hand-made held document in the
   * shared dev database that a person needs to stay held; it was consumed once
   * by a suite that decided on whatever it found. This asserts that running
   * this file did not do that again.
   */
  test('leaves every hold it did not create still held', () => {
    const others = query<{ id: number; anonymisation_status: string }>(
      `select id, anonymisation_status from documents
        where held_text is not null and id <> :'id'`,
      { id: heldId },
    );
    for (const row of others) {
      expect(row.anonymisation_status, `document ${row.id} was decided by this run`).toBe('held');
    }
  });
});
