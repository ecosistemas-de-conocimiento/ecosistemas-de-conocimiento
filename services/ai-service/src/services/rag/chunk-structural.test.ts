// Unit tests for the structural chunker and the strategy resolver.
//
// The assertions here are mostly about BOUNDARIES, because a boundary error is
// the one chunker bug that is invisible downstream: retrieval still returns
// something plausible, the citation still renders, and the passage simply
// belongs to a different section than the one being cited.
//
// Every pattern below is supplied BY THE TEST, which is the whole point: the
// module ships no presets and no document-format knowledge, so a test that
// reached for a built-in would be testing something that must not exist.

import { describe, expect, it, vi } from 'vitest';

import { maxChunkChars } from './chunk.js';
import { chunkForCorpus, parseStructuralConfig } from './chunk-strategy.js';
import { chunkStructural } from './chunk-structural.js';

/** A caller-supplied config, of exactly the shape that crosses the wire. */
const SECTIONS = {
  sections: [
    {
      key: 'section',
      pattern: String.raw`^[ \t]*(?:section|sec\.)[ \t]+(\d+(?:[ \t]*(?:bis|ter))?(?:[ \t]*[-–][ \t]*[a-z])?)\b`,
      flags: 'i',
    },
  ],
  subSections: [
    { key: 'clause', pattern: String.raw`^[ \t]*([IVXLCDM]{1,7})[ \t]*[.)\-–][ \t]`, flags: '' },
  ],
};

const DOC = `SYNTHETIC TEST DOCUMENT

Section 1. First provision of the document.

Section 2. Second provision of the document.

SECTION 3.- Uppercase variant with a dash.

Sec. 4 Abbreviated variant with no full stop.

Section 5 Bis. An insertion made after the fact.

Section 5 Ter. A second insertion.

Section 6-A. Variant with an alphabetic suffix.

section 7. Lowercase variant.
`;

describe('chunkStructural — caller-supplied section patterns', () => {
  const chunks = chunkStructural(DOC, SECTIONS);
  const ids = chunks.map((c) => c.metadata?.['section']).filter(Boolean);

  it('emits one chunk per section', () => {
    expect(ids).toEqual(['1', '2', '3', '4', '5 bis', '5 ter', '6-a', '7']);
  });

  it('keeps the preamble rather than dropping it', () => {
    expect(chunks[0]!.text).toContain('SYNTHETIC TEST DOCUMENT');
    expect(chunks[0]!.metadata?.['section']).toBeUndefined();
  });

  it('never splits one section across two chunks', () => {
    for (const c of chunks) {
      // Exactly one "Section N" header per chunk (the preamble has none).
      const headers = c.text.match(/^[ \t]*(?:section|sec\.)[ \t]+/gim) ?? [];
      expect(headers.length).toBeLessThanOrEqual(1);
    }
  });

  it('distinguishes 5 Bis from 5 and 6-A from 6', () => {
    const bis = chunks.find((c) => c.metadata?.['section'] === '5 bis');
    expect(bis?.text).toContain('after the fact');
    // Folding "5 Bis" into "5" is the classic failure; assert they are separate
    // units and that neither swallowed the other's body.
    expect(bis?.text).not.toContain('provision');
    const a6 = chunks.find((c) => c.metadata?.['section'] === '6-a');
    expect(a6?.text).toContain('alphabetic suffix');
  });

  it('normalises identifier spelling so 12  Bis and 12 bis agree', () => {
    const [a] = chunkStructural('Section 12  BIS. One.', SECTIONS);
    const [b] = chunkStructural('section 12 bis. One.', SECTIONS);
    expect(a!.metadata?.['section']).toBe('12 bis');
    expect(b!.metadata?.['section']).toBe('12 bis');
  });

  it('assigns contiguous ordinals', () => {
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('splits an oversize section at sub-section boundaries', () => {
    const body = Array.from(
      { length: 6 },
      (_, i) => `${['I', 'II', 'III', 'IV', 'V', 'VI'][i]}. ${'filler '.repeat(60)}`,
    ).join('\n');
    const out = chunkStructural(`Section 9. Heading.\n${body}`, {
      ...SECTIONS,
      maxChars: 500,
    });
    expect(out.length).toBeGreaterThan(1);
    // Every piece still knows which section it came from...
    for (const c of out) expect(c.metadata?.['section']).toBe('9');
    // ...and at least one records the sub-section it starts at, so a citation
    // can still be narrowed below the section level.
    expect(out.some((c) => typeof c.metadata?.['clause'] === 'string')).toBe(true);
    expect(out.every((c) => c.text.length <= 500)).toBe(true);
  });

  it('refuses to run without patterns rather than inventing a default', () => {
    // There is no built-in fallback structure to reach for. Anything else here
    // would mean the module holding an opinion about someone's documents.
    expect(() => chunkStructural('x', {})).toThrow(/requires a non-empty `sections` list/);
  });

  it('works with an entirely different structure — markdown headings', () => {
    const md = '# One\ntext one\n# Two\ntext two\n';
    const out = chunkStructural(md, {
      sections: [{ key: 'heading', pattern: String.raw`^#[ \t]+(.+)$` }],
      minChars: 0,
    });
    expect(out.map((c) => c.metadata?.['heading'])).toEqual(['one', 'two']);
  });
});

describe('chunkForCorpus — strategy resolution', () => {
  const base = { chunkSize: 800, chunkOverlap: 100 };

  it('uses the recursive splitter by default', () => {
    const out = chunkForCorpus(DOC, { ...base, chunkStrategy: 'recursive-char' });
    expect(out).toHaveLength(1);
    expect(out[0]!.metadata).toBeUndefined();
  });

  it('uses the structural splitter when configured', () => {
    const out = chunkForCorpus(DOC, {
      ...base,
      chunkStrategy: 'structural',
      chunkConfig: SECTIONS,
    });
    expect(out.length).toBeGreaterThan(5);
    expect(out.some((c) => c.metadata?.['section'] === '5 bis')).toBe(true);
  });

  it('falls back to recursive — with a warning — on an unknown strategy', () => {
    const warn = vi.fn();
    const out = chunkForCorpus(DOC, { ...base, chunkStrategy: 'nonsense' }, warn);
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown chunk_strategy'));
  });

  it('falls back rather than throwing when structural config is missing', () => {
    // A poison-pill config must not turn every ingest job for the corpus into
    // an infinite BullMQ retry loop.
    const warn = vi.fn();
    const out = chunkForCorpus(DOC, { ...base, chunkStrategy: 'structural' }, warn);
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no usable chunk_config'));
  });

  it('falls back when the structural strategy finds no structure in a big document', () => {
    const warn = vi.fn();
    const prose = 'Running text with no structure at all. '.repeat(400);
    const out = chunkForCorpus(
      prose,
      { chunkSize: 200, chunkOverlap: 20, chunkStrategy: 'structural', chunkConfig: SECTIONS },
      warn,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched no section boundaries'));
  });
});

describe('chunkForCorpus — chunk_size is a REAL ceiling for every strategy', () => {
  // Why this matters beyond ingestion: `/v1/retrieve` now clamps stored passage
  // text to `maxChunkChars(corpus.chunk_size)`. If a caller's `chunk_config`
  // could raise the ingestion ceiling above that number, retrieval would
  // truncate legitimately-ingested text and warn about a non-anomaly. So the
  // override may LOWER the ceiling, never raise it.
  const bigSection = (n: number) =>
    `Section ${n}. ` + `Filler prose for this section. `.repeat(60);
  const DOC_BIG = [1, 2, 3].map(bigSection).join('\n\n');

  it('clamps a chunk_config.maxChars that exceeds the corpus ceiling', () => {
    const warn = vi.fn();
    const chunkSize = 40; // 40 tokens => 160 chars
    const out = chunkForCorpus(
      DOC_BIG,
      {
        chunkSize,
        chunkOverlap: 4,
        chunkStrategy: 'structural',
        chunkConfig: { ...SECTIONS, maxChars: 100_000 },
      },
      warn,
    );
    const ceiling = maxChunkChars(chunkSize);
    expect(ceiling).toBe(160);
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(ceiling);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeds the corpus ceiling'),
    );
  });

  it('honours a chunk_config.maxChars that LOWERS the ceiling, without warning', () => {
    const warn = vi.fn();
    const out = chunkForCorpus(
      DOC_BIG,
      {
        chunkSize: 800, // ceiling 3200
        chunkOverlap: 100,
        chunkStrategy: 'structural',
        chunkConfig: { ...SECTIONS, maxChars: 120 },
      },
      warn,
    );
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(120);
    }
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('exceeds the corpus ceiling'),
    );
  });

  it('with no maxChars override the ceiling is the corpus chunk_size', () => {
    const out = chunkForCorpus(DOC_BIG, {
      chunkSize: 50,
      chunkOverlap: 5,
      chunkStrategy: 'structural',
      chunkConfig: SECTIONS,
    });
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(maxChunkChars(50));
    }
  });

  it('the recursive strategy respects the same ceiling', () => {
    const out = chunkForCorpus(DOC_BIG, {
      chunkSize: 60,
      chunkOverlap: 6,
      chunkStrategy: 'recursive-char',
    });
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(maxChunkChars(60));
    }
  });
});

describe('parseStructuralConfig', () => {
  it('rejects a non-object, a string, and an empty object', () => {
    expect(parseStructuralConfig(null)).toBeNull();
    expect(parseStructuralConfig('sections')).toBeNull();
    expect(parseStructuralConfig({})).toBeNull();
  });

  it('accepts an explicit sections list', () => {
    expect(parseStructuralConfig(SECTIONS)).toEqual({
      sections: SECTIONS.sections,
      subSections: SECTIONS.subSections,
    });
  });

  it('accepts sections alone — subSections, maxChars and minChars are optional', () => {
    // This is what a consumer that treats sizing as chunker machinery sends,
    // and it must not be rejected for the fields it deliberately omits.
    const cfg = parseStructuralConfig({ sections: SECTIONS.sections });
    expect(cfg).toEqual({ sections: SECTIONS.sections });
  });

  it('rejects a `preset` key and says what to send instead', () => {
    // Named presets were removed: a preset is this repo asserting what someone
    // else's documents look like. The warning has to name the replacement, or
    // the next person just re-adds the preset.
    const warn = vi.fn();
    expect(parseStructuralConfig({ preset: 'es-legal' }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('`preset` is not supported'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('`sections`'));
  });

  it('rejects a pattern that does not compile, at config-parse time', () => {
    const warn = vi.fn();
    // Rejecting here rather than inside the worker means one bad corpus row
    // degrades to the default splitter instead of throwing per document.
    expect(
      parseStructuralConfig({ sections: [{ key: 'k', pattern: '([unclosed' }] }, warn),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not compile'));
  });

  it('drops malformed section entries but keeps the good ones', () => {
    const warn = vi.fn();
    const cfg = parseStructuralConfig(
      { sections: [{ key: 'a', pattern: '^(x)' }, { nope: true }] },
      warn,
    );
    expect(cfg?.sections).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });
});
