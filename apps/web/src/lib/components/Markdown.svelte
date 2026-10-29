<script lang="ts">
  import { onMount } from 'svelte';
  import { markdownToPlainText, renderHighlightedMarkdown, renderMarkdown, type HighlightSegment } from '$lib/markdown';
  import 'highlight.js/styles/github.css';

  let {
    source = '',
    inline = false,
    document = false,
    highlights,
    markTitle = () => '',
    citations,
    oncite,
    testid,
    class: className = '',
  }: {
    source?: string;
    inline?: boolean;
    /**
     * Document text (note, transcript, published document, testimonio), not a
     * chat answer: `[[wikilinks]]` read as plain text, `[N]` stays text.
     */
    document?: boolean;
    /** Held text with highlighted stretches (`/revision/[id]`); replaces `source`. */
    highlights?: readonly HighlightSegment[];
    /** The `title` of a highlight of this type. */
    markTitle?: (type: string) => string;
    /** Ordinals with a source: their `[N]` markers become buttons. */
    citations?: number[];
    /** Called with N when the reader clicks `[N]`. */
    oncite?: (ordinal: number) => void;
    /** `data-testid` on the wrapper. */
    testid?: string;
    /** Extra classes on the wrapper. */
    class?: string;
  } = $props();

  // DOMPurify requires `window`; defer rendering until the client mounts so
  // SSR markup and the first client paint agree (no hydration mismatch).
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });

  const html = $derived(
    !mounted
      ? ''
      : highlights
        ? renderHighlightedMarkdown(highlights, markTitle)
        : renderMarkdown(source, { inline, citations, document }),
  );

  // One delegated listener: the buttons are inside `{@html}`.
  function onclick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement | null)?.closest?.('button[data-cite]');
    if (!btn || !oncite) return;
    const n = Number(btn.getAttribute('data-cite'));
    if (Number.isFinite(n)) oncite(n);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
{#if inline}
  <!-- Before mount (and on the server) a one-line text reads as plain text, not as nothing. -->
  <span class="md-body {className}" data-testid={testid} {onclick}
    >{#if mounted}{@html html}{:else}{markdownToPlainText(source)}{/if}</span
  >
{:else}
  <!-- Before mount (and on the server) document text reads as plain text, not
       as nothing; a chat answer keeps its empty first paint. -->
  <div class="md-body {className}" class:md-document={document || !!highlights} data-testid={testid} {onclick}>
    {#if mounted}{@html html}{:else if highlights}{markdownToPlainText(highlights.map((h) => h.text).join(''))}{:else if document}{markdownToPlainText(source)}{/if}
  </div>
{/if}

<style>
  .md-body :global(button.cite-ref) {
    font: inherit;
    font-weight: 600;
    color: var(--edc-color-brand);
    text-decoration: underline;
    cursor: pointer;
    padding: 0 1px;
    background: none;
    border: 0;
  }
  .md-body :global(p) {
    margin: 0.5em 0;
  }
  .md-body :global(p:first-child) {
    margin-top: 0;
  }
  .md-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .md-body :global(h1),
  .md-body :global(h2),
  .md-body :global(h3),
  .md-body :global(h4),
  .md-body :global(h5),
  .md-body :global(h6) {
    font-family: var(--edc-font-display);
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 0.9em 0 0.4em;
    line-height: 1.25;
    color: var(--edc-color-ink);
  }
  .md-body :global(h1) {
    font-size: 1.3em;
  }
  .md-body :global(h2) {
    font-size: 1.18em;
  }
  .md-body :global(h3) {
    font-size: 1.08em;
  }
  .md-body :global(h4),
  .md-body :global(h5),
  .md-body :global(h6) {
    font-size: 1em;
  }
  .md-body :global(ul),
  .md-body :global(ol) {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }
  .md-body :global(ul) {
    list-style: disc;
  }
  .md-body :global(ol) {
    list-style: decimal;
  }
  .md-body :global(li) {
    margin: 0.2em 0;
  }
  .md-body :global(li > p) {
    margin: 0.2em 0;
  }
  .md-body :global(a) {
    color: var(--edc-color-brand);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .md-body :global(a:hover) {
    color: var(--edc-color-brand-strong);
  }
  .md-body :global(code) {
    font-family: var(--edc-font-mono);
    font-size: 0.9em;
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-brand-strong);
    padding: 0.1em 0.35em;
    border-radius: 0.25em;
    border: 1px solid var(--edc-color-elevated-border);
  }
  .md-body :global(pre) {
    background: var(--edc-color-surface-soft);
    padding: 0.75em 1em;
    border-radius: var(--edc-radius-2);
    overflow-x: auto;
    margin: 0.75em 0;
    border: 1px solid var(--edc-color-elevated-border);
  }
  .md-body :global(pre code) {
    background: transparent;
    padding: 0;
    border: 0;
    border-radius: 0;
    font-size: 0.85em;
    color: var(--edc-color-ink);
    display: block;
    white-space: pre;
  }
  .md-body :global(blockquote) {
    border-left: 3px solid var(--edc-color-brand-outline);
    padding-left: 0.75em;
    margin: 0.5em 0;
    color: var(--edc-color-ink-soft);
  }
  .md-body :global(table) {
    border-collapse: collapse;
    margin: 0.6em 0;
    width: 100%;
    font-size: 0.95em;
  }
  .md-body :global(th),
  .md-body :global(td) {
    border: 1px solid var(--edc-color-elevated-border);
    padding: 0.35em 0.6em;
    text-align: left;
    vertical-align: top;
  }
  .md-body :global(th) {
    background: var(--edc-color-surface-soft);
    font-weight: 700;
  }
  .md-body :global(hr) {
    border: 0;
    border-top: 1px solid var(--edc-color-elevated-border);
    margin: 1em 0;
  }
  /* No img rule: images never render (`$lib/markdown`, FORBID_TAGS). */
  .md-document {
    overflow-wrap: anywhere;
  }
  .md-body :global(strong) {
    font-weight: 700;
  }
  .md-body :global(em) {
    font-style: italic;
  }
</style>
