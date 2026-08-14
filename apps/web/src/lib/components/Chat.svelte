<script lang="ts">
  import { tick } from 'svelte';
  import Message from './Message.svelte';
  import Composer from './Composer.svelte';
  import { app } from '$lib/stores/app.svelte';
  import { generateSync, generateStream, userFacingError, type SyncGenerateResult } from '$lib/api';
  import type { ContextRef, ContextScope } from '$lib/types';

  let scrollRef: HTMLDivElement | undefined = $state();
  let busy = $state(false);
  let controller: AbortController | null = null;

  // The turn's context scope. This product has one level of tenancy — a user's
  // organization — so every turn is organization-wide and there is no scope
  // picker. The engine still wants the ref, so we hand it the org sentinel.
  const scope = $derived<ContextScope>(
    app.active?.contextScope ?? { refs: [{ kind: 'org', id: 'org', label: 'Ecosistema' }] },
  );

  // Auto-scroll on message count changes.
  $effect(() => {
    void app.active?.messages.length;
    tick().then(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
    });
  });

  async function handleSend(text: string, refs: ContextRef[]) {
    const s = app.active;
    if (!s) return;

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
      };

      const finalize = (result: SyncGenerateResult) => {
        app.updateMessage(s.id, placeholder.id, {
          id: result.messageId ?? placeholder.id,
          content: result.text,
          pending: false,
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
    }
  }

  function handleCancel() {
    controller?.abort();
  }
</script>

<section class="flex-1 min-w-0 flex flex-col">
  <header class="border-b border-line px-4 py-2 flex items-center gap-2 bg-surface backdrop-blur">
    {#if app.sidebarCollapsed}
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
    {#if !app.docsPanelOpen}
      <button
        class="text-xs text-ink-soft hover:text-brand px-2 py-1 rounded-lg border border-line hover:border-brand transition-colors"
        onclick={() => app.toggleDocsPanel()}
      >
        Docs ›
      </button>
    {/if}
  </header>

  <div bind:this={scrollRef} class="flex-1 overflow-y-auto">
    <div class="max-w-3xl mx-auto p-4 space-y-3">
      {#if (app.active?.messages.length ?? 0) > 0}
        {#each app.active?.messages ?? [] as m (m.id)}
          <Message msg={m} />
        {/each}
      {:else}
        <div class="text-center text-ink-soft text-sm pt-16">
          <p>Inicia una conversación.</p>
          <p class="text-xs mt-1">
            Sube documentos en el panel de la derecha y usa @ para mencionarlos.
          </p>
        </div>
      {/if}
    </div>
  </div>

  <Composer
    {busy}
    sessionId={app.active?.id ?? ''}
    onsend={handleSend}
    oncancel={handleCancel}
  />
</section>
