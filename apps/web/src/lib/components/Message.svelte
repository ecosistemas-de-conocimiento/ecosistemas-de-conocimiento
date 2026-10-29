<script lang="ts">
  import type { Message } from '$lib/types';
  import Markdown from './Markdown.svelte';
  import { markdownToPlainText } from '$lib/markdown';
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
  import { citationsWithOrdinals, denseCitations } from '$lib/citationOrdinals';
  import { chatSourceTitle } from '$lib/biblioteca';
  import type { CitationLike, MentionRefLike } from '@edc/chat-engine/core';

  let {
    msg,
    waiting = 'searching',
    onretry,
  }: {
    msg: Message;
    /** Ask a failed answer again (same turn). Absent: no retry button. */
    onretry?: () => void;
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
  // Seconds waited, shown beside the label from `SHOW_SECONDS_AFTER` on: a
  // number that keeps moving says the turn is alive (demo review 2026-10-28:
  // 30–60 s of a still label read as a hang).
  const SHOW_SECONDS_AFTER = 3;
  let waited = $state(0);
  const slow = $derived(waited * 1000 >= SLOW_WAIT_MS);
  $effect(() => {
    if (!(msg.pending && !msg.content)) {
      waited = 0;
      return;
    }
    const started = Date.now();
    const t = setInterval(() => (waited = Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
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
  // Each source keeps the `[N]` the answer used for it (`$lib/citationOrdinals`).
  // A testimonio reads "<generated title> · <24 oct>", else "Testimonio ·
  // <ecosistema> · <24 oct>", plus "— «excerpt»" when one has no placeholder
  // (`chatSourceTitle`); the excerpt was cut server-side from the redacted
  // passage (`$lib/server/citationProvenance`).
  const rawCitations = $derived<CitationLike[]>(
    citationsWithOrdinals(msg.provenance ?? null).map((c) => ({
      ...c,
      title: chatSourceTitle(c.title, c.metadata, app.ecosystem?.name),
      // The card quotes the passage as text: without this a note's `**` and
      // `#` showed raw in the quote (owner, 2026-10-28).
      passageText: c.passageText ? markdownToPlainText(c.passageText) : c.passageText,
    })),
  );

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
  const marked = $derived(markDraftCitations(rawCitations, draftIds));
  // Listed in [N] order and renumbered 1..n with the answer's markers
  // (`denseCitations`). A streaming answer keeps its raw markers until done:
  // its sources arrive only with the final frame.
  const dense = $derived(
    isAssistant && !msg.error && !msg.pending
      ? denseCitations(msg.content ?? '', marked.citations)
      : { content: msg.content, citations: [...marked.citations].sort((a, b) => a.ordinal - b.ordinal) },
  );
  const citations = $derived(dense.citations);
  const hasCitations = $derived(isAssistant && !msg.error && citations.length > 0);
  const ordinals = $derived(hasCitations ? citations.map((c) => c.ordinal) : []);

  // Rating is for ANSWERS only — never the user's own prompt, never a failed or
  // still-streaming turn, and never before the backend has issued the message
  // an id (a `local-…` placeholder has no row to attach a rating to).
  const canRate = $derived(
    isAssistant && !msg.error && !msg.pending && isRatableMessageId(msg.id),
  );
</script>

<!-- On a phone an answer takes the full width: at 80% a 390px screen left a
     ~75px empty strip beside every answer (dev screenshot, 2026-10-28). The
     reader's own messages keep their inset, so who said what stays visible. -->
<div class="flex {isUser ? 'justify-end' : 'justify-start'}">
  <div
    class="max-w-[80%] {isUser ? 'max-sm:max-w-[88%]' : 'max-sm:max-w-full'} min-w-0 [overflow-wrap:anywhere] rounded-lg px-3 py-2 text-sm leading-relaxed shadow-1 {isUser
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
          {#if waited >= SHOW_SECONDS_AFTER}
            <span class="tabular-nums text-xs" aria-hidden="true" data-testid="answer-waited">{waited} s</span>
          {/if}
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
          source={dense.content}
          citations={ordinals}
          oncite={(n) => citationCard?.reveal(n)}
        />
      {:else}
        {msg.content}
      {/if}
    {/if}
    {#if msg.error}
      <div class="mt-1 text-xs">
        ⚠ {msg.error}
        {#if onretry}
          <button
            type="button"
            class="ml-1 underline font-medium hover:no-underline"
            data-testid="answer-retry"
            onclick={onretry}>Reintentar</button
          >
        {/if}
      </div>
    {/if}
    {#if msg.notice && !msg.error}
      <div class="mt-1 text-xs text-ink-soft" role="status" data-testid="answer-notice">
        ⚠ {msg.notice}
      </div>
    {/if}

    {#if hasCitations}
      <!-- No top border here: the card's sources list draws its own. -->
      <div class="mt-2 sources">
        <!-- Sources start OPEN (UX backlog #10), and so does every source's
             card with its quoted passage (demo review 2026-10-28): the
             passages are how a reader checks the answer. ⚠ The card reads
             `initiallyExpanded` once at mount; the key remounts it when the
             final frame renumbers the ordinals. -->
        {#key ordinals.join(',')}
          <CitationCard
            bind:this={citationCard}
            sourcesOpenByDefault
            initiallyExpanded={ordinals}
            {citations}
            labels={CHAT_CITATION_LABELS}
            linkResolver={chatCitationHref}
            collapsibleSources
            idSeed={msg.id}
          />
        {/key}
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

  /* One link per source: the title. The engine's list also renders an
     "Abrir documento" link beside it; the expanded card keeps its own. */
  .sources :global(.citation-source-open) {
    display: none;
  }
</style>
