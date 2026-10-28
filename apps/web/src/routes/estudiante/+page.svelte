<svelte:options runes={true} />

<script lang="ts">
  /** `/estudiante` — minimal copy (owner rule); every rule is in the backend. */
  import { enhance } from '$app/forms';
  import { CONSENT_ACTIVITY, CONSENT_ACTIVITY_WITH_TESTIMONIOS } from '$lib/consent';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const o = $derived(data.overview);
  const message = $derived(form && 'message' in form ? (form.message as string) : null);
  const preguntas = $derived(form && 'preguntas' in form ? (form.preguntas as string[]) : []);
  const suggested = $derived(Boolean(form && 'suggested' in form));
  let generating = $state(false);
</script>

<svelte:head><title>Mi investigación · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <p class="kicker">Mi investigación</p>
    <h1>Mis temas</h1>
  </header>

  {#if message}
    <p class="error" role="alert" data-testid="estudiante-error">{message}</p>
  {/if}

  {#if !o}
    <p class="notice">No disponible. Intenta de nuevo.</p>
  {:else}
    {#if o.temas.length}
      <ul class="chips" data-testid="mis-temas">
        {#each o.temas as t (t)}<li class="chip">{t}</li>{/each}
      </ul>
    {:else}
      <p class="muted">Sube un trabajo.</p>
    {/if}

    <section aria-labelledby="preguntas">
      <h2 id="preguntas">Preguntas para investigar</h2>
      <form
        method="POST"
        action="?/preguntas"
        use:enhance={() => {
          generating = true;
          return async ({ update }) => {
            await update({ reset: false });
            generating = false;
          };
        }}
      >
        <button type="submit" class="primary" disabled={generating} data-testid="preguntas-generar">
          {generating ? 'Generando…' : 'Generar preguntas'}
        </button>
      </form>
      {#if preguntas.length}
        <ol class="list questions" data-testid="preguntas">
          {#each preguntas as q (q)}<li>{q}</li>{/each}
        </ol>
      {/if}
    </section>

    <section aria-labelledby="companeros">
      <h2 id="companeros">Compañeros con temas cercanos</h2>
      {#if o.companeros.length}
        <ul class="list" data-testid="companeros">
          {#each o.companeros as c (c.name)}
            <li class="row"><strong>{c.name}</strong> <span class="muted">· {c.topics.join(', ')}</span></li>
          {/each}
        </ul>
      {:else}
        <p class="muted">Nadie todavía.</p>
      {/if}
      <form method="POST" action="?/perfil" use:enhance={() => ({ update }) => update({ reset: false })}>
        <input type="hidden" name="key" value="shareWithPeers" />
        <input type="hidden" name="value" value={String(!o.perfil.shareWithPeers)} />
        <label class="toggle">
          <input type="checkbox" checked={o.perfil.shareWithPeers} onchange={(e) => e.currentTarget.form?.requestSubmit()} data-testid="share-peers" />
          <span>Mostrar mi nombre y mis temas a otros estudiantes</span>
        </label>
      </form>
    </section>

    <section aria-labelledby="autores">
      <h2 id="autores">Mis autores</h2>
      {#if o.autores.length}
        <ul class="list" data-testid="mis-autores">
          {#each o.autores as a (a.name)}
            <li class="row">
              {#if a.page}<a href={`/biblioteca/${a.page.id}`}>{a.name}</a>{:else}{a.name}{/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">Ninguno todavía.</p>
      {/if}
    </section>

    <section aria-labelledby="leer">
      <h2 id="leer">Autores para leer en este corpus</h2>
      {#if o.autoresParaLeer.length}
        <ul class="list" data-testid="autores-leer">
          {#each o.autoresParaLeer as a (a.name)}
            <li class="row">
              {#if a.page}<a href={`/biblioteca/${a.page.id}`}>{a.name}</a>{:else}{a.name}{/if}
              <span class="muted">· {a.docs}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">Ninguno todavía.</p>
      {/if}
    </section>

    <section aria-labelledby="sugerir">
      <h2 id="sugerir">Sugerir</h2>
      {#if suggested}<p class="done" role="status">Gracias.</p>{/if}
      <form method="POST" action="?/sugerir" use:enhance class="suggest" data-testid="sugerir">
        <select name="kind" required aria-label="Tipo">
          <option value="contenido">Contenido</option>
          <option value="arquitectura">Arquitectura</option>
          <option value="interaccion">Interacción</option>
        </select>
        <textarea name="text" rows="3" maxlength="2000" required aria-label="Sugerencia"></textarea>
        <button type="submit">Enviar</button>
      </form>
    </section>

    <section aria-labelledby="actividad">
      <h2 id="actividad">Actividad</h2>
      <form method="POST" action="?/perfil" use:enhance={() => ({ update }) => update({ reset: false })}>
        <input type="hidden" name="key" value="shareActivity" />
        <input type="hidden" name="value" value={String(!o.perfil.shareActivity)} />
        <label class="toggle">
          <input type="checkbox" checked={o.perfil.shareActivity} onchange={(e) => e.currentTarget.form?.requestSubmit()} data-testid="share-activity" />
          <span>{CONSENT_ACTIVITY}</span>
        </label>
      </form>
      {#if o.testimoniosEnReporte === true}
        <form method="POST" action="?/perfil" use:enhance={() => ({ update }) => update({ reset: false })}>
          <input type="hidden" name="key" value="shareTestimonios" />
          <input type="hidden" name="value" value={String(!o.perfil.shareTestimonios)} />
          <label class="toggle">
            <input type="checkbox" checked={o.perfil.shareTestimonios === true} onchange={(e) => e.currentTarget.form?.requestSubmit()} data-testid="share-testimonios" />
            <span>{CONSENT_ACTIVITY_WITH_TESTIMONIOS}</span>
          </label>
        </form>
      {/if}
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
    margin: 1.75rem 0 0.6rem;
    font-size: 1.05rem;
  }
  .muted {
    color: var(--edc-color-ink-soft);
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
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
  }
  .chip {
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 999px;
  }
  .list {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
  }
  .questions {
    list-style: decimal;
    padding-left: 1.4rem;
  }
  .questions li {
    padding: 0.3rem 0;
  }
  .row {
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--edc-color-line);
  }
  .toggle {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-top: 0.6rem;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .suggest {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 36rem;
  }
  a {
    color: var(--edc-color-brand);
  }
  select,
  textarea,
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
    align-self: flex-start;
  }
  .primary {
    font-weight: 700;
  }
</style>
