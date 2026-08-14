<script lang="ts">
  /**
   * Which ecosistema am I in — and, if I belong to several, switch.
   *
   * ⚠ IT SITS AT THE TOP OF THE SIDEBAR, ABOVE THE CONVERSATIONS, AND IT IS
   * NEVER HIDDEN. Whether a document is private or shared depends entirely on
   * which ecosistema it lands in, so someone who cannot see the answer cannot
   * reason about who reads their uploads. The collapsed rail keeps a two-letter
   * badge for the same reason — collapsing the sidebar is a layout choice, not
   * consent to stop being told which tenant you are in.
   *
   * ⚠ WITH EXACTLY ONE MEMBERSHIP THERE IS NO CHOOSER — just the name. A
   * dropdown with one option is noise that teaches people to ignore the control
   * that matters on the day they have two.
   */
  import { app } from '$lib/stores/app.svelte';
  import { ecosystemInitials } from '$lib/ecosystems';

  let { collapsed = false }: { collapsed?: boolean } = $props();

  let open = $state(false);

  const current = $derived(app.ecosystem);
  const name = $derived(current?.name ?? '');
  const many = $derived(app.canSwitchEcosystem);

  async function choose(id: string) {
    open = false;
    if (id === app.ecosystemId) return;
    await app.switchEcosystem(id);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  onclick={(e) => {
    // Click-outside. The menu is small and modal-less; a stray click elsewhere
    // should close it rather than leave it floating over the conversations.
    if (open && !(e.target as HTMLElement)?.closest?.('[data-ecosystem-picker]')) open = false;
  }}
/>

{#if collapsed}
  <!-- Collapsed rail: initials only, with the full name in the tooltip. -->
  <button
    class="w-7 h-7 shrink-0 rounded-lg bg-surface-accent text-ink text-[10px] font-semibold
           flex items-center justify-center hover:bg-surface-soft"
    onclick={() => app.toggleSidebar()}
    title={name ? `Ecosistema: ${name}` : 'Ecosistema'}
    aria-label={name ? `Ecosistema actual: ${name}` : 'Ecosistema'}
  >
    {name ? ecosystemInitials(name) : '·'}
  </button>
{:else}
  <div class="px-3 py-2.5 border-b border-line" data-ecosystem-picker>
    <p class="text-[10px] uppercase tracking-wider text-ink-soft">Ecosistema</p>

    {#if !app.ecosystemsReady}
      <p class="text-sm text-ink-soft mt-0.5">Cargando…</p>
    {:else if app.ecosystemsUnavailable}
      <p class="text-sm text-ink-soft mt-0.5" title="No se pudo leer tu lista de ecosistemas">
        No disponible
      </p>
    {:else if !current}
      <p class="text-sm text-ink-soft mt-0.5">Ninguno</p>
    {:else if !many}
      <!-- One membership: the name, and nothing to press. -->
      <p class="text-sm font-medium text-ink truncate mt-0.5" title={name}>{name}</p>
    {:else}
      <div class="relative mt-0.5">
        <button
          class="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 -mx-2
                 text-left hover:bg-surface-soft disabled:opacity-60"
          onclick={() => (open = !open)}
          disabled={app.switchingEcosystem}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={name}
        >
          <span class="text-sm font-medium text-ink truncate">{name}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0 text-ink-soft"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {#if open}
          <ul
            class="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg
                   border border-line bg-surface shadow-lg py-1"
            role="listbox"
            aria-label="Elige un ecosistema"
          >
            {#each app.ecosystems as eco (eco.id)}
              {@const isCurrent = eco.id === app.ecosystemId}
              <li>
                <button
                  class="w-full text-left px-2.5 py-1.5 text-sm flex items-center gap-2
                         {isCurrent ? 'text-ink bg-surface-accent' : 'text-ink-soft hover:bg-surface-soft hover:text-ink'}"
                  role="option"
                  aria-selected={isCurrent}
                  onclick={() => choose(eco.id)}
                >
                  <span class="w-3 shrink-0 text-center">{isCurrent ? '✓' : ''}</span>
                  <span class="truncate">{eco.name}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if app.switchingEcosystem}
      <p class="text-[10px] text-ink-soft mt-1">Cambiando de ecosistema…</p>
    {:else if current}
      <!-- The reason this control exists, said once, where the choice is made. -->
      <p class="text-[10px] text-ink-soft mt-1 leading-snug">
        Lo que publiques aquí lo ve este ecosistema. Tus borradores solo los ves tú.
      </p>
    {/if}
  </div>
{/if}
