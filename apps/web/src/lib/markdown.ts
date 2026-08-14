import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

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
}

/**
 * Render a markdown string to sanitized HTML.
 * Client-only — returns '' on the server (DOMPurify needs `window`).
 */
export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (typeof window === 'undefined') return '';
  ensureHook();
  const raw = opts.inline ? md.renderInline(source ?? '') : md.render(source ?? '');
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
