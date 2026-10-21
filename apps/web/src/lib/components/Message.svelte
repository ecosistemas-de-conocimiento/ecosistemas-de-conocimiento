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
  import { markAssistantCitations } from '$lib/assistantChunks';
  import { provenanceToCitations } from '@edc/chat-engine/core';
  import type { CitationLike, MentionRefLike } from '@edc/chat-engine/core';

  let {
    msg,
    waiting = 'searching',
  }: {
    msg: Message;
    /**
     * What a still-empty answer is waiting on (UX backlog #9). `searching`
     * until the stream opens — the server only opens it once it has searched
     * the documents — then `writing` until the first words arrive.
     */
    waiting?: 'searching' | 'writing';
  } = $props();

  // A wait that runs long gets one more plain sentence, so 30 s of waiting
  // does not look like a hang. 12 s is inferred from the 8–39 s first-word
  // times in the UX backlog (#9), not measured here.
  const SLOW_WAIT_MS = 12_000;
  let slow = $state(false);
  $effect(() => {
    if (!(msg.pending && !msg.content)) {
      slow = false;
      return;
    }
    const t = setTimeout(() => (slow = true), SLOW_WAIT_MS);
    return () => clearTimeout(t);
  });

  // The source list, so a click on `[N]` in the answer can open source N.
  let citationCard: { reveal: (ordinal: number) => void } | undefined = $state();
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
   * "published" — retrieval still reaches beyond this conversation's panel in
   * two ways. PUBLISHED documents are the ecosistema's shared corpus and are
   * searched from every conversation, whether or not they are attached to this
   * one. And a DRAFT can be attached to several conversations at once, so one
   * cited here may be listed in another conversation's panel too. Drafts that
   * are attached somewhere else and NOT here are no longer reachable — a draft
   * belongs to the conversations it was added to.
   */
  const draftIds = $derived(draftDocumentIds(app.active?.docs ?? []));
  // An earlier assistant answer retrieved as a source is labelled as such, the
  // same words the model reads in the prompt fence ($lib/assistantChunks).
  const marked = $derived(markDraftCitations(markAssistantCitations(rawCitations), draftIds));
  const citations = $derived(marked.citations);
  const hasCitations = $derived(isAssistant && !msg.error && citations.length > 0);
  const ordinals = $derived(hasCitations ? citations.map((c) => c.ordinal) : []);

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
      <div class="text-ink-soft" role="status" aria-live="polite" data-testid="answer-waiting">
        <span class="inline-flex gap-2 items-center">
          <span class="inline-flex gap-1 items-center" aria-hidden="true">
            <span class="size-1.5 rounded-full bg-ink-soft animate-pulse"></span>
            <span class="size-1.5 rounded-full bg-ink-soft animate-pulse [animation-delay:120ms]"
            ></span>
            <span class="size-1.5 rounded-full bg-ink-soft animate-pulse [animation-delay:240ms]"
            ></span>
          </span>
          {waiting === 'writing' ? 'Escribiendo la respuesta…' : 'Buscando en los documentos…'}
        </span>
        {#if slow}
          <p class="mt-1 text-xs">Puede tardar hasta un minuto.</p>
        {/if}
      </div>
    {/if}
    {#if msg.content}
      {#if isUser && hasRefs}
        <MessageContent content={msg.content} {refs} registry={CHAT_KIND_REGISTRY} />
      {:else if isAssistant && !msg.error}
        <Markdown
          source={msg.content}
          citations={ordinals}
          oncite={(n) => citationCard?.reveal(n)}
        />
      {:else}
        {msg.content}
      {/if}
    {/if}
    {#if msg.error}
      <div class="mt-1 text-xs">⚠ {msg.error}</div>
    {/if}
    {#if msg.notice && !msg.error}
      <div class="mt-1 text-xs text-ink-soft" role="status" data-testid="answer-notice">
        ⚠ {msg.notice}
      </div>
    {/if}

    {#if hasCitations}
      <div class="mt-2 pt-2 border-t border-elevated">
        <!-- Sources start OPEN (UX backlog #10): the list is how a reader
             checks the answer, and a closed toggle hid it. -->
        <CitationCard
          bind:this={citationCard}
          sourcesOpenByDefault
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
