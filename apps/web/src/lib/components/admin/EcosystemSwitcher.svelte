<svelte:options runes={true} />

<script lang="ts">
  /**
   * 🔴 THE OVERSIGHT SELECTOR. Which ecosistema is /admin looking at?
   *
   * ⚠ THIS IS NOT THE SIDEBAR PICKER, AND THE DIFFERENCE IS THE WHOLE POINT.
   *
   *  · `EcosystemPicker` (sidebar) lists the ecosistemas you are a MEMBER of.
   *    It decides where YOUR uploads and YOUR conversations land, and the
   *    backend refuses anything else (`Sessions.beforeValidate`).
   *  · This one lists EVERY ecosistema on the installation. It decides what you
   *    are REVIEWING. It grants nothing, joins nothing, and writes nothing.
   *
   * The owner's rule — *"admin es admin, no necesita ser miembro para ver todo,
   * y no deberá poderse asignar"* — is exactly that split. So rows the caller
   * actually belongs to carry a "Eres miembro" tag: seeing which of the 90 you
   * are IN, while looking at a list you can review all of, is what keeps the
   * two powers from blurring back together in the reader's head.
   *
   * ── THE CONTROL IS A LINK, NOT A FETCH ─────────────────────────────────────
   *
   * Picking an ecosistema navigates to `?eco=<id>`; searching submits a plain
   * GET form. Three things fall out of that and all three are wanted:
   *  · the scope of the page is visible in the URL and shareable,
   *  · the whole page re-scopes server-side, so nothing stale can survive a
   *    switch the way it could with a partial client-side update,
   *  · it works with JavaScript off.
   *
   * ── SEARCH AT ~90 ENTRIES ──────────────────────────────────────────────────
   *
   * The server already sent every row (one `limit=100` read, ids + names +
   * slugs only, a few kB). So typing filters THE LIST IN THE BROWSER, with no
   * round trip: at 90 rows — nearly all `e2e-be-…` litter — that is the
   * difference between a usable box and one that stutters on every keystroke.
   *
   * ⚠ The server-side search is still wired, and is not dead code: it is what
   * `truncated` falls back to when an installation outgrows one page. When that
   * happens the panel says so and the Enter key reaches the backend.
   */
  import { untrack } from 'svelte';

  import { filterEcosystems } from '$lib/components/admin/summary';
  import { ecosystemInitials, type Ecosystem } from '$lib/ecosystems';

  interface Directory {
    rows: Ecosystem[];
    totalDocs: number;
    truncated: boolean;
    ok: boolean;
    search: string;
  }

  let {
    directory,
    selected,
    /** Ids the caller is a member of. Display only — it restricts nothing. */
    mine = [],
    /** `?eco=` named an ecosistema that does not exist. */
    notFound = false,
  }: {
    directory: Directory;
    selected: Ecosystem | null;
    mine?: string[];
    notFound?: boolean;
  } = $props();

  /** How many rows the panel draws before it stops and says how many are left. */
  const MAX_VISIBLE = 40;

  let open = $state(false);
  /**
   * The in-browser filter. SEEDED ONCE from whatever the server already filtered
   * by, then owned by the input.
   *
   * ⚠ Deliberately not reactive to `directory.search`. Every switch and every
   * server-side search is a full navigation, so the component remounts with the
   * right seed — while a live binding would yank the box out from under someone
   * mid-word.
   */
  // svelte-ignore state_referenced_locally
  let term = $state(untrack(() => directory.search));

  const memberOf = $derived(new Set(mine));

  /**
   * 🔴 The filter is PURE and lives in `summary.ts`, not here.
   *
   * `apps/web` runs vitest with no DOM, so nothing inside a `.svelte` file can
   * be asserted. Accent folding and the name-or-slug rule are exactly the parts
   * a refactor breaks silently, so they are unit-tested next door.
   */
  const matches = $derived(filterEcosystems(directory.rows, term));
  const visible = $derived(matches.slice(0, MAX_VISIBLE));

  /** Keep the search term in the URL when switching, so the list survives it. */
  function href(id: string): string {
    const qs = new URLSearchParams({ eco: id });
    if (directory.search) qs.set('q', directory.search);
    return `/admin?${qs.toString()}`;
  }
</script>

<div class="switcher">
  <div class="current">
    <span class="badge" aria-hidden="true">{selected ? ecosystemInitials(selected.name) : '·'}</span>
    <div class="who">
      <p class="label">Estás revisando</p>
      <p class="name">{selected?.name ?? 'Ninguno'}</p>
    </div>
    <button
      class="toggle"
      type="button"
      onclick={() => (open = !open)}
      aria-expanded={open}
      data-interactive
    >
      {open ? 'Cerrar' : 'Cambiar de ecosistema'}
    </button>
  </div>

  {#if notFound}
    <p class="note warn" role="status">
      El ecosistema que pediste no existe. Estás viendo otro; elígelo de la lista.
    </p>
  {/if}

  {#if !directory.ok}
    <!-- ⚠ A failed read is not an empty installation, and must never be shown
         as one. Whatever arrived is still listed, labelled as partial. -->
    <p class="note warn" role="status">
      No pudimos leer la lista completa de ecosistemas. Puede faltar alguno.
    </p>
  {/if}

  {#if open}
    <div class="panel">
      <!-- A real GET form: works without JavaScript, and is the path that
           reaches the backend when the list is bigger than one page. -->
      <form class="search" method="GET" action="/admin">
        {#if selected}<input type="hidden" name="eco" value={selected.id} />{/if}
        <label class="sr-only" for="eco-search">Buscar ecosistema</label>
        <input
          id="eco-search"
          name="q"
          type="search"
          class="search-input"
          placeholder="Buscar por nombre o clave…"
          autocomplete="off"
          bind:value={term}
          data-interactive
        />
        {#if directory.truncated}
          <button class="search-go" type="submit" data-interactive>Buscar</button>
        {/if}
      </form>

      <p class="note">
        {#if directory.truncated}
          <!-- The one case where the browser cannot answer on its own. -->
          Mostramos {directory.rows.length} de {directory.totalDocs} ecosistemas. Escribe y presiona
          <strong>Buscar</strong> para consultar el resto.
        {:else if term.trim()}
          {matches.length} de {directory.rows.length} ecosistemas coinciden.
        {:else}
          {directory.rows.length}
          {directory.rows.length === 1 ? 'ecosistema' : 'ecosistemas'} en la plataforma.
        {/if}
      </p>

      {#if matches.length === 0}
        <p class="note">Ningún ecosistema coincide con “{term.trim()}”.</p>
      {:else}
        <ul class="list">
          {#each visible as eco (eco.id)}
            {@const isCurrent = eco.id === selected?.id}
            <li>
              <a
                class="row"
                class:current-row={isCurrent}
                href={href(eco.id)}
                aria-current={isCurrent ? 'true' : undefined}
                data-interactive
              >
                <span class="tick" aria-hidden="true">{isCurrent ? '✓' : ''}</span>
                <span class="row-name">{eco.name}</span>
                {#if eco.slug}<span class="slug">{eco.slug}</span>{/if}
                {#if memberOf.has(eco.id)}
                  <!-- 🔴 Membership is a LABEL here, never a filter. You review
                       all of them; you belong to some of them. -->
                  <span class="member">Eres miembro</span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
        {#if matches.length > visible.length}
          <p class="note">
            Y {matches.length - visible.length} más. Escribe para acotar la lista.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .switcher {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem 0.9rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
  }
  .current {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }
  .who {
    flex: 1 1 12rem;
    min-width: 0;
  }
  .badge {
    flex: none;
    width: 1.9rem;
    height: 1.9rem;
    border-radius: var(--edc-radius-1);
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-ink);
    font-size: 0.68rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .label {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  .name {
    margin: 0.1rem 0 0;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--edc-color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toggle {
    flex: none;
    padding: 0.35rem 0.75rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    background: transparent;
    font-size: 0.76rem;
    font-weight: 700;
    color: var(--edc-color-ink-soft);
    cursor: pointer;
  }
  .toggle:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }
  .panel {
    display: grid;
    gap: 0.45rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .search {
    display: flex;
    gap: 0.4rem;
  }
  .search-input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.6rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font-size: 0.85rem;
  }
  .search-go {
    flex: none;
    padding: 0.35rem 0.7rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-neutral-outline);
    background: transparent;
    font-size: 0.76rem;
    font-weight: 700;
    color: var(--edc-color-ink-soft);
    cursor: pointer;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 19rem;
    overflow-y: auto;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface);
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    text-decoration: none;
    color: var(--edc-color-ink-body);
  }
  .row:hover {
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink);
  }
  .current-row {
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-ink);
    font-weight: 700;
  }
  .tick {
    width: 0.8rem;
    flex: none;
  }
  .row-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .slug {
    font-family: var(--edc-font-mono);
    font-size: 0.68rem;
    color: var(--edc-color-ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .member {
    margin-left: auto;
    flex: none;
    padding: 0.05rem 0.35rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-neutral-outline);
    font-size: 0.62rem;
    font-weight: 700;
    color: var(--edc-color-ink-soft);
  }
  .note {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--edc-color-ink-soft);
  }
  .note.warn {
    color: var(--edc-color-ink-body);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
