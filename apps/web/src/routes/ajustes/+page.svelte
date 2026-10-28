<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/ajustes` — toggles + save. Every rule is in the backend; no explainer
   * copy (owner rule).
   */
  import { enhance } from '$app/forms';
  import { FEATURE_KEYS, FEATURE_LABELS } from '$lib/features';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const failure = $derived(form && 'message' in form ? (form.message as string) : null);
  const saved = $derived(Boolean(form && 'saved' in form && form.saved));
  const fallbackChoice = $derived(data.plataforma?.detectorFallback ?? 'env');
</script>

<svelte:head><title>Ajustes · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <p class="kicker">Ajustes</p>
    <h1>{data.selected?.name ?? 'Ajustes'}</h1>
  </header>

  {#if data.ecosistemas.length > 1 && data.selected}
    <nav class="switcher" aria-label="Elegir ecosistema">
      {#each data.ecosistemas as eco (eco.id)}
        <a
          class="chip"
          class:current={eco.id === data.selected.id}
          href={`/ajustes?eco=${encodeURIComponent(eco.id)}`}
          aria-current={eco.id === data.selected.id ? 'page' : undefined}
        >
          {eco.name}
        </a>
      {/each}
    </nav>
  {/if}

  {#if failure}
    <p class="error" role="alert" data-testid="ajustes-error">{failure}</p>
  {:else if saved}
    <p class="done" role="status" data-testid="ajustes-saved">Guardado.</p>
  {/if}

  {#if data.state === 'unavailable' || !data.selected}
    <p class="notice">No pudimos cargar los ajustes. Intenta de nuevo.</p>
  {:else}
    {#key data.selected.id}
      <form method="POST" action="?/funciones" use:enhance={() => ({ update }) => update({ reset: false })} data-testid="ajustes-funciones">
        <input type="hidden" name="organization" value={data.selected.id} />
        <ul class="list">
          {#each FEATURE_KEYS as key (key)}
            {@const locked = data.lockedFeatures.includes(key)}
            <li class="row">
              <label class:locked>
                <input type="checkbox" name={key} checked={data.selected.features[key]} disabled={locked} />
                <span>{FEATURE_LABELS[key]}</span>
              </label>
              {#if locked}
                <input type="hidden" name="locked" value={key} />
                <p class="note">Solo administración de la plataforma puede cambiarlo</p>
              {/if}
            </li>
          {/each}
        </ul>
        <button type="submit" class="primary">Guardar</button>
      </form>
    {/key}
  {/if}

  {#if data.plataforma}
    <section aria-labelledby="plataforma">
      <h2 id="plataforma">Plataforma</h2>
      <form method="POST" action="?/plataforma" use:enhance={() => ({ update }) => update({ reset: false })} data-testid="ajustes-plataforma">
        <label class="field">
          <span>Respaldo del detector</span>
          <select name="detectorFallback">
            <option value="env" selected={fallbackChoice === 'env'}>
              Según el entorno ({data.plataforma.detectorFallbackEnv === 'none' ? 'ninguno' : data.plataforma.detectorFallbackEnv === 'hosted' ? 'modelo alojado' : 'no válido'})
            </option>
            <option value="hosted" selected={fallbackChoice === 'hosted'}>Modelo alojado</option>
            <option value="none" selected={fallbackChoice === 'none'}>Ninguno</option>
          </select>
        </label>
        <button type="submit" class="primary">Guardar</button>
      </form>
    </section>
  {/if}
</div>

<style>
  .page {
    width: min(52rem, 100%);
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  .kicker {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.2rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.6rem;
    line-height: 1.2;
  }
  h2 {
    margin: 1.5rem 0 0.6rem;
    font-size: 1.05rem;
  }
  .notice,
  .error,
  .done {
    margin: 1rem 0 0;
    padding: 0.8rem 1rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-neutral-soft);
  }
  .switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 1rem 0 0;
  }
  .chip {
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 999px;
    text-decoration: none;
    color: inherit;
  }
  .chip.current {
    font-weight: 700;
  }
  .list {
    list-style: none;
    margin: 1rem 0;
    padding: 0;
  }
  .row {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--edc-color-line);
  }
  .row label {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    cursor: pointer;
  }
  .row label.locked {
    cursor: default;
    color: var(--edc-color-ink-soft);
  }
  .note {
    margin: 0.2rem 0 0 1.6rem;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 0.8rem;
    font-size: 0.85rem;
  }
  select,
  button {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: inherit;
  }
  button {
    cursor: pointer;
  }
  .primary {
    font-weight: 700;
  }
</style>
