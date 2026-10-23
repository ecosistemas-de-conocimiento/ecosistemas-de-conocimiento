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
   * 🔴 ONE MEMBERSHIP STILL GETS A FIELD, NEVER A FAKE CHOOSER.
   *
   * This used to render the name as plain text when there was nothing to
   * choose. The reasoning — a dropdown with one option is noise — was right,
   * and `ecosystemPickerView` still refuses to draw a chooser in that case.
   * The conclusion was wrong: removing the control removed the FIELD too, and
   * a grey name under a small heading reads as decoration. People could not
   * find the feature at all.
   *
   * So the value now always sits in a bordered field with its initials badge,
   * and only the `multiple` case is pressable. No disabled dropdown, no chevron
   * that goes nowhere. No explainer line under it either (UX backlog #33).
   *
   * The safety behaviour is untouched and lives elsewhere: the selection is
   * re-validated server-side against real memberships (`$lib/server/ecosystem`,
   * `resolveEcosystemSelection`), switching blanks ecosistema-scoped state
   * before new data lands (`app.switchEcosystem`), and an unreadable list shows
   * `No disponible` rather than claiming zero memberships.
   */
  import { invalidate } from '$app/navigation';
  import { app } from '$lib/stores/app.svelte';
  import { ECOSYSTEM_DEPENDENCY, ecosystemInitials, ecosystemPickerView } from '$lib/ecosystems';

  let { collapsed = false }: { collapsed?: boolean } = $props();

  let open = $state(false);

  const current = $derived(app.ecosystem);
  const name = $derived(current?.name ?? '');
  const view = $derived(
    ecosystemPickerView({
      ready: app.ecosystemsReady,
      unavailable: app.ecosystemsUnavailable,
      current,
      count: app.ecosystems.length,
    }),
  );

  async function choose(id: string) {
    open = false;
    if (id === app.ecosystemId) return;
    // Re-run server loads scoped to the selection (e.g. `/revision`).
    if (await app.switchEcosystem(id)) await invalidate(ECOSYSTEM_DEPENDENCY);
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
    <p class="text-[10px] uppercase tracking-wider text-ink-soft" id="eco-picker-label">
      Ecosistema
    </p>

    {#if view.interactive}
      <!-- Several memberships: the field IS the chooser. Same box as the
           single-membership one, plus a chevron and a listbox. -->
      <div class="relative mt-1">
        <button
          class="eco-field eco-field-button"
          onclick={() => (open = !open)}
          disabled={app.switchingEcosystem}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="eco-picker-label"
          title={name}
        >
          <span class="eco-initials" aria-hidden="true">{ecosystemInitials(view.value)}</span>
          <span class="text-sm font-medium text-ink line-clamp-2 leading-tight flex-1 text-left">{view.value}</span>
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
            aria-hidden="true"
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
    {:else}
      <!-- 🔴 NOT A DISABLED DROPDOWN. A `<div>` with no chevron and no hover
           state: it is a field showing a value, and the hint below says why
           there is nothing to press. A greyed-out `<select>` here would imply
           options this user does not have. -->
      <div
        class="eco-field eco-field-static"
        class:eco-field-muted={view.mode !== 'single'}
        aria-labelledby="eco-picker-label"
        title={view.mode === 'single' ? name : view.hint || view.value}
      >
        {#if view.mode === 'single'}
          <span class="eco-initials" aria-hidden="true">{ecosystemInitials(view.value)}</span>
        {/if}
        <span
          class="text-sm line-clamp-2 leading-tight flex-1 {view.mode === 'single'
            ? 'font-medium text-ink'
            : 'text-ink-soft'}"
        >
          {view.value}
        </span>
      </div>
    {/if}

    {#if app.switchingEcosystem}
      <p class="text-[10px] text-ink-soft mt-1" role="status">Cambiando de ecosistema…</p>
    {:else if view.hint}
      <p class="text-[10px] text-ink-soft mt-1 leading-snug">{view.hint}</p>
    {/if}
  </div>
{/if}

<style>
  /* The field. Same box whether or not it can be pressed — that sameness is
     the point: the setting is always visibly A SETTING. */
  .eco-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
    padding: 0.375rem 0.5rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface-soft);
  }
  .eco-field-button {
    cursor: pointer;
    text-align: left;
  }
  .eco-field-button:hover:not(:disabled) {
    background: var(--edc-color-surface-accent);
  }
  .eco-field-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .eco-field-button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  /* Not pressable: no cursor change, no hover. Nothing here invites a click. */
  .eco-field-static {
    cursor: default;
  }
  /* Loading / unavailable / none — a field with no value worth emphasising. */
  .eco-field-muted {
    border-style: dashed;
    background: transparent;
  }
  .eco-initials {
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--edc-radius-1);
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-ink);
    font-size: 0.5625rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
