import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CitationCard from './CitationCard.svelte';
import MessageContent from './MessageContent.svelte';
import { safeHref } from './safeHref';
import type { CitationLike, MentionRefLike, KindRegistry } from '@edc/chat-engine/core';

/**
 * Scheme-allowlist on resolver/metadata-supplied hrefs (sec chat-engine/L8).
 *
 * Svelte does NOT sanitize `href` attribute values, so a consumer resolver (or
 * citation metadata coming back from retrieval) that emits `javascript:` would
 * be XSS in every consumer of this shared package. The guard lives in each
 * component's `hrefFor`; these tests assert the OBSERVABLE effect — the
 * server-rendered markup — not the helper: a hostile href must never reach an
 * `<a href>`, and a benign one must still become a working link (the guard
 * must not over-tighten into "no links at all").
 *
 * GENERIC INVARIANT (preferred over named cases, audit §5): every `href="…"`
 * attribute in the rendered output of BOTH components, across hostile and
 * benign inputs alike, resolves — under the WHATWG URL parser, the same one
 * the browser uses — to http(s), and a link that does not name its own scheme
 * stays on the page's origin. The oracle is the URL parser, never a copy of
 * the production rule: a test that re-declares the guard's regex agrees with
 * the guard by construction and cannot catch it being too wide (it was:
 * `//evil.example/x` matched `^\/` and rendered as an off-site link).
 *
 * ⚠ WHY `package.json` DELETES `dist/svelte/*.test.*` AFTER `svelte-package`.
 * This file is co-located with the components it renders — the same shape the
 * core tests use — but `src/svelte` is ALSO the packager's INPUT directory, and
 * `@sveltejs/package` 2.5.8 has no exclude option (`--help`: input, output,
 * preserve-output, types, tsconfig, watch — that is the whole list). Measured:
 * a plain `npm run build` emitted `dist/svelte/hrefAllowlist.ssr.test.js`,
 * importing `vitest`, into the published tarball (`files: ["dist", …]`), where
 * consumers pin this package EXACT. `build:svelte` therefore ends in a `find
 * … -delete` — the svelte-side equivalent of the test-file `exclude` in
 * `tsconfig.core.json` (see that file). Keep the deletion if you add tests
 * here, and do not split `build` away from `build:svelte`: the filter lives in
 * one script on purpose, so any test file under `src/svelte` is covered,
 * including one added in a subdirectory tomorrow.
 */

const HOSTILE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(document.cookie)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  ' javascript:alert(1)', // leading whitespace must not defeat the anchor
  'jav\tascript:alert(1)', // embedded control char must not defeat the anchor
  'JAVASCRIPT:alert(1)',
  '\njavascript:alert(1)',
  // Off-origin links that pass a "starts with /" rule. Each one leaves the
  // page for another host in a browser:
  '//evil.example/x', // protocol-relative
  '//EVIL.example/x',
  '/\\evil.example/x', // browsers read `\` as `/` in http(s) URLs
  '/\t/evil.example/x', // the URL parser strips tab and newline anywhere
  '/\n/evil.example/x',
  ' //evil.example/x', // leading whitespace is stripped too
];

const BENIGN = [
  'https://example.com/doc/1',
  'http://example.com/doc/2',
  'HTTPS://EXAMPLE.COM/CAPS', // scheme check is case-insensitive
  '/documents/42', // relative path
];

// Where the components render, for the URL-parser oracle below. Any origin
// works; `.invalid` can never be a real host.
const PAGE = 'https://chat.invalid/conversations/1';

/** True when a browser on PAGE would follow `href` to http(s) and, unless the
 * href names its scheme, stay on PAGE's origin. */
function staysSafeInABrowser(href: string): boolean {
  const url = new URL(href, PAGE);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const namesItsScheme = /^https?:/i.test(href);
  return namesItsScheme || url.origin === new URL(PAGE).origin;
}

function hrefsIn(body: string): string[] {
  return [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

const labels = {
  sourcesTitle: 'Fuentes consultadas',
  openSource: 'Abrir documento',
  relevance: 'Relevancia',
  untitledSource: 'Fuente sin título',
};

function citation(href: string | null): CitationLike {
  return { ordinal: 1, title: 'Doc uno', passageText: 'pasaje', score: 0.9, href };
}

function renderCitationCard(props: {
  citations: CitationLike[];
  linkResolver?: (c: CitationLike) => string | null;
}): string {
  return render(CitationCard, { props: { ...props, labels } }).body;
}

const registry: KindRegistry = {
  descriptors: [{ kind: 'documento', label: 'Documento', emoji: '📄' }],
} as KindRegistry;

const ref: MentionRefLike = { kind: 'documento', id: 1, label: 'Doc' };

function renderMessageContent(hrefForRef?: (r: MentionRefLike) => string | null): string {
  return render(MessageContent, {
    props: { content: 'ver @Doc aquí', refs: [ref], registry, hrefForRef },
  }).body;
}

describe('safeHref, the one guard both components call', () => {
  it.each(HOSTILE)('rejects %j', (bad) => {
    expect(safeHref(bad)).toBeNull();
  });

  it.each(BENIGN)('keeps %j unchanged', (good) => {
    expect(safeHref(good)).toBe(good);
  });

  it.each([null, undefined, ''])('rejects an empty href: %j', (empty) => {
    expect(safeHref(empty)).toBeNull();
  });

  // A resolver is consumer code typed `string | null`, but JS callers and bad
  // metadata can hand over anything. A non-string must become "no link", not a
  // crash that takes the whole message or source list down with it.
  it.each([
    ['a URL object', new URL('https://example.com/doc')],
    ['a number', 42],
    ['a plain object', {}],
    ['an array', ['/x']],
    ['a boolean', true],
  ])('returns null, never throws, for a non-string: %s', (_label, value) => {
    expect(safeHref(value as unknown as string)).toBeNull();
  });

  // Intended behaviour: only ROOT-relative paths are links. A path-relative,
  // query-only or fragment-only href resolves against whatever page the
  // consumer mounts the component on, so its target is not knowable here.
  it.each(['docs/42', './docs/42', '../docs/42', '?q=1', '#a'])(
    'rejects a non-root-relative href: %j',
    (rel) => {
      expect(safeHref(rel)).toBeNull();
    },
  );
});

describe('CitationCard href scheme allowlist (SSR)', () => {
  it.each(HOSTILE)('never links a hostile citation.href: %j', (bad) => {
    const body = renderCitationCard({ citations: [citation(bad)] });
    expect(hrefsIn(body)).toEqual([]); // no <a href> at all
    expect(body).toContain('Doc uno'); // …but the source still renders, linkless
  });

  it.each(HOSTILE)('never links a hostile linkResolver result: %j', (bad) => {
    const body = renderCitationCard({
      citations: [citation(null)],
      linkResolver: () => bad,
    });
    expect(hrefsIn(body)).toEqual([]);
  });

  it.each(BENIGN)('keeps a benign href linked: %j', (good) => {
    const body = renderCitationCard({ citations: [citation(good)] });
    expect(hrefsIn(body)).toEqual([good]); // exactly the one source-list link
    expect(body).toContain(labels.openSource);
  });
});

describe('MessageContent href scheme allowlist (SSR)', () => {
  it.each(HOSTILE)('renders a static pill for a hostile hrefForRef: %j', (bad) => {
    const body = renderMessageContent(() => bad);
    expect(hrefsIn(body)).toEqual([]);
    expect(body).toContain('is-static'); // pill still renders, as a <span>
    expect(body).toContain('Doc');
  });

  it.each(BENIGN)('keeps a benign hrefForRef linked: %j', (good) => {
    const body = renderMessageContent(() => good);
    expect(hrefsIn(body)).toEqual([good]);
    expect(body).not.toContain('is-static');
  });

  it('renders a static pill when no resolver is injected (default posture)', () => {
    const body = renderMessageContent(undefined);
    expect(hrefsIn(body)).toEqual([]);
    expect(body).toContain('is-static');
  });
});

describe('generic invariant: no rendered href escapes the scheme allowlist', () => {
  it('every href either component renders stays http(s) and on-origin unless absolute', () => {
    const bodies: string[] = [];
    for (const candidate of [...HOSTILE, ...BENIGN]) {
      bodies.push(renderCitationCard({ citations: [citation(candidate)] }));
      bodies.push(
        renderCitationCard({ citations: [citation(null)], linkResolver: () => candidate }),
      );
      bodies.push(renderMessageContent(() => candidate));
    }
    const all = bodies.flatMap(hrefsIn);
    expect(all.length).toBeGreaterThan(0); // the sweep must actually produce links
    const unsafe = all.filter((href) => !staysSafeInABrowser(href));
    expect(unsafe).toEqual([]);
  });
});
