// Pure unit tests for the fail-safe routing decision logic. No network.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROUTER_PROMPT,
  ROUTE_RESPONSE_SCHEMA,
  decideRoute,
  fallbackRouteId,
  renderCandidates,
} from './decide.js';
import { renderPrompt } from '../render/handlebars.js';
import type { RouteCandidateInput } from '../../contract/route.js';

const CANDIDATES: RouteCandidateInput[] = [
  { id: 'search', description: 'semantic text search (default)' },
  { id: 'sql', description: 'aggregate / filter over a table' },
  { id: 'catalog', description: 'metadata about the corpus' },
];

describe('decideRoute — happy path', () => {
  it('picks the candidate the model returned (from parsed)', () => {
    const d = decideRoute({ parsed: { routeId: 'sql', reason: 'count question' } }, CANDIDATES);
    expect(d).toEqual({ routeId: 'sql', reason: 'count question', fallback: false });
  });

  it('parses JSON from text when parsed is absent', () => {
    const d = decideRoute(
      { text: '{"routeId":"catalog","reason":"asks which docs exist"}' },
      CANDIDATES,
    );
    expect(d.routeId).toBe('catalog');
  });

  it('strips a ```json fence in text', () => {
    const d = decideRoute(
      { text: '```json\n{"routeId":"search","reason":"content"}\n```' },
      CANDIDATES,
    );
    expect(d.routeId).toBe('search');
  });
});

describe('decideRoute — fail-safe', () => {
  it('falls back to candidates[0] on unparseable output', () => {
    const d = decideRoute({ text: 'not json at all' }, CANDIDATES);
    expect(d.routeId).toBe('search');
    expect(d.reason).toMatch(/^fallback:/);
  });

  it('falls back to defaultRouteId when supplied', () => {
    const d = decideRoute({ text: 'garbage' }, CANDIDATES, 'catalog');
    expect(d.routeId).toBe('catalog');
    expect(d.reason).toMatch(/^fallback:/);
  });

  it('rejects an out-of-list routeId and falls back', () => {
    const d = decideRoute({ parsed: { routeId: 'nonexistent', reason: 'x' } }, CANDIDATES);
    expect(d.routeId).toBe('search');
    expect(d.reason).toMatch(/not one of the candidates/);
  });

  it('falls back when routeId is missing', () => {
    const d = decideRoute({ parsed: { reason: 'no id' } }, CANDIDATES, 'sql');
    expect(d.routeId).toBe('sql');
    expect(d.reason).toMatch(/omitted routeId/);
  });

  it('ignores a defaultRouteId that is not in the list (uses candidates[0])', () => {
    const d = decideRoute({ text: 'garbage' }, CANDIDATES, 'bogus-default');
    expect(d.routeId).toBe('search');
  });
});

describe('fallbackRouteId', () => {
  it('returns defaultRouteId when it is a valid candidate', () => {
    expect(fallbackRouteId(CANDIDATES, 'sql')).toBe('sql');
  });
  it('returns candidates[0] when default is absent or invalid', () => {
    expect(fallbackRouteId(CANDIDATES)).toBe('search');
    expect(fallbackRouteId(CANDIDATES, 'nope')).toBe('search');
  });
});

describe('renderCandidates', () => {
  it('renders id + description, with optional schema', () => {
    const out = renderCandidates([
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second', schema: { cols: ['x'] } },
    ]);
    expect(out).toContain('- a: first');
    expect(out).toContain('- b: second [schema:');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ROUTER_PROMPT — machinery guards. All offline: `renderPrompt` is pure
// and this file makes NO provider call.
// ---------------------------------------------------------------------------

// Deliberately hostile: every character Handlebars' HTML escaper rewrites, plus
// accents. A plain-ASCII fixture would pass with double staches too and would
// therefore prove nothing.
const HOSTILE = {
  question: '¿Cuántos casos de Ana\'s área tienen "etiqueta" & prioridad <alta> o `urgente`?',
  candidates: '- a: consulta & análisis <general>\n- b: "reportes" de Ana\'s `tablero`',
  history: 'user: ¿y qué hay de esos?\nassistant: aquí están `los` <datos> & "notas"',
};

// Handlebars' escapeExpression output, which must never reach a model.
const HTML_ENTITIES = ['&#x27;', '&quot;', '&amp;', '&lt;', '&gt;', '&#x60;', '&#39;'];

describe('DEFAULT_ROUTER_PROMPT — escaping regression (triple stache)', () => {
  const rendered = renderPrompt(DEFAULT_ROUTER_PROMPT, HOSTILE);

  it.each(Object.entries(HOSTILE))('interpolates %s verbatim, unescaped', (_key, raw) => {
    expect(rendered).toContain(raw);
  });

  it.each(HTML_ENTITIES)('never emits the HTML entity %s', (entity) => {
    expect(rendered).not.toContain(entity);
  });

  it('keeps every interpolation on a TRIPLE stache', () => {
    for (const v of ['{{{candidates}}}', '{{{history}}}', '{{{question}}}']) {
      expect(DEFAULT_ROUTER_PROMPT).toContain(v);
    }
    // Any `{{` that is not part of `{{{`, and not a `{{#`/`{{/` block helper,
    // is an HTML-escaping interpolation.
    expect(DEFAULT_ROUTER_PROMPT).not.toMatch(/(?<!\{)\{\{(?![{#/])/);
  });
});

describe('DEFAULT_ROUTER_PROMPT — contract tokens are not translated', () => {
  it('still names the response object exactly `{ routeId, reason }`', () => {
    // `decideRoute` reads obj['routeId'] / obj['reason']; translating either key
    // would silently route every request to the fallback.
    expect(DEFAULT_ROUTER_PROMPT).toContain('{ routeId, reason }');
  });

  it('keeps the response schema property names and keywords in English', () => {
    expect(Object.keys(ROUTE_RESPONSE_SCHEMA.properties)).toEqual(['routeId', 'reason']);
    expect(ROUTE_RESPONSE_SCHEMA.required).toEqual(['routeId', 'reason']);
    expect(ROUTE_RESPONSE_SCHEMA.type).toBe('object');
    expect(ROUTE_RESPONSE_SCHEMA.additionalProperties).toBe(false);
  });

  it('translates the schema descriptions to Spanish', () => {
    expect(ROUTE_RESPONSE_SCHEMA.properties.routeId.description).toMatch(/TAL CUAL/);
    expect(ROUTE_RESPONSE_SCHEMA.properties.reason.description).toMatch(/frase corta/);
  });
});

describe('DEFAULT_ROUTER_PROMPT — is Spanish', () => {
  it('carries no leftover English instruction wording', () => {
    expect(DEFAULT_ROUTER_PROMPT).not.toMatch(/\bYou are\b|\bReturn the\b|\bRespond\b/);
  });

  it('keeps the emphatic caps that carry meaning', () => {
    expect(DEFAULT_ROUTER_PROMPT).toContain('EXACTAMENTE UNO');
    expect(DEFAULT_ROUTER_PROMPT).toContain('TAL CUAL');
    expect(DEFAULT_ROUTER_PROMPT).toContain('ÚNICAMENTE');
  });
});

describe('decideRoute — reason strings stay English (API response values)', () => {
  // Consumers on older servers match `reason.startsWith('fallback:')` (newer ones
  // can read `fallback`). They are wire values, NOT prompts.
  it('prefixes every fail-safe reason with the English `fallback:`', () => {
    expect(decideRoute({ text: 'garbage' }, CANDIDATES).reason).toBe(
      'fallback: router produced unparseable output',
    );
    expect(decideRoute({ parsed: { reason: 'x' } }, CANDIDATES).reason).toBe(
      'fallback: router omitted routeId',
    );
    expect(decideRoute({ parsed: { routeId: 'nope' } }, CANDIDATES).reason).toBe(
      "fallback: router chose 'nope', not one of the candidates",
    );
  });

  it('uses the English default reason when the model omits one', () => {
    expect(decideRoute({ parsed: { routeId: 'sql' } }, CANDIDATES).reason).toBe(
      'selected by capability router',
    );
  });
});
