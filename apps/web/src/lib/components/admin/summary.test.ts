import { describe, expect, it } from 'vitest';

import {
  aggregateContributors,
  filterDocs,
  filterEcosystems,
  foldText,
  formatDay,
  isPlatformAdmin,
  kindLabel,
  lowScoreHeadline,
  MIN_LOW_SCORES_FOR_HEADLINE,
  parseDocRow,
  plural,
  parseRatingRow,
  reasonLabel,
  relationId,
  share,
  summarizeAudio,
  summarizeDocuments,
  summarizeRatings,
  formatCostUsd,
  budgetLine,
  formatSpan,
  parseUsageSummary,
  shortModelName,
  type AdminDocRow,
  type AdminPerson,
  type AdminRatingRow,
} from './summary';

/**
 * The admin view's arithmetic and its Spanish.
 *
 * ⚠ NOTHING HERE IS RENDERED. vitest runs in `node` with no DOM in this repo,
 * so the `.svelte` files under `admin/` are UNVERIFIED by this suite — that is
 * exactly why every rule worth keeping was pushed down into `summary.ts` and
 * is asserted here instead.
 */

function doc(over: Partial<AdminDocRow> = {}): AdminDocRow {
  return {
    id: 'd1',
    title: 'Doc',
    kind: 'pdf',
    uploaderId: 'u1',
    createdAt: '2026-08-01T00:00:00.000Z',
    publicationStatus: 'draft',
    ingestStatus: 'ready',
    audioMeta: null,
    transcriptChars: null,
    ...over,
  };
}

function person(over: Partial<AdminPerson> = {}): AdminPerson {
  return { id: 'u1', name: 'Ana', email: null, role: 'member', isMember: true, ...over };
}

function rating(stars: number, reason: string | null = null, userId = 'u1'): AdminRatingRow {
  return { stars, reason, userId };
}

describe('isPlatformAdmin', () => {
  it('accepts only the literal true', () => {
    expect(isPlatformAdmin({ isPlatformAdmin: true })).toBe(true);
    expect(isPlatformAdmin({ isPlatformAdmin: 'true' })).toBe(false);
    expect(isPlatformAdmin({ isPlatformAdmin: 1 })).toBe(false);
  });

  it('denies anything that is not a user object', () => {
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
    expect(isPlatformAdmin({})).toBe(false);
    expect(isPlatformAdmin('admin')).toBe(false);
  });
});

describe('relationId', () => {
  it('reads ids off scalars and depth>0 objects alike', () => {
    expect(relationId(7)).toBe('7');
    expect(relationId('7')).toBe('7');
    expect(relationId({ id: 7 })).toBe('7');
    expect(relationId(null)).toBe('');
    expect(relationId({})).toBe('');
  });
});

describe('parseDocRow', () => {
  it('reads a Payload row', () => {
    const row = parseDocRow({
      id: 72,
      name: '  Acta.pdf ',
      kind: 'pdf',
      uploadedBy: 3,
      publicationStatus: 'published',
      ingestStatus: 'ready',
      createdAt: '2026-08-27T15:02:06.563Z',
      audioMeta: null,
    });
    expect(row).toMatchObject({
      id: '72',
      title: 'Acta.pdf',
      kind: 'pdf',
      uploaderId: '3',
      publicationStatus: 'published',
      ingestStatus: 'ready',
    });
  });

  it('falls back to the private reading when the status is unknown', () => {
    // Same asymmetry `parsePublicationStatus` documents: calling a draft
    // "published" is the dangerous direction.
    expect(parseDocRow({ id: 1, publicationStatus: 'weird' })?.publicationStatus).toBe('draft');
    expect(parseDocRow({ id: 1, ingestStatus: 'weird' })?.ingestStatus).toBe('n/a');
  });

  it('keeps a row with missing fields, drops one with no id', () => {
    expect(parseDocRow({ id: 1 })?.title).toBe('Sin título');
    expect(parseDocRow({ name: 'huérfano' })).toBeNull();
    expect(parseDocRow(null)).toBeNull();
  });

  it('reads audio metadata and ignores garbage in it', () => {
    const row = parseDocRow({
      id: 1,
      kind: 'audio',
      audioMeta: { durationSeconds: 45, language: 'es', segmentCount: 'seven' },
    });
    expect(row?.audioMeta?.durationSeconds).toBe(45);
    expect(row?.audioMeta?.language).toBe('es');
    expect(row?.audioMeta?.segmentCount).toBeNull();
  });

  it('never carries document text', () => {
    const row = parseDocRow({ id: 1, extractedText: 'secreto' }) as unknown as Record<string, unknown>;
    expect(Object.values(row)).not.toContain('secreto');
  });
});

describe('parseRatingRow', () => {
  it('drops scores that are not whole 1-5', () => {
    expect(parseRatingRow({ stars: 4.5 })).toBeNull();
    expect(parseRatingRow({ stars: 0 })).toBeNull();
    expect(parseRatingRow({ stars: 6 })).toBeNull();
    expect(parseRatingRow({ stars: 3, user: 2 })).toEqual({ stars: 3, reason: null, userId: '2' });
  });
});

describe('labels', () => {
  it('names the kinds in Spanish', () => {
    expect(kindLabel('pdf')).toBe('PDF');
    expect(kindLabel('docx')).toBe('Word');
    expect(kindLabel('audio')).toBe('Audio');
    expect(kindLabel('markdown')).toBe('Nota');
  });

  it('uses the app’s own reason wording', () => {
    expect(reasonLabel('not-grounded')).toBe('Cita algo que la fuente no dice');
    expect(reasonLabel('clear')).toBe('Se entiende bien');
    expect(reasonLabel('other')).toBe('Otro');
  });

  it('shows an unknown reason instead of hiding it', () => {
    // A reason the backend added and the frontend has not learned must stay
    // countable — folding it into "Otro" hides the signal the page is for.
    expect(reasonLabel('brand-new-reason')).toBe('brand-new-reason');
  });

  it('agrees in number, so the copy does not read as machine output', () => {
    expect(plural(1, 'persona', 'personas')).toBe('1 persona');
    expect(plural(0, 'persona', 'personas')).toBe('0 personas');
    expect(plural(26, 'documento', 'documentos')).toBe('26 documentos');
  });

  it('formats a day, and survives a bad date', () => {
    expect(formatDay('2026-08-27T15:02:06.563Z')).toMatch(/2026/);
    expect(formatDay('not a date')).toBe('');
    expect(formatDay(null)).toBe('');
  });
});

describe('share', () => {
  it('rounds to whole percents', () => {
    expect(share(1, 3)).toBe(33);
    expect(share(41, 100)).toBe(41);
  });

  it('returns null rather than 0 % of nothing', () => {
    expect(share(0, 0)).toBeNull();
    expect(share(3, -1)).toBeNull();
  });
});

describe('summarizeDocuments', () => {
  it('splits published from everything else', () => {
    const s = summarizeDocuments([
      doc({ id: '1', publicationStatus: 'published' }),
      doc({ id: '2', publicationStatus: 'draft' }),
      doc({ id: '3', publicationStatus: 'publishing' }),
      doc({ id: '4', publicationStatus: 'failed' }),
    ]);
    // Only `published` is shared; publishing and failed are still private.
    expect(s.published).toBe(1);
    expect(s.drafts).toBe(3);
    expect(s.total).toBe(4);
  });

  it('separates a failed pipeline from one still running', () => {
    const s = summarizeDocuments([
      doc({ id: '1', ingestStatus: 'failed' }),
      doc({ id: '2', ingestStatus: 'transcribing' }),
      doc({ id: '3', ingestStatus: 'ready' }),
      doc({ id: '4', ingestStatus: 'n/a' }),
    ]);
    expect(s.failed).toBe(1);
    expect(s.inProgress).toBe(1);
  });

  it('counts by kind', () => {
    const s = summarizeDocuments([doc({ id: '1', kind: 'audio' }), doc({ id: '2', kind: 'pdf' })]);
    expect(s.byKind).toEqual({ audio: 1, pdf: 1, docx: 0, markdown: 0 });
  });
});

describe('aggregateContributors', () => {
  it('counts each person’s uploads, published and draft', () => {
    const rows = aggregateContributors(
      [
        doc({ id: '1', uploaderId: 'u1', publicationStatus: 'published' }),
        doc({ id: '2', uploaderId: 'u1', kind: 'audio' }),
        doc({ id: '3', uploaderId: 'u2' }),
      ],
      [person({ id: 'u1', name: 'Ana' }), person({ id: 'u2', name: 'Beto' })],
    );
    expect(rows[0]).toMatchObject({ total: 2, published: 1, drafts: 1, audio: 1 });
    expect(rows[0]!.person.name).toBe('Ana');
    expect(rows[1]!.total).toBe(1);
  });

  it('keeps members who have uploaded nothing, and sorts them last', () => {
    // The point of the table: "12 of 14 people never uploaded anything" is the
    // fact a contributors-only list would hide.
    const rows = aggregateContributors(
      [doc({ uploaderId: 'u2' })],
      [person({ id: 'u1', name: 'Ana' }), person({ id: 'u2', name: 'Beto' })],
    );
    expect(rows.map((r) => r.person.name)).toEqual(['Beto', 'Ana']);
    expect(rows[1]!.total).toBe(0);
    expect(rows[1]!.lastAt).toBeNull();
  });

  it('still shows an uploader who is no longer a member, so the totals add up', () => {
    const rows = aggregateContributors([doc({ uploaderId: 'ghost' })], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person.isMember).toBe(false);
    expect(rows[0]!.total).toBe(1);
  });

  it('takes the latest upload date', () => {
    const rows = aggregateContributors(
      [
        doc({ id: '1', createdAt: '2026-01-01T00:00:00.000Z' }),
        doc({ id: '2', createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
      [person()],
    );
    expect(rows[0]!.lastAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('per-person totals add up to the document count', () => {
    const docs = [
      doc({ id: '1', uploaderId: 'u1' }),
      doc({ id: '2', uploaderId: 'u2' }),
      doc({ id: '3', uploaderId: 'ghost' }),
    ];
    const rows = aggregateContributors(docs, [person({ id: 'u1' }), person({ id: 'u2' })]);
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(docs.length);
  });
});

describe('summarizeAudio', () => {
  it('counts only audio, and totals the recorded time', () => {
    const s = summarizeAudio([
      doc({ id: '1', kind: 'audio', audioMeta: { durationSeconds: 45 }, ingestStatus: 'ready' }),
      doc({ id: '2', kind: 'audio', audioMeta: { durationSeconds: 75 }, ingestStatus: 'ready' }),
      doc({ id: '3', kind: 'pdf' }),
    ]);
    expect(s.total).toBe(2);
    expect(s.durationSeconds).toBe(120);
    expect(s.durationLabel).toBe('2 min');
  });

  it('treats `transcribed` and `embedding` as "the audio became text"', () => {
    // The hours-long part is done by then; the embedding that follows is
    // seconds, and is not what an admin is asking about.
    const s = summarizeAudio([
      doc({ id: '1', kind: 'audio', ingestStatus: 'transcribed' }),
      doc({ id: '2', kind: 'audio', ingestStatus: 'embedding' }),
      doc({ id: '3', kind: 'audio', ingestStatus: 'ready' }),
      doc({ id: '4', kind: 'audio', ingestStatus: 'transcribing' }),
      doc({ id: '5', kind: 'audio', ingestStatus: 'failed' }),
    ]);
    expect(s.transcribed).toBe(3);
    expect(s.inProgress).toBe(1);
    expect(s.failed).toBe(1);
  });

  it('sums the transcript sizes it was given', () => {
    const s = summarizeAudio([
      doc({ id: '1', kind: 'audio', transcriptChars: 473 }),
      doc({ id: '2', kind: 'audio', transcriptChars: 27 }),
    ]);
    expect(s.transcriptChars).toBe(500);
  });

  it('says nothing about duration when it knows none', () => {
    expect(summarizeAudio([doc({ kind: 'audio' })]).durationLabel).toBeNull();
  });
});

describe('summarizeRatings', () => {
  it('averages to one decimal and bins by score', () => {
    const s = summarizeRatings([rating(5), rating(4), rating(1)]);
    expect(s.total).toBe(3);
    expect(s.average).toBe(3.3);
    expect(s.byStars).toEqual([1, 0, 0, 1, 1]);
  });

  it('splits low from high at 4, same as the backend', () => {
    const s = summarizeRatings([rating(3), rating(4)]);
    expect(s.lowTotal).toBe(1);
    expect(s.highTotal).toBe(1);
  });

  it('computes each reason’s share of its OWN group', () => {
    // 41 of 100 low scores said `not-grounded`. Adding 5-star ratings must not
    // move that number — as a share of ALL ratings it would.
    const low = [
      ...Array.from({ length: 41 }, () => rating(2, 'not-grounded')),
      ...Array.from({ length: 59 }, () => rating(2, 'invented')),
    ];
    const s = summarizeRatings([...low, ...Array.from({ length: 200 }, () => rating(5, 'clear'))]);
    const top = s.lowReasons[0]!;
    expect(top.value).toBe('invented');
    expect(s.lowReasons.find((r) => r.value === 'not-grounded')?.share).toBe(41);
    expect(s.highReasons[0]).toMatchObject({ value: 'clear', count: 200, share: 100 });
  });

  it('divides by the group total, not by the ones that carry a reason', () => {
    // 1 reason out of 4 low scores is 25 %, not 100 %. The other reading
    // inflates every share the moment people stop picking one.
    const s = summarizeRatings([rating(1, 'invented'), rating(1), rating(2), rating(3)]);
    expect(s.lowReasons[0]!.share).toBe(25);
    expect(s.withoutReason).toBe(3);
  });

  it('counts distinct raters, not ratings', () => {
    const s = summarizeRatings([rating(5, null, 'u1'), rating(4, null, 'u1'), rating(3, null, 'u2')]);
    expect(s.raters).toBe(2);
  });

  it('is empty-safe', () => {
    const s = summarizeRatings([]);
    expect(s.average).toBeNull();
    expect(s.lowReasons).toEqual([]);
    expect(s.byStars).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('lowScoreHeadline', () => {
  it('names the most common complaint as a percentage', () => {
    const s = summarizeRatings(Array.from({ length: 10 }, () => rating(2, 'not-grounded')));
    expect(lowScoreHeadline(s)).toContain('100 %');
    expect(lowScoreHeadline(s)).toContain('Cita algo que la fuente no dice');
  });

  it('stays silent on a sample too small to describe', () => {
    // "100 % of low scores" off one rating is how a dashboard starts lying.
    const s = summarizeRatings(
      Array.from({ length: MIN_LOW_SCORES_FOR_HEADLINE - 1 }, () => rating(1, 'invented')),
    );
    expect(lowScoreHeadline(s)).toBeNull();
  });

  it('stays silent when nobody gave a reason', () => {
    const s = summarizeRatings(Array.from({ length: 9 }, () => rating(1)));
    expect(lowScoreHeadline(s)).toBeNull();
  });
});

describe('filterDocs / foldText', () => {
  const docs = [
    doc({ id: '1', title: 'Sesión de junta', kind: 'audio', publicationStatus: 'published' }),
    doc({ id: '2', title: 'Informe anual', kind: 'pdf', publicationStatus: 'draft' }),
    doc({ id: '3', title: 'Notas', kind: 'markdown', publicationStatus: 'publishing' }),
  ];

  it('ignores accents and case, because that is how people type', () => {
    expect(foldText('Sesión')).toBe('sesion');
    expect(filterDocs(docs, { kind: null, published: null, query: 'sesion' })).toHaveLength(1);
    expect(filterDocs(docs, { kind: null, published: null, query: 'SESIÓN' })).toHaveLength(1);
  });

  it('filters by kind', () => {
    expect(filterDocs(docs, { kind: 'audio', published: null, query: '' })).toHaveLength(1);
  });

  it('treats "not published" as everything that is not `published`', () => {
    const notPublished = filterDocs(docs, { kind: null, published: false, query: '' });
    expect(notPublished.map((d) => d.id)).toEqual(['2', '3']);
    expect(filterDocs(docs, { kind: null, published: true, query: '' }).map((d) => d.id)).toEqual([
      '1',
    ]);
  });

  it('combines filters', () => {
    expect(filterDocs(docs, { kind: 'pdf', published: false, query: 'anual' })).toHaveLength(1);
    expect(filterDocs(docs, { kind: 'pdf', published: true, query: 'anual' })).toHaveLength(0);
  });
});

/**
 * 🔴 FINDING ONE ECOSISTEMA AMONG ~90.
 *
 * The /admin selector lists EVERY ecosistema, because a platform admin reviews
 * all of them without belonging to any — and on this deployment nearly all of
 * them are e2e litter. Without a search that actually finds things the
 * oversight surface is a 90-row scroll, and nobody uses it.
 *
 * The server sends the whole list (ids, names, slugs — a few kB), so this runs
 * in the browser on every keystroke with no round trip.
 */
describe('filterEcosystems', () => {
  const rows = [
    { id: '1', name: 'Organización Demo', slug: 'demo' },
    { id: '2', name: 'Ecosistema Norte', slug: 'norte' },
    { id: '3', name: 'Prueba 41', slug: 'e2e-be-41' },
    { id: '4', name: 'Prueba 42', slug: 'e2e-be-42' },
    { id: '5', name: 'Sin clave', slug: null },
  ];

  it('an empty term is NO filter — not a filter that matches nothing', () => {
    expect(filterEcosystems(rows, '')).toHaveLength(5);
    expect(filterEcosystems(rows, '   ')).toHaveLength(5);
  });

  it('matches on the slug, which is the only readable half of the e2e litter', () => {
    expect(filterEcosystems(rows, 'e2e-be').map((r) => r.id)).toEqual(['3', '4']);
    expect(filterEcosystems(rows, 'e2e-be-42').map((r) => r.id)).toEqual(['4']);
  });

  it('matches on the name too', () => {
    expect(filterEcosystems(rows, 'norte').map((r) => r.id)).toEqual(['2']);
  });

  it('⚠ ignores accents — nobody types "Organización" with the accent', () => {
    expect(filterEcosystems(rows, 'organizacion').map((r) => r.id)).toEqual(['1']);
    expect(filterEcosystems(rows, 'ORGANIZACIÓN').map((r) => r.id)).toEqual(['1']);
  });

  it('tolerates a row with no slug', () => {
    expect(filterEcosystems(rows, 'sin clave').map((r) => r.id)).toEqual(['5']);
  });

  it('returns a copy, so a caller cannot mutate the list it was handed', () => {
    const out = filterEcosystems(rows, '');
    expect(out).not.toBe(rows);
  });

  it('an unmatched term returns nothing, and says so by being empty', () => {
    expect(filterEcosystems(rows, 'zzz')).toEqual([]);
  });
});

// ── Chat usage ─────────────────────────────────────────────────────────────

/**
 * 🔴 The usage aggregate is computed by the backend (`lib/chatUsage.ts`, where
 * its arithmetic is tested). This side only rebuilds it from the wire, and the
 * rebuild is the web's own door against text reaching the page.
 */
describe('parseUsageSummary', () => {
  const BODY = {
    ecosystem: { id: '7', name: 'Acme', slug: 'acme' },
    usage: {
      conversations: 28,
      conversationsWithMessages: 20,
      messages: 45,
      userTurns: 23,
      assistantTurns: 22,
      turnsPerConversation: 2.3,
      costUsd: 0.0094,
      pricedTurns: 22,
      unpricedTurns: 0,
      costIsComplete: true,
      costPerTurn: 0.00043,
      spans: { measured: 15, totalSeconds: 1185, averageSeconds: 79, longestSeconds: 400 },
      models: [{ name: 'deepseek/deepseek-chat-v3.1', turns: 22, costUsd: 0.0094, share: 100 }],
      providers: [{ name: 'openrouter', turns: 22, costUsd: 0.0094, share: 100 }],
      daily: [{ day: '2026-08-27', conversations: 3, messages: 9, costUsd: 0.002 }],
      firstAt: '2026-08-01T10:00:00.000Z',
      lastAt: '2026-08-27T21:55:55.137Z',
    },
  };

  it('reads the backend aggregate as-is', () => {
    const s = parseUsageSummary(BODY)!;
    expect(s.conversations).toBe(28);
    expect(s.costUsd).toBeCloseTo(0.0094);
    expect(s.spans.averageSeconds).toBe(79);
    expect(s.models[0]!.name).toBe('deepseek/deepseek-chat-v3.1');
    expect(s.daily).toEqual(BODY.usage.daily);
  });

  it('🔴 drops anything it does not know, so text cannot ride along', () => {
    const leaky = {
      ...BODY,
      usage: {
        ...BODY.usage,
        content: 'El presupuesto participativo es de 1,250,000 pesos.',
        sessions: [{ title: '¿Cuánto cobra la regidora?' }],
        daily: [{ ...BODY.usage.daily[0], day: 'Acta de la sesión' }],
        models: [{ name: 'x'.repeat(500), turns: 1 }],
      },
    };
    const serialized = JSON.stringify(parseUsageSummary(leaky));
    expect(serialized).not.toContain('presupuesto');
    expect(serialized).not.toContain('regidora');
    expect(serialized).not.toContain('Acta');
    expect(serialized).not.toContain('xxxxx');
  });

  it('re-derives completeness from the unpriced count rather than trusting a flag', () => {
    const s = parseUsageSummary({ usage: { ...BODY.usage, unpricedTurns: 2, costIsComplete: true } })!;
    expect(s.costIsComplete).toBe(false);
  });

  it('returns null for something that is not a usage body — never a zero', () => {
    expect(parseUsageSummary(null)).toBeNull();
    expect(parseUsageSummary({ errors: [{ message: 'No such ecosistema.' }] })).toBeNull();
  });
});

describe('formatCostUsd', () => {
  it('says USD out loud, because the figure is not pesos', () => {
    // 🔴 Relabelling dollars as MXN would change a number's meaning without
    // converting it — the worst thing a money field can do.
    expect(formatCostUsd(1.5)).toBe('$1.50 USD');
  });

  it('keeps four decimals below a cent, instead of reporting zero', () => {
    expect(formatCostUsd(0.00936)).toBe('$0.0094 USD');
  });

  it('renders nothing as $0.00 USD, not NaN', () => {
    expect(formatCostUsd(0)).toBe('$0.00 USD');
    expect(formatCostUsd(Number.NaN)).toBe('$0.00 USD');
  });
});

describe('formatSpan', () => {
  it('⚠ keeps seconds — most conversations are shorter than a minute', () => {
    expect(formatSpan(45)).toBe('45 s');
    expect(formatSpan(0)).toBe('0 s');
  });

  it('⚠ keeps the seconds below an hour, so 79 s does not read as "1 min"', () => {
    // "1 min" next to "2 min" looks like a doubling; they are 40 s apart.
    expect(formatSpan(79)).toBe('1 min 19 s');
    expect(formatSpan(747)).toBe('12 min 27 s');
    expect(formatSpan(120)).toBe('2 min');
  });

  it('drops the seconds past an hour, where they stop meaning anything', () => {
    expect(formatSpan(3600)).toBe('1 h');
    expect(formatSpan(7500)).toBe('2 h 5 min');
  });

  it('returns null when there is nothing to say', () => {
    expect(formatSpan(null)).toBeNull();
    expect(formatSpan(-1)).toBeNull();
  });
});

describe('shortModelName', () => {
  it('drops the vendor prefix for a narrow column', () => {
    expect(shortModelName('deepseek/deepseek-chat-v3.1')).toBe('deepseek-chat-v3.1');
  });

  it('leaves a bare name, and a trailing slash, alone', () => {
    expect(shortModelName('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(shortModelName('vendor/')).toBe('vendor/');
  });
});

describe('budgetLine (C-6)', () => {
  it('shows spent of limit, with the share', () => {
    expect(
      budgetLine({ ok: true, limitUsd: 10, spentUsd: 1.5, remainingUsd: 8.5, currency: 'USD' }),
    ).toBe('$1.50 USD de $10.00 USD (15 %)');
  });
  it('shows nothing for a failed or missing read', () => {
    expect(budgetLine({ ok: false })).toBeNull();
    expect(budgetLine(null)).toBeNull();
  });
  it('omits the share when the limit is zero', () => {
    expect(budgetLine({ ok: true, limitUsd: 0, spentUsd: 0, remainingUsd: 0, currency: 'USD' })).toBe(
      '$0.00 USD de $0.00 USD',
    );
  });
});
