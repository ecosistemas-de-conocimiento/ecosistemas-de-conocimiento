<script lang="ts">
  import { tick } from 'svelte';
  import Message from './Message.svelte';
  import Composer from './Composer.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { generateSync, generateStream, userFacingError, type SyncGenerateResult } from '$lib/api';
  import { answerNotice } from '$lib/aiMessages';
  import type { ContextRef, ContextScope } from '$lib/types';
  import {
    LENGUA_ALL,
    LENGUA_CHAT_HINT,
    LENGUA_LABEL,
    lenguaFacetCopy,
    type LenguaFacet,
  } from '$lib/lengua';

  /**
   * ⚠ NARROW-SCREEN CASE. Below 64rem the two supporting panes are drawers
   * opened from the labelled bar in `ChatWorkspace.svelte`. These two in-header
   * buttons open the same things, so on a phone they are a second, differently
   * worded way to do what the bar already does — and one of them ("Docs ›") is
   * an abbreviation. One control per job.
   */
  let { hidePanelButtons = false }: { hidePanelButtons?: boolean } = $props();

  let scrollRef: HTMLDivElement | undefined = $state();
  let busy = $state(false);
  let controller: AbortController | null = null;
  /**
   * The answer being waited on, and what it is waiting for (UX backlog #9).
   * Kept here rather than on the message: it is screen state, never saved.
   */
  let waitingId = $state<string | null>(null);
  let waitingPhase = $state<'searching' | 'writing'>('searching');

  // The turn's context scope. This product has one level of tenancy — a user's
  // organization — so every turn is organization-wide and there is no scope
  // picker. The engine still wants the ref, so we hand it the org sentinel.
  const scope = $derived<ContextScope>(
    app.active?.contextScope ?? { refs: [{ kind: 'org', id: 'org', label: 'Ecosistema' }] },
  );

  /**
   * The lengua filter for this conversation's next turns. `''` ⇒ none.
   *
   * ⚠ Reset when the conversation changes: a filter carried silently into
   * another conversation would answer there from a fraction of the corpus.
   */
  let lengua = $state('');
  let lenguas = $state<LenguaFacet[]>([]);
  $effect(() => {
    void app.active?.id;
    lengua = '';
  });
  // The ecosistema's languages, once. A failed read leaves the control hidden.
  $effect(() => {
    let cancelled = false;
    fetch('/api/lenguas', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { lenguas?: LenguaFacet[] } | null) => {
        if (!cancelled && Array.isArray(body?.lenguas)) lenguas = body.lenguas;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  // Auto-scroll on message count changes.
  $effect(() => {
    void app.active?.messages.length;
    tick().then(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
    });
  });

  async function handleSend(text: string, refs: ContextRef[]) {
    // With no conversation open, this send creates it. `busy` goes up first so
    // a second Enter while the create is on the wire is ignored by Composer.
    if (busy) return;
    let s = app.active;
    if (!s) {
      busy = true;
      try {
        await app.ensureSession();
      } finally {
        busy = false;
      }
      s = app.active;
      // The create failed and `newSession` already said why.
      if (!s) return;
    }

    const userMsg = app.addLocalMessage(s.id, { role: 'user', content: text, contextRefs: refs });
    const placeholder = app.addLocalMessage(s.id, {
      role: 'assistant',
      content: '',
      pending: true,
    });

    void app.persistMessage(s.id, { role: 'user', content: text, contextRefs: refs }).then((serverId) => {
      if (serverId) {
        app.updateMessage(s.id, userMsg.id, { id: serverId });
      }
    });

    controller = new AbortController();
    busy = true;
    waitingId = placeholder.id;
    waitingPhase = 'searching';
    try {
      const fresh = app.active;
      if (!fresh) return;
      const payload = {
        sessionId: fresh.id,
        messages: fresh.messages
          .filter((m) => m.id !== placeholder.id)
          .map((m) => ({ role: m.role, content: m.content })),
        contextRefs: refs,
        scope: fresh.contextScope ?? scope,
        ...(lengua ? { lengua } : {}),
      };

      const finalize = (result: SyncGenerateResult) => {
        app.updateMessage(s.id, placeholder.id, {
          id: result.messageId ?? placeholder.id,
          content: result.text,
          pending: false,
          notice: answerNotice(result.warnings),
          provenance: result.provenance ?? null,
          generationMeta: {
            traceId: result.traceId,
            modelUsed: result.modelUsed,
            provider: result.provider,
            costUsd: result.costUsd,
          },
        });
      };

      let acc = '';
      let received = false;
      try {
        const result = await generateStream(payload, {
          signal: controller.signal,
          onOpen: () => {
            waitingPhase = 'writing';
          },
          onDelta: (delta) => {
            received = true;
            acc += delta;
            app.updateMessage(s.id, placeholder.id, { content: acc });
          },
        });
        finalize(result);
      } catch (streamErr) {
        if (streamErr instanceof Error && streamErr.name === 'AbortError') throw streamErr;
        if (received) {
          app.updateMessage(s.id, placeholder.id, {
            pending: false,
            error: userFacingError(streamErr),
          });
        } else {
          const result = await generateSync(payload, { signal: controller.signal });
          finalize(result);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        app.deleteMessage(s.id, placeholder.id);
      } else {
        app.updateMessage(s.id, placeholder.id, {
          content: '',
          pending: false,
          error: userFacingError(err),
        });
      }
    } finally {
      busy = false;
      controller = null;
      waitingId = null;
    }
  }

  function handleCancel() {
    controller?.abort();
  }
</script>

<section class="flex-1 min-w-0 flex flex-col">
  <header class="border-b border-line px-4 py-2 flex items-center gap-2 bg-surface backdrop-blur">
    {#if app.sidebarCollapsed && !hidePanelButtons}
      <button
        class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
        onclick={() => app.toggleSidebar()}
        title="Mostrar barra lateral"
        aria-label="Mostrar barra lateral"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    {/if}
    <h2 class="text-sm font-semibold text-ink truncate flex-1 font-display">
      {app.active?.title ?? 'Sin chat seleccionado'}
    </h2>
    {#if lenguas.length > 0}
      <label class="flex items-center gap-1 text-xs text-ink-soft" title={LENGUA_CHAT_HINT}>
        <span class="sr-only sm:not-sr-only">{LENGUA_LABEL}</span>
        <select
          class="text-xs rounded-lg border border-line bg-surface px-1.5 py-1 max-w-[11rem]"
          class:border-brand={lengua !== ''}
          bind:value={lengua}
          aria-label={`${LENGUA_LABEL}: ${LENGUA_CHAT_HINT}`}
          data-testid="chat-lengua"
        >
          <option value="">{LENGUA_ALL}</option>
          {#each lenguas as f (f.lengua)}
            <option value={f.lengua}>{lenguaFacetCopy(f)}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if !app.docsPanelOpen && !hidePanelButtons}
      <button
        class="text-xs text-ink-soft hover:text-brand px-2 py-1 rounded-lg border border-line hover:border-brand transition-colors whitespace-nowrap"
        onclick={() => app.toggleDocsPanel()}
      >
        Documentos ›
      </button>
    {/if}
  </header>

  <div bind:this={scrollRef} class="flex-1 overflow-y-auto">
    <div class="max-w-3xl mx-auto p-4 space-y-3">
      {#if (app.active?.messages.length ?? 0) > 0}
        {#each app.active?.messages ?? [] as m (m.id)}
          <Message msg={m} waiting={m.id === waitingId ? waitingPhase : 'searching'} />
        {/each}
      {:else}
        <div class="text-center text-ink-soft text-sm pt-16">
          <p>Inicia una conversación.</p>
        </div>
      {/if}
    </div>
  </div>

  <Composer
    {busy}
    narrow={hidePanelButtons}
    sessionId={app.active?.id ?? ''}
    onsend={handleSend}
    oncancel={handleCancel}
  />
</section>
