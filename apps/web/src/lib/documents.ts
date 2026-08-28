/**
 * Reading Payload's `documents.session` relationship — pure, and shared by
 * BOTH halves of the app.
 *
 * 🔴 ONE DOCUMENT, MANY CONVERSATIONS. `documents.session` is a `hasMany`
 * relationship. Four surfaces now read it — the attach/detach route, the
 * conversation picker (`…/documents/available`), "Mis documentos"
 * (`/api/documentos`) and the browser store's `docFromBackend` — and every one
 * of them has to answer the same question: which ids are in this value.
 *
 * They each used to answer it with their own copy. That is a silent way to be
 * wrong: mis-read the value on a write and the document is quietly detached
 * from every conversation except the one being edited.
 *
 * ⚠ THIS MODULE IS DELIBERATELY NOT UNDER `$lib/server/`. The store needs it
 * too, and SvelteKit refuses to bundle `$lib/server/**` into client code — so
 * a server-only home would have forced the second copy straight back.
 */

/**
 * Every id in a `hasMany` relationship value, whatever shape Payload sent.
 *
 * ⚠ FOUR SHAPES, and they are not interchangeable. Payload hands this back as
 * a bare scalar (a row written before the field went plural), an array of ids
 * (`depth=0`), an array of populated rows (`depth>0`), or `null`. Normalising
 * before deciding anything is the difference between APPENDING to the list and
 * REPLACING it.
 */
export function relationIds(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') {
      out.push(String(item));
    } else if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string' || typeof id === 'number') out.push(String(id));
    }
  }
  return out;
}

/** One conversation a document is attached to, named so a person can recognise it. */
export interface AttachedSession {
  id: string;
  title: string;
}

/**
 * The same relationship value, but keeping the TITLES that `depth=1` populated.
 *
 * "Mis documentos" has to say WHERE a document is being used, and a list of
 * numeric ids says nothing to the person reading it. Rows that came back
 * unpopulated (a scalar, or `depth=0`) keep their id and get an EMPTY title —
 * the caller decides what to show rather than this inventing a name.
 */
export function relationSessions(raw: unknown): AttachedSession[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: AttachedSession[] = [];
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') {
      out.push({ id: String(item), title: '' });
    } else if (item && typeof item === 'object' && 'id' in item) {
      const row = item as { id?: unknown; title?: unknown };
      if (typeof row.id !== 'string' && typeof row.id !== 'number') continue;
      out.push({
        id: String(row.id),
        title: typeof row.title === 'string' ? row.title : '',
      });
    }
  }
  return out;
}

/**
 * Payload's relationship columns are `bigint` on the default Postgres adapter,
 * so a numeric id must go back on the wire as a NUMBER. Non-numeric ids (a
 * future uuid mode) pass through untouched.
 */
export function coerceRelationId(raw: string): number | string {
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

// ── Copy: "quitar" is not "eliminar", and it has to SAY where the document goes ──
//
// 🔴 THE WHOLE RISK ON A DOCUMENT ROW IS TWO ACTIONS THAT LOOK ALIKE. `Quitar`
// takes the document out of ONE conversation. `Eliminar` destroys it
// everywhere, forever. They sit next to each other because that is where a
// person looks for both, and the only thing keeping them apart is the words.
//
// The strings live here, not inline in the component, because this repo has no
// DOM test environment: a sentence inside a `.svelte` file cannot be asserted
// by anything but the Playwright journey. These are the sentences that must not
// drift.

/** Where a document with no conversation now lives. Used in several sentences. */
export const OWNED_DOCS_VIEW_NAME = 'Mis documentos';

/**
 * The confirmation for "Quitar de esta conversación".
 *
 * 🔴 TWO BRANCHES, because the honest answer is different.
 *
 * Detaching the LAST conversation used to be impossible in the UI: the action
 * only appeared on a document that was in two or more, so it could always
 * promise "sigue en las demás". That gate did not stop documents from ending up
 * in no conversation — a deleted conversation does it, and in the dev database
 * most documents were already there — it only stopped anyone from SEEING them.
 *
 * Now the action is always offered, and the copy carries the difference: when
 * this was the last conversation, the sentence has to name the place the
 * document lands. A person who is told only "se quita" will read it as "se
 * borra", and will keep a document in a conversation they do not want it in
 * rather than risk losing it.
 */
export function detachConfirmCopy(title: string, attachedCount: number): string {
  const head = `¿Quitar "${title}" de esta conversación?`;
  // `<= 1` rather than `=== 1`: a row whose relationship we could not read
  // reports 0, and the cautious sentence is the one that promises less.
  if (attachedCount <= 1) {
    // ⚠ The first sentence is a FACT, so it is only stated when we actually
    // know it. A count of 0 means the relationship could not be read, and the
    // rest of this branch is a promise ("no se borra", "lo vas a encontrar en
    // …") that holds either way.
    const only = attachedCount === 1 ? 'Es la única conversación donde lo estás usando.\n\n' : '';
    return (
      `${head}\n\n` +
      only +
      `El documento NO se borra. Lo vas a encontrar en "${OWNED_DOCS_VIEW_NAME}", ` +
      'y desde ahí puedes volver a usarlo en otra conversación cuando quieras.\n\n' +
      'Mientras no esté en ninguna conversación, el asistente no lo va a leer.'
    );
  }
  const others = attachedCount - 1;
  const rest =
    others === 1
      ? 'Sigue en la otra conversación donde lo agregaste'
      : `Sigue en las otras ${others} conversaciones donde lo agregaste`;
  return (
    `${head}\n\n` +
    `El documento NO se borra. ${rest}, y puedes volver a traerlo aquí cuando quieras.`
  );
}

/** Tooltip on the "Quitar" link. Same promise, short enough to hover. */
export function detachHintCopy(attachedCount: number): string {
  return attachedCount <= 1
    ? `Quitar el documento de esta conversación. NO se borra: lo vas a encontrar en "${OWNED_DOCS_VIEW_NAME}".`
    : 'Quitar el documento de esta conversación. NO se borra: sigue en las demás.';
}

/**
 * 🔴 THE SENTENCE "MIS DOCUMENTOS" EXISTS FOR.
 *
 * A document attached to no conversation is not broken and is not deleted — it
 * is simply not being read by anything. Nobody can guess that from a list, and
 * a person who does not know it will assume the assistant is using a file it
 * has never seen. It is stated on the row, not in a tooltip: a tooltip is a
 * thing you find only if you already suspected there was something to find.
 */
export const LOOSE_DOC_EXPLANATION =
  'No lo estás usando en ninguna conversación, así que el asistente no lo lee.';

/** What to do about it, in the order the buttons appear. */
export const LOOSE_DOC_OPTIONS =
  'Puedes agregarlo a una conversación, publicarlo para que lo tenga todo tu ecosistema, o eliminarlo.';

/** The confirmation for the destructive delete. Says what is lost. */
export function deleteConfirmCopy(title: string, attachedCount: number): string {
  const head = `¿Eliminar "${title}"?`;
  const where =
    attachedCount > 0
      ? attachedCount === 1
        ? '\n\nSe quita de la conversación donde lo estás usando.'
        : `\n\nSe quita de las ${attachedCount} conversaciones donde lo estás usando.`
      : '';
  // ⚠ The words that separate this from `detachConfirmCopy` are "para siempre"
  // and "no se puede deshacer" — NOT the case of a "no"/"sí". A pair of
  // confirmations whose only difference is `NO se borra` vs `SÍ se borra` is a
  // pair a tired reader, a screen reader, or a translator can flatten into one.
  return (
    `${head}\n\n` +
    'Esto lo borra para siempre.\n\n' +
    'Se elimina el documento y todo lo que el asistente aprendió de él. ' +
    'No se puede deshacer.' +
    where
  );
}
