<svelte:options runes={true} />

<script lang="ts">
  /**
   * Pure chip list. A chip is a `MentionRefLike` (kind/id/label). Kind labels
   * come from the injected registry; remove button + aria strings injected.
   */
  import type { MentionRefLike, KindRegistry } from "@edc/chat-engine/core";
  import { kindLabel as resolveKindLabel } from "@edc/chat-engine/core";

  interface Props {
    chips: MentionRefLike[];
    registry: KindRegistry;
    /** When provided, each chip shows a remove button. */
    onremove?: (chip: MentionRefLike) => void;
    label?: string;
    /** Injected aria label for the remove button (chip label appended). */
    removeLabel?: string;
  }

  const { chips, registry, onremove, label, removeLabel = "Remove" }: Props =
    $props();
</script>

{#if chips.length > 0}
  <div
    class="context-chips"
    data-testid="chat-context-chips"
    role="list"
    aria-label={label ?? "Context"}
  >
    {#each chips as chip (`${chip.kind}:${chip.id}`)}
      <span class="context-chip" role="listitem" data-testid="chat-context-chip">
        <span class="context-chip-kind">{resolveKindLabel(registry, chip.kind)}</span>
        <span class="context-chip-label" title={chip.label}>{chip.label}</span>
        {#if onremove}
          <button
            type="button"
            class="context-chip-remove"
            data-testid="chat-context-chip-remove"
            aria-label={`${removeLabel}: ${chip.label}`}
            onclick={() => onremove(chip)}
          >
            ×
          </button>
        {/if}
      </span>
    {/each}
  </div>
{/if}

<style>
  .context-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .context-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 100%;
    padding: 0.2rem 0.2rem 0.2rem 0.5rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 999px;
    background: var(--edc-color-surface-soft);
    font-size: 0.78rem;
    color: var(--edc-color-ink);
  }

  .context-chip-kind {
    font-size: 0.64rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--edc-color-brand);
  }

  .context-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--edc-color-ink-soft);
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
  .context-chip-remove:hover {
    background: var(--edc-color-line);
    color: var(--edc-color-ink);
  }
</style>
