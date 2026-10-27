<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import EcosystemPicker from './EcosystemPicker.svelte';
  import { TITLE_MAX } from '$lib/sessionTitle';
  import { SESSION_KIND_LABELS, SESSION_KINDS } from '$lib/sessionKind';

  /**
   * ⚠ THE `/admin` ENTRY THAT USED TO LIVE HERE MOVED TO THE PRIMARY NAV.
   *
   * This sidebar is the CHAT'S OWN furniture — the ecosistema picker and the
   * list of conversations. A link to a different section of the app sat here
   * only because there was nowhere else to put it, and it was invisible from
   * every page except the chat. Section navigation now lives in
   * `$lib/components/PrimaryNav.svelte`, which decides admin visibility from
   * the same verified `$page.data.user` and with the same caveat: hiding a
   * link is a courtesy, `routes/admin/+page.server.ts` is the control.
   */

  /**
   * ⚠ `forceExpanded` is the NARROW-SCREEN case, not a preference.
   *
   * Inside a drawer (`ChatWorkspace.svelte`, below 64rem) the 40px collapsed
   * rail is meaningless: the drawer is already either open or gone. So the rail
   * is skipped and the collapse button with it — the drawer's own "Cerrar"
   * button is the way out, and two controls that both mean "make this go away"
   * is one more decision than the screen needs.
   *
   * It deliberately does NOT write `app.sidebarCollapsed`. That value is
   * persisted per conversation and belongs to the desktop layout; a phone
   * visit must not silently re-arrange the desk someone left set up.
   */
  let { forceExpanded = false }: { forceExpanded?: boolean } = $props();

  /** The conversation whose name is being edited, and the text so far. */
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  /** The conversation whose "¿Borrar?" question is showing. */
  let confirmingDeleteId = $state<string | null>(null);

  function startRename(id: string, title: string): void {
    confirmingDeleteId = null;
    renameDraft = title;
    renamingId = id;
  }

  async function saveRename(id: string): Promise<void> {
    // Enter and the blur that follows it both land here; act once.
    if (renamingId !== id) return;
    renamingId = null;
    await app.renameSession(id, renameDraft);
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/sign-in';
  }
</script>

{#if app.sidebarCollapsed && !forceExpanded}
  <aside
    class="w-10 shrink-0 border-r border-line bg-surface flex flex-col items-center py-3 gap-2 backdrop-blur"
  >
    <!-- Which ecosistema, even collapsed. See EcosystemPicker's header. -->
    <EcosystemPicker collapsed />
    <button
      class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
      onclick={() => app.toggleSidebar()}
      title="Mostrar barra lateral"
      aria-label="Mostrar barra lateral"
    >
      <svg
        width="18"
        height="18"
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
    <button
      class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
      onclick={() => app.newSession()}
      title="Nueva conversación"
      aria-label="Nueva conversación"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </aside>
{:else}
  <aside class="w-64 shrink-0 border-r border-line bg-surface flex flex-col backdrop-blur">
    <EcosystemPicker />
    <div class="p-3 flex items-center justify-between border-b border-line">
      <h1 class="text-sm font-bold tracking-wide text-ink font-display">Conversaciones</h1>
      <div class="flex items-center gap-1">
        <button
          class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
          onclick={() => app.newSession()}
          title="Nueva conversación"
          aria-label="Nueva conversación"
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
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {#if !forceExpanded}
          <button
            class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
            onclick={() => app.toggleSidebar()}
            title="Contraer"
            aria-label="Contraer barra lateral"
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
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        {/if}
      </div>
    </div>

    <!-- ⚠ Named, because the app now has TWO navigation landmarks: this list of
         conversations and the primary section menu in the root layout. An
         unnamed one leaves a screen-reader user with two identical
         "navigation" landmarks and no way to tell them apart. -->
    <!-- Generales / Resonancias (`$lib/sessionKind`). Labels only, no hint
         copy (owner rule). "Nueva conversación" creates one in the active tab. -->
    <div class="flex gap-1 px-2 pt-2" role="tablist" aria-label="Tipo de conversación">
      {#each SESSION_KINDS as kind (kind)}
        {@const selected = app.sessionKindTab === kind}
        <button
          class="flex-1 text-xs py-1 rounded-md border transition-colors {selected
            ? 'bg-surface-accent text-ink border-brand font-semibold'
            : 'text-ink-soft border-line hover:bg-surface-soft hover:text-ink'}"
          role="tab"
          aria-selected={selected}
          onclick={() => app.setSessionKindTab(kind)}
          data-testid={`session-tab-${kind}`}
        >
          {SESSION_KIND_LABELS[kind]}
        </button>
      {/each}
    </div>

    <nav class="flex-1 overflow-y-auto p-2 space-y-0.5" aria-label="Conversaciones">
      {#each app.tabSessions as s (s.id)}
        {@const isActive = s.id === app.activeSessionId}
        <!-- 🔴 THE OPEN CONVERSATION IS MARKED THREE WAYS, NOT ONE. The tint
             alone was the whole signal, and a tint is exactly what a
             colour-blind reader and a washed-out cheap screen both lose. Now
             there is also a bar down the left edge (a SHAPE) and bold weight,
             plus `aria-current` so a screen reader is told outright rather
             than being expected to see it. -->
        <div
          class="group flex items-center gap-1 rounded-lg border-l-2 pl-1.5 pr-1 py-1 transition-colors {isActive
            ? 'bg-surface-accent text-ink border-brand font-semibold'
            : 'text-ink-soft border-transparent hover:bg-surface-soft hover:text-ink'}"
          data-testid="session-row"
        >
          {#if renamingId === s.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="flex-1 min-w-0 text-sm rounded border border-brand bg-surface px-1.5 py-0.5 text-ink font-normal"
              bind:value={renameDraft}
              maxlength={TITLE_MAX}
              aria-label="Nuevo nombre de la conversación"
              autofocus
              onkeydown={(e) => {
                if (e.key === 'Enter') void saveRename(s.id);
                if (e.key === 'Escape') renamingId = null;
              }}
              onblur={() => void saveRename(s.id)}
            />
          {:else if confirmingDeleteId === s.id}
            <!-- In-app confirm (UX backlog #19). The native confirm() box is a
                 grey browser dialog that looks like an error on a phone. -->
            <div class="flex-1 min-w-0 flex flex-col gap-1 py-0.5" role="group" aria-label="Confirmar borrado">
              <span class="text-xs text-ink font-normal">¿Borrar esta conversación?</span>
              <div class="flex gap-1">
                <button
                  class="text-xs px-2 py-1 rounded border border-danger text-danger font-semibold hover:bg-surface-soft"
                  onclick={() => {
                    confirmingDeleteId = null;
                    void app.deleteSession(s.id);
                  }}
                  data-testid="session-delete-confirm"
                >
                  Sí, borrar
                </button>
                <button
                  class="text-xs px-2 py-1 rounded border border-line text-ink hover:bg-surface-soft"
                  onclick={() => (confirmingDeleteId = null)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          {:else}
            <!-- 🔴 THE OPEN CONVERSATION IS MARKED THREE WAYS, NOT ONE. The tint
                 alone was the whole signal, and a tint is exactly what a
                 colour-blind reader and a washed-out cheap screen both lose. Now
                 there is also a bar down the left edge (a SHAPE) and bold weight,
                 plus `aria-current` so a screen reader is told outright rather
                 than being expected to see it. -->
            <button
              class="flex-1 min-w-0 text-left truncate text-sm py-0.5"
              onclick={() => app.selectSession(s.id)}
              aria-current={isActive ? 'true' : undefined}
              title={s.title}
            >
              {s.title}
            </button>
            <!-- ⚠ Always visible, not hover-only (UX backlog #19): a phone has
                 no hover, so a hover-only button does not exist there. Soft
                 until the row is hovered or focused. -->
            <button
              class="shrink-0 p-1 rounded text-ink-soft opacity-60 group-hover:opacity-100 focus:opacity-100 hover:text-brand"
              onclick={() => startRename(s.id, s.title)}
              title="Cambiar nombre"
              aria-label={`Cambiar el nombre de "${s.title}"`}
              data-testid="session-rename"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </button>
            <button
              class="shrink-0 p-1 rounded text-ink-soft opacity-60 group-hover:opacity-100 focus:opacity-100 hover:text-danger"
              onclick={() => {
                renamingId = null;
                confirmingDeleteId = s.id;
              }}
              title="Borrar conversación"
              aria-label={`Borrar "${s.title}"`}
              data-testid="session-delete"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"
                />
              </svg>
            </button>
          {/if}
        </div>
      {/each}
    </nav>

    <div class="border-t border-line p-2 flex items-center justify-end text-xs text-ink-soft">
      <button class="px-1.5 py-0.5 rounded hover:bg-surface-soft hover:text-ink" onclick={logout}>
        Cerrar sesión
      </button>
    </div>
  </aside>
{/if}
