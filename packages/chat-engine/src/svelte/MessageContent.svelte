<svelte:options runes={true} />

<script lang="ts">
  /**
   * Renders `splitContentByRefs` (from core) as text runs + `.mention-pill`
   * spans. Deep-linking is domain-agnostic: an injected `hrefForRef?` prop
   * decides whether a ref becomes a link (and where). With no `hrefForRef`,
   * every pill is a static span.
   */
  import type { MentionRefLike, KindRegistry } from "@edc/chat-engine/core";
  import {
    splitContentByRefs,
    kindEmoji as resolveKindEmoji,
    kindLabel as resolveKindLabel,
  } from "@edc/chat-engine/core";

  interface Props {
    content: string;
    /** Refs attached to this turn, used to swap `@<label>` for inline pills. */
    refs?: MentionRefLike[];
    registry: KindRegistry;
    /** Map a ref to an href; return null for a non-linked (static) pill. */
    hrefForRef?: (ref: MentionRefLike) => string | null;
    /** Intercept a plain left-click on a linked pill (e.g. SPA pushState). */
    onnavigate?: (ref: MentionRefLike, href: string) => void;
  }

  const { content, refs = [], registry, hrefForRef, onnavigate }: Props =
    $props();

  const segments = $derived(splitContentByRefs(content, refs));

  function hrefFor(ref: MentionRefLike): string | null {
    return hrefForRef ? hrefForRef(ref) : null;
  }

  function onPillClick(e: MouseEvent, ref: MentionRefLike, href: string): void {
    // Let modified clicks (new tab) and middle-clicks fall through.
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    if (!onnavigate) return; // no handler → let the browser follow the href
    e.preventDefault();
    onnavigate(ref, href);
  }
</script>

<p class="chat-content" data-testid="chat-message-content">{#each segments as seg, i (i)}{#if seg.type === "text"}{seg.text}{:else}{@const href = hrefFor(seg.ref)}{#if href}<a
        class="mention-pill"
        data-testid="chat-mention-pill"
        data-kind={seg.ref.kind}
        {href}
        title={`${resolveKindLabel(registry, seg.ref.kind)}: ${seg.ref.label}`}
        onclick={(e) => onPillClick(e, seg.ref, href)}
      ><span class="mention-pill-emoji" aria-hidden="true">{resolveKindEmoji(registry, seg.ref.kind)}</span>{seg.ref.label}</a>{:else}<span
        class="mention-pill is-static"
        data-testid="chat-mention-pill"
        data-kind={seg.ref.kind}
        title={`${resolveKindLabel(registry, seg.ref.kind)}: ${seg.ref.label}`}
      ><span class="mention-pill-emoji" aria-hidden="true">{resolveKindEmoji(registry, seg.ref.kind)}</span>{seg.ref.label}</span>{/if}{/if}{/each}</p>

<style>
  .chat-content {
    margin: 0;
  }

  .mention-pill {
    display: inline;
    align-items: baseline;
    padding: 0.05em 0.35em;
    border-radius: 0.5em;
    background: color-mix(in srgb, currentColor 14%, transparent);
    color: inherit;
    text-decoration: none;
    font-weight: 600;
    white-space: normal;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  .mention-pill.is-static {
    cursor: default;
  }
  a.mention-pill {
    cursor: pointer;
  }
  a.mention-pill:hover,
  a.mention-pill:focus-visible {
    background: color-mix(in srgb, currentColor 24%, transparent);
    outline: none;
  }

  .mention-pill-emoji {
    font-weight: 400;
    margin-right: 0.2em;
  }
</style>
