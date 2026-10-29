<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/admin/evals` — the latest run's numbers per measure, their trend, each
   * item's detail, the item editor and "Ejecutar" (estimate, then confirm).
   * Same language as `/ajustes`; no explainer copy (owner rule).
   */
  import { onDestroy } from 'svelte';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ChatItemResult, EvalItem, PrivacyItemResult } from '$lib/server/evals/types';
  import Sparkline from './Sparkline.svelte';
  import { METRICS, TABS, delta, pct, rateOf, usd, type TabId } from './metrics';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let active = $state<TabId>('respuestas');
  let confirming = $state(false);

  const ready = $derived(data.state === 'ready' ? data : null);
  const latest = $derived(ready?.latest ?? null);
  const chat = $derived((latest?.results ?? []).filter((r): r is ChatItemResult => r.kind === 'pregunta'));
  const privacy = $derived((latest?.results ?? []).filter((r): r is PrivacyItemResult => r.kind === 'privacidad'));
  const trend = $derived(ready?.trend ?? []);
  const current = $derived(trend.at(-1)?.metrics ?? null);
  const previous = $derived(trend.at(-2)?.metrics ?? null);
  const questions = $derived((ready?.items ?? []).filter((i) => i.kind === 'pregunta'));
  const texts = $derived((ready?.items ?? []).filter((i) => i.kind === 'privacidad'));

  // While a run is going, reload its progress.
  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (ready?.running && !timer) timer = setInterval(() => void invalidateAll(), 4000);
    if (!ready?.running && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  onDestroy(() => timer && clearInterval(timer));

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const errorFor = (scope: string, id: string | null = null) =>
    form && 'message' in form && form.scope === scope && ('id' in form ? (form.id ?? null) === id : true) ? form.message : null;
  const lines = (xs: string[]) => xs.join('\n');
  const supported = (r: ChatItemResult) => `${r.claims.filter((c) => c.ok).length}/${r.claims.length}`;
</script>

<svelte:head><title>Evaluaciones · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <p class="kicker">Evaluaciones</p>
    <h1>{data.selected?.name ?? 'Evaluaciones'}</h1>
  </header>

  {#if data.ecosistemas.length > 1 && data.selected}
    <nav class="switcher" aria-label="Elegir ecosistema">
      {#each data.ecosistemas as eco (eco.id)}
        <a
          class="chip"
          class:current={eco.id === data.selected.id}
          href={`/admin/evals?eco=${encodeURIComponent(eco.id)}`}
          aria-current={eco.id === data.selected.id ? 'page' : undefined}>{eco.name}</a
        >
      {/each}
    </nav>
  {/if}

  {#if !ready}
    <p class="notice">{data.state === 'empty' ? 'No hay ecosistemas.' : 'No pudimos cargar las evaluaciones. Intenta de nuevo.'}</p>
  {:else}
    <section class="card runbar" data-testid="evals-runbar">
      <div class="run-meta">
        {#if ready.running}
          <span class="badge working" data-testid="evals-running">
            En curso · {ready.running.progress?.done ?? 0}/{ready.running.progress?.total ?? '?'}
          </span>
        {:else if latest}
          <span class="badge" class:bad={latest.status === 'failed'}>{latest.status === 'failed' ? 'Falló' : 'Última'}</span>
          <span>{fmtDate(latest.finishedAt ?? latest.createdAt)}</span>
          <span class="mono">{usd(latest.costUsd)}</span>
          {#if latest.commitSha}<span class="mono">{latest.commitSha.slice(0, 7)}</span>{/if}
          {#if latest.models?.chat?.length}<span class="mono soft">{latest.models.chat.join(', ')}</span>{/if}
          {#if latest.error}<span class="soft">{latest.error}</span>{/if}
        {:else}
          <span class="soft">Sin ejecuciones</span>
        {/if}
      </div>
      {#if !ready.running}
        {#if !confirming}
          <button
            type="button"
            class="btn primary"
            data-testid="evals-ejecutar"
            disabled={ready.items.length === 0}
            onclick={() => (confirming = true)}>Ejecutar</button
          >
        {:else}
          <form
            method="POST"
            action="?/ejecutar"
            class="confirm"
            data-testid="evals-confirm"
            use:enhance={() =>
              async ({ update }) => {
                confirming = false;
                await update();
              }}
          >
            <input type="hidden" name="organization" value={data.selected?.id} />
            <input type="hidden" name="confirm" value="si" />
            <span data-testid="evals-estimate">
              ≈ <strong>{usd(ready.estimate.usd)}</strong> · {ready.estimate.questions} preguntas · {ready.estimate.privacy} textos
              <span class="soft">({ready.estimate.basis})</span>
            </span>
            <button type="submit" class="btn primary">Confirmar</button>
            <button type="button" class="btn" onclick={() => (confirming = false)}>Cancelar</button>
          </form>
        {/if}
      {/if}
      {#if errorFor('run')}<p class="error" role="alert">{errorFor('run')}</p>{/if}
    </section>

    <div class="settings">
      <div class="tabs" role="tablist" aria-label="Medidas">
        {#each TABS as t (t.id)}
          <button
            type="button"
            role="tab"
            class="tab"
            id={`tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            data-testid={`evals-tab-${t.id}`}
            onclick={() => (active = t.id)}>{t.label}</button
          >
        {/each}
      </div>

      <div class="card" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {#if active !== 'preguntas'}
          <div class="tiles">
            {#each METRICS[active] as m (m.key)}
              {@const value = rateOf(current, m.key)}
              {@const d = delta(value, rateOf(previous, m.key), m.up)}
              <div class="tile" data-testid={`evals-metric-${m.key}`}>
                <span class="tile-label">{m.label}</span>
                <span class="tile-value">{pct(value)}</span>
                <span class="tile-sub">
                  {#if current}n={m.of(current)}{/if}
                  {#if d}<span class="delta" class:good={d.good === true} class:bad={d.good === false}>{d.text}</span>{/if}
                </span>
                <Sparkline values={trend.map((t) => rateOf(t.metrics, m.key))} label={m.label} />
              </div>
            {/each}
            {#if active === 'privacidad' && current}
              <div class="tile"><span class="tile-label">Retenidos</span><span class="tile-value">{current.holds}</span><span class="tile-sub">de {current.privacyItems}</span></div>
            {/if}
          </div>
          {#if active === 'estilo' && !ready.hasStyle}
            <p class="empty">Sin estilo configurado</p>
          {/if}

          <ul class="rows">
            {#if active === 'respuestas'}
              {#each chat as r (r.itemId)}
                <li>
                  <details>
                    <summary>
                      <span class="q">{r.question}</span>
                      {#if r.error}<span class="badge bad">error</span>{/if}
                      {#if r.shouldRefuse}<span class="badge">debe rechazar</span>{/if}
                      <span class="badge" class:good={r.refusalOk} class:bad={!r.refusalOk}>{r.refused ? 'rechazó' : 'respondió'}</span>
                      {#if r.claims.length}<span class="badge mono">{supported(r)}</span>{/if}
                    </summary>
                    <div class="detail">
                      {#if r.error}<p class="error">{r.error}</p>{/if}
                      <p class="answer">{r.answer}</p>
                      {#if r.claims.length}
                        <ul class="claims">
                          {#each r.claims as c, i (i)}
                            <li class:good={c.ok} class:bad={!c.ok}><span class="mono">[{c.n}] {c.ok ? 'SI' : 'NO'}</span> {c.claim}</li>
                          {/each}
                        </ul>
                      {/if}
                      {#if r.sources.length}
                        <ol class="sources">
                          {#each r.sources as s (s.n)}<li><span class="mono">[{s.n}]</span> {s.title ?? '—'} {#if s.docId}<span class="mono soft">#{s.docId}</span>{/if}</li>{/each}
                        </ol>
                      {/if}
                    </div>
                  </details>
                </li>
              {/each}
            {:else if active === 'recuperacion'}
              {#each chat.filter((r) => r.expectedDocIds.length > 0) as r (r.itemId)}
                <li>
                  <details>
                    <summary>
                      <span class="q">{r.question}</span>
                      <span class="badge mono" class:good={r.rank !== null && r.rank <= 5} class:bad={r.rank === null}>{r.rank === null ? 'no' : `#${r.rank}`}</span>
                    </summary>
                    <div class="detail">
                      <p class="soft mono">esperado: {r.expectedDocIds.map((id) => `#${id}`).join(' ')}</p>
                      <ol class="sources">
                        {#each r.sources as s (s.n)}
                          <li class:good={s.docId !== null && r.expectedDocIds.map(String).includes(s.docId)}>
                            <span class="mono">[{s.n}]</span> {s.title ?? '—'} {#if s.docId}<span class="mono soft">#{s.docId}</span>{/if}
                          </li>
                        {/each}
                      </ol>
                    </div>
                  </details>
                </li>
              {/each}
            {:else if active === 'privacidad'}
              {#each privacy as r (r.itemId)}
                <li>
                  <details>
                    <summary>
                      <span class="q">{r.notes || `Texto ${r.itemId}`}</span>
                      <span class="badge" class:bad={r.status !== 'ready'}>{r.status === 'ready' ? 'listo' : r.status === 'hold' ? `retenido · ${r.stage ?? ''}` : 'error'}</span>
                      {#if r.status === 'ready'}
                        <span class="badge mono" class:bad={r.terms.some((t) => t.ok === false)}>{r.terms.filter((t) => t.ok === false).length} mal</span>
                      {/if}
                    </summary>
                    <div class="detail">
                      {#if r.error}<p class="error">{r.error}</p>{/if}
                      <p class="soft mono">{r.detector ?? ''} {r.model ?? ''}</p>
                      <table class="terms">
                        <tbody>
                          {#each r.terms as t (t.cls + t.term)}
                            <tr class:good={t.ok === true} class:bad={t.ok === false}>
                              <td>{t.term}</td>
                              <td class="soft">{t.cls}</td>
                              <td class="mono">{t.before}→{t.after}</td>
                              <td class="mono">{t.ok === null ? 'ausente' : t.ok ? 'bien' : t.cls === 'privado' ? 'fuga' : 'oculto'}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </li>
              {/each}
            {:else if active === 'estilo'}
              {#each chat.filter((r) => r.style) as r (r.itemId)}
                <li>
                  <details>
                    <summary>
                      <span class="q">{r.question}</span>
                      <span class="badge" class:good={r.style?.ok} class:bad={!r.style?.ok}>{r.style?.ok ? 'SI' : 'NO'}</span>
                    </summary>
                    <div class="detail">
                      <p class="soft">{r.style?.reason}</p>
                      <p class="answer">{r.answer}</p>
                    </div>
                  </details>
                </li>
              {/each}
            {/if}
          </ul>
        {:else}
          <div class="editor" data-testid="evals-editor">
            {#if ready.items.length === 0}
              <form method="POST" action="?/cargar" use:enhance class="seed">
                <input type="hidden" name="organization" value={data.selected?.id} />
                <button type="submit" class="btn" data-testid="evals-cargar">Cargar set inicial</button>
                {#if errorFor('seed')}<span class="error" role="alert">{errorFor('seed')}</span>{/if}
              </form>
            {/if}

            <h2>Preguntas <span class="soft">{questions.length}</span></h2>
            {#each [...questions, null] as item (item?.id ?? 'nueva-pregunta')}
              {@render questionForm(item)}
            {/each}

            <h2>Privacidad <span class="soft">{texts.length}</span></h2>
            {#each [...texts, null] as item (item?.id ?? 'nuevo-texto')}
              {@render privacyForm(item)}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#snippet itemButtons(item: EvalItem | null)}
  <div class="actions">
    <button type="submit" class="btn primary">Guardar</button>
    {#if item}<button type="submit" class="btn danger" formaction="?/borrar" formnovalidate>Borrar</button>{/if}
    {#if errorFor('item', item?.id ?? null)}<span class="error" role="alert">{errorFor('item', item?.id ?? null)}</span>{/if}
  </div>
{/snippet}

{#snippet questionForm(item: EvalItem | null)}
  <details class="item" data-testid={item ? `evals-item-${item.id}` : 'evals-new-pregunta'}>
    <summary>{item ? item.question : '+ Pregunta'}{#if item?.shouldRefuse}<span class="badge">rechazar</span>{/if}</summary>
    <form method="POST" action="?/guardar" use:enhance={() => async ({ update }) => update({ reset: !item })}>
      <input type="hidden" name="organization" value={data.selected?.id} />
      <input type="hidden" name="kind" value="pregunta" />
      {#if item}<input type="hidden" name="id" value={item.id} />{/if}
      <label>Pregunta<textarea name="question" rows="2" required>{item?.question ?? ''}</textarea></label>
      <label>Documentos esperados (ids)<input name="expectedDocIds" value={item?.expectedDocIds.join(', ') ?? ''} inputmode="numeric" /></label>
      <label class="check"><input type="checkbox" name="shouldRefuse" checked={item?.shouldRefuse ?? false} />Debe rechazar</label>
      <label>Notas<input name="notes" value={item?.notes ?? ''} /></label>
      {@render itemButtons(item)}
    </form>
  </details>
{/snippet}

{#snippet privacyForm(item: EvalItem | null)}
  <details class="item" data-testid={item ? `evals-item-${item.id}` : 'evals-new-privacidad'}>
    <summary>{item ? item.notes || `Texto ${item.id}` : '+ Texto'}</summary>
    <form method="POST" action="?/guardar" use:enhance={() => async ({ update }) => update({ reset: !item })}>
      <input type="hidden" name="organization" value={data.selected?.id} />
      <input type="hidden" name="kind" value="privacidad" />
      {#if item}<input type="hidden" name="id" value={item.id} />{/if}
      <label>Texto sintético<textarea name="text" rows="6" required>{item?.text ?? ''}</textarea></label>
      <div class="two">
        <label>Nombres privados<textarea name="privateNames" rows="4">{lines(item?.privateNames ?? [])}</textarea></label>
        <label>Nombres públicos<textarea name="publicNames" rows="4">{lines(item?.publicNames ?? [])}</textarea></label>
      </div>
      <label
        >Tipo<select name="gateKind" value={item?.gateKind ?? 'documento'}>
          <option value="documento">documento</option>
          <option value="testimonio">testimonio</option>
        </select></label
      >
      <label>Notas<input name="notes" value={item?.notes ?? ''} /></label>
      {@render itemButtons(item)}
    </form>
  </details>
{/snippet}

<style>
  .page {
    min-width: 0;
    width: min(64rem, 100%);
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-4) var(--edc-space-12);
    display: grid;
    gap: var(--edc-space-5);
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
  h1 {
    margin: 0.15rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: var(--edc-leading-tight);
    overflow-wrap: anywhere;
  }
  h2 {
    margin: var(--edc-space-4) 0 var(--edc-space-2);
    font-size: var(--edc-text-lg);
    font-weight: var(--edc-weight-bold);
  }
  .notice,
  .empty {
    margin: 0;
    padding: 0.8rem 1rem;
    color: var(--edc-color-ink-body);
  }
  .notice {
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-soft);
  }
  .switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--edc-color-neutral-outline);
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: var(--edc-text-sm);
    font-weight: var(--edc-weight-semibold);
    text-decoration: none;
  }
  .chip.current {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  .card {
    min-width: 0;
    overflow: clip;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  .runbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--edc-space-3);
    padding: var(--edc-space-3) var(--edc-space-4);
  }
  .run-meta,
  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    font-size: var(--edc-text-sm);
    min-width: 0;
  }
  .mono {
    font-family: var(--edc-font-mono);
    font-size: var(--edc-text-xs);
  }
  .soft {
    color: var(--edc-color-ink-soft);
  }
  .badge {
    flex: none;
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-surface-soft);
    font-size: var(--edc-text-xs);
    font-weight: var(--edc-weight-semibold);
    color: var(--edc-color-ink-soft);
  }
  .badge.working {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  .badge.good,
  .good > .mono:first-child {
    color: var(--edc-color-success);
  }
  .badge.good {
    border-color: var(--edc-color-success-outline);
    background: var(--edc-color-success-soft);
  }
  .badge.bad {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-danger);
  }
  .btn {
    min-height: 2.5rem;
    padding: 0.45rem 1rem;
    border: 1px solid var(--edc-color-neutral-outline);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font: inherit;
    font-size: var(--edc-text-sm);
    font-weight: var(--edc-weight-semibold);
    cursor: pointer;
  }
  .btn.primary {
    border-color: var(--edc-color-brand);
    background: var(--edc-color-brand);
    color: var(--edc-color-on-brand);
  }
  .btn.danger {
    color: var(--edc-color-danger);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn:focus-visible,
  .tab:focus-visible,
  .chip:focus-visible,
  summary:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .error {
    margin: 0;
    color: var(--edc-color-danger);
    font-size: var(--edc-text-sm);
  }
  .settings {
    display: grid;
    gap: var(--edc-space-3);
    min-width: 0;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 3px;
    margin: -3px;
  }
  .tab {
    flex: none;
    min-height: 2.75rem;
    padding: 0.5rem 0.85rem;
    border: 1px solid transparent;
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: var(--edc-color-ink-soft);
    font: inherit;
    font-size: var(--edc-text-md);
    font-weight: var(--edc-weight-semibold);
    text-align: left;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }
  .tab[aria-selected='true'] {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: var(--edc-space-3);
    padding: var(--edc-space-4);
    border-bottom: 1px solid var(--edc-color-elevated-border);
  }
  .tile {
    display: grid;
    gap: 0.2rem;
    align-content: start;
  }
  .tile-label {
    font-size: var(--edc-text-sm);
    font-weight: var(--edc-weight-semibold);
    color: var(--edc-color-ink-soft);
  }
  .tile-value {
    font-family: var(--edc-font-display);
    font-size: 2rem;
    font-weight: 800;
    line-height: 1;
    color: var(--edc-color-ink);
  }
  .tile-sub {
    display: flex;
    gap: 0.5rem;
    font-family: var(--edc-font-mono);
    font-size: var(--edc-text-xs);
    color: var(--edc-color-ink-soft);
  }
  .delta.good {
    color: var(--edc-color-success);
  }
  .delta.bad {
    color: var(--edc-color-danger);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rows > li + li {
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: var(--edc-space-3) var(--edc-space-4);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--edc-color-neutral-soft);
  }
  .q {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .detail {
    display: grid;
    gap: var(--edc-space-3);
    padding: 0 var(--edc-space-4) var(--edc-space-4);
    min-width: 0;
  }
  .detail p {
    margin: 0;
  }
  .answer {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--edc-color-ink-body);
    font-size: var(--edc-text-sm);
  }
  .claims,
  .sources {
    margin: 0;
    padding-left: 1.2rem;
    display: grid;
    gap: 0.3rem;
    font-size: var(--edc-text-sm);
  }
  .claims {
    list-style: none;
    padding-left: 0;
  }
  .claims .bad > .mono {
    color: var(--edc-color-danger);
  }
  .terms {
    border-collapse: collapse;
    font-size: var(--edc-text-sm);
    width: 100%;
  }
  .terms td {
    padding: 0.25rem 0.5rem 0.25rem 0;
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .terms tr.bad td:last-child {
    color: var(--edc-color-danger);
    font-weight: var(--edc-weight-semibold);
  }
  .editor {
    padding: var(--edc-space-2) var(--edc-space-4) var(--edc-space-4);
  }
  .seed {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding-top: var(--edc-space-2);
  }
  .item {
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    margin-bottom: 0.4rem;
    background: var(--edc-color-surface);
  }
  .item summary {
    padding: 0.55rem 0.8rem;
    font-size: var(--edc-text-sm);
  }
  .item form {
    display: grid;
    gap: var(--edc-space-3);
    padding: 0 0.8rem 0.8rem;
  }
  label {
    display: grid;
    gap: 0.3rem;
    font-size: var(--edc-text-sm);
    font-weight: var(--edc-weight-semibold);
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .two {
    display: grid;
    gap: var(--edc-space-3);
  }
  textarea,
  input:not([type='checkbox']),
  select {
    width: 100%;
    font: inherit;
    font-weight: normal;
    font-size: var(--edc-text-md);
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  @media (min-width: 48rem) {
    .page {
      padding: var(--edc-space-8) var(--edc-space-6) var(--edc-space-12);
    }
    .settings {
      grid-template-columns: 12rem minmax(0, 1fr);
      align-items: start;
      gap: var(--edc-space-5);
    }
    .tabs {
      flex-direction: column;
      overflow: visible;
      position: sticky;
      top: var(--edc-space-4);
    }
    .tab {
      width: 100%;
    }
    .two {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
