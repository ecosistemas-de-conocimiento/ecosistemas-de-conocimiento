<svelte:options runes={true} />

<script lang="ts">
  /**
   * Everything about the entity currently in focus: the picture, its
   * neighbours, and the documents behind whatever is selected.
   *
   * 🔴 DOCUMENT TITLES ARE RENDERED EXACTLY AS THE BACKEND SENT THEM. They are
   * already neutralised there. Nothing in this component — or anywhere else in
   * this feature — looks up a document's "real" name: for a testimonio that
   * name is free text that never passed the anonymisation gate, and putting it
   * on screen would undo the whole of `plan/anonimizacion-y-voces.md`.
   *
   * ⚠ The document list is the ONLY place the two states differ: with a
   * neighbour selected it shows the documents where BOTH appear (that is where
   * the connection comes from); with nothing selected it shows where this
   * entity appears at all. Both are captioned, because a list of titles with no
   * caption invites the reader to guess which one they are looking at.
   */
  import EgoNetwork from './EgoNetwork.svelte';
  import {
    contentKindLabel,
    entityDocsTitle,
    GRAPH_CLEAR_EDGE_LABEL,
    GRAPH_EDGE_DOCS_EMPTY,
    GRAPH_EDGE_DOCS_TITLE,
    GRAPH_EDGE_DOCS_TITLE_APPROX,
    GRAPH_EDGE_DOCS_UNAVAILABLE,
    GRAPH_ENTITY_DOCS_EMPTY,
    GRAPH_NO_NEIGHBOURS,
    GRAPH_RECENTRE_LABEL,
    relationLabel,
    supportCopy,
    entityEcosystemNames,
    supportShort,
    typeChipLabel,
    type GraphEntityDetail,
    // ⚠ IMPORTED, NOT RE-DECLARED. This file used to keep its own copy of the
    // `SelectedEdge` shape. The copy went stale the first time the real one
    // grew a field (`exact`), and svelte-check caught it only because the
    // component happened to read that field — a duplicate type that nothing
    // reads yet fails silently.
    type SelectedEdge,
  } from '$lib/graph';
  import { filterByLengua } from '$lib/lengua';

  type Props = {
    detail: GraphEntityDetail;
    edge: SelectedEdge | null;
    onSelectEdge: (id: string | null) => void;
    onRecentre: (id: string) => void;
    /** `?lengua=`; `''` ⇒ no filter. Narrows the document list only. */
    lengua?: string;
    /** Documento id → lengua, from `/api/lenguas`. A testimonio is never in it. */
    lenguaByDocument?: Record<string, string>;
    /** Combined view: ecosistema id → name, for the merged node's chips. */
    ecosystemNames?: Record<string, string>;
  };
  let {
    detail,
    edge,
    onSelectEdge,
    onRecentre,
    lengua = '',
    lenguaByDocument = {},
    ecosystemNames,
  }: Props = $props();

  const ecoNames = $derived(
    ecosystemNames ? entityEcosystemNames(detail.entity, ecosystemNames) : [],
  );

  const allDocuments = $derived(edge ? edge.documents : detail.documents);
  const documents = $derived(filterByLengua(allDocuments, lenguaByDocument, lengua));
  // 🔴 THE WORDING FOLLOWS `edge.exact`. With per-edge evidence from
  // `graph_relations` we may say these documents SUSTAIN the connection; with
  // only the intersection of two entity lists we may say the two entities
  // APPEAR in them, and no more. Showing the confident sentence over the
  // approximate list is the failure nobody could spot by looking at it.
  const docsTitle = $derived(
    edge
      ? edge.exact
        ? GRAPH_EDGE_DOCS_TITLE
        : GRAPH_EDGE_DOCS_TITLE_APPROX
      : entityDocsTitle(detail.entity.label),
  );
  // ⚠ "We found none" and "we could not read them" are different sentences.
  // Saying the first when the second is true tells someone their ecosistema has
  // less in it than it does.
  const docsEmpty = $derived(
    lengua && allDocuments.length > 0
      ? `Ninguno de estos documentos habla de personas que hablan ${lengua}.`
      : edge
      ? edge.ok
        ? GRAPH_EDGE_DOCS_EMPTY
        : GRAPH_EDGE_DOCS_UNAVAILABLE
      : GRAPH_ENTITY_DOCS_EMPTY,
  );
</script>

<div class="panel">
  <header class="head">
    <h2 class="name">{detail.entity.label}</h2>
    <p class="meta">
      <span class="chip">{typeChipLabel(detail.entity.type)}</span>
      <span>{supportCopy(detail.entity.support)}</span>
    </p>
    {#if ecoNames.length > 0}
      <ul class="ecos" data-testid="grafo-entidad-ecosistemas">
        {#each ecoNames as name (name)}<li class="chip">{name}</li>{/each}
      </ul>
    {/if}
  </header>

  {#if detail.neighbours.length === 0}
    <p class="notice">{GRAPH_NO_NEIGHBOURS}</p>
  {:else}
    <EgoNetwork
      centre={detail.entity}
      neighbours={detail.neighbours}
      selectedId={edge?.entity.id ?? null}
      onSelect={(id) => onSelectEdge(edge?.entity.id === id ? null : id)}
    />

    <section class="neighbours" aria-label="Conexiones">
      <ul class="rows">
        {#each detail.neighbours as n (n.entity.id)}
          <li class="row" class:active={edge?.entity.id === n.entity.id}>
            <button
              type="button"
              class="row-main"
              aria-pressed={edge?.entity.id === n.entity.id}
              onclick={() => onSelectEdge(edge?.entity.id === n.entity.id ? null : n.entity.id)}
              data-testid={`grafo-vecino-${n.entity.id}`}
            >
              <span class="rel">{relationLabel(n.relationType, n.direction)}</span>
              <span class="rel-label">{n.entity.label}</span>
              <span class="rel-meta">
                {typeChipLabel(n.entity.type)} · {supportShort(n.support)}
              </span>
            </button>
            <button
              type="button"
              class="recentre"
              onclick={() => onRecentre(n.entity.id)}
              title={GRAPH_RECENTRE_LABEL}
            >
              {GRAPH_RECENTRE_LABEL}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="docs" aria-label={docsTitle}>
    <div class="docs-head">
      <h3 class="docs-title">{docsTitle}</h3>
      {#if edge}
        <button type="button" class="clear" onclick={() => onSelectEdge(null)}>
          {GRAPH_CLEAR_EDGE_LABEL}
        </button>
      {/if}
    </div>
    {#if documents.length === 0}
      <p class="notice">{docsEmpty}</p>
    {:else}
      <ul class="doc-rows">
        {#each documents as doc (doc.id)}
          {@const kind = contentKindLabel(doc.contentKind)}
          <li class="doc">
            <a class="doc-link" href={`/biblioteca/${doc.id}`}>
              <span class="doc-kind" class:voice={kind.tone === 'voice'}>{kind.label}</span>
              <!-- 🔴 Verbatim. See the module header. -->
              <span class="doc-title">{doc.title}</span>
              {#if lenguaByDocument[doc.id]}
                <span class="doc-lengua">{lenguaByDocument[doc.id]}</span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .panel {
    display: grid;
    gap: var(--edc-space-4);
    align-content: start;
    padding: var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  .head {
    display: grid;
    gap: 0.2rem;
  }
  .name {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 1.25rem;
    font-weight: 800;
    letter-spacing: -0.015em;
    color: var(--edc-color-ink);
  }
  .ecos {
    margin: 0.35rem 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  .meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    color: var(--edc-color-ink-soft);
  }
  .chip {
    padding: 0.1rem 0.45rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-size: 0.68rem;
    font-weight: 700;
  }

  .notice {
    margin: 0;
    padding: 0.65rem 0.8rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }

  .rows,
  .doc-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid transparent;
  }
  .row:hover {
    background: var(--edc-color-surface-soft);
    border-color: var(--edc-color-elevated-border);
  }
  .row.active {
    background: var(--edc-color-brand-soft);
    border-color: var(--edc-color-brand-outline);
  }
  .row-main {
    flex: 1 1 auto;
    display: grid;
    gap: 0.05rem;
    text-align: left;
    padding: 0.4rem 0.55rem;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    border-radius: var(--edc-radius-2);
  }
  .row-main:focus-visible,
  .recentre:focus-visible,
  .clear:focus-visible,
  .doc-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
    border-radius: var(--edc-radius-2);
  }
  .rel {
    font-size: 0.68rem;
    font-family: var(--edc-font-mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  .rel-label {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--edc-color-ink);
    line-height: 1.3;
  }
  .rel-meta {
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  .recentre {
    flex: none;
    margin-right: 0.35rem;
    padding: 0.2rem 0.5rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .recentre:hover {
    color: var(--edc-color-ink);
  }

  .docs {
    display: grid;
    gap: 0.3rem;
    padding-top: var(--edc-space-3);
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .docs-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .docs-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 800;
    color: var(--edc-color-ink);
  }
  .clear {
    padding: 0.2rem 0.5rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
  }
  .doc {
    display: grid;
    gap: 0.1rem;
  }
  .doc-link {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.35rem 0.55rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface);
    text-decoration: none;
    color: inherit;
  }
  .doc-link:hover {
    border-color: var(--edc-color-line-strong);
  }
  .doc-lengua {
    flex: none;
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--edc-color-ink-soft);
  }
  .doc-kind {
    flex: none;
    padding: 0.05rem 0.4rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-soft);
    font-size: 0.66rem;
    font-weight: 700;
  }
  /* A voz and a documento must not look the same — the same rule the
     biblioteca states. A reader weighing a connection needs to know whether
     its evidence is a file somebody wrote or a person's words. */
  .doc-kind.voice {
    border-color: var(--edc-color-accent-outline);
    background: var(--edc-color-accent-soft);
    color: var(--edc-color-accent-strong);
  }
  .doc-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--edc-color-ink);
    line-height: 1.35;
  }
</style>
