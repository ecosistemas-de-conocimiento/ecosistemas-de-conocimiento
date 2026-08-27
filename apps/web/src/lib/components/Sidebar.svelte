<script lang="ts">
  import { page } from '$app/stores';
  import { app } from '$lib/stores/app.svelte';
  import { isPlatformAdmin } from '$lib/components/admin/summary';
  import EcosystemPicker from './EcosystemPicker.svelte';

  /**
   * Show the admin entry only to platform admins.
   *
   * ⚠ THIS IS A COURTESY, NOT A CONTROL. `/admin` gates itself server-side in
   * its own `load` (see `routes/admin/+page.server.ts`); hiding the link only
   * keeps the sidebar honest for everyone else. If this line were the whole
   * protection, typing the URL would defeat it.
   *
   * Read off `$page.data.user`, which the root layout's server load supplies
   * from the verified session — not off the app store, which is about the
   * chat's state and knows nothing about roles.
   */
  const showAdmin = $derived(isPlatformAdmin($page.data.user));

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/sign-in';
  }
</script>

{#if app.sidebarCollapsed}
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
    {#if showAdmin}
      <a
        href="/admin"
        data-interactive
        class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
        title="Contribuciones"
        aria-label="Contribuciones"
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
          <path d="M3 3v18h18M7 15V9m5 6V5m5 10v-4" />
        </svg>
      </a>
    {/if}
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
      </div>
    </div>

    <nav class="flex-1 overflow-y-auto p-2 space-y-0.5">
      {#each app.sessions as s (s.id)}
        {@const isActive = s.id === app.activeSessionId}
        <div
          class="group flex items-center justify-between rounded-lg px-2 py-1.5 cursor-pointer transition-colors {isActive
            ? 'bg-surface-accent text-ink'
            : 'text-ink-soft hover:bg-surface-soft hover:text-ink'}"
          onclick={() => app.selectSession(s.id)}
          onkeydown={(e) => e.key === 'Enter' && app.selectSession(s.id)}
          role="button"
          tabindex="0"
        >
          <span class="truncate text-sm">{s.title}</span>
          <button
            class="opacity-0 group-hover:opacity-100 text-ink-soft hover:text-danger p-0.5"
            onclick={(e) => {
              e.stopPropagation();
              if (confirm(`¿Eliminar "${s.title}"?`)) app.deleteSession(s.id);
            }}
            title="Eliminar conversación"
            aria-label="Eliminar conversación"
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
        </div>
      {/each}
    </nav>

    {#if showAdmin}
      <a
        href="/admin"
        data-interactive
        data-testid="admin-link"
        class="mx-2 mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-surface-soft hover:text-ink"
        title="Ver todo lo que ha reunido el ecosistema"
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
          <path d="M3 3v18h18M7 15V9m5 6V5m5 10v-4" />
        </svg>
        <span class="truncate">Contribuciones</span>
      </a>
    {/if}

    <div class="border-t border-line p-2 flex items-center justify-between text-[10px] text-ink-soft">
      <span>guardado en el servidor</span>
      <button
        class="px-1.5 py-0.5 rounded hover:bg-surface-soft hover:text-ink"
        onclick={logout}
        title="Cerrar sesión"
      >
        cerrar sesión
      </button>
    </div>
  </aside>
{/if}
