<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Uso del chat" — what the conversations cost and how they behaved.
   *
   * 🔴 NOT ONE WORD OF ANY CONVERSATION REACHES THIS FILE. It receives a
   * `UsageSummary`: counts, timings, models, dollars. The
   * backend computes it over the WHOLE ecosistema (`apps/backend/src/lib/
   * chatUsage.ts`), its row type has no field for message text, and the
   * elevated read never asks for one. Admins see THAT conversations
   * happened and what shape they had. What was said is not administration.
   *
   * ⚠ Three honesty rules are drawn, not just computed, and they are why this
   * component has more copy than markup:
   *
   *  · COST IS A FLOOR when some answers arrived without telemetry. The panel
   *    says how many are missing rather than summing around them.
   *  · TOKENS ARE ABSENT, and the panel says why. ai-service records tokens
   *    under one deployment-wide tenant, so its total cannot be attributed to
   *    one ecosistema. Printing it here would be a precise wrong number.
   *  · THE SPAN IS WALL CLOCK between the first and last turn — not time spent
   *    reading or typing. The label says so.
   *
   * All the arithmetic is in the backend's `chatUsage.ts`, where vitest
   * reaches it; this file lays it out.
   */
  import {
    budgetLine,
    formatCostUsd,
    formatDay,
    formatSpan,
    plural,
    shortModelName,
    type BudgetView,
    type UsageSummary,
  } from './summary';

  type Props = {
    summary: UsageSummary;
    /** `false` ⇒ a read failed. Different from "nothing happened". */
    ok: boolean;
    /**
     * ai-service's budget for this ecosistema (C-6). `null` = not asked;
     * `{ok:false}` = the read failed, and the panel says so.
     */
    budget?: BudgetView | null;
  };

  let { summary, ok, budget = null }: Props = $props();
  const budgetText = $derived(budgetLine(budget));

  const numbers = new Intl.NumberFormat('es-MX');

  /** The most recent days with activity. Older ones scroll off; the total stays in the tiles. */
  const DAYS_SHOWN = 14;
  const days = $derived(summary.daily.slice(-DAYS_SHOWN));
  const busiestDay = $derived(Math.max(1, ...days.map((d) => d.messages)));

  const avgSpan = $derived(formatSpan(summary.spans.averageSeconds));
  const longestSpan = $derived(formatSpan(summary.spans.longestSeconds));

  const periodLabel = $derived.by(() => {
    const from = formatDay(summary.firstAt);
    const to = formatDay(summary.lastAt);
    if (!from) return null;
    return from === to ? from : `${from} – ${to}`;
  });
</script>

{#if budget}
  <p class="caveat" data-testid="budget">
    {#if budgetText}
      <strong>Presupuesto de IA:</strong> {budgetText} gastado. Es todo lo que el servicio de IA
      cobró a este ecosistema: respuestas, preparación de búsquedas e indexación de documentos.
    {:else}
      No pudimos leer el presupuesto de IA de este ecosistema.
    {/if}
  </p>
{/if}

{#if !ok}
  <p class="notice">
    No pudimos leer las conversaciones de este ecosistema en este momento.
  </p>
{:else if summary.messages === 0}
  <p class="empty">
    {#if summary.conversations > 0}
      Hay {plural(summary.conversations, 'conversación abierta', 'conversaciones abiertas')}, pero
      todavía sin mensajes que contar.
    {:else}
      Todavía nadie ha conversado en este ecosistema.
    {/if}
  </p>
{:else}
  <dl class="figures">
    <div>
      <dt>Conversaciones</dt>
      <dd>{numbers.format(summary.conversations)}</dd>
      {#if summary.turnsPerConversation != null}
        <p class="foot">{summary.turnsPerConversation} mensajes en promedio</p>
      {/if}
    </div>
    <div>
      <dt>Mensajes</dt>
      <dd>{numbers.format(summary.messages)}</dd>
      <p class="foot">
        {numbers.format(summary.userTurns)} de personas ·
        {numbers.format(summary.assistantTurns)} respuestas
      </p>
    </div>
    <div>
      <dt>Costo (solo respuestas)</dt>
      <dd class="cost">{formatCostUsd(summary.costUsd)}</dd>
      <p class="foot">
        {#if summary.costPerTurn != null}
          {formatCostUsd(summary.costPerTurn)} por respuesta · no incluye reformular la pregunta
        {:else}
          Ninguna respuesta trae su costo.
        {/if}
      </p>
    </div>
    <div>
      <dt>Duración de una conversación</dt>
      <dd>{avgSpan ?? '—'}</dd>
      <p class="foot">
        {#if avgSpan}
          en promedio, de la primera a la última respuesta{#if longestSpan}{' · la más larga ' +
              longestSpan}{/if}
        {:else}
          Ninguna conversación tuvo dos mensajes.
        {/if}
      </p>
    </div>
  </dl>

  <!-- ⚠ Both caveats are permanent parts of the number, not error states.
       Hiding them when they are inconvenient is how a dashboard starts lying. -->
  {#if !summary.costIsComplete}
    <p class="caveat">
      El costo es un <strong>mínimo</strong>:
      {plural(summary.unpricedTurns, 'respuesta llegó', 'respuestas llegaron')}
      sin su dato de costo, así que no {summary.unpricedTurns === 1 ? 'está' : 'están'} sumada{summary.unpricedTurns ===
      1
        ? ''
        : 's'} aquí.
    </p>
  {/if}
  <p class="caveat">
    No mostramos tokens. El servicio de IA los registra bajo una sola cuenta para toda la
    instalación, así que su total no se puede repartir por ecosistema. El costo sí viene mensaje por
    mensaje, y por eso es el número que ves.
  </p>

  {#if periodLabel}
    <p class="caveat">Actividad registrada del {periodLabel}.</p>
  {/if}

  {#if summary.models.length > 0}
    <section class="block">
      <h3>Con qué modelos</h3>
      <ul class="rows">
        {#each summary.models as m (m.name)}
          <li>
            <span class="row-name" title={m.name}>{shortModelName(m.name)}</span>
            <span class="row-num">
              {numbers.format(m.turns)}
              {#if m.share != null}<span class="dim"> · {m.share} %</span>{/if}
              {#if m.costUsd > 0}<span class="dim"> · {formatCostUsd(m.costUsd)}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
      {#if summary.providers.length > 0}
        <p class="foot">
          Proveedor{summary.providers.length === 1 ? '' : 'es'}:
          {summary.providers.map((p) => `${p.name} (${p.turns})`).join(' · ')}
        </p>
      {/if}
    </section>
  {/if}

  {#if days.length > 0}
    <section class="block">
      <h3>Día a día <span class="dim">({days.length === 1 ? 'un día' : `últimos ${days.length} días con actividad`})</span></h3>
      <ul class="days">
        {#each days as d (d.day)}
          <li>
            <span class="day-label">{formatDay(`${d.day}T12:00:00.000Z`)}</span>
            <span class="day-track">
              <span class="day-fill" style={`width: ${(d.messages / busiestDay) * 100}%`}></span>
            </span>
            <span class="day-num">
              {numbers.format(d.messages)}
              {#if d.conversations > 0}<span class="dim"> · {d.conversations} conv.</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

<style>
  .figures {
    display: grid;
    gap: 0.7rem;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    margin: 0 0 0.8rem;
  }
  .figures > div {
    display: grid;
    gap: 0.1rem;
    align-content: start;
    padding: 0.7rem 0.8rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
  }
  dt {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--edc-color-ink-body);
  }
  dd {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.15;
    color: var(--edc-color-ink);
  }
  dd.cost {
    color: var(--edc-color-brand);
  }
  .foot {
    margin: 0.1rem 0 0;
    font-size: 0.7rem;
    line-height: 1.35;
    color: var(--edc-color-ink-soft);
  }
  .caveat {
    margin: 0 0 0.5rem;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--edc-color-ink-soft);
  }
  .caveat strong {
    color: var(--edc-color-ink-body);
  }
  .notice {
    margin: 0 0 0.6rem;
    padding: 0.45rem 0.6rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }
  .empty {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--edc-color-ink-soft);
  }
  .block {
    margin-top: 0.9rem;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--edc-color-ink-body);
  }
  .dim {
    font-weight: 400;
    color: var(--edc-color-ink-soft);
  }
  .rows,
  .days {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }
  .rows li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.76rem;
    color: var(--edc-color-ink-body);
  }
  .row-name {
    font-family: var(--edc-font-mono);
    overflow-wrap: anywhere;
  }
  .row-num {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .days li {
    display: grid;
    grid-template-columns: 6.5rem 1fr auto;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--edc-color-ink-body);
  }
  .day-label {
    color: var(--edc-color-ink-soft);
  }
  .day-track {
    height: 0.45rem;
    border-radius: 999px;
    background: var(--edc-color-neutral-soft);
    overflow: hidden;
  }
  .day-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--edc-gradient-brand);
  }
  .day-num {
    font-variant-numeric: tabular-nums;
  }
</style>
