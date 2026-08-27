<script lang="ts">
  import type { Message } from '$lib/types';
  import Markdown from './Markdown.svelte';
  import MessageRating from './MessageRating.svelte';
  import { isRatableMessageId } from '$lib/ratings';
  import { app } from '$lib/stores/app.svelte';
  import {
    draftDocumentIds,
    markDraftCitations,
  } from '$lib/publication';
  import { MessageContent, CitationCard } from '@edc/chat-engine/svelte';
  import { CHAT_KIND_REGISTRY } from '$lib/engine/registry';
  import { CHAT_CITATION_LABELS, chatCitationHref } from '$lib/engine/client';
  import { provenanceToCitations } from '@edc/chat-engine/core';
  import type { CitationLike, MentionRefLike } from '@edc/chat-engine/core';

  let { msg }: { msg: Message } = $props();
  const isUser = $derived(msg.role === 'user');
  const isAssistant = $derived(msg.role === 'assistant');

  // Refs carried on a user turn render as inline pills.
  const refs = $derived<MentionRefLike[]>(
    (msg.contextRefs ?? []).map((r) => ({
      kind: r.kind,
      id: r.id,
      label: r.label,
      sublabel: r.sublabel,
      scopeId: r.scopeId,
    })),
  );
  const hasRefs = $derived(refs.length > 0);

  // Citation provenance → the engine's canonical `CitationCard`. Map the
  // persisted provenance to the engine's domain-agnostic `CitationLike[]`; the
  // body stays in this app's own Markdown renderer, so the card renders only
  // the quoted-passage cards + the "Fuentes consultadas" list.
  const rawCitations = $derived<CitationLike[]>(provenanceToCitations(msg.provenance ?? null));

  /**
   * A user can chat against their OWN drafts, so an answer may quote a document
   * nobody else in the ecosistema can open. Mark those, or someone will forward
   * the answer and send a colleague after a source they cannot read.
   *
   * The draft set comes from this session's own document list: a draft is
   * visible only to its uploader, so any draft we can see here is ours. A
   * citation we cannot find in that list is left unmarked rather than called
   * "published" — retrieval can reach documents outside this session.
   */
  const draftIds = $derived(draftDocumentIds(app.active?.docs ?? []));
  const marked = $derived(markDraftCitations(rawCitations, draftIds));
  const citations = $derived(marked.citations);
  const hasCitations = $derived(isAssistant && !msg.error && citations.length > 0);

  // Rating is for ANSWERS only — never the user's own prompt, never a failed or
  // still-streaming turn, and never before the backend has issued the message
  // an id (a `local-…` placeholder has no row to attach a rating to).
  const canRate = $derived(
    isAssistant && !msg.error && !msg.pending && isRatableMessageId(msg.id),
  );
</script>

<div class="flex {isUser ? 'justify-end' : 'justify-start'}">
  <div
    class="max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed shadow-1 {isUser
      ? 'bg-brand text-on-brand whitespace-pre-wrap'
      : msg.error
        ? 'bg-surface-strong border border-danger text-danger whitespace-pre-wrap'
        : 'bg-surface-strong border border-elevated text-ink'}"
  >
    {#if msg.pending && !msg.content}
      <span class="inline-flex gap-1 items-center text-ink-soft">
        <span class="size-1.5 rounded-full bg-ink-soft animate-pulse"></span>
        <span class="size-1.5 rounded-full bg-ink-soft animate-pulse [animation-delay:120ms]"
        ></span>
        <span class="size-1.5 rounded-full bg-ink-soft animate-pulse [animation-delay:240ms]"
        ></span>
      </span>
    {/if}
    {#if msg.content}
      {#if isUser && hasRefs}
        <MessageContent content={msg.content} {refs} registry={CHAT_KIND_REGISTRY} />
      {:else if isAssistant && !msg.error}
        <Markdown source={msg.content} />
      {:else}
        {msg.content}
      {/if}
    {/if}
    {#if msg.error}
      <div class="mt-1 text-xs">⚠ {msg.error}</div>
    {/if}

    {#if hasCitations}
      <div class="mt-2 pt-2 border-t border-elevated">
        <CitationCard
          {citations}
          labels={CHAT_CITATION_LABELS}
          linkResolver={chatCitationHref}
          collapsibleSources
          idSeed={msg.id}
        />
      </div>
    {/if}

    {#if canRate}
      <div class="mt-2 pt-2 border-t border-elevated">
        <MessageRating {msg} />
      </div>
    {/if}
  </div>
</div>

<style>
  /* Tailwind v3 cannot apply an opacity modifier (`bg-warning/10`) to a colour
     defined as a bare `var(--edc-…)`: that needs the `<alpha-value>` channel
     form, so those utilities silently produce NO colour. The design system
     ships `-soft` / `-outline` pairs for exactly this case — use them. */
</style>
