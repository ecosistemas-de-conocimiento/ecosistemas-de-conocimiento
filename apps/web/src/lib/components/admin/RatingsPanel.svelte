<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Qué opinan de las respuestas" — the ratings, counted.
   *
   * 🔴 THE REASONS ARE THE POINT, NOT THE AVERAGE. An average of 4.2 tells you
   * nothing you can act on. "41 % de las calificaciones bajas dicen: cita algo
   * que la fuente no dice" tells you retrieval is grounding badly, and it moves
   * when you fix it. The average is here because people look for it; the
   * reason tables are here because they are the reason the column exists.
   *
   * ⚠ Percentages are shares OF THEIR OWN GROUP — low reasons over low scores,
   * high reasons over high scores. `summarizeRatings` computes them; this file
   * only draws them.
   */
  import { lowScoreHeadline, MIN_LOW_SCORES_FOR_HEADLINE, share, type RatingsSummary } from './summary';

  type Props = { summary: RatingsSummary };
  let { summary }: Props = $props();

  const headline = $derived(lowScoreHeadline(summary));
  const maxBar = $derived(Math.max(1, ...summary.byStars));
</script>

{#if summary.total === 0}
  <p class="empty">
    Todavía nadie ha calificado una respuesta en este ecosistema.
  </p>
{:else}
  <div class="top">
    <div class="avg">
      <p class="avg-value">{summary.average?.toFixed(1) ?? '—'}</p>
      <p class="avg-label">
        promedio de {summary.total}
        {summary.total === 1 ? 'calificación' : 'calificaciones'}
        {#if summary.raters > 0}
          · {summary.raters} {summary.raters === 1 ? 'persona' : 'personas'}
        {/if}
      </p>
    </div>

    <ul class="bars">
      {#each [5, 4, 3, 2, 1] as stars (stars)}
        {@const count = summary.byStars[stars - 1] ?? 0}
        <li>
          <span class="bar-label">{stars}★</span>
          <span class="bar-track">
            <span class="bar-fill" style={`width: ${(count / maxBar) * 100}%`}></span>
          </span>
          <span class="bar-count">{count}</span>
        </li>
      {/each}
    </ul>
  </div>

  {#if headline}
    <p class="headline">{headline}</p>
  {/if}

  <div class="reasons">
    <section>
      <h3>Qué salió mal <span class="dim">({summary.lowTotal} de 1 a 3 estrellas)</span></h3>
      {#if summary.lowTotal === 0}
        <p class="empty">Ninguna respuesta se calificó por debajo de 4 estrellas.</p>
      {:else if summary.lowReasons.length === 0}
        <p class="empty">Nadie eligió un motivo en estas calificaciones.</p>
      {:else}
        <ul class="reason-list">
          {#each summary.lowReasons as r (r.value)}
            <li>
              <span class="reason-label">{r.label}</span>
              <span class="reason-num">{r.count}{#if r.share != null}<span class="dim"> · {r.share} %</span>{/if}</span>
            </li>
          {/each}
        </ul>
        {#if summary.lowTotal < MIN_LOW_SCORES_FOR_HEADLINE}
          <p class="caveat">Son pocas para sacar conclusiones todavía.</p>
        {/if}
      {/if}
    </section>

    <section>
      <h3>Qué estuvo bien <span class="dim">({summary.highTotal} de 4 a 5 estrellas)</span></h3>
      {#if summary.highTotal === 0}
        <p class="empty">Ninguna respuesta llegó a 4 estrellas.</p>
      {:else if summary.highReasons.length === 0}
        <p class="empty">Nadie eligió un motivo en estas calificaciones.</p>
      {:else}
        <ul class="reason-list">
          {#each summary.highReasons as r (r.value)}
            <li>
              <span class="reason-label">{r.label}</span>
              <span class="reason-num">{r.count}{#if r.share != null}<span class="dim"> · {r.share} %</span>{/if}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  {#if summary.withoutReason > 0}
    <p class="caveat">
      {summary.withoutReason} {summary.withoutReason === 1 ? 'calificación no trae' : 'calificaciones no traen'}
      motivo{#if share(summary.withoutReason, summary.total) != null}&nbsp;({share(
          summary.withoutReason,
          summary.total,
        )} % del total){/if}. Cuentan para el promedio, no para los motivos.
    </p>
  {/if}
{/if}

<style>
  .empty,
  .caveat {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.5;
    color: var(--edc-color-ink-soft);
  }
  .caveat {
    margin-top: 0.6rem;
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1.4rem;
    margin-bottom: 0.8rem;
  }
  .avg-value {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 2.1rem;
    font-weight: 800;
    line-height: 1;
    color: var(--edc-color-ink);
  }
  .avg-label {
    margin: 0.2rem 0 0;
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
  }
  .bars {
    flex: 1 1 14rem;
    display: grid;
    gap: 0.2rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bars li {
    display: grid;
    grid-template-columns: 2rem 1fr 2.2rem;
    align-items: center;
    gap: 0.5rem;
  }
  .bar-label,
  .bar-count {
    font-size: 0.72rem;
    color: var(--edc-color-ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .bar-count {
    text-align: right;
  }
  .bar-track {
    height: 0.5rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-neutral-soft);
    overflow: hidden;
  }
  .bar-fill {
    display: block;
    height: 100%;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-brand);
  }
  .headline {
    margin: 0 0 0.8rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
    color: var(--edc-color-warning);
    font-size: 0.82rem;
    font-weight: 700;
    line-height: 1.4;
  }
  .reasons {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  }
  h3 {
    margin: 0 0 0.4rem;
    font-family: var(--edc-font-display);
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--edc-color-ink);
  }
  .dim {
    font-weight: 400;
    color: var(--edc-color-ink-soft);
  }
  .reason-list {
    display: grid;
    gap: 0.15rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .reason-list li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--edc-color-line);
    font-size: 0.79rem;
  }
  .reason-label {
    color: var(--edc-color-ink-body);
  }
  .reason-num {
    font-weight: 700;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--edc-color-ink);
  }
</style>
