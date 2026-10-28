<svelte:options runes={true} />

<script lang="ts">
  /** `/seguimiento` — minimal copy (owner rule); every rule is in the backend. */
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const r = $derived(data.reporte);
  const KIND: Record<string, string> = { contenido: 'Contenido', arquitectura: 'Arquitectura', interaccion: 'Interacción' };
  const STATE: Record<'held' | 'rejected' | 'pending', string> = {
    held: 'En revisión de anonimización',
    rejected: 'No aprobado',
    pending: 'Anonimización en curso',
  };
  const date = (s: string) => (s ? new Date(s).toLocaleDateString('es-MX') : '');
</script>

<svelte:head><title>Estudiantes · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <p class="kicker">Estudiantes</p>
    <h1>Seguimiento</h1>
  </header>

  {#if data.estudiantes}
    <section aria-labelledby="reporte">
      <h2 id="reporte">Reporte de actividad</h2>
      {#if data.estudiantes.length}
        <nav class="chips" aria-label="Estudiantes" data-testid="estudiantes">
          {#each data.estudiantes as s (s.id)}
            <a class="chip" class:current={String(s.id) === data.chosen} href={`/seguimiento?estudiante=${s.id}`}>{s.name}</a>
          {/each}
        </nav>
      {:else}
        <p class="muted">Nadie comparte su actividad todavía.</p>
      {/if}

      {#if r}
        <article class="report" data-testid="reporte">
          <h3>{r.student.name}</h3>
          <p class="summary">
            {r.summary.documents} documentos · {r.summary.published} publicados · {r.summary.topics} temas ·
            {r.summary.conversations} conversaciones
          </p>

          <h4>Temas</h4>
          <p>{r.topics.join(', ') || '—'}</p>

          <h4>Vacíos</h4>
          <p>{r.gaps.join(', ') || '—'}</p>

          <h4>Lecturas sugeridas</h4>
          {#if r.readings.length}
            <ul class="list">
              {#each r.readings as d (d.id)}<li class="row"><a href={`/biblioteca/${d.id}`}>{d.name}</a></li>{/each}
            </ul>
          {:else}<p>—</p>{/if}

          <h4>Trabajos</h4>
          <ul class="list">
            {#each r.uploads as u (u.id)}
              <li class="row">{u.name ?? 'Borrador sin título'} <span class="muted">· {date(u.createdAt)} · {u.status === 'published' ? 'publicado' : 'borrador'}</span></li>
            {/each}
          </ul>

          {#if r.testimonios}
            <h4>Testimonios</h4>
            {#if r.testimonios.length}
              <ul class="list" data-testid="testimonios">
                {#each r.testimonios as t (t.id)}
                  <li class="row">
                    {#if t.state === 'visible'}
                      <strong>{t.title}</strong> <span class="muted">· {date(t.createdAt)}</span>
                      <p class="redacted">{t.text}</p>
                    {:else}
                      <span class="muted">{STATE[t.state]} · {date(t.createdAt)}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}<p>Sin testimonios.</p>{/if}
          {/if}
        </article>
      {:else if data.chosen}
        <p class="muted">Sin reporte.</p>
      {/if}
    </section>
  {/if}

  <section aria-labelledby="sugerencias">
    <h2 id="sugerencias">Sugerencias</h2>
    {#if data.sugerencias.length}
      <ul class="list" data-testid="sugerencias">
        {#each data.sugerencias as s (s.id)}
          <li class="row">
            <span class="tag">{KIND[s.kind] ?? s.kind}</span>
            {s.text}
            <span class="muted">· {s.author} · {date(s.createdAt)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">Ninguna todavía.</p>
    {/if}
  </section>
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
  h3 {
    margin: 1rem 0 0.2rem;
    font-size: 1.1rem;
  }
  h4 {
    margin: 0.9rem 0 0.2rem;
    font-size: 0.85rem;
    color: var(--edc-color-ink-soft);
  }
  p {
    margin: 0.2rem 0;
  }
  .muted {
    color: var(--edc-color-ink-soft);
  }
  .summary {
    font-size: 0.9rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
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
    border-color: var(--edc-color-brand);
  }
  .report {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
  }
  .list {
    list-style: none;
    margin: 0.3rem 0;
    padding: 0;
  }
  .row {
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--edc-color-line);
  }
  .tag {
    font-size: 0.75rem;
    font-weight: 700;
    margin-right: 0.4rem;
  }
  .redacted {
    white-space: pre-wrap;
    max-height: 12rem;
    overflow: auto;
  }
  a {
    color: var(--edc-color-brand);
  }
</style>
