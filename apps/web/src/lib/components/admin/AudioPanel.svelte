<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Audio y transcripciones" — did the recordings become text?
   *
   * 🔴 THIS PANEL SHOWS SIZES, NEVER CONTENT. The transcript of a draft
   * recording is private to the person who uploaded it, by the same rule that
   * governs every other draft. "45 min de audio → 473 caracteres" answers the
   * question an admin actually has (did the pipeline work) without putting
   * anyone's meeting into an admin page.
   *
   * ⚠ Nothing here frames a running transcription as nearly finished.
   * Transcription runs at roughly real time on CPU — an hour of audio is an
   * hour of work — and `$lib/ingest.ts` owns that copy for exactly this reason.
   */
  import { Badge } from '$lib/primitives';
  import { audioDurationChip, TRANSCRIPT_PROVENANCE_TOOLTIP } from '$lib/ingest';
  import { formatDay, type AdminDocRow, type AudioSummary } from './summary';

  type Props = {
    summary: AudioSummary;
    docs: AdminDocRow[];
    nameById: Record<string, string>;
  };
  let { summary, docs, nameById }: Props = $props();

  const audioDocs = $derived(docs.filter((d) => d.kind === 'audio').slice(0, 12));

  const numbers = new Intl.NumberFormat('es-MX');
</script>

{#if summary.total === 0}
  <p class="empty">
    Todavía nadie ha subido audio a este ecosistema. Cuando alguien suba una grabación,
    se transcribe sola y aparece aquí.
  </p>
{:else}
  <p class="lede">
    {summary.total}
    {summary.total === 1 ? 'grabación' : 'grabaciones'}{#if summary.durationLabel}, {summary.durationLabel} en total{/if}.
    <strong>{summary.transcribed}</strong>
    {summary.transcribed === 1 ? 'ya tiene transcripción' : 'ya tienen transcripción'}.
    {#if summary.inProgress > 0}
      {summary.inProgress} en proceso — la transcripción tarda más o menos lo que dura la grabación.
    {/if}
    {#if summary.failed > 0}
      <span class="bad">{summary.failed} no se pudieron procesar.</span>
    {/if}
  </p>

  <div class="scroller">
    <table>
      <thead>
        <tr>
          <th scope="col">Grabación</th>
          <th scope="col">Quién la subió</th>
          <th scope="col">Cuándo</th>
          <th scope="col">Duración</th>
          <th scope="col">Transcripción</th>
        </tr>
      </thead>
      <tbody>
        {#each audioDocs as d (d.id)}
          <tr>
            <th scope="row">{d.title}</th>
            <td>{nameById[d.uploaderId] ?? 'Sin identificar'}</td>
            <td class="nowrap">{formatDay(d.createdAt)}</td>
            <td class="nowrap">{audioDurationChip(d.audioMeta) ?? '—'}</td>
            <td>
              {#if d.transcriptChars && d.transcriptChars > 0}
                <span title={TRANSCRIPT_PROVENANCE_TOOLTIP}>
                  <Badge
                    label={`${numbers.format(d.transcriptChars)} caracteres`}
                    tone="success"
                    size="sm"
                  />
                </span>
              {:else if d.ingestStatus === 'failed'}
                <Badge label="No se pudo transcribir" tone="danger" size="sm" />
              {:else}
                <Badge label="Todavía no" tone="warning" size="sm" />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if summary.total > audioDocs.length}
    <p class="note">Se muestran las {audioDocs.length} grabaciones más recientes.</p>
  {/if}
{/if}

<style>
  .empty,
  .note {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--edc-color-ink-soft);
  }
  .note {
    margin-top: 0.5rem;
    font-size: 0.7rem;
  }
  .lede {
    margin: 0 0 0.7rem;
    font-size: 0.84rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }
  .lede strong {
    color: var(--edc-color-ink);
  }
  .bad {
    color: var(--edc-color-danger);
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
    overflow-wrap: anywhere;
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
