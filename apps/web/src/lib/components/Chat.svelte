<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/stores';
  import Message from './Message.svelte';
  import Composer from './Composer.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { runTurn, userFacingError } from '$lib/api';
  import { answerNotice } from '$lib/aiMessages';
  import type { ContextRef, ContextScope } from '$lib/types';
  import {
    LENGUA_ALL,
    LENGUA_CHAT_HINT,
    LENGUA_LABEL,
    lenguaFacetCopy,
    type LenguaFacet,
  } from '$lib/lengua';
  import { ENTREVISTA_LABEL, readEntrevista, showsEntrevista, writeEntrevista } from '$lib/entrevista';
  import { parseSessionKind } from '$lib/sessionKind';

  /** The browser's storage, or null where there is none. */
  const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

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
  /** Student view only (`studentAccess`, layout load): `''` = the whole ecosistema. */
  let alcance = $state<'' | 'mios' | 'companeros'>('');
  const isStudent = $derived($page.data.studentAccess?.student === true);
  $effect(() => {
    void app.active?.id;
    lengua = '';
    alcance = '';
  });

  /**
   * "Hazme preguntas" (`$lib/entrevista`): per conversation, off by default,
   * remembered in this browser. With no conversation open it follows the tab
   * (the first send creates one of that kind) and is saved once it exists.
   */
  const kind = $derived(app.active ? parseSessionKind(app.active.kind) : app.sessionKindTab);
  const showEntrevista = $derived(showsEntrevista(kind, app.features.interviewerMode));
  let entrevista = $state(false);
  $effect(() => {
    entrevista = readEntrevista(storage, app.active?.id);
  });
  function toggleEntrevista() {
    entrevista = !entrevista;
    writeEntrevista(storage, app.active?.id, entrevista);
  }
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
    // Read before the create: opening the new conversation resets the switch.
    const wantEntrevista = showEntrevista && entrevista;
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
      if (wantEntrevista) {
        writeEntrevista(storage, s.id, true);
        entrevista = true;
      }
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

    const fresh = app.active;
    if (!fresh) return;
    const payload = {
      sessionId: fresh.id,
      // One id for the turn, kept by "Reintentar": the server hands back an
      // answer it already saved (or is still writing) instead of a second one.
      turnId: crypto.randomUUID(),
      messages: fresh.messages
        .filter((m) => m.id !== placeholder.id)
        .map((m) => ({ role: m.role, content: m.content })),
      contextRefs: refs,
      scope: fresh.contextScope ?? scope,
      ...(lengua ? { lengua } : {}),
      ...(isStudent && alcance ? { alcance } : {}),
      ...(wantEntrevista ? { entrevista: true } : {}),
    };
    await answer(s.id, placeholder.id, payload);
  }

  /** Failed answers that can be asked again, by placeholder id. */
  let retries = $state<Record<string, () => void>>({});

  async function answer(sessionId: string, placeholderId: string, payload: Parameters<typeof runTurn>[0]) {
    controller = new AbortController();
    busy = true;
    waitingId = placeholderId;
    waitingPhase = 'searching';
    // The answer streamed so far. Kept on screen above the error when the
    // server fails part way, as before `runTurn`.
    let acc = '';
    try {
      // Stream, then sync, then the saved conversation: see `runTurn`.
      const result = await runTurn(payload, {
        signal: controller.signal,
        onOpen: () => {
          waitingPhase = 'writing';
        },
        onDelta: (delta) => {
          acc += delta;
          app.updateMessage(sessionId, placeholderId, { content: acc });
        },
        onRestart: () => {
          acc = '';
          waitingPhase = 'searching';
          app.updateMessage(sessionId, placeholderId, { content: '' });
        },
      });
      app.updateMessage(sessionId, placeholderId, {
        id: result.messageId ?? placeholderId,
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
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        app.deleteMessage(sessionId, placeholderId);
      } else {
        app.updateMessage(sessionId, placeholderId, {
          content: acc,
          pending: false,
          error: userFacingError(err),
        });
        retries[placeholderId] = () => {
          if (busy) return;
          delete retries[placeholderId];
          app.updateMessage(sessionId, placeholderId, { content: '', pending: true, error: undefined });
          void answer(sessionId, placeholderId, payload);
        };
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
  <!-- On a phone the title takes its own line and the controls wrap under it:
       side by side, the lengua picker and the switch squeezed the title to one
       letter at 390px (measured 2026-10-28). -->
  <header class="border-b border-line px-4 py-2 flex flex-wrap items-center gap-2 bg-surface backdrop-blur">
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
    <h2 class="text-sm font-semibold text-ink truncate flex-1 max-sm:basis-full font-display">
      {app.active?.title ?? 'Nueva conversación'}
    </h2>
    {#if isStudent}
      <select
        class="text-xs rounded-lg border border-line bg-surface px-1.5 py-1 max-w-[11rem]"
        class:border-brand={alcance !== ''}
        bind:value={alcance}
        aria-label="Buscar en"
        data-testid="chat-alcance"
      >
        <option value="">Todo el ecosistema</option>
        <option value="mios">Mis trabajos</option>
        <option value="companeros">Mis compañeros</option>
      </select>
    {/if}
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
    {#if showEntrevista}
      <!-- 🔴 A switch, not a checkbox: the state is the "on" track AND the
           knob position AND aria-checked, so it never rests on colour alone. -->
      <button
        type="button"
        role="switch"
        aria-checked={entrevista}
        class="entrevista"
        class:on={entrevista}
        onclick={toggleEntrevista}
        data-testid="chat-entrevista"
      >
        <span class="track" aria-hidden="true"><span class="knob"></span></span>
        <span class="whitespace-nowrap">{ENTREVISTA_LABEL}</span>
      </button>
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
          <Message
            msg={m}
            waiting={m.id === waitingId ? waitingPhase : 'searching'}
            onretry={busy ? undefined : retries[m.id]}
          />
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

<style>
  .entrevista {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.75rem;
    cursor: pointer;
  }
  .entrevista.on {
    border-color: var(--edc-color-brand);
    color: var(--edc-color-brand-strong);
  }
  .entrevista:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .track {
    position: relative;
    width: 1.9rem;
    height: 1.1rem;
    flex: none;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-line-strong);
    transition: background var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .on .track {
    background: var(--edc-color-brand);
  }
  .knob {
    position: absolute;
    top: 0.15rem;
    left: 0.15rem;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    background: var(--edc-color-surface);
    box-shadow: var(--edc-shadow-1);
    transition: transform var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .on .knob {
    transform: translateX(0.8rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .track,
    .knob {
      transition: none;
    }
  }
</style>
