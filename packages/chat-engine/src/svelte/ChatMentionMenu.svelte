<svelte:options runes={true} />

<script lang="ts">
  /**
   * Typeahead listbox over `ContextSearchResult[]`. Domain-agnostic: kind
   * labels come from the injected `KindRegistry` + a `kindLabel` prop, and all
   * UI strings are injected (no built-in i18n).
   */
  import type { ContextSearchResult, KindRegistry } from "@edc/chat-engine/core";
  import { kindLabel as resolveKindLabel } from "@edc/chat-engine/core";

  interface Props {
    results: ContextSearchResult[];
    loading: boolean;
    activeIndex: number;
    /** Stable id for ARIA wiring (matches the textarea's aria-controls). */
    listId: string;
    /** Kind registry for kind labels. */
    registry: KindRegistry;
    /** Injected UI strings (localized by the consumer). */
    labels?: {
      listLabel?: string;
      searching?: string;
      noResults?: string;
    };
    onselect: (result: ContextSearchResult) => void;
    onhover: (index: number) => void;
  }

  const {
    results,
    loading,
    activeIndex,
    listId,
    registry,
    labels = {},
    onselect,
    onhover,
  }: Props = $props();

  function optionId(i: number): string {
    return `${listId}-opt-${i}`;
  }
</script>

<div class="mention-menu" data-testid="chat-mention-menu">
  <ul id={listId} role="listbox" aria-label={labels.listLabel ?? "Mentions"}>
    {#if loading && results.length === 0}
      <li class="mention-status" aria-disabled="true">
        {labels.searching ?? "Searching…"}
      </li>
    {:else if results.length === 0}
      <li class="mention-status" aria-disabled="true">
        {labels.noResults ?? "No results"}
      </li>
    {:else}
      {#each results as result, i (`${result.kind}:${result.id}`)}
        <li
          id={optionId(i)}
          role="option"
          aria-selected={i === activeIndex}
          class="mention-option {i === activeIndex ? 'is-active' : ''}"
          data-testid="chat-mention-option"
          onmousedown={(e) => {
            // mousedown (not click) so the textarea doesn't blur first.
            e.preventDefault();
            onselect(result);
          }}
          onmouseenter={() => onhover(i)}
        >
          <span class="mention-kind">{resolveKindLabel(registry, result.kind)}</span>
          <span class="mention-label">{result.label}</span>
          {#if result.sublabel}
            <span class="mention-sublabel">{result.sublabel}</span>
          {/if}
        </li>
      {/each}
    {/if}
  </ul>
</div>

<style>
  .mention-menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 0.35rem);
    z-index: 20;
    background: var(--edc-color-surface);
    border: 1px solid var(--edc-color-line);
    border-radius: 0.5rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    overflow: hidden;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    max-height: 14rem;
    overflow-y: auto;
  }

  .mention-status {
    padding: 0.5rem 0.6rem;
    font-size: 0.82rem;
    color: var(--edc-color-ink-soft);
  }

  .mention-option {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.35rem;
    cursor: pointer;
    font-size: 0.85rem;
    color: var(--edc-color-ink);
  }
  .mention-option.is-active {
    background: color-mix(in srgb, var(--edc-color-brand) 12%, transparent);
  }

  .mention-kind {
    flex: 0 0 auto;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--edc-color-brand);
  }
  .mention-label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mention-sublabel {
    flex: 0 1 auto;
    font-size: 0.76rem;
    color: var(--edc-color-ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
