<svelte:options runes={true} />

<script lang="ts">
  /**
   * Every document in the ecosistema, with who put it there and what state it
   * is in.
   *
   * ⚠ The status copy is NOT written here. `publicationBadge` and `ingestBadge`
   * are the app's own words, already tested in `$lib/publication` and
   * `$lib/ingest`, and already what the uploader sees in `DocsPanel`. An admin
   * reading "transcribiendo…" here and the uploader reading something else for
   * the same row is a support call, not a wording difference.
   */
  import { Badge } from '$lib/primitives';
  import type { Tone } from '$lib/primitives/types';
  import { audioDurationChip, ingestBadge } from '$lib/ingest';
  import { publicationBadge, type BadgeTone } from '$lib/publication';
  import {
    EMPTY_DOC_FILTER,
    filterDocs,
    formatDay,
    kindLabel,
    type AdminDocRow,
    type DocFilter,
  } from './summary';
  import type { DocKind } from '$lib/types';

  type Props = {
    docs: AdminDocRow[];
    /** uploader id → display name, from the contributors aggregate. */
    nameById: Record<string, string>;
  };
  let { docs, nameById }: Props = $props();

  let filter = $state<DocFilter>({ ...EMPTY_DOC_FILTER });
  const visible = $derived(filterDocs(docs, filter));

  const KINDS: { value: DocKind | null; label: string }[] = [
    { value: null, label: 'Todo' },
    { value: 'pdf', label: 'PDF' },
    { value: 'docx', label: 'Word' },
    { value: 'audio', label: 'Audio' },
    { value: 'markdown', label: 'Notas' },
  ];

  const STATES: { value: boolean | null; label: string }[] = [
    { value: null, label: 'Todo' },
    { value: true, label: 'Publicados' },
    { value: false, label: 'Borradores' },
  ];

  /** Publication tone → the primitive's tone vocabulary. */
  function pubTone(tone: BadgeTone): Tone {
    switch (tone) {
      case 'shared':
        return 'success';
      case 'progress':
        return 'warning';
      case 'error':
        return 'danger';
      case 'private':
        return 'neutral';
    }
  }

  function ingestTone(tone: 'pending' | 'ready' | 'failed'): Tone {
    return tone === 'ready' ? 'success' : tone === 'failed' ? 'danger' : 'warning';
  }

  function uploader(id: string): string {
    return nameById[id] ?? (id ? `Persona ${id}` : 'Sin identificar');
  }
</script>

<div class="controls">
  <label class="search">
    <span class="sr-only">Buscar por título</span>
    <input
      type="search"
      placeholder="Buscar por título…"
      bind:value={filter.query}
      data-interactive
    />
  </label>

  <div class="chips" role="group" aria-label="Filtrar por tipo">
    {#each KINDS as k (k.label)}
      <button
        type="button"
        class="chip"
        class:on={filter.kind === k.value}
        aria-pressed={filter.kind === k.value}
        onclick={() => (filter.kind = k.value)}
      >
        {k.label}
      </button>
    {/each}
  </div>

  <div class="chips" role="group" aria-label="Filtrar por publicación">
    {#each STATES as s (s.label)}
      <button
        type="button"
        class="chip"
        class:on={filter.published === s.value}
        aria-pressed={filter.published === s.value}
        onclick={() => (filter.published = s.value)}
      >
        {s.label}
      </button>
    {/each}
  </div>
</div>

<p class="count">
  {visible.length}
  {visible.length === 1 ? 'documento' : 'documentos'}
  {#if visible.length !== docs.length}<span class="of"> de {docs.length}</span>{/if}
</p>

{#if visible.length === 0}
  <p class="empty">Ningún documento coincide con estos filtros.</p>
{:else}
  <div class="scroller">
    <table>
      <thead>
        <tr>
          <th scope="col">Documento</th>
          <th scope="col">Tipo</th>
          <th scope="col">Quién lo subió</th>
          <th scope="col">Cuándo</th>
          <th scope="col">Quién lo ve</th>
          <th scope="col">Procesamiento</th>
        </tr>
      </thead>
      <tbody>
        {#each visible as d (d.id)}
          {@const pub = publicationBadge(d.publicationStatus)}
          {@const ing = ingestBadge(d.ingestStatus, d.kind, d.audioMeta)}
          {@const audio = audioDurationChip(d.audioMeta)}
          <tr>
            <th scope="row">
              <span class="title">{d.title}</span>
              {#if audio}<span class="sub">{audio}</span>{/if}
            </th>
            <td><Badge label={kindLabel(d.kind)} tone="neutral" emphasis="outline" size="sm" /></td>
            <td>{uploader(d.uploaderId)}</td>
            <td class="nowrap">{formatDay(d.createdAt)}</td>
            <td>
              <span title={pub.description}>
                <Badge label={pub.label} tone={pubTone(pub.tone)} size="sm" />
              </span>
            </td>
            <td>
              {#if ing}
                <span title={ing.title}>
                  <Badge label={ing.label} tone={ingestTone(ing.tone)} size="sm" />
                </span>
              {:else}
                <span class="sub">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }
  .search input {
    min-width: 14rem;
    padding: 0.35rem 0.6rem;
    font-size: 0.8rem;
    color: var(--edc-color-ink);
    background: var(--edc-color-surface-soft);
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
  }
  /* ⚠ `--edc-focus-ring` is a COLOUR, not an `outline` shorthand. Writing
     `outline: var(--edc-focus-ring)` parses, but the shorthand resets
     `outline-style` to its initial `none` — so it painted nothing AND
     suppressed the browser's own focus ring, leaving keyboard focus on this
     search box invisible. The token is designed for `box-shadow`, which is how
     every other call site uses it (`Composer`, `DocsPanel`, `EcosystemPicker`,
     `primitives/Input`, `primitives/StarRating`). `outline: none` stays so the
     UA ring is replaced rather than doubled. */
  .search input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .chips {
    display: flex;
    gap: 0.25rem;
  }
  .chip {
    /* ⚠ Measured at 29px tall on a 380px screen — under the 32px touch bar. */
    min-height: 2rem;
    padding: 0.35rem 0.6rem;
    font-size: 0.74rem;
    font-weight: 700;
    color: var(--edc-color-ink-soft);
    background: transparent;
    border: 1px solid var(--edc-color-neutral-outline);
    border-radius: var(--edc-radius-pill);
    cursor: pointer;
  }
  .chip:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }
  .chip.on {
    color: var(--edc-color-brand);
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
  }
  .count {
    margin: 0 0 0.4rem;
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  .of {
    opacity: 0.8;
  }
  .empty {
    margin: 0;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
  .scroller {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--edc-color-line);
    vertical-align: middle;
  }
  thead th {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--edc-color-ink-soft);
    white-space: nowrap;
  }
  tbody th {
    font-weight: 600;
    color: var(--edc-color-ink);
    max-width: 22rem;
  }
  .title {
    display: block;
    overflow-wrap: anywhere;
  }
  .sub {
    display: block;
    font-weight: 400;
    font-size: 0.7rem;
    color: var(--edc-color-ink-soft);
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
