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
  import OverviewGraph from '$lib/components/graph/OverviewGraph.svelte';
  import { isMapEscape, nextSelection, type SelectionEvent } from '$lib/components/graph/selection';
  import LenguaPanel from '$lib/components/graph/LenguaPanel.svelte';
  import { withLengua, type GrafoLenguaData } from '$lib/lengua';
  import {
    emptyGraphCopy,
    graphEntityHref,
    GRAPH_SEARCH_DEBOUNCE_MS,
    GRAPH_SEARCH_MAX_LENGTH,
    GRAPH_SEARCH_PLACEHOLDER,
    GRAPH_ENTITY_NOT_FOUND,
    GRAPH_ENTITY_UNAVAILABLE,
    GRAPH_KICKER,
    GRAPH_OFF,
    GRAPH_UNAVAILABLE,
    noEcosystemCopy,
    parseSearchIds,
    resultsSummary,
    searchHighlight,
    type GrafoPageData,
  } from '$lib/graph';

  type Props = { data: GrafoPageData & GrafoLenguaData };
  let { data }: Props = $props();

  let search = $state('');
  /** The last answer from `/grafo/buscar`; `null` = none yet, or it failed. */
  let resultIds = $state<string[] | null>(null);
  /** Only the newest request may write `resultIds`. */
  let searchSeq = 0;

  /**
   * Full-text search (backlog #31): a typing pause, then one request. The
   * previous highlight stays until the new answer lands, so the map does not
   * flash undimmed between keystrokes. An empty box clears it at once.
   */
  $effect(() => {
    const q = search.trim();
    const eco = data.ecosystem?.id ?? null;
    const seq = ++searchSeq;
    if (q === '' || !data.searchEnabled) {
      resultIds = null;
      return;
    }
    const timer = setTimeout(async () => {
      let ids: string[] | null = null;
      try {
        const res = await fetch('/grafo/buscar', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q, eco }),
        });
        ids = res.ok ? parseSearchIds(await res.json()) : null;
      } catch {
        ids = null;
      }
      if (seq === searchSeq) resultIds = ids;
    }, GRAPH_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  /** What the search matches, for dimming the rest of the map. */
  const matches = $derived(searchHighlight(data.view.entities, search, resultIds));
  const filtered = $derived(matches !== null);
  const visible = $derived(
    matches ? data.view.entities.filter((e) => matches.has(e.id)) : data.view.entities,
  );
  const busy = $derived(Boolean($navigating));

  /**
   * ⚠ The selection lives in the URL, not in a variable. A graph view is
   * something people send each other ("mira con qué se conecta este tema"), and
   * the back button should undo a selection rather than leave the page. Same
   * reasoning as `/biblioteca`'s filters and `/admin`'s `?eco=`.
   */
  function navigate(entidad: string | null, conexion: string | null): Promise<void> {
    // 🔴 The scope params ride along. Rebuilding the URL without them drops a
    // platform admin's `?eco=` on their first click and quietly re-scopes the
    // page to a different ecosistema. See `graphEntityHref`.
    // `?lengua=` rides along too, so picking an entity keeps the filter.
    return goto(withLengua(graphEntityHref(entidad, conexion, scopeParams), data.lengua), {
      keepFocus: true,
      noScroll: true,
    });
  }

  const selectedId = $derived(data.entity?.entity.id ?? null);

  /** The map's selection rules (`selection.ts`): click, click again, Esc, empty space. */
  function onMapSelection(event: SelectionEvent) {
    const next = nextSelection(selectedId, event);
    if (next === selectedId) return;
    void navigate(next, null);
  }

  function onKeydown(event: KeyboardEvent) {
    if (selectedId === null || !isMapEscape(event)) return;
    onMapSelection({ kind: 'escape' });
  }

  /**
   * Phone (UX backlog #24): the lists sit BELOW the map and the panel, so a
   * tap on a topic changed a panel the reader could not see. Below the
   * two-column breakpoint, bring the panel into view once it has loaded.
   */
  let panelEl = $state<HTMLElement | null>(null);
  async function selectFromList(id: string) {
    await navigate(id, null);
    // Desktop too: the lists sit below the fold, so the panel beside the map is out of sight.
    panelEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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

<svelte:window onkeydown={onKeydown} />

<svelte:head><title>{GRAPH_KICKER} · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <!-- ⚠ No title and no subtitle (backlog #27): the nav tab already says
       "Conexiones" and the page opens on the map. The heading stays, small,
       so the page still has one for a screen reader. -->
  <h1 class="kicker">{GRAPH_KICKER}</h1>

  <!-- 🔴 SCOPE, NEVER CONTENT (ADR §7.1). Platform admins only, and all it does
       is choose which ecosistema the page is describing. Rendered ABOVE the
       state branches on purpose: an admin who is looking at an empty or
       unreadable ecosistema still needs the control to switch away from it. -->
  {#if scope}
    <EcosystemScope {scope} selected={data.ecosystem} />
  {/if}

  {#if data.state === 'no-ecosystem'}
    <!-- ⚠ Two different sentences. A member is told to ask for access; an admin
         is told the installation has no ecosistema — telling THEM to ask for
         access sends them to themselves. See `noEcosystemCopy`. -->
    <p class="notice">{noEcosystemCopy(scope?.admin === true)}</p>
  {:else if data.graphOff}
    <p class="notice" data-testid="grafo-desactivado">{GRAPH_OFF}</p>
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
    </div>
  {:else}
    <!-- The whole graph first (backlog #3), the selected entity's panel
         beside it. Clicking a point selects exactly as the lists do: through
         the URL, so the back button undoes it. -->
    <div class="stage" class:with-panel={data.entity || data.entityState === 'unavailable' || data.entityState === 'not-found'}>
      <OverviewGraph
        combined={data.combined}
        allow3d={data.allow3d !== false}
        entities={data.view.entities}
        edges={data.view.edges ?? []}
        {selectedId}
        {matches}
        panelNeighbourIds={data.entity?.neighbours.map((n) => n.entity.id) ?? []}
        onSelect={(id) => onMapSelection({ kind: 'node', id })}
        onDeselect={() => onMapSelection({ kind: 'background' })}      />

      <section class="col-panel" aria-label="Conexiones" aria-busy={busy} bind:this={panelEl}>
        {#if data.entityState === 'unavailable'}
          <p class="notice">{GRAPH_ENTITY_UNAVAILABLE}</p>
        {:else if data.entityState === 'not-found'}
          <p class="notice">{GRAPH_ENTITY_NOT_FOUND}</p>
        {:else if data.entity}
          <EntityPanel
            detail={data.entity}
            edge={data.edge}
            lengua={data.lengua}
            lenguaByDocument={data.lenguaByDocument}
            onSelectEdge={(id) => navigate(data.entity!.entity.id, id)}
            onRecentre={(id) => navigate(id, null)}
            ecosystemNames={data.combined ? data.ecosystemNames : undefined}
          />
        {/if}
        <!-- No "pick an entity" hint when nothing is selected (owner, 2026-10-21). -->
      </section>
    </div>

    <!-- No scope note and no withheld-count line (backlog #28, #29). The
         threshold itself is unchanged; it is applied in the backend's SQL. -->

    <div class="board">
      <section class="col-lists" aria-label="Entidades del grafo">
        <!-- Full-text search (backlog #31); env switch `GRAPH_SEARCH_ENABLED`. -->
        {#if data.searchEnabled}
          <label class="search">
            <span class="sr-only">{GRAPH_SEARCH_PLACEHOLDER}</span>
            <input
              type="search"
              class="search-input"
              placeholder={GRAPH_SEARCH_PLACEHOLDER}
              maxlength={GRAPH_SEARCH_MAX_LENGTH}
              bind:value={search}
              data-testid="grafo-busqueda"
            />
          </label>
        {/if}
        <p class="count" data-testid="grafo-conteo">
          {resultsSummary({
            total: data.view.entities.length,
            shown: visible.length,
            filtered,
            available: data.view.total,
          })}
        </p>

        <EntityLists
          entities={visible}
          {selectedId}
          onSelect={(id) => void selectFromList(id)}
        />

      </section>

      <LenguaPanel
        lenguas={data.lenguas}
        selected={data.lengua}
        hrefFor={(l) => withLengua($page.url.pathname + $page.url.search, l)}
      />
    </div>
  {/if}
</div>

<style>
  .page {
    min-height: 100vh;
    /* ⚠ The page sits in a flex row: without `width` it shrinks to its
       content, and the map (which is 100% wide) shrinks with it. */
    width: 100%;
    box-sizing: border-box;
    max-width: 90rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    display: grid;
    /* One column that may shrink below its content's width: an implicit
       `auto` column grows to a long ecosistema name, and `main` then
       scrolls sideways on a phone. Same for `.stage` and `.board`. */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--edc-space-4);
    align-content: start;
  }
  .kicker {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
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

  .stage,
  .board {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--edc-space-5);
    align-items: start;
  }
  @media (min-width: 60rem) {
    /* The panel column exists only with something in it: no empty third of the screen. */
    .stage.with-panel {
      grid-template-columns: minmax(0, 1fr) minmax(0, 26rem);
    }
    /* The panel scrolls beside the map instead of pushing the page down. */
    .stage .col-panel {
      max-height: clamp(24rem, 70vh, 46rem);
      overflow-y: auto;
    }
    .board {
      grid-template-columns: minmax(0, 1fr) minmax(0, 21rem);
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
  .count {
    margin: 0 0 0.2rem;
    font-size: 0.78rem;
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
