<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/biblioteca` — everything this ecosistema has PUBLISHED, browsable by any
   * of its members.
   *
   * 🔴 THE GAP THIS FILLS. Until now there were two surfaces and neither was
   * this one: the documents panel shows ONE CONVERSATION'S files (yours, drafts
   * included), and `/admin` shows every tenant's METADATA to platform admins.
   * An ordinary member had nowhere to see what their ecosistema had actually
   * accumulated — which is the entire point of building a shared corpus
   * together. Publishing existed; the place the published thing lands did not.
   *
   * 🔴 EVERY DECISION THAT MATTERS IS SERVER-SIDE. The tenant scope, the
   * published-only filter and the anonymity of a testimonio are all enforced in
   * `$lib/server/biblioteca.ts` before a row is serialised. This file renders
   * what it is given and names nothing: no user, no organization, no corpus.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    formatLibraryDate,
    isTestimony,
    kindFilterLabel,
    kindLabel,
    KIND_FILTERS,
    LIBRARY_EMPTY,
    LIBRARY_EMPTY_HINT,
    LIBRARY_NO_RESULTS,
    LIBRARY_SCOPE_NOTE,
    LIBRARY_UNAVAILABLE,
    MAX_SEARCH_LENGTH,
    parseKindFilter,
    resultsSummary,
    TESTIMONY_ANONYMITY_NOTE,
    type KindFilter,
    type LibraryItem,
  } from '$lib/biblioteca';
  import { audioMetaChips } from '$lib/ingest';
  import type { AudioMeta } from '$lib/types';

  interface LibraryResponse {
    state: 'ready' | 'no-ecosystem' | 'unavailable';
    ecosystem: { id: string; name: string } | null;
    items: LibraryItem[];
    total: number;
    page: number;
    hasNextPage: boolean;
  }

  /**
   * The filter state lives IN THE URL, not in a component variable.
   *
   * ⚠ Deliberate: a library view is something people send each other ("mira las
   * voces de este mes"), and the back button should undo a filter rather than
   * leave the page. Same reasoning as `/admin`'s `?eco=` — a scope you can see
   * in the address bar is a scope you cannot misread.
   */
  const query = $derived({
    q: ($page.url.searchParams.get('q') ?? '').slice(0, MAX_SEARCH_LENGTH),
    kind: parseKindFilter($page.url.searchParams.get('kind')),
    page: Math.max(1, Math.floor(Number($page.url.searchParams.get('page')) || 1)),
  });

  let searchInput = $state('');
  let data = $state<LibraryResponse | null>(null);
  let loading = $state(true);
  /** ⚠ A failed FETCH is not an empty library. Tracked separately, said differently. */
  let failed = $state(false);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function pushQuery(next: { q?: string; kind?: KindFilter; page?: number }) {
    const params = new URLSearchParams();
    const q = next.q ?? query.q;
    const kind = next.kind ?? query.kind;
    // ⚠ Changing the term or the kind resets to page 1. Staying on page 4 of a
    // result set that now has one page shows an empty screen that looks like
    // "nothing matched" and is not.
    const pageNo = next.page ?? (next.q !== undefined || next.kind !== undefined ? 1 : query.page);
    if (q) params.set('q', q);
    if (kind !== 'todos') params.set('kind', kind);
    if (pageNo > 1) params.set('page', String(pageNo));
    const qs = params.toString();
    void goto(qs ? `/biblioteca?${qs}` : '/biblioteca', {
      keepFocus: true,
      noScroll: true,
      replaceState: true,
    });
  }

  function onSearchInput(value: string) {
    searchInput = value;
    if (searchTimer) clearTimeout(searchTimer);
    // 350ms: comfortable for human typing, and it keeps a five-word search from
    // being five backend queries.
    searchTimer = setTimeout(() => pushQuery({ q: value.trim() }), 350);
  }

  /**
   * Re-read whenever the URL changes. `key` is the only dependency that matters,
   * so a re-render for any other reason does not re-fetch.
   */
  $effect(() => {
    const key = `${query.q}|${query.kind}|${query.page}`;
    void key;
    let cancelled = false;
    loading = true;
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.kind !== 'todos') params.set('kind', query.kind);
    params.set('page', String(query.page));
    fetch(`/api/biblioteca?${params.toString()}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          failed = true;
          return;
        }
        data = (await res.json()) as LibraryResponse;
        failed = data.state === 'unavailable';
      })
      .catch(() => {
        if (!cancelled) failed = true;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Keep the box in step when the URL changes from somewhere else (back button,
  // a shared link). Guarded so it does not fight the user's own typing.
  $effect(() => {
    const fromUrl = query.q;
    if (fromUrl !== searchInput.trim()) searchInput = fromUrl;
  });

  const items = $derived(data?.items ?? []);
  const filtered = $derived(query.q !== '' || query.kind !== 'todos');
</script>

<svelte:head><title>Biblioteca · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <div>
      <p class="kicker">Biblioteca</p>
      <h1>Lo que ha publicado tu ecosistema</h1>
      {#if data?.ecosystem}
        <p class="sub">
          Documentos y voces compartidas en <strong>{data.ecosystem.name}</strong>.
        </p>
      {/if}
    </div>
    <a class="back" href="/" data-interactive>Volver al chat</a>
  </header>

  <!-- 🔴 SAID ON THE PAGE, NOT IN A TOOLTIP. The commonest misreading of a
       shared library is "this is everything there is". It is everything that
       has been PUBLISHED — and someone who found their own draft here would
       reasonably conclude everyone else can see it too. -->
  <p class="notice">{LIBRARY_SCOPE_NOTE}</p>

  {#if data?.state === 'no-ecosystem'}
    <p class="notice">
      Todavía no perteneces a ningún ecosistema, así que no hay una biblioteca que mostrar.
      Pídele acceso a quien administra tu ecosistema.
    </p>
  {:else if failed}
    <p class="notice">{LIBRARY_UNAVAILABLE}</p>
  {:else}
    <section class="controls" aria-label="Buscar y filtrar">
      <label class="search">
        <span class="sr-only">Buscar por título</span>
        <input
          type="search"
          class="search-input"
          placeholder="Buscar por título…"
          maxlength={MAX_SEARCH_LENGTH}
          value={searchInput}
          oninput={(e) => onSearchInput(e.currentTarget.value)}
          data-testid="library-search"
        />
      </label>
      <!-- ⚠ Says WHAT is searched. A box that silently searches titles only,
           while the reader assumes it searches the text, produces "no está" for
           a document that is right there. -->
      <p class="hint">La búsqueda es por título.</p>
      <div class="filters" role="group" aria-label="Filtrar por tipo">
        {#each KIND_FILTERS as f (f)}
          <button
            class="filter"
            class:active={query.kind === f}
            aria-pressed={query.kind === f}
            onclick={() => pushQuery({ kind: f })}
            data-testid={`library-filter-${f}`}
          >
            {kindFilterLabel(f)}
          </button>
        {/each}
      </div>
    </section>

    <p class="count" data-testid="library-count">
      {#if loading && !data}
        Cargando…
      {:else}
        {resultsSummary({ total: data?.total ?? 0, shown: items.length, filtered })}
      {/if}
    </p>

    {#if items.length > 0}
      <ul class="list">
        {#each items as item (item.id)}
          {@const label = kindLabel(item.kind)}
          {@const voice = isTestimony(item.kind)}
          <li class="card" class:voice>
            <a class="card-link" href={`/biblioteca/${item.id}`} data-testid={`library-item-${item.id}`}>
              <div class="card-top">
                <!-- 🔴 A VOZ AND A DOCUMENTO MUST NOT LOOK THE SAME. They are
                     different kinds of source, and a reader weighing a passage
                     should not have to work out which one they are holding. -->
                <span class="kind kind-{label.tone}" title={label.description}>{label.label}</span>
                <span class="date">{formatLibraryDate(item.createdAt)}</span>
              </div>
              <h2 class="title">{item.title}</h2>
              {#if voice}
                <!-- 🔴 NO AUTHOR SLOT EXISTS HERE, and this line is why the
                     absence does not read as missing data. The server never
                     sends a name for a testimonio — see `mayShowContributor`. -->
                <p class="meta anon">{TESTIMONY_ANONYMITY_NOTE}</p>
              {:else if item.contributor}
                <p class="meta">Compartido por {item.contributor}</p>
              {/if}
              {#if item.kind === 'audio'}
                <p class="meta">
                  {#each audioMetaChips(item.audioMeta as AudioMeta | null) as chip (chip.label)}
                    <span class="chip" title={chip.title}>{chip.label}</span>
                  {/each}
                </p>
              {/if}
            </a>
          </li>
        {/each}
      </ul>

      {#if query.page > 1 || data?.hasNextPage}
        <nav class="pager" aria-label="Páginas">
          <button
            class="page-btn"
            disabled={query.page <= 1}
            onclick={() => pushQuery({ page: query.page - 1 })}
          >
            ← Anterior
          </button>
          <span class="page-no">Página {query.page}</span>
          <button
            class="page-btn"
            disabled={!data?.hasNextPage}
            onclick={() => pushQuery({ page: query.page + 1 })}
          >
            Siguiente →
          </button>
        </nav>
      {/if}
    {:else if !loading}
      <div class="empty">
        <p class="empty-title">{filtered ? LIBRARY_NO_RESULTS : LIBRARY_EMPTY}</p>
        {#if !filtered}<p class="notice">{LIBRARY_EMPTY_HINT}</p>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    min-height: 100vh;
    max-width: 60rem;
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
  .back {
    flex: none;
    padding: 0.4rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    font-size: 0.78rem;
    font-weight: 700;
    text-decoration: none;
    color: var(--edc-color-ink-soft);
  }
  .back:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
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

  .controls {
    display: grid;
    gap: 0.5rem;
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
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .filter {
    padding: 0.3rem 0.7rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.76rem;
    font-weight: 600;
  }
  .filter:hover {
    color: var(--edc-color-ink);
  }
  .filter.active {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }

  .count {
    margin: 0;
    font-size: 0.78rem;
    color: var(--edc-color-ink-soft);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }
  .card {
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  /* The visible difference between a voice and a document, carried by the card
     itself and not only by its chip: a reader scanning a long list sees the
     shape before they read the label. */
  .card.voice {
    border-left: 3px solid var(--edc-color-accent);
  }
  .card:hover {
    border-color: var(--edc-color-line-strong);
  }
  .card-link {
    display: block;
    padding: 0.75rem 0.9rem;
    text-decoration: none;
    color: inherit;
  }
  .card-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
    border-radius: var(--edc-radius-2);
  }
  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .title {
    margin: 0.3rem 0 0;
    font-size: 1rem;
    font-weight: 700;
    color: var(--edc-color-ink);
  }
  .date {
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  .meta {
    margin: 0.3rem 0 0;
    font-size: 0.75rem;
    color: var(--edc-color-ink-soft);
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .meta.anon {
    font-style: italic;
  }
  .kind {
    padding: 0.1rem 0.45rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-elevated-border);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .kind-voice {
    border-color: var(--edc-color-accent-outline);
    background: var(--edc-color-accent-soft);
    color: var(--edc-color-accent-strong);
  }
  .kind-document {
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-soft);
  }
  .chip {
    padding: 0.05rem 0.35rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
  }

  .pager {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    justify-content: center;
  }
  .page-btn {
    padding: 0.35rem 0.8rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.78rem;
    font-weight: 600;
  }
  .page-btn:disabled {
    opacity: 0.4;
  }
  .page-no {
    font-size: 0.76rem;
    color: var(--edc-color-ink-soft);
  }

  .empty {
    display: grid;
    gap: 0.5rem;
    padding: 1.5rem 0;
    text-align: center;
  }
  .empty-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
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
