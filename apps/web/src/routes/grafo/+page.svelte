<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/grafo` — la vista del grafo del corpus.
   *
   * 🔴 EVERY DECISION THAT MATTERS IS SERVER-SIDE. The tenant scope, the
   * published-only rule, the minimum-support threshold and the rule that a
   * person node can only come from a `documento` are all settled before a row
   * is serialised (`+page.server.ts`, `$lib/server/graph.ts`, and the backend).
   * This file renders what it is given and names nothing: no user, no
   * organization, no corpus.
   *
   * 🔴 THE EMPTY GRAPH SAYS SO (ADR §7.3.3). In a young ecosistema the graph is
   * genuinely empty, because a connection needs several published documents
   * behind it before it may be shown. A blank canvas would read as broken and
   * send someone to report a bug, so the screen says what happened — and says
   * how many entities the threshold is holding back, rather than quietly
   * dropping the number.
   *
   * ⚠ ALL COPY AND ALL RULES LIVE IN `$lib/graph.ts`. `apps/web` runs vitest in
   * a node environment with no DOM, so anything asserted has to be outside a
   * `.svelte` file.
   */
  import { goto } from '$app/navigation';
  import { navigating, page } from '$app/stores';
  import EcosystemScope from '$lib/components/graph/EcosystemScope.svelte';
  import EntityLists from '$lib/components/graph/EntityLists.svelte';
  import EntityPanel from '$lib/components/graph/EntityPanel.svelte';
  import {
    emptyGraphCopy,
    filterEntities,
    graphEntityHref,
    GRAPH_SUBTITLE_LEAD,
    GRAPH_ENTITY_NOT_FOUND,
    GRAPH_ENTITY_UNAVAILABLE,
    GRAPH_KICKER,
    GRAPH_PICK_ENTITY,
    GRAPH_SCOPE_NOTE,
    GRAPH_SEARCH_HINT,
    GRAPH_TITLE,
    GRAPH_UNAVAILABLE,
    hiddenCopy,
    noEcosystemCopy,
    resultsSummary,
    type GrafoPageData,
  } from '$lib/graph';

  type Props = { data: GrafoPageData };
  let { data }: Props = $props();

  /** Same cap the backend search takes; keeps a pasted essay out of the filter. */
  const MAX_SEARCH_LENGTH = 120;

  let search = $state('');

  const visible = $derived(filterEntities(data.view.entities, search));
  const filtered = $derived(search.trim() !== '');
  const hidden = $derived(hiddenCopy(data.view.hidden, data.view.minSupport));
  const busy = $derived(Boolean($navigating));

  /**
   * ⚠ The selection lives in the URL, not in a variable. A graph view is
   * something people send each other ("mira con qué se conecta este tema"), and
   * the back button should undo a selection rather than leave the page. Same
   * reasoning as `/biblioteca`'s filters and `/admin`'s `?eco=`.
   */
  function navigate(entidad: string | null, conexion: string | null) {
    // 🔴 The scope params ride along. Rebuilding the URL without them drops a
    // platform admin's `?eco=` on their first click and quietly re-scopes the
    // page to a different ecosistema. See `graphEntityHref`.
    void goto(graphEntityHref(entidad, conexion, scopeParams), {
      keepFocus: true,
      noScroll: true,
    });
  }

  const selectedId = $derived(data.entity?.entity.id ?? null);

  /**
   * ⚠ `data.scope` is `null` for everybody who is not a platform admin — "no
   * picker", not "an empty picker". It also decides WHICH "no ecosistema"
   * sentence is shown: an admin must not be told to go ask for access.
   */
  const scope = $derived(data.scope);

  /**
   * The scope half of the URL, echoed back on every in-page navigation.
   *
   * ⚠ Read off `$page.url`, not off `data.scope`: `?eco=` may name an ecosistema
   * and `?q=` a search the server did not have to change, and what has to
   * survive a click is what the ADDRESS BAR says, not what we resolved it to.
   */
  const scopeParams = $derived(
    scope
      ? { eco: $page.url.searchParams.get('eco'), q: $page.url.searchParams.get('q') }
      : {},
  );
</script>

<svelte:head><title>{GRAPH_KICKER} · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <div>
      <p class="kicker">{GRAPH_KICKER}</p>
      <h1>{GRAPH_TITLE}</h1>
      {#if data.ecosystem}
        <!-- ⚠ The enumeration comes from `$lib/graph.ts`, not from this
             template: it lists the entity types, and a list that drifts out of
             step with `GRAPH_VIEW_TYPES` is the silent kind of wrong. Only the
             ecosistema's name is composed here, so it can be bolded — it is
             the one word on this line a reader scans for. -->
        <p class="sub">{GRAPH_SUBTITLE_LEAD} <strong>{data.ecosystem.name}</strong>.</p>
      {/if}
    </div>
  </header>

  <!-- 🔴 SCOPE, NEVER CONTENT (ADR §7.1). Platform admins only, and all it does
       is choose which ecosistema the page is describing. Rendered ABOVE the
       state branches on purpose: an admin who is looking at an empty or
       unreadable ecosistema still needs the control to switch away from it. -->
  {#if scope}
    <EcosystemScope {scope} selected={data.ecosystem} />
  {/if}

  <!-- 🔴 Said on the page, not in a tooltip. Two misreadings are common: that
       the graph covers everything, and that a missing connection means it does
       not exist. -->
  <p class="notice">{GRAPH_SCOPE_NOTE}</p>

  {#if data.state === 'no-ecosystem'}
    <!-- ⚠ Two different sentences. A member is told to ask for access; an admin
         is told the installation has no ecosistema — telling THEM to ask for
         access sends them to themselves. See `noEcosystemCopy`. -->
    <p class="notice">{noEcosystemCopy(scope !== null)}</p>
  {:else if data.state === 'unavailable' || !data.viewOk}
    <!-- ⚠ An outage is not an empty ecosistema, and must not read like one. -->
    <p class="notice">{GRAPH_UNAVAILABLE}</p>
  {:else if data.view.entities.length === 0}
    <!-- 🔴 An empty graph is the design working, not a blank canvas. And WHICH
         empty it is decides the sentence: "nobody has published anything yet"
         is fixed by publishing, "everything is below the threshold" by
         publishing more. See `emptyGraphCopy`. -->
    {@const empty = emptyGraphCopy(data.view)}
    <div class="empty" data-testid="grafo-vacio">
      <p class="empty-title">{empty.title}</p>
      <p class="notice">{empty.hint}</p>
      {#if hidden}<p class="notice">{hidden}</p>{/if}
    </div>
  {:else}
    {#if hidden}
      <!-- 🔴 The withheld count, said out loud. A number we hold and do not show
           is a number that makes a short list look like a bug. -->
      <p class="notice" data-testid="grafo-ocultas">{hidden}</p>
    {/if}

    <div class="board">
      <section class="col-lists" aria-label="Entidades del grafo">
        <label class="search">
          <span class="sr-only">Buscar por nombre</span>
          <input
            type="search"
            class="search-input"
            placeholder="Buscar por nombre…"
            maxlength={MAX_SEARCH_LENGTH}
            bind:value={search}
            data-testid="grafo-busqueda"
          />
        </label>
        <p class="hint">{GRAPH_SEARCH_HINT}</p>
        <p class="count" data-testid="grafo-conteo">
          {resultsSummary({
            total: data.view.entities.length,
            shown: visible.length,
            filtered,
          })}
        </p>

        <EntityLists
          entities={visible}
          {selectedId}
          onSelect={(id) => navigate(id, null)}
        />
      </section>

      <section class="col-panel" aria-label="Conexiones" aria-busy={busy}>
        {#if data.entityState === 'unavailable'}
          <p class="notice">{GRAPH_ENTITY_UNAVAILABLE}</p>
        {:else if data.entityState === 'not-found'}
          <p class="notice">{GRAPH_ENTITY_NOT_FOUND}</p>
        {:else if data.entity}
          <EntityPanel
            detail={data.entity}
            edge={data.edge}
            onSelectEdge={(id) => navigate(data.entity!.entity.id, id)}
            onRecentre={(id) => navigate(id, null)}
          />
        {:else}
          <p class="placeholder">{GRAPH_PICK_ENTITY}</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .page {
    min-height: 100vh;
    max-width: 76rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    display: grid;
    gap: var(--edc-space-4);
    align-content: start;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .kicker {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.15rem 0 0.2rem;
    font-family: var(--edc-font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
  }
  .sub {
    margin: 0;
    font-size: 0.86rem;
    color: var(--edc-color-ink-soft);
  }
  .sub strong {
    color: var(--edc-color-ink);
  }
  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }

  .board {
    display: grid;
    gap: var(--edc-space-5);
    align-items: start;
  }
  @media (min-width: 60rem) {
    .board {
      grid-template-columns: minmax(0, 21rem) minmax(0, 1fr);
    }
  }
  .col-lists {
    display: grid;
    gap: 0.4rem;
    align-content: start;
  }
  .col-panel {
    min-width: 0;
  }
  .col-panel[aria-busy='true'] {
    opacity: 0.6;
  }

  .search {
    display: block;
  }
  .search-input {
    width: 100%;
    padding: 0.55rem 0.75rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font-size: 0.9rem;
    outline: none;
  }
  .search-input:focus {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .hint {
    margin: 0;
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  .count {
    margin: 0 0 0.2rem;
    font-size: 0.78rem;
    color: var(--edc-color-ink-soft);
  }

  .placeholder {
    margin: 0;
    padding: 2.5rem 1rem;
    text-align: center;
    border: 1px dashed var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-soft);
    font-size: 0.88rem;
    color: var(--edc-color-ink-soft);
  }

  .empty {
    display: grid;
    gap: 0.5rem;
    padding: 1.5rem 0;
    text-align: center;
    justify-items: center;
  }
  .empty-title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 800;
    color: var(--edc-color-ink);
  }
  .empty .notice {
    max-width: 40rem;
    text-align: left;
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
