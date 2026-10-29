import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import { linkCitations } from './citationLinks';

import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import markdownLang from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('md', markdownLang);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
  highlight: (str: string, lang: string): string => {
    const language = lang && hljs.getLanguage(lang) ? lang : '';
    if (language) {
      try {
        const out = hljs.highlight(str, {
          language,
          ignoreIllegals: true,
        }).value;
        return `<pre class="hljs"><code class="hljs language-${language}">${out}</code></pre>`;
      } catch {
        // fall through to plain escaping
      }
    }
    return `<pre class="hljs"><code class="hljs">${escapeHtml(str)}</code></pre>`;
  },
});
// 🔴 NO IMAGES, IN ANSWERS OR IN DOCUMENTS. A remote `![](https://…)` loads
// the moment the text renders, with nobody clicking: a prompt-injected
// document can make the answer leak data through the image URL (code audit
// 2026-10-28, item 6). `![alt](url)` renders as its alt text, and DOMPurify
// drops any `<img>` that gets through another way (`FORBID_TAGS` below).
md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? '');

// DOMPurify needs `window`. Install the link-hardening hook once, on the client.
let hookInstalled = false;
function ensureHook(): void {
  if (hookInstalled) return;
  if (typeof window === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      const el = node as HTMLAnchorElement;
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  hookInstalled = true;
}

export interface RenderOptions {
  inline?: boolean;
  /** Source ordinals whose `[N]` markers become buttons. See `./citationLinks`. */
  citations?: number[];
  /**
   * Document text (a note, a transcript, a published document, a testimonio),
   * not a chat answer: `[[wikilinks]]` show as their plain text and `[N]`
   * stays plain text even if `citations` is passed.
   */
  document?: boolean;
}

/** `[[Destino]]` → `Destino`; `[[Destino|lo que se lee]]` → `lo que se lee`. */
const WIKILINK = /\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/g;

export function unwrapWikilinks(source: string): string {
  return source.replace(WIKILINK, (_m, target: string, label?: string) => (label ?? target).trim());
}

const SANITIZE = { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe'] };

/**
 * Render a markdown string to sanitized HTML.
 * Client-only — returns '' on the server (DOMPurify needs `window`).
 */
export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (typeof window === 'undefined') return '';
  ensureHook();
  const text = opts.document ? unwrapWikilinks(source ?? '') : (source ?? '');
  const raw = opts.inline ? md.renderInline(text) : md.render(text);
  const clean = DOMPurify.sanitize(raw, SANITIZE);
  // After sanitising: the buttons are our own fixed markup, not the model's.
  return !opts.document && opts.citations?.length ? linkCitations(clean, opts.citations) : clean;
}

/** A stretch of text, highlighted when `type` is set (`$lib/holds` `segmentHeldText`). */
export interface HighlightSegment {
  text: string;
  type: string | null;
}

// Private-use characters: no markdown meaning, and nothing a document contains.
const MARK_OPEN = '\uE000';
const MARK_CLOSE = '\uE001';
const MARK_TYPE_BASE = 0xe100;
const SENTINELS = /[\uE000\uE001\uE100-\uF8FF]/g;
/** The same, percent-encoded as UTF-8 (U+E000–U+FFFF is `%EE`/`%EF` + two bytes). */
const ENCODED_SENTINELS = /%E[EF](?:%[89AB][0-9A-F]){2}/gi;

/**
 * Document text rendered as Markdown with some stretches wrapped in
 * `<mark class="hit" title="…">` — the held-text reader in `/revision/[id]`.
 *
 * The highlights travel through the Markdown render as private-use characters
 * (no Markdown meaning), so a highlight never changes how the text parses.
 * They become `<mark>` elements on the sanitised DOM, text node by text node:
 * never by rewriting HTML with a regex (code audit 2026-10-28, item 7). A
 * highlight that crosses formatting (`**Ju**an`) becomes one mark per piece.
 */
export function renderHighlightedMarkdown(
  segments: readonly HighlightSegment[],
  titleOf: (type: string) => string,
): string {
  if (typeof window === 'undefined') return '';
  ensureHook();
  const types: string[] = [];
  const source = segments
    .map((seg) => {
      // A document's own private-use characters must not open or close a mark.
      const text = seg.text.replace(SENTINELS, '');
      if (!seg.type) return text;
      let i = types.indexOf(seg.type);
      if (i < 0) i = types.push(seg.type) - 1;
      return `${MARK_OPEN}${String.fromCharCode(MARK_TYPE_BASE + i)}${text}${MARK_CLOSE}`;
    })
    .join('');
  const frag = DOMPurify.sanitize(md.render(unwrapWikilinks(source)), {
    ...SANITIZE,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;

  // A sentinel inside an attribute (a link's URL, where markdown-it
  // percent-encodes it) is just dropped.
  frag.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const value = attr.value.replace(SENTINELS, '').replace(ENCODED_SENTINELS, '');
      if (value !== attr.value) el.setAttribute(attr.name, value);
    }
  });

  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  let open: string | null = null; // the type of the mark we are inside, across nodes
  for (const node of texts) {
    const value = node.data;
    if (!open && !/[\uE000\uE001]/.test(value)) continue;
    const parts = document.createDocumentFragment();
    let buf = '';
    const flush = () => {
      if (!buf) return;
      if (open) {
        const mark = document.createElement('mark');
        mark.className = 'hit';
        mark.title = titleOf(open);
        mark.textContent = buf;
        parts.append(mark);
      } else parts.append(buf);
      buf = '';
    };
    for (let i = 0; i < value.length; i++) {
      const c = value[i]!;
      if (c === MARK_OPEN) {
        flush();
        const t = value.charCodeAt(i + 1) - MARK_TYPE_BASE;
        open = types[t] ?? '';
        i++;
      } else if (c === MARK_CLOSE) {
        flush();
        open = null;
      } else buf += c;
    }
    flush();
    node.replaceWith(parts);
  }
  const box = document.createElement('div');
  box.append(frag);
  return box.innerHTML;
}

/**
 * Markdown as plain text, for places that show a short quote as text (a
 * source card's passage): `**negrita**` → `negrita`, `# Título` → `Título`,
 * `[[enlace]]` → `enlace`. Runs on the server too — markdown-it only, no DOM.
 */
export function markdownToPlainText(source: string): string {
  const out: string[] = [];
  const walk = (tokens: ReturnType<typeof md.parse>) => {
    for (const t of tokens) {
      if (t.children) walk(t.children);
      else if (t.type === 'text' || t.type === 'code_inline' || t.type === 'code_block' || t.type === 'fence') out.push(t.content);
      else if (t.type === 'softbreak' || t.type === 'hardbreak' || t.type.endsWith('_close') || t.type === 'hr') out.push(' ');
    }
  };
  walk(md.parse(unwrapWikilinks(source ?? ''), {}));
  return out.join('').replace(/\s+/g, ' ').trim();
}
