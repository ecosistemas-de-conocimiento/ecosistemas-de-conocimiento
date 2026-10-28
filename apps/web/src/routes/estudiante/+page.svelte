<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/estudiante` — minimal copy (owner rule); every rule is in the backend.
   *
   * Shape: "Mis temas" stays on top (what the rest is about, plus the one
   * action that uses it); everything else sits behind tabs so a phone shows
   * one list at a time. Panels are rendered and `hidden`, never left out, so
   * `aria-controls` always points at something.
   */
  import { enhance } from '$app/forms';
  import ConsentSwitch from '$lib/components/estudiante/ConsentSwitch.svelte';
  import { CONSENT_ACTIVITY, CONSENT_ACTIVITY_WITH_TESTIMONIOS, TESTIMONIO_CONSENT_VERSION } from '$lib/consent';
  import {
    companeroHref,
    docsLabel,
    ESTUDIANTE_TABS,
    initials,
    PEERS_CONSENT,
    tabAfterKey,
    topicHref,
    trabajosLabel,
    type EstudianteTab,
  } from '$lib/estudiante';
  import { Button } from '$lib/primitives';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const o = $derived(data.overview);
  const message = $derived(form && 'message' in form ? (form.message as string) : null);
  const preguntas = $derived(form && 'preguntas' in form ? (form.preguntas as string[]) : []);
  const suggested = $derived(Boolean(form && 'suggested' in form));
  let generating = $state(false);

  let tab = $state<EstudianteTab>('autores');
  const counts = $derived<Partial<Record<EstudianteTab, number>>>(
    o ? { autores: o.autores.length + o.autoresParaLeer.length, companeros: o.companeros.length } : {},
  );

  function onTabKey(e: KeyboardEvent) {
    const next = tabAfterKey(tab, e.key);
    if (!next) return;
    e.preventDefault();
    tab = next;
    document.getElementById(`tab-${next}`)?.focus();
  }

  const KINDS = [
    { value: 'contenido', label: 'Contenido' },
    { value: 'arquitectura', label: 'Arquitectura' },
    { value: 'interaccion', label: 'Interacción' },
  ] as const;
</script>

<svelte:head><title>Mi investigación · Ecosistemas de Conocimiento</title></svelte:head>

{#snippet authorList(list: NonNullable<typeof o>['autores'], testid: string, withDocs: boolean)}
  {#if list.length}
    <ul class="rows" data-testid={testid}>
      {#each list as a (a.name)}
        <li>
          {#if a.page}
            <a class="row row-link" href={`/biblioteca/${a.page.id}`}>
              <span class="row-main">
                <span class="row-title">{a.name}</span>
                {#if withDocs}<span class="row-meta">{docsLabel(a.docs)}</span>{/if}
              </span>
              <span class="chevron" aria-hidden="true">→</span>
            </a>
          {:else}
            <span class="row">
              <span class="row-main">
                <span class="row-title">{a.name}</span>
                {#if withDocs}<span class="row-meta">{docsLabel(a.docs)}</span>{/if}
              </span>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">Ninguno todavía.</p>
  {/if}
{/snippet}

<div class="page text-ink">
  <header class="head">
    {#if data.ecosystemName}<p class="kicker">{data.ecosystemName}</p>{/if}
    <h1>Mi investigación</h1>
  </header>

  {#if message}
    <p class="notice error" role="alert" data-testid="estudiante-error">{message}</p>
  {/if}

  {#if !o}
    <p class="notice">No disponible. Intenta de nuevo.</p>
  {:else}
    <section class="card temas" aria-labelledby="temas-h">
      <div class="card-head">
        <h2 id="temas-h">Mis temas</h2>
        {#if o.documentos.length}
          <a class="meta-link" href="/documentos">{trabajosLabel(o.documentos.length)} <span aria-hidden="true">→</span></a>
        {/if}
      </div>

      {#if o.temas.length}
        <ul class="chips" data-testid="mis-temas">
          {#each o.temas as t (t.id)}
            <li><a class="chip chip-mine chip-link" href={topicHref(data.organization, t.id)} data-testid="tema-link">{t.label}</a></li>
          {/each}
        </ul>
      {:else if o.documentos.length}
        <!-- A note or upload not processed yet (`lib/studentNotes.ts` in the backend). -->
        <p class="empty" data-testid="temas-pendientes">Sin temas todavía.</p>
      {:else}
        <a class="cta" href="/documentos" data-testid="temas-vacio">
          <span class="cta-icon" aria-hidden="true">+</span>
          <span>Sube un trabajo.</span>
        </a>
      {/if}

      <div class="preguntas">
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
          <Button
            type="submit"
            variant={preguntas.length ? 'outline' : 'solid'}
            disabled={generating}
            dataTestId="preguntas-generar"
            label={generating ? 'Generando…' : preguntas.length ? 'Generar otras preguntas' : 'Generar preguntas para investigar'}
          />
        </form>
        {#if preguntas.length}
          <ol class="questions" data-testid="preguntas" aria-label="Preguntas para investigar">
            {#each preguntas as q, i (q)}
              <li><span class="q-no" aria-hidden="true">{i + 1}</span><span>{q}</span></li>
            {/each}
          </ol>
        {/if}
      </div>
    </section>

    <div class="tabs" role="tablist" aria-label="Mi investigación">
      {#each ESTUDIANTE_TABS as t (t.id)}
        {@const selected = tab === t.id}
        <button
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          class="tab"
          aria-selected={selected}
          aria-controls={`panel-${t.id}`}
          tabindex={selected ? 0 : -1}
          onclick={() => (tab = t.id)}
          onkeydown={onTabKey}
          data-testid={`tab-${t.id}`}
        >
          {t.label}
          {#if counts[t.id]}<span class="count">{counts[t.id]}</span>{/if}
        </button>
      {/each}
    </div>

    <div class="panel" role="tabpanel" id="panel-autores" aria-labelledby="tab-autores" tabindex="0" hidden={tab !== 'autores'}>
      <div class="columns">
        <section aria-labelledby="autores">
          <h3 id="autores">Mis autores</h3>
          {@render authorList(o.autores, 'mis-autores', false)}
        </section>
        <section aria-labelledby="leer">
          <h3 id="leer">Para leer</h3>
          {@render authorList(o.autoresParaLeer, 'autores-leer', true)}
        </section>
      </div>
    </div>

    <div class="panel" role="tabpanel" id="panel-companeros" aria-labelledby="tab-companeros" tabindex="0" hidden={tab !== 'companeros'}>
      <ConsentSwitch
        key="shareWithPeers"
        checked={o.perfil.shareWithPeers}
        label={PEERS_CONSENT}
        testid="share-peers"
      />
      {#if o.companeros.length}
        <ul class="peers" data-testid="companeros">
          {#each o.companeros as c (c.id)}
            <li class="peer">
              <span class="avatar" aria-hidden="true">{initials(c.name)}</span>
              <div class="peer-main">
                <a class="peer-name peer-link" href={companeroHref(c.id)} data-testid="companero-link">
                  {c.name} <span class="chevron" aria-hidden="true">→</span>
                </a>
                <ul class="chips chips-sm" aria-label="Temas en común">
                  {#each c.topics as t (t.id)}
                    <li><a class="chip chip-mine chip-link" href={topicHref(data.organization, t.id)} data-testid="companero-tema-link">{t.label}</a></li>
                  {/each}
                </ul>
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">Nadie todavía.</p>
      {/if}
    </div>

    <div class="panel" role="tabpanel" id="panel-privacidad" aria-labelledby="tab-privacidad" tabindex="0" hidden={tab !== 'privacidad'}>
      <div class="stack">
        <ConsentSwitch key="shareActivity" checked={o.perfil.shareActivity} label={CONSENT_ACTIVITY} testid="share-activity" />
        {#if o.testimoniosEnReporte === true}
          <ConsentSwitch
            key="shareTestimonios"
            checked={o.perfil.shareTestimonios === true}
            label={CONSENT_ACTIVITY_WITH_TESTIMONIOS}
            testid="share-testimonios"
            consentVersion={TESTIMONIO_CONSENT_VERSION}
          />
        {/if}
      </div>
    </div>

    <div class="panel" role="tabpanel" id="panel-sugerir" aria-labelledby="tab-sugerir" tabindex="0" hidden={tab !== 'sugerir'}>
      <form method="POST" action="?/sugerir" use:enhance class="suggest" data-testid="sugerir">
        <fieldset class="kinds">
          <legend class="sr-only">Tipo</legend>
          {#each KINDS as k, i (k.value)}
            <label class="kind">
              <input type="radio" name="kind" value={k.value} checked={i === 0} required />
              <span>{k.label}</span>
            </label>
          {/each}
        </fieldset>
        <textarea name="text" rows="4" maxlength="2000" required aria-label="Sugerencia" placeholder="Tu sugerencia…"></textarea>
        <div class="suggest-foot">
          <Button type="submit" label="Enviar" />
          {#if suggested}<p class="done" role="status">Gracias.</p>{/if}
        </div>
      </form>
    </div>
  {/if}
</div>

<style>
  .page {
    /* A flex item of the root layout's scrolling `.app-main`: without this a
       long unbroken name widens the page past a phone screen (see /biblioteca). */
    min-width: 0;
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-4) var(--edc-space-12);
    display: grid;
    gap: var(--edc-space-5);
    align-content: start;
  }
  @media (min-width: 40rem) {
    .page {
      padding-inline: var(--edc-space-6);
    }
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
    color: var(--edc-color-ink);
  }
  h2 {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: var(--edc-text-lg);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  h3 {
    margin: 0 0 var(--edc-space-2);
    font-size: var(--edc-text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }

  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-body);
  }
  .notice.error {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-danger);
  }
  .empty {
    margin: 0;
    padding: var(--edc-space-3) 0;
    font-size: var(--edc-text-md);
    color: var(--edc-color-ink-soft);
  }

  /* ── Mis temas ─────────────────────────────────────────────── */
  .card {
    display: grid;
    gap: var(--edc-space-4);
    padding: var(--edc-space-5);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  .card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--edc-space-2) var(--edc-space-4);
  }
  .meta-link {
    font-size: var(--edc-text-sm);
    font-weight: 600;
    color: var(--edc-color-brand);
    text-decoration: none;
  }
  .meta-link:hover {
    text-decoration: underline;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    padding: 0.3rem 0.75rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    font-size: var(--edc-text-md);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .chip-mine {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  .chip-link {
    display: inline-block;
    text-decoration: none;
  }
  .chip-link:hover {
    border-color: var(--edc-color-brand);
    text-decoration: underline;
  }
  .chip-link:focus-visible,
  .peer-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .chips-sm {
    gap: var(--edc-space-1);
  }
  .chips-sm .chip {
    padding: 0.1rem 0.55rem;
    font-size: var(--edc-text-xs);
  }

  .cta {
    display: flex;
    align-items: center;
    gap: var(--edc-space-3);
    padding: var(--edc-space-4);
    border: 1px dashed var(--edc-color-brand-outline);
    border-radius: var(--edc-radius-2);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
    text-decoration: none;
  }
  .cta:hover {
    background: var(--edc-color-brand-soft);
  }
  .cta-icon {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--edc-gradient-brand);
    color: var(--edc-color-on-brand);
    font-size: 1.1rem;
    line-height: 1;
  }

  .preguntas {
    display: grid;
    gap: var(--edc-space-3);
    padding-top: var(--edc-space-4);
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .preguntas form {
    display: flex;
  }
  .questions {
    display: grid;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .questions li {
    display: grid;
    grid-template-columns: 1.6rem minmax(0, 1fr);
    gap: var(--edc-space-3);
    align-items: start;
    padding: var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-ink);
    font-size: var(--edc-text-md);
    line-height: var(--edc-leading-snug);
  }
  .q-no {
    display: grid;
    place-items: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    background: var(--edc-gradient-brand);
    color: var(--edc-color-on-brand);
    font-size: var(--edc-text-xs);
    font-weight: 700;
  }

  /* ── Tabs ──────────────────────────────────────────────────── */
  .tabs {
    display: flex;
    margin-top: var(--edc-space-2);
    border-bottom: 1px solid var(--edc-color-elevated-border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    flex: 1 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    min-height: 2.75rem;
    padding: 0 var(--edc-space-1);
    border: 0;
    /* The current tab: the same 3px bar as the main menu, plus weight and
       aria-selected — never colour alone. */
    border-bottom: 3px solid transparent;
    background: transparent;
    color: var(--edc-color-ink-soft);
    font-size: var(--edc-text-sm);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--edc-color-ink);
  }
  .tab[aria-selected='true'] {
    border-bottom-color: var(--edc-color-brand);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }
  .tab:focus-visible,
  .panel:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
    border-radius: var(--edc-radius-1);
  }
  .count {
    min-width: 1.25rem;
    padding: 0 0.3rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink-soft);
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1.25rem;
    text-align: center;
  }
  .tab[aria-selected='true'] .count {
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  @media (min-width: 40rem) {
    .tabs {
      gap: var(--edc-space-4);
    }
    .tab {
      flex: 0 0 auto;
      font-size: var(--edc-text-md);
    }
  }

  .panel {
    display: grid;
    gap: var(--edc-space-4);
    align-content: start;
  }
  .panel[hidden] {
    display: none;
  }
  .stack {
    display: grid;
    gap: var(--edc-space-3);
  }

  /* ── Autores ───────────────────────────────────────────────── */
  .columns {
    display: grid;
    gap: var(--edc-space-6);
  }
  @media (min-width: 48rem) {
    .columns {
      grid-template-columns: 1fr 1fr;
    }
  }
  .rows {
    display: grid;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--edc-space-3);
    padding: var(--edc-space-3) var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-strong);
    color: var(--edc-color-ink);
    text-decoration: none;
  }
  .row-link {
    box-shadow: var(--edc-shadow-1);
  }
  .row-link:hover {
    border-color: var(--edc-color-brand-outline);
  }
  .row-link:hover .chevron {
    color: var(--edc-color-brand);
  }
  .row-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .row-main {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }
  .row-title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .row-link .row-title {
    color: var(--edc-color-brand-strong);
  }
  .row-meta {
    font-size: var(--edc-text-xs);
    color: var(--edc-color-ink-soft);
  }
  .chevron {
    flex: none;
    color: var(--edc-color-ink-soft);
  }

  /* ── Compañeros ────────────────────────────────────────────── */
  .peers {
    display: grid;
    gap: var(--edc-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  @media (min-width: 48rem) {
    .peers {
      grid-template-columns: 1fr 1fr;
    }
  }
  .peer {
    display: flex;
    gap: var(--edc-space-3);
    align-items: flex-start;
    padding: var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  .avatar {
    flex: none;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-brand-strong);
    font-size: var(--edc-text-sm);
    font-weight: 800;
    letter-spacing: 0.02em;
  }
  .peer-main {
    display: grid;
    gap: var(--edc-space-2);
    min-width: 0;
  }
  .peer-name {
    margin: 0;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .peer-link {
    color: var(--edc-color-brand-strong);
    text-decoration: none;
    border-radius: var(--edc-radius-1);
  }
  .peer-link:hover {
    text-decoration: underline;
  }

  /* ── Sugerir ───────────────────────────────────────────────── */
  .suggest {
    display: grid;
    gap: var(--edc-space-3);
    max-width: 40rem;
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }
  .kind {
    position: relative;
    cursor: pointer;
  }
  .kind input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }
  .kind span {
    display: inline-flex;
    align-items: center;
    min-height: 2.25rem;
    padding: 0 var(--edc-space-3);
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: var(--edc-text-sm);
    font-weight: 600;
  }
  .kind input:checked + span {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }
  .kind input:checked + span::before {
    content: '✓';
    margin-right: 0.35rem;
  }
  .kind input:focus-visible + span {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  textarea {
    width: 100%;
    padding: var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font: inherit;
    font-size: var(--edc-text-md);
    resize: vertical;
  }
  textarea:focus {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .suggest-foot {
    display: flex;
    align-items: center;
    gap: var(--edc-space-3);
  }
  .done {
    margin: 0;
    font-size: var(--edc-text-sm);
    font-weight: 700;
    color: var(--edc-color-success);
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
