<svelte:options runes={true} />

<script lang="ts">
  /**
   * 🔴 WHICH ECOSISTEMA IS `/grafo` DESCRIBING? Platform admins only.
   *
   * ⚠ THIS SELECTS SCOPE, NEVER CONTENT (ADR §7.1). It is the one thing that
   * differs by role on this page. An admin picks an ecosistema and then sees
   * exactly the rows a member of it would see: same minimum-support threshold,
   * same published-only rule, same everything. There is deliberately no
   * unprotected view of the graph, and this is not one — the note on the panel
   * says so out loud, because a picker that lists all 90 tenants would
   * otherwise read as "I am now seeing more".
   *
   * ⚠ NOT THE SIDEBAR PICKER. `EcosystemPicker` lists the ecosistemas you are a
   * MEMBER of and decides where YOUR uploads and conversations land. This one
   * lists every ecosistema on the installation and decides what you are LOOKING
   * AT. It writes nothing — in particular not the `eco_selected` cookie — so
   * looking at a tenant never re-points the tenant you work in.
   *
   * ── A SIBLING OF `admin/EcosystemSwitcher.svelte`, NOT A SHARED COMPONENT ───
   *
   * The two look alike and are deliberately separate. The admin one navigates
   * to `/admin`; this one navigates to `/grafo` AND has a rule the admin one
   * does not need — it drops `?entidad=`/`?conexion=` on the way, because an
   * entity id belongs to exactly one ecosistema and carrying it across a switch
   * opens the new graph on "eso ya no aparece en el grafo". That rule lives in
   * `graphEcosystemHref` in `$lib/graph.ts`, where vitest can assert it.
   *
   * ── THE CONTROL IS A LINK, NOT A FETCH ──────────────────────────────────────
   *
   * Picking navigates to `?eco=<id>`; searching submits a plain GET form. The
   * scope is visible in the URL and shareable, the whole page re-scopes
   * server-side so nothing stale survives a switch, and it works with
   * JavaScript off. Same three reasons `/admin` gives.
   *
   * 🔴 NOTHING IS DECIDED HERE. Every Spanish word and every rule comes from
   * `$lib/graph.ts` — `apps/web` runs vitest in `node` with no DOM, so a rule
   * that lives in a `.svelte` file is a rule nothing checks.
   */
  import { untrack } from 'svelte';

  import { filterEcosystems } from '$lib/components/admin/summary';
  import { ecosystemInitials } from '$lib/ecosystems';
  import {
    graphEcosystemHref,
    GRAPH_SWITCHER_CLOSE,
    GRAPH_SWITCHER_LABEL,
    GRAPH_SWITCHER_MEMBER_TAG,
    GRAPH_SWITCHER_NONE,
    GRAPH_SWITCHER_NOT_FOUND,
    GRAPH_SWITCHER_OPEN,
    GRAPH_SWITCHER_PARTIAL,
    GRAPH_SWITCHER_SCOPE_NOTE,
    GRAPH_SWITCHER_SEARCH_GO,
    GRAPH_SWITCHER_SEARCH_LABEL,
    GRAPH_SWITCHER_SEARCH_PLACEHOLDER,
    switcherCountCopy,
    switcherNoMatches,
    type GraphScopePicker,
  } from '$lib/graph';

  type Props = {
    scope: GraphScopePicker;
    /** The ecosistema currently being described, or null when there is none. */
    selected: { id: string; name: string } | null;
  };
  let { scope, selected }: Props = $props();

  /** How many rows the panel draws before it stops and says how many are left. */
  const MAX_VISIBLE = 40;

  let open = $state(false);

  /**
   * The in-browser filter. SEEDED ONCE from whatever the server already
   * filtered by, then owned by the input.
   *
   * ⚠ Deliberately not reactive to `scope.search`. Every switch and every
   * server-side search is a full navigation, so the component remounts with the
   * right seed — a live binding would yank the box out from under someone
   * mid-word.
   */
  // svelte-ignore state_referenced_locally
  let term = $state(untrack(() => scope.search));

  const memberOf = $derived(new Set(scope.mine));

  /**
   * 🔴 The filter is PURE and lives in `summary.ts`, not here. Accent folding
   * and the name-or-slug rule are exactly the parts a refactor breaks silently.
   */
  const matches = $derived(filterEcosystems(scope.rows, term));
  const visible = $derived(matches.slice(0, MAX_VISIBLE));
  const filtered = $derived(term.trim() !== '');
</script>

<div class="scope">
  <div class="current">
    <span class="badge" aria-hidden="true">
      {selected ? ecosystemInitials(selected.name) : '·'}
    </span>
    <div class="who">
      <p class="label">{GRAPH_SWITCHER_LABEL}</p>
      <p class="name">{selected?.name ?? GRAPH_SWITCHER_NONE}</p>
    </div>
    <button
      class="toggle"
      type="button"
      onclick={() => (open = !open)}
      aria-expanded={open}
      data-testid="grafo-cambiar-ecosistema"
      data-interactive
    >
      {open ? GRAPH_SWITCHER_CLOSE : GRAPH_SWITCHER_OPEN}
    </button>
  </div>

  <!-- 🔴 The ADR §7.1 sentence, on the page. Scope, not permissions. -->
  <p class="note">{GRAPH_SWITCHER_SCOPE_NOTE}</p>

  {#if scope.notFound}
    <p class="note warn" role="status">{GRAPH_SWITCHER_NOT_FOUND}</p>
  {/if}

  {#if !scope.ok}
    <!-- ⚠ A failed read is not an empty installation, and must never be shown
         as one. Whatever arrived is still listed, labelled as partial. -->
    <p class="note warn" role="status">{GRAPH_SWITCHER_PARTIAL}</p>
  {/if}

  {#if open}
    <div class="panel">
      <!-- A real GET form: works without JavaScript, and is the path that
           reaches the backend when the list is bigger than one page. ⚠ It posts
           to `/grafo` with only `eco` and `q` — the entity selection is left
           behind on purpose, same reason as `graphEcosystemHref`. -->
      <form class="search" method="GET" action="/grafo">
        {#if selected}<input type="hidden" name="eco" value={selected.id} />{/if}
        <label class="sr-only" for="grafo-eco-search">{GRAPH_SWITCHER_SEARCH_LABEL}</label>
        <input
          id="grafo-eco-search"
          name="q"
          type="search"
          class="search-input"
          placeholder={GRAPH_SWITCHER_SEARCH_PLACEHOLDER}
          autocomplete="off"
          bind:value={term}
          data-interactive
        />
        {#if scope.truncated}
          <button class="search-go" type="submit" data-interactive>
            {GRAPH_SWITCHER_SEARCH_GO}
          </button>
        {/if}
      </form>

      <p class="note">
        {switcherCountCopy({
          total: scope.total,
          rows: scope.rows.length,
          matches: matches.length,
          truncated: scope.truncated,
          filtered,
        })}
      </p>

      {#if matches.length === 0}
        <p class="note">{switcherNoMatches(term)}</p>
      {:else}
        <ul class="list">
          {#each visible as eco (eco.id)}
            {@const isCurrent = eco.id === selected?.id}
            <li>
              <a
                class="row"
                class:current-row={isCurrent}
                href={graphEcosystemHref(eco.id, scope.search)}
                aria-current={isCurrent ? 'true' : undefined}
                data-interactive
              >
                <span class="tick" aria-hidden="true">{isCurrent ? '✓' : ''}</span>
                <span class="row-name">{eco.name}</span>
                {#if eco.slug}<span class="slug">{eco.slug}</span>{/if}
                {#if memberOf.has(eco.id)}
                  <!-- 🔴 Membership is a LABEL here, never a filter. You may look
                       at all of them; you belong to some of them. -->
                  <span class="member">{GRAPH_SWITCHER_MEMBER_TAG}</span>
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
  .scope {
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
  .toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
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
    outline: none;
  }
  .search-input:focus {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
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
  .row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  /* ⚠ The current row is marked by a fill AND a tick, never by colour alone:
     the same information has to survive a greyscale screen. */
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
