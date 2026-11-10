/**
 * La biblioteca del ecosistema — the taxonomy, the copy, and the pure rules.
 *
 * Sibling of `$lib/publication.ts` and `$lib/ingest.ts`, same shape and same
 * reason: this repo has no DOM test environment, so anything that lives inside
 * a `.svelte` file cannot be covered by a unit test. The rules that matter here
 * — which kinds exist, which one is a testimonio, and what a card is allowed to
 * say about who contributed it — are exactly the ones a refactor would quietly
 * get wrong, so they live in a plain module that vitest can assert.
 *
 * ## 🔴 WHAT THIS SURFACE IS
 *
 * Everything the ecosistema has PUBLISHED, browsable by any member. It is not
 * "my documents" and it is not `/admin`:
 *
 *   · `/` (DocsPanel)  — one conversation's documents, drafts included, yours.
 *   · `/admin`         — every tenant's METADATA, for platform admins.
 *   · `/biblioteca`    — one ecosistema's PUBLISHED content, readable by its
 *                        members. This file.
 *
 * ## 🔴 DRAFTS ARE NOT LISTED HERE. NOT EVEN THE READER'S OWN.
 *
 * The filter is `publicationStatus = published`, applied in the backend query
 * (`$lib/server/biblioteca.ts`), never in the component. Two reasons, and the
 * second is the one that is easy to miss:
 *
 *  1. A list that mixes two privacy states teaches people to read it as one.
 *     Someone who finds their own draft on a page titled "lo que ha reunido tu
 *     ecosistema" will reasonably conclude that everyone else sees it too — and
 *     the drafts they never publish are the ones they most wanted private.
 *  2. `Documents.visibleToCaller` in the backend returns bare `true` for a
 *     platform admin. Leaning on access control to do the filtering would make
 *     this page show an admin every tenant's documents under one ecosistema's
 *     name, and it would look perfectly normal doing it.
 */

/**
 * The kinds a library row can have.
 *
 * ⚠ `testimonio` IS NOT IN `DocKind` (`$lib/types.ts`) YET. The backend model
 * for Voces is being added separately, and this page must not break in either
 * direction: before it lands, no row carries the value and the taxonomy is
 * simply unused; after it lands, rows carry it and are labelled correctly with
 * no change here. A kind we do not recognise degrades to `otro` rather than
 * being hidden — a document missing from the library is worse than one with a
 * dull label.
 */
export const LIBRARY_KINDS = [
  'testimonio',
  'audio',
  'pdf',
  'docx',
  'xlsx',
  'xls',
  'csv',
  'html',
  'markdown',
  'otro',
] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function parseLibraryKind(raw: unknown): LibraryKind {
  return typeof raw === 'string' && (LIBRARY_KINDS as readonly string[]).includes(raw)
    ? (raw as LibraryKind)
    : 'otro';
}

/**
 * 🔴 THE ONE PREDICATE THE ANONYMITY RULE HANGS OFF.
 *
 * A testimonio is a voice recorded ON BEHALF OF someone by an investigador, and
 * the system deliberately does not store who spoke. Every "who contributed
 * this?" decision in this file and in `$lib/server/biblioteca.ts` routes
 * through here, so the rule is one line to check rather than an audit.
 */
export function isTestimony(kind: LibraryKind): boolean {
  return kind === 'testimonio';
}

/**
 * 🔴 IS THIS ROW GATED CONTENT? Read off `contentKind`, NEVER off `kind`.
 *
 * Two different "kind"s live on a `documents` row (backend
 * `lib/contentKind.ts`): `kind` is the FILE FORMAT (`pdf | docx | audio |
 * markdown`) and `contentKind` is what the material IS (`documento |
 * testimonio | conversacion`). A Voz is usually `kind: 'audio'`,
 * `contentKind: 'testimonio'`. This page used to test `kind === 'testimonio'`,
 * which no row ever matches — so every testimony was shown with its uploader
 * and its filename. Found by the 2026-10-17 audit.
 *
 * ⚠ `!== 'documento'`, so it FAILS CLOSED: an unknown or missing
 * `contentKind` is treated as gated. The cost of that mistake is a neutral
 * title; the other mistake is a name on an anonymous testimony.
 */
export function isGatedContent(contentKind: unknown): boolean {
  return contentKind !== 'documento';
}

/**
 * The library kind of a row: `testimonio` from `contentKind`, else the format.
 */
export function libraryKindOf(row: { kind?: unknown; contentKind?: unknown }): LibraryKind {
  if (row.contentKind === 'testimonio') return 'testimonio';
  return parseLibraryKind(row.kind);
}

/**
 * The title a reader sees. Mirrors `titleFor` in the backend's
 * `lib/contentKind.ts`: gated content gets a NEUTRAL title, because `name` is
 * free text the uploader typed (usually the filename) and never went through
 * the anonymisation gate.
 */
export function libraryTitleFor(
  contentKind: unknown,
  name: unknown,
  topic: string | null = null,
  /**
   * 🔴 The row's gate columns (P-13/I-07/C-10, owner decision 2026-11-10). A
   * `documento` filed for anonymisation shows the gate's redacted title
   * (`anonymisationReport.redactedTitle`), else "Documento" — never `name`.
   * Absent = ungated, as the backend's `titleFor`.
   */
  gate?: { anonymise?: unknown; anonymisationReport?: unknown } | null,
): string {
  if (contentKind === 'testimonio') return testimonyLabel(topic);
  if (contentKind === 'conversacion') return 'Conversación';
  if (isGatedContent(contentKind)) return 'Documento sin título';
  if (gate && isGatedTitle(gate.anonymise)) return redactedTitleOf(gate.anonymisationReport) ?? 'Documento';
  return typeof name === 'string' && name.trim() ? name.trim() : 'Documento sin título';
}

/** {@link libraryTitleFor} over a `documents` row (kind, name and gate columns). */
export function libraryTitleOf(row: Record<string, unknown>, topic: string | null = null): string {
  return libraryTitleFor(row.contentKind, row.name, topic, row);
}

/**
 * A `documento` filed for anonymisation: backend `anonymiseRequested`,
 * anything but missing/null/false.
 */
export function isGatedDocumento(anonymise: unknown): boolean {
  return anonymise !== undefined && anonymise !== null && anonymise !== false;
}

/**
 * 🔴 Is a `documento`'s TITLE gated? Backend `titleIsGated`: a NULL counts as
 * gated (conservative, 2026-11-10); only an explicit `false` shows `name`.
 * 🔴 An absent key is gated too (fails closed: a partial row never shows the
 * filename). Title only: {@link isGatedDocumento} still decides the text.
 */
export function isGatedTitle(anonymise: unknown): boolean {
  return anonymise !== false;
}

/** The gate's redacted title on a report (backend `redactedTitleOf`), or null. */
export function redactedTitleOf(report: unknown): string | null {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  const t = (report as { redactedTitle?: unknown }).redactedTitle;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}

// ── Testimonio label and excerpt (owner ruling 2026-10-23) ─────────────────

/**
 * Plain names for the backend's `documents.tema` values (seed/corpus.ts).
 * Spelled like the four ecosistemas they map to, so a card in the library and
 * a source in chat read the same. An unknown value is shown as stored.
 */
const TEMA_LABELS: Record<string, string> = {
  dengue: 'Prevención del dengue',
  discapacidad: 'Discapacidad',
  traduccion: 'Traducción en salud',
  escuela: 'Acompañamiento escolar',
};

/**
 * The topic after "Testimonio ·": the row's `tema` when it has one, else the
 * ecosistema's name. Neither names a person (`tema` is one of four values,
 * readable on every row by backend design: `lenguaReadable` notes).
 */
export function testimonyTopic(tema: unknown, ecosystemName: unknown): string | null {
  const t = typeof tema === 'string' ? tema.trim() : '';
  if (t) return TEMA_LABELS[t] ?? t;
  const e = typeof ecosystemName === 'string' ? ecosystemName.trim() : '';
  return e || null;
}

/** `Testimonio · <topic>`, or plain `Testimonio` with no topic. */
export function testimonyLabel(topic: string | null | undefined): string {
  const t = typeof topic === 'string' ? topic.trim() : '';
  return t ? `Testimonio · ${t}` : 'Testimonio';
}

// ── System-proposed testimonio titles (owner ruling 2026-10-24) ─────────────

/**
 * A testimonio's generated title (backend `documents.testimonioTitle`, made
 * from the gate's REDACTED output), or `null` when absent or unusable.
 *
 * ⚠ Belt and braces over the backend's own check: a bracket means a
 * placeholder (`[Persona A]`) and is never shown; over 120 chars is not a title.
 */
export function generatedTestimonyTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120 || hasPlaceholder(t)) return null;
  return t;
}

/**
 * 🔴 Does `s` carry a redaction placeholder? Backend `anonymise/types.ts`
 * (`PLACEHOLDER_PATTERN`): `[Persona A]`, `[Domicilio B]`, `[Dato omitido]`.
 * Any bracket counts (a placeholder cut in half, or one added later), and so
 * do the words without brackets (backend `PLACEHOLDER_WORDS` in
 * `lib/testimonioTitle.ts`). "una persona mayor" does not: the letter after
 * Persona or Domicilio is upper case in every placeholder.
 */
export function hasPlaceholder(s: string): boolean {
  return (
    /[[\]]/.test(s) ||
    /(?<!\p{L})(?:[Pp]ersona|[Dd]omicilio)\s+\p{Lu}{1,3}(?!\p{L})|(?<!\p{L})[Dd]atos?\s+[Oo]mitidos?(?!\p{L})/u.test(s)
  );
}

/**
 * `2026-10-24T…` → `24 oct`: the short day under a testimonio's generated
 * title (owner ruling 2026-10-26). Empty string when unparseable. Fixed to
 * Mexico City so server and browser render the same day.
 */
export function shortDay(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return '';
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    timeZone: 'America/Mexico_City',
  }).format(d);
}

/**
 * What a testimonio card shows: the generated title with its short day under
 * it (owner ruling 2026-10-26; `TestimonySource` draws the source icon), or —
 * no title yet, or generation failed — "Testimonio · <topic>" alone.
 *
 * ⚠ `subtitle` is `''`, not `null`, for a generated title with no usable
 * date: `null` alone means "no generated title".
 */
export function testimonyHeading(
  generated: unknown,
  topic: string | null | undefined,
  createdAt: unknown = null,
): { title: string; subtitle: string | null } {
  const title = generatedTestimonyTitle(generated);
  return title ? { title, subtitle: shortDay(createdAt) } : { title: testimonyLabel(topic), subtitle: null };
}

/**
 * A document row as "Mis documentos" and the conversation panel show it.
 *
 * A testimonio with a system-proposed title shows that title, with its short
 * day under it; anything else keeps the name the backend let this caller read
 * (the uploader's own filename), with no subtitle.
 */
export function workingDocHeading(row: {
  name?: unknown;
  contentKind?: unknown;
  testimonioTitle?: unknown;
  createdAt?: unknown;
}): { title: string; subtitle: string | null } {
  const name = typeof row.name === 'string' && row.name ? row.name : 'Documento sin título';
  if (row.contentKind !== 'testimonio') return { title: name, subtitle: null };
  const generated = generatedTestimonyTitle(row.testimonioTitle);
  return generated ? { title: generated, subtitle: shortDay(row.createdAt) } : { title: name, subtitle: null };
}

/**
 * A testimonio chat source's title, the one string the card shows AND the
 * model reads on its `Título:` line (`sourceTitle` in
 * `$lib/server/engine/sources`).
 *
 * `<generated title> · <24 oct>` when the row has a generated title, else
 * the neutral `Testimonio · <ecosistema> · <24 oct>`, followed by
 * ` — «excerpt»` only when the excerpt is free of placeholders (owner ruling
 * 2026-10-28: a title cut from redacted text read "…en el [Domicilio A]…").
 * `metadata` carries `testimonioTitle` and `testimonioDate` (added per read,
 * `withTestimonioTitles`) and `excerpt` (`$lib/server/citationProvenance`).
 */
export function testimonySourceTitle(
  metadata: Record<string, unknown> | null | undefined,
  ecosystemName: string | null | undefined,
): string {
  const day = shortDay(metadata?.testimonioDate);
  const generated = generatedTestimonyTitle(metadata?.testimonioTitle);
  if (generated) return day ? `${generated} · ${day}` : generated;
  const label = testimonyLabel(testimonyTopic(null, ecosystemName));
  const neutral = day ? `${label} · ${day}` : label;
  const excerpt = typeof metadata?.excerpt === 'string' ? metadata.excerpt.trim() : '';
  return excerpt && !hasPlaceholder(excerpt) ? `${neutral} — «${excerpt}»` : neutral;
}

/**
 * The excerpt in a testimonio source's title: the first placeholder-free prose
 * line of a `published` testimonio passage ({@link excerptFrom}), else `null`.
 * One rule for the card (`$lib/server/citationProvenance`) and the model's
 * `Título:` line (`$lib/server/engine/sources`), so the two read the same.
 */
export function testimonySourceExcerpt(
  text: unknown,
  metadata: Record<string, unknown> | null | undefined,
  skipIntro: boolean,
): string | null {
  if (metadata?.kind !== 'testimonio' || metadata.publication !== 'published') return null;
  return excerptFrom(text, { skipIntro, placeholderFree: true });
}

/**
 * A chat source's title: a testimonio (`metadata.kind === 'testimonio'`, kept
 * by `$lib/server/citationProvenance`) reads {@link testimonySourceTitle};
 * anything else keeps its own title.
 *
 * ⚠ The ecosistema name, not `tema`: chunk metadata carries no `tema`, and
 * each ecosistema is one corpus topic (owner ruling, 4 ecosistemas). The
 * excerpt was cut server-side; this only joins strings, rendered as text.
 */
export function chatSourceTitle(
  title: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  ecosystemName: string | null | undefined,
): string | null | undefined {
  // 🔴 A known kind, never the title: a documento may be titled "Testimonio".
  if (metadata?.kind !== 'testimonio') return title;
  return testimonySourceTitle(metadata, ecosystemName);
}

/** The longest excerpt, "…" included. */
export const EXCERPT_MAX = 120;

/** Fewer words than this and a line is a heading, a date or a field, not prose. */
const EXCERPT_MIN_WORDS = 8;

/** `---`, `***`, `===`, `___`: a rule line. */
const RULE_LINE = /^\s*([-*_=])\1{2,}\s*$/;

/** `# `, `> `, `- `, `1. ` and emphasis markers at the start of a line. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(>\s*)+/, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/(\*\*|__)/g, '')
    // `[[enlace]]` / `[[destino|texto]]` read as their text, like the reader shows them.
    .replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_m, a: string, b?: string) => (b ?? a).trim())
    .trim();
}

/**
 * A speaker or field label (`E:`, `P:`, `Entrevistadora:`, `Lugar de origen:`):
 * one to four words before a colon. ⚠ Never a `[Persona A]` placeholder: the
 * label must start with a letter, and placeholders stay as they are.
 */
const SPEAKER_LABEL = /^\p{L}[\p{L}\d.()]*(?: [\p{L}\d.()]+){0,3}:\s+/u;

/**
 * All capitals once placeholders and parentheses are set aside, or before the
 * first ` — ` (`NOTAS DE CAMPO — [Persona A]`): a heading.
 */
function isShoutedHeading(line: string): boolean {
  const shouted = (s: string) => {
    const letters = s.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^\p{L}]/gu, '');
    return letters.length >= 4 && letters === letters.toUpperCase();
  };
  return shouted(line) || (line.includes(' — ') && shouted(line.split(' — ')[0]!));
}

/** A dateline (`Villa de Ayala, a 6 de marzo de 2026.`) or a diary date. */
const DATE_LINE = /\b\d{1,2} de \p{L}+ de \d{4}\.?$/u;

/** The interviewer's turn (`E:`, `Entrevistadora:`): not the testimonio's voice. */
const INTERVIEWER = /^(?:E|Entrevistador|Entrevistadora)\s*:/u;

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Cut at a word boundary to at most `max` chars, "…" included. Never leaves a
 * placeholder half open: `[Persona` becomes nothing rather than a fragment.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > 0) cut = cut.slice(0, space);
  const open = cut.lastIndexOf('[');
  if (open > cut.lastIndexOf(']')) cut = cut.slice(0, open);
  cut = cut.replace(/[\s,;:.—–-]+$/u, '');
  return `${cut}…`;
}

/**
 * The 11 languages of the seeded corpus (handoff R8; backend
 * `lib/graph/noise.ts` holds a longer list this app cannot import), plus
 * spelling variants. ⚠ For the excerpt's intro skip only. It is not an
 * anonymisation list: the gate decides what is redacted, never this.
 */
const INTRO_LANGUAGES = [
  'náhuatl', 'nahuatl', 'mixteco', 'mazateco', 'zapoteco', 'totonaco', 'tlahuica',
  'tlapaneco', "me'phaa", 'me’phaa', 'amuzgo', 'hñähñu', 'otomí', 'otomi', 'tsotsil',
  'tzotzil', 'mixe',
];

const INTRO_LINE = new RegExp(
  `(?<!\\p{L})(?:soy de|nací|naci|crecí hablando|años|${INTRO_LANGUAGES.join('|')})(?!\\p{L})`,
  'iu',
);

/**
 * A self-introduction: origin, language or age (`Soy de Chenalhó, Chiapas.
 * Crecí hablando tsotsil…`, `Nací hace 79 años en…`). The 10-23 audit measured
 * the first prose line was one of these on 59/59 raw seeded testimonios.
 */
export function isIntroLine(line: string): boolean {
  return INTRO_LINE.test(line);
}

/**
 * `BIBLIOTECA_EXCERPT_SKIP_INTRO`: off unless `true`, `1`, `on` or `yes`.
 * 🔴 Default OFF (owner ruling 2026-10-23, option A): the excerpt SHOWS the
 * first line, origin, language or age included ("its relevant demographics in
 * some cases"). The switch stays for turning the skip back on. Read by the
 * server callers only.
 */
export function parseSkipIntro(raw: string | undefined): boolean {
  return /^(true|1|on|yes)$/i.test((raw ?? '').trim());
}

export interface ExcerptOptions {
  max?: number;
  /** Skip self-introduction lines ({@link isIntroLine}). Default false. */
  skipIntro?: boolean;
  /**
   * Only a line with no placeholder ({@link hasPlaceholder}), else `null`.
   * For any excerpt a reader sees (chat title, Biblioteca card). Default false.
   */
  placeholderFree?: boolean;
}

/**
 * 🔴 A SHORT EXCERPT OF A TESTIMONIO, FROM ITS REDACTED TEXT ONLY.
 *
 * The caller passes the gate's `redactedText` (or a published chunk, which is
 * cut from it). Never `extractedText` or `bodyMarkdown`: those are the raw
 * original. This function cannot tell them apart, so the rule lives at the
 * call sites (`toLibraryItem`, `$lib/server/citationProvenance`).
 *
 * The first line that reads as prose: a header block closed by a rule line in
 * its first 15 lines is skipped (up to the last such rule), as are headings in
 * capitals, short lines (fields, salutations), datelines, lines with ` · `
 * (metadata), questions and the interviewer's turns. A leading speaker label
 * is dropped. With `skipIntro`, every self-introduction line is skipped too
 * ({@link isIntroLine}). With `placeholderFree`, every line with a placeholder
 * too. With no such line, the first non-empty line that is
 * neither a heading nor an intro; with none, null. Whitespace collapsed, then {@link clip}ped.
 *
 * Returns the text as plain text: render it with `{…}`, never `{@html}`.
 */
export function excerptFrom(text: unknown, opts: ExcerptOptions = {}): string | null {
  const max = opts.max ?? EXCERPT_MAX;
  const skipIntro = opts.skipIntro ?? false;
  if (typeof text !== 'string' || !text.trim()) return null;
  let lines = text.split(/\r?\n/);
  const head = lines.slice(0, 15);
  const rule = head.length - 1 - [...head].reverse().findIndex((l) => RULE_LINE.test(l));
  if (rule < head.length) lines = lines.slice(rule + 1);
  const cleaned = lines
    .filter((l) => !RULE_LINE.test(l))
    .map((l) => ({ heading: /^\s*#/.test(l), text: stripMarkdown(l).replace(/\s+/g, ' ') }))
    .filter((l) => /[\p{L}\p{N}]/u.test(l.text))
    .filter((l) => !(skipIntro && isIntroLine(l.text)))
    .filter((l) => !(opts.placeholderFree && hasPlaceholder(l.text)));
  const prose = cleaned.find(({ heading, text: t }) => {
    if (heading || isShoutedHeading(t) || t.includes(' · ') || /[?¿]$/.test(t)) return false;
    if (DATE_LINE.test(t) || INTERVIEWER.test(t)) return false;
    return wordCount(t.replace(SPEAKER_LABEL, '')) >= EXCERPT_MIN_WORDS;
  });
  const line = prose
    ? prose.text.replace(SPEAKER_LABEL, '')
    : cleaned.find((l) => !l.heading && !isShoutedHeading(l.text))?.text;
  return line ? clip(line.trim(), max) : null;
}

/**
 * 🔴 WHETHER A CONTRIBUTOR NAME MAY EXIST FOR THIS ROW AT ALL.
 *
 * Not "should the UI hide it" — whether the field is allowed to be populated.
 * The server drops `uploadedBy` before the row leaves the BFF (see
 * `$lib/server/biblioteca.ts`), so for a testimonio there is no name in the
 * response, nothing in the browser's memory, and no slot in the card. A UI that
 * merely declines to render a value it holds is one careless `{#if}` away from
 * publishing it.
 */
export function mayShowContributor(kind: LibraryKind): boolean {
  return !isTestimony(kind);
}

// ── Copy ───────────────────────────────────────────────────────────────────

export interface KindLabel {
  /** The chip on the card. Short, because it repeats on every row. */
  label: string;
  /** What this kind IS, in one sentence. `title=` and the reader header. */
  description: string;
  /** Drives the chip's colour class. Testimonies get their own tone. */
  tone: 'voice' | 'document';
}

/**
 * ⚠ A TESTIMONIO AND A DOCUMENTO MUST NOT LOOK THE SAME. They are different
 * kinds of source: one is a person's words, gathered and anonymised; the other
 * is a file somebody wrote. A reader deciding how much weight to give a passage
 * needs to know which they are looking at without guessing, so the difference
 * is a labelled chip with its own colour, not a subtle icon.
 */
export function kindLabel(kind: LibraryKind, opts: { fromAudio?: boolean } = {}): KindLabel {
  switch (kind) {
    case 'testimonio':
      // ⚠ A Voz can be a recording OR a PDF/DOCX. Saying "de viva voz" about a
      // written file was false (UX demo backlog #12). `fromAudio` is the file
      // format, set server-side in `toLibraryItem`.
      return {
        label: 'Voz',
        description: opts.fromAudio
          ? 'Testimonio grabado en audio. Es anónimo: no se guarda quién lo contó.'
          : 'Testimonio entregado por escrito. Es anónimo: no se guarda quién lo contó.',
        tone: 'voice',
      };
    case 'audio':
      return {
        label: 'Audio',
        description:
          'Grabación con transcripción automática. El texto lo escribió una máquina y puede contener errores.',
        tone: 'document',
      };
    case 'pdf':
      return { label: 'PDF', description: 'Documento en PDF.', tone: 'document' };
    case 'docx':
      return { label: 'DOCX', description: 'Documento de Word.', tone: 'document' };
    case 'xlsx':
      return { label: 'Excel', description: 'Hoja de cálculo de Excel.', tone: 'document' };
    case 'xls':
      return { label: 'Excel', description: 'Hoja de cálculo de Excel 97–2003.', tone: 'document' };
    case 'csv':
      return { label: 'CSV', description: 'Tabla en CSV.', tone: 'document' };
    case 'html':
      return { label: 'HTML', description: 'Página web.', tone: 'document' };
    case 'markdown':
      return {
        label: 'Nota',
        description: 'Nota escrita dentro de la aplicación.',
        tone: 'document',
      };
    case 'otro':
      return { label: 'Documento', description: 'Documento del ecosistema.', tone: 'document' };
  }
}

/**
 * ⚠ NOT OPTIONAL on a testimonio. The absence of a name is a DECISION, and an
 * absence that is not explained reads as an omission — a reader who sees no
 * author on one card and a name on the next assumes the data is incomplete and
 * goes looking. This says the quiet part: nobody knows, on purpose.
 */
export const TESTIMONY_ANONYMITY_NOTE = 'Testimonio anónimo';

/** The machine-transcription warning, reused verbatim from `$lib/ingest.ts`. */
export const LIBRARY_TRANSCRIPT_NOTE = 'Transcripción automática: puede tener errores.';

/**
 * 🔴 DOES THIS ROW'S TEXT COME FROM A MACHINE TRANSCRIPTION? Keyed on the FILE
 * FORMAT, not on "is it a Voz": a testimonio uploaded as a PDF was written by a
 * person, and labelling it machine-made was false (UX demo backlog #12). An
 * audio testimonio still gets the warning.
 */
export function isMachineTranscript(item: { kind: LibraryKind; fromAudio?: boolean }): boolean {
  return item.kind === 'audio' || item.fromAudio === true;
}

export const LIBRARY_EMPTY = 'Todavía no hay nada publicado en tu ecosistema.';

export const LIBRARY_NO_RESULTS = 'Ningún documento coincide con lo que buscas.';

export const LIBRARY_UNAVAILABLE = 'No pudimos leer la biblioteca. Inténtalo más tarde.';

// ── Filters ────────────────────────────────────────────────────────────────

/**
 * The kind filter, as it travels in the URL and on the wire.
 *
 * `todos` is a real value rather than "the parameter is absent", so the state
 * is always nameable and a bad value has somewhere safe to land.
 */
export const KIND_FILTERS = [
  'todos',
  'testimonio',
  'audio',
  'pdf',
  'docx',
  'hojas',
  'html',
  'markdown',
] as const;

export type KindFilter = (typeof KIND_FILTERS)[number];

export function parseKindFilter(raw: unknown): KindFilter {
  return typeof raw === 'string' && (KIND_FILTERS as readonly string[]).includes(raw)
    ? (raw as KindFilter)
    : 'todos';
}

export function kindFilterLabel(filter: KindFilter): string {
  switch (filter) {
    case 'todos':
      return 'Todo';
    case 'testimonio':
      return 'Voces';
    case 'audio':
      return 'Audios';
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'Word';
    case 'hojas':
      return 'Hojas de cálculo';
    case 'html':
      return 'Páginas web';
    case 'markdown':
      return 'Notas';
  }
}

/**
 * The backend `kind` values a filter selects, or `null` for "do not constrain".
 *
 * ⚠ `todos` returns null instead of listing every kind. A list would have to be
 * kept in step with a `kind` enum this app does not own — and the day the
 * backend adds a sixth kind, "Todo" would silently stop showing it.
 */
export function kindFilterValues(filter: KindFilter): string[] | null {
  if (filter === 'todos') return null;
  return filter === 'hojas' ? ['xlsx', 'xls', 'csv'] : [filter];
}

/**
 * The backend `where` pairs a filter adds, or none for `todos`.
 *
 * ⚠ `Voces` filters on `contentKind`, every other filter on the format AND on
 * `contentKind = documento`. A Voz is `kind: 'audio'`; without the second
 * clause the "Audios" filter would list testimonies too.
 */
export function kindFilterWhere(filter: KindFilter): Array<[string, string]> {
  if (filter === 'todos') return [];
  if (filter === 'testimonio') return [['where[contentKind][equals]', 'testimonio']];
  // Payload's `in` takes a comma-separated list.
  return [
    ['where[kind][in]', (kindFilterValues(filter) ?? []).join(',')],
    ['where[contentKind][equals]', 'documento'],
  ];
}

/**
 * Trim and cap a search term.
 *
 * ⚠ The cap is not cosmetic: the term is interpolated into a backend `like`
 * query, and an unbounded string from the URL is an unbounded string in a
 * database pattern match.
 */
export const MAX_SEARCH_LENGTH = 120;

export function normalizeSearch(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_SEARCH_LENGTH) : '';
}

// ── Reading a row ──────────────────────────────────────────────────────────

/** One row of the library, as the BFF hands it to the browser. */
export interface LibraryItem {
  id: string;
  title: string;
  kind: LibraryKind;
  /** Epoch ms. When it was published is not stored, so this is when it landed. */
  createdAt: number;
  updatedAt: number;
  /**
   * Who contributed it.
   *
   * 🔴 ALWAYS `null` FOR A TESTIMONIO, and null because the server never put a
   * value here — not because the card declines to render one. See
   * `mayShowContributor`.
   */
  contributor: string | null;
  /**
   * The language of the people this documento is about (`$lib/lengua.ts`).
   * 🔴 ALWAYS `null` on anything but a documento — set server-side, not hidden.
   */
  lengua: string | null;
  /** Duration / language chips, for `audio`. Absent otherwise. */
  audioMeta?: Record<string, unknown> | null;
  /**
   * The uploaded FILE was audio. Needed because `kind` says `testimonio` for
   * every Voz, whatever its format. Drives `isMachineTranscript`.
   */
  fromAudio: boolean;
  /**
   * A short line from a testimonio's REDACTED text ({@link excerptFrom}), cut
   * server-side. 🔴 `null` on anything else, and on a testimonio the gate has
   * not cleared. The full redacted text never rides the list.
   */
  excerpt: string | null;
  /**
   * The line under the title. For a testimonio with a system-proposed title,
   * its short day (`24 oct`, owner ruling 2026-10-26); `null` otherwise.
   */
  subtitle: string | null;
}

/** A full document, as the reader page gets it. */
export interface LibraryDocument extends LibraryItem {
  /** The document's text: the transcript for audio, the extraction otherwise. */
  text: string;
}

/**
 * Human summary of what the list is currently showing.
 *
 * Lives here rather than in the component because "27 documentos" vs "1
 * documento" vs "ninguno" is the kind of thing that reads fine until the day it
 * says "1 documentos".
 */
export function resultsSummary(input: {
  total: number;
  shown: number;
  filtered: boolean;
}): string {
  if (input.total === 0) return input.filtered ? LIBRARY_NO_RESULTS : LIBRARY_EMPTY;
  const noun = input.total === 1 ? 'publicación' : 'publicaciones';
  const total = input.total.toLocaleString('es-MX');
  // The pager says which page; "30 de 31" read as one item missing (demo pass).
  return `${total} ${noun}`;
}

/** `'hola que tal'` → `3 palabras`. Null for empty text. Mirrors ingest.ts. */
export function textStatsCopy(text: string | null | undefined): string | null {
  const words = typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  if (words === 0) return null;
  return words === 1 ? '1 palabra' : `${words.toLocaleString('es-MX')} palabras`;
}

/** `2026-08-15T…` → `15 de agosto de 2026`. Empty string when unparseable. */
export function formatLibraryDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(epochMs));
  } catch {
    return '';
  }
}
