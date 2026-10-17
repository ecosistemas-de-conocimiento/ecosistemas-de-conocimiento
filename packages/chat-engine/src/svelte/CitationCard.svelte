<svelte:options runes={true} />

<script lang="ts">
  /**
   * The canonical, domain-agnostic citation surface for assistant turns:
   *   - clickable `[N]` markers (rendered from `content` as CLEAN TEXT — no
   *     `{@html}`) that reveal …
   *   - an inline card per citation with the QUOTED passage (`<blockquote>`),
   *     the source title and a link to open the original asset. It shows NO
   *     relevance number (0.6.0): `CitationLike.score` is data only, and its
   *     scale depends on the retrieve mode (cosine vs RRF vs rerank). A
   *     hybrid hit the model rightly cited rendered as "4%" (decision D1).
   *   - plus a "Fuentes consultadas" list that toggles each card open/closed.
   *
   * EVERYTHING product-specific is injected:
   *   - `citations`     `CitationLike[]` (ordinal/title/passageText/score/…)
   *   - `linkResolver`  citation → href|null (consumer owns routing); a citation
   *                     may also carry its own `href`. No resolver + no href =
   *                     no "open" link (passage still shows).
   *   - `labels`        all Spanish (or any-locale) UI strings — no hard-coded
   *                     product copy.
   *   - `content`       OPTIONAL assistant text. When provided, the component
   *                     renders it with inline clickable `[N]` markers. When
   *                     omitted, the consumer renders the body itself (e.g. via
   *                     its own Markdown renderer) and drives the cards by
   *                     binding `this` and calling `reveal(ordinal)` from its own
   *                     `[N]` click handler.
   *
   * Theming via the shared `--edc-*` custom properties (the consumer supplies
   * them; `apps/web` defines them in `src/lib/design/tokens.css`).
   */
  import type { CitationLike, CitationSegment } from "@edc/chat-engine/core";
  import { splitContentByCitations } from "@edc/chat-engine/core";
  import { safeHref } from "./safeHref.js";

  interface CitationLabels {
    /** Heading above the source list. e.g. "Fuentes consultadas". */
    sourcesTitle: string;
    /** Text/aria for the "open the original asset" link. e.g. "Abrir documento". */
    openSource: string;
    /**
     * @deprecated Since 0.6.0 the card renders no relevance number, so this
     * label is ignored. Kept optional so existing consumers still typecheck;
     * it will be removed in the next breaking release.
     */
    relevance?: string;
    /** Fallback when a citation has no title. e.g. "Fuente sin título". */
    untitledSource: string;
    /** aria-label for a `[N]` marker button (ordinal appended). e.g. "Ver fuente". */
    citationMarker?: string;
  }

  interface Props {
    /** Normalized citations (see `provenanceToCitations`). Empty → renders nothing. */
    citations: CitationLike[];
    labels: CitationLabels;
    /** Citation → href to open the source asset. Falls back to `citation.href`. */
    linkResolver?: (citation: CitationLike) => string | null;
    /**
     * OPTIONAL assistant body. When set, the component renders it as clean text
     * with inline clickable `[N]` markers wired to `reveal()`. Omit it to render
     * only the cards + source list (consumer renders the body separately).
     */
    content?: string;
    /** Open the source list collapsed behind a toggle. */
    collapsibleSources?: boolean;
    /** When `collapsibleSources`, start expanded. Default false. */
    sourcesOpenByDefault?: boolean;
    /** Intercept opening a source link (e.g. SPA pushState / new tab policy). */
    onopensource?: (citation: CitationLike, href: string) => void;
    /** Stable id seed for ARIA + card anchors (unique per message). Default auto. */
    idSeed?: string | number;
    /**
     * Ordinals whose cards start expanded. ADDITIVE (0.6.0), default none.
     * Read once at mount, like `sourcesOpenByDefault`; thereafter user-toggled.
     */
    initiallyExpanded?: number[];
  }

  const {
    citations,
    labels,
    linkResolver,
    content,
    collapsibleSources = false,
    sourcesOpenByDefault = false,
    onopensource,
    idSeed,
    initiallyExpanded,
  }: Props = $props();

  // Stable-enough seed for element ids when the consumer doesn't pass one.
  const seed = $derived(
    idSeed != null ? String(idSeed) : `cc-${Math.random().toString(36).slice(2, 8)}`,
  );

  const ordinals = $derived(citations.map((c) => c.ordinal));
  const segments = $derived<CitationSegment[]>(
    content != null ? splitContentByCitations(content, ordinals) : [],
  );

  // Which citation cards are expanded (by ordinal).
  // svelte-ignore state_referenced_locally
  let expanded = $state<Set<number>>(new Set(initiallyExpanded ?? []));
  // Source list open/closed (only relevant when collapsible). Seeded once from
  // the prop's initial value; thereafter user-toggled.
  // svelte-ignore state_referenced_locally
  let sourcesOpen = $state(sourcesOpenByDefault);

  function byOrdinal(ordinal: number): CitationLike | undefined {
    return citations.find((c) => c.ordinal === ordinal);
  }

  function cardId(ordinal: number): string {
    return `cite-${seed}-${ordinal}`;
  }

  /** Public: reveal a citation card and scroll it into view. */
  export function reveal(ordinal: number): void {
    const next = new Set(expanded);
    next.add(ordinal);
    expanded = next;
    sourcesOpen = true;
    if (typeof document !== "undefined") {
      queueMicrotask(() => {
        document
          .getElementById(cardId(ordinal))
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  /** Public: toggle a citation card open/closed (source-list click). */
  export function toggle(ordinal: number): void {
    const next = new Set(expanded);
    if (next.has(ordinal)) next.delete(ordinal);
    else next.add(ordinal);
    expanded = next;
  }

  function isExpanded(ordinal: number): boolean {
    return expanded.has(ordinal);
  }

  function hrefFor(c: CitationLike): string | null {
    const resolved = linkResolver ? linkResolver(c) : null;
    const href = resolved ?? c.href ?? null;
    return safeHref(href); // the one shared guard — see safeHref.ts
  }

  function onSourceLinkClick(e: MouseEvent, c: CitationLike, href: string): void {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return; // modified / non-left clicks fall through to the browser
    }
    if (!onopensource) return;
    e.preventDefault();
    onopensource(c, href);
  }

  function titleOf(c: CitationLike): string {
    return (c.title && c.title.trim()) || labels.untitledSource;
  }

  const hasCitations = $derived(citations.length > 0);
</script>

{#if content != null}
  <p class="citation-content" data-testid="citation-content"
    >{#each segments as seg, i (i)}{#if seg.type === "text"}{seg.text}{:else}{@const c = byOrdinal(seg.ordinal)}<button
          type="button"
          class="citation-marker"
          data-testid="citation-marker"
          data-ordinal={seg.ordinal}
          aria-label={`${labels.citationMarker ?? "Fuente"} ${seg.ordinal}`}
          disabled={!c}
          onclick={() => reveal(seg.ordinal)}>[{seg.ordinal}]</button
        >{/if}{/each}</p
  >
{/if}

{#if hasCitations}
  <div class="citation-cards" data-testid="citation-cards">
    {#each citations as c (c.ordinal)}
      {#if isExpanded(c.ordinal)}
        {@const href = hrefFor(c)}
        <div class="citation-card" id={cardId(c.ordinal)} data-testid="citation-card">
          <div class="citation-card-head">
            <span class="citation-card-ord">[{c.ordinal}]</span>
            <span class="citation-card-title" title={titleOf(c)}>{titleOf(c)}</span>
            {#if href}
              <a
                class="citation-card-open"
                data-testid="citation-open"
                {href}
                onclick={(e) => onSourceLinkClick(e, c, href)}>{labels.openSource}</a
              >
            {/if}
          </div>
          {#if c.passageText && c.passageText.trim()}
            <blockquote class="citation-card-passage">{c.passageText}</blockquote>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="citation-sources" data-testid="citation-sources">
    {#if collapsibleSources}
      <button
        type="button"
        class="citation-sources-toggle"
        data-testid="citation-sources-toggle"
        aria-expanded={sourcesOpen}
        onclick={() => (sourcesOpen = !sourcesOpen)}
      >
        {labels.sourcesTitle} ({citations.length})
        <span aria-hidden="true">{sourcesOpen ? "▴" : "▾"}</span>
      </button>
    {:else}
      <h4 class="citation-sources-title">{labels.sourcesTitle}</h4>
    {/if}

    {#if !collapsibleSources || sourcesOpen}
      <ol class="citation-sources-list" data-testid="citation-sources-list">
        {#each citations as c (c.ordinal)}
          {@const href = hrefFor(c)}
          <li class="citation-source" data-testid="citation-source">
            <button
              type="button"
              class="citation-source-link"
              data-testid="citation-source-link"
              aria-expanded={isExpanded(c.ordinal)}
              onclick={() => toggle(c.ordinal)}
            >
              <span class="citation-source-ord">[{c.ordinal}]</span>
              <span class="citation-source-title">{titleOf(c)}</span>
            </button>
            {#if href}
              <a
                class="citation-source-open"
                {href}
                onclick={(e) => onSourceLinkClick(e, c, href)}>{labels.openSource}</a
              >
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}

<style>
  .citation-content {
    margin: 0;
    white-space: pre-wrap;
  }

  .citation-marker {
    display: inline;
    padding: 0 0.3em;
    margin: 0 0.05em;
    border: 0;
    border-radius: 0.35em;
    background: var(--edc-color-brand-soft, color-mix(in srgb, currentColor 12%, transparent));
    color: var(--edc-color-brand-strong, currentColor);
    font-size: 0.78em;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    vertical-align: baseline;
  }
  .citation-marker:hover,
  .citation-marker:focus-visible {
    background: var(--edc-color-brand-soft-strong, color-mix(in srgb, currentColor 22%, transparent));
    outline: none;
  }
  .citation-marker:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .citation-cards {
    display: grid;
    gap: 0.5rem;
  }
  .citation-card {
    margin-top: 0.6rem;
    border: 1px solid var(--edc-color-brand-outline, var(--edc-color-line));
    border-left: 3px solid var(--edc-color-brand, currentColor);
    border-radius: 0.5rem;
    background: var(--edc-color-brand-soft, transparent);
    padding: 0.55rem 0.75rem;
  }
  .citation-card-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    margin-bottom: 0.35rem;
  }
  .citation-card-ord {
    font-weight: 700;
    color: var(--edc-color-brand-strong, currentColor);
    flex: 0 0 auto;
  }
  .citation-card-title {
    font-weight: 600;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .citation-card-open,
  .citation-source-open {
    flex: 0 0 auto;
    color: var(--edc-color-brand, currentColor);
    text-decoration: none;
    font-size: 0.8rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .citation-card-open:hover,
  .citation-source-open:hover {
    text-decoration: underline;
  }
  .citation-card-passage {
    margin: 0;
    font-size: 0.85rem;
    color: var(--edc-color-ink-body, var(--edc-color-ink));
    font-style: italic;
    white-space: pre-wrap;
  }

  .citation-sources {
    margin-top: 0.65rem;
    border-top: 1px solid var(--edc-color-line);
    padding-top: 0.5rem;
  }
  .citation-sources-title {
    margin: 0 0 0.35rem;
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .citation-sources-toggle {
    border: 0;
    background: none;
    padding: 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--edc-color-ink-soft);
    cursor: pointer;
  }
  .citation-sources-toggle:hover {
    color: var(--edc-color-brand, currentColor);
  }
  .citation-sources-list {
    margin: 0.25rem 0 0;
    padding-left: 1.2rem;
    font-size: 0.85rem;
    display: grid;
    gap: 0.2rem;
  }
  .citation-source {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .citation-source-link {
    flex: 1 1 auto;
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: var(--edc-color-brand, currentColor);
    font-size: 0.85rem;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .citation-source-link:hover {
    color: var(--edc-color-brand-strong, currentColor);
  }
  .citation-source-ord {
    flex: 0 0 auto;
    font-weight: 700;
  }
  .citation-source-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
