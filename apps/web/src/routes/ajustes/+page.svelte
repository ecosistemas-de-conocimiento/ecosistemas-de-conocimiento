<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/ajustes` — one ecosistema's switches and answer style, in tabs; the
   * platform switch under them. Every rule is in the backend; no explainer
   * copy (owner rule).
   *
   * 🔴 THE SWITCH TABS ARE ONE FORM (`ajustes-funciones`). The action writes
   * every key it is not told is locked, so every switch must post with every
   * save: a tab that is not showing is `hidden`, never unrendered. See
   * `secciones.ts`. The answer style is its own form and endpoint.
   */
  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import { beforeNavigate } from '$app/navigation';
  import { ANSWER_STYLE_KINDS, ANSWER_STYLE_LABELS, ANSWER_STYLE_MAX_LENGTH, type AnswerStyles } from '$lib/answerStyle';
  import { FEATURE_DEFAULTS, type FeatureKey, type Features } from '$lib/features';
  import Icon from './Icon.svelte';
  import SaveBar from './SaveBar.svelte';
  import SwitchRow from './SwitchRow.svelte';
  import { SECCIONES, seccionDirty, seccionLocked, type SeccionId } from './secciones';
  import { guardLeave } from './unsaved';
  import type { ActionData, PageData } from './$types';

  type Scope = 'funciones' | 'estilo' | 'plataforma';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let hydrated = $state(false);
  onMount(() => (hydrated = true));

  let active = $state<SeccionId>('conversacion');
  let pending = $state<Scope | null>(null);

  const scope = $derived<Scope | null>(form?.scope ?? null);
  const failureFor = (s: Scope) =>
    pending !== s && scope === s && form && 'message' in form ? (form.message ?? null) : null;
  const savedFor = (s: Scope) => scope === s && Boolean(form && 'saved' in form && form.saved);

  const locked = $derived(data.lockedFeatures as FeatureKey[]);
  const stored = $derived<Features>(data.selected?.features ?? { ...FEATURE_DEFAULTS });
  // Writable deriveds: the stored value until edited; reset by every reload
  // (a save, or another ecosistema).
  let features = $derived<Features>({ ...stored });
  const storedStyles = $derived<AnswerStyles>(
    data.selected?.answerStyles ?? { generales: null, resonancias: null, interviewer: null },
  );
  let styles = $derived<AnswerStyles>({ ...storedStyles });

  const dirtyTabs = $derived(new Set(SECCIONES.filter((s) => seccionDirty(s, features, stored, locked)).map((s) => s.id)));
  const featuresDirty = $derived(dirtyTabs.size > 0);
  const stylesDirty = $derived(ANSWER_STYLE_KINDS.some((k) => (styles[k] ?? '') !== (storedStyles[k] ?? '')));
  const tabDirty = (id: SeccionId) => (id === 'estilo' ? stylesDirty : dirtyTabs.has(id));
  const tabLocked = (id: SeccionId) =>
    id === 'estilo' ? !data.answerStylesEditable : seccionLocked(SECCIONES.find((s) => s.id === id)!, locked);

  const fallbackChoice = $derived(data.plataforma?.detectorFallback ?? 'env');
  let fallback = $derived<string>(fallbackChoice);

  // A save reloads the stored values, so nothing is dirty after it.
  const anyDirty = $derived(featuresDirty || stylesDirty || fallback !== fallbackChoice);
  beforeNavigate((nav) => guardLeave(anyDirty, nav, (m) => window.confirm(m)));

  const submit = (s: Scope) => () => {
    pending = s;
    return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false });
      pending = null;
    };
  };

  // Roving tabindex, arrows in both directions: the strip is a row on a phone
  // and a column on a desktop.
  const tabEls: Record<string, HTMLButtonElement> = {};
  function onTabKey(e: KeyboardEvent) {
    const i = SECCIONES.findIndex((s) => s.id === active);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = step !== undefined ? (i + step + SECCIONES.length) % SECCIONES.length : null;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = SECCIONES.length - 1;
    if (next === null) return;
    e.preventDefault();
    select(SECCIONES[next]!.id);
    tabEls[active]?.focus();
  }
  function select(id: SeccionId) {
    active = id;
    tabEls[id]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
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

  {#if data.state === 'unavailable' || !data.selected}
    <p class="notice">No pudimos cargar los ajustes. Intenta de nuevo.</p>
  {:else}
    <div class="settings">
      <div class="tabs" role="tablist" aria-label="Secciones">
        {#each SECCIONES as s (s.id)}
          <button
            bind:this={tabEls[s.id]}
            type="button"
            role="tab"
            class="tab"
            id={`tab-${s.id}`}
            aria-selected={active === s.id}
            aria-controls={`panel-${s.id}`}
            tabindex={active === s.id ? 0 : -1}
            data-testid={`ajustes-tab-${s.id}`}
            onclick={() => select(s.id)}
            onkeydown={onTabKey}
          >
            <Icon name={s.id} size={18} />
            <span class="tab-label">{s.label}</span>
            {#if tabDirty(s.id)}
              <span class="tab-dot" aria-hidden="true"></span><span class="sr-only">, cambios sin guardar</span>
            {:else if tabLocked(s.id)}
              <span class="tab-lock"><Icon name="lock" size={13} /></span><span class="sr-only">, solo lectura</span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="card">
        {#key data.selected.id}
          <form
            method="POST"
            action="?/funciones"
            use:enhance={submit('funciones')}
            data-testid="ajustes-funciones"
            hidden={active === 'estilo'}
          >
            <input type="hidden" name="organization" value={data.selected.id} />
            {#each SECCIONES.filter((s) => s.switches.length > 0) as s (s.id)}
              <div
                class="panel"
                role="tabpanel"
                id={`panel-${s.id}`}
                aria-labelledby={`tab-${s.id}`}
                hidden={active !== s.id}
              >
                {#each s.switches as g (g.key)}
                  <SwitchRow
                    key={g.key}
                    checked={features[g.key]}
                    locked={locked.includes(g.key)}
                    onchange={(v) => (features = { ...features, [g.key]: v })}
                  />
                  {#each g.children as c (c)}
                    <SwitchRow
                      key={c}
                      child
                      hidden={!features[g.key]}
                      checked={features[c]}
                      locked={locked.includes(c)}
                      onchange={(v) => (features = { ...features, [c]: v })}
                    />
                  {/each}
                {/each}
              </div>
            {/each}
            <SaveBar
              dirty={featuresDirty}
              pending={pending === 'funciones'}
              saved={savedFor('funciones')}
              error={failureFor('funciones')}
              {hydrated}
              sticky
            />
          </form>

          <div
            class="panel"
            role="tabpanel"
            id="panel-estilo"
            aria-labelledby="tab-estilo"
            hidden={active !== 'estilo'}
          >
            <form method="POST" action="?/estilo" use:enhance={submit('estilo')} data-testid="ajustes-estilo">
              <input type="hidden" name="organization" value={data.selected.id} />
              {#if !data.answerStylesEditable}
                <p class="readonly-note"><Icon name="lock" size={14} />Solo administración de la plataforma</p>
              {/if}
              <div class="styles">
                {#each ANSWER_STYLE_KINDS as kind (kind)}
                  {@const text = styles[kind] ?? ''}
                  <div class="field">
                    <div class="field-head">
                      <label for={`style-${kind}`}>{ANSWER_STYLE_LABELS[kind]}</label>
                      {#if data.answerStylesEditable}
                        <span class="count" class:near={text.length > ANSWER_STYLE_MAX_LENGTH * 0.9} aria-hidden="true">
                          {text.length}/{ANSWER_STYLE_MAX_LENGTH}
                        </span>
                      {/if}
                    </div>
                    <textarea
                      id={`style-${kind}`}
                      name={`style-${kind}`}
                      rows="4"
                      maxlength={ANSWER_STYLE_MAX_LENGTH}
                      readonly={!data.answerStylesEditable}
                      placeholder="Estilo base"
                      data-testid={`ajustes-estilo-${kind}`}
                      value={text}
                      oninput={(e) => (styles = { ...styles, [kind]: e.currentTarget.value })}
                    ></textarea>
                  </div>
                {/each}
              </div>
              {#if data.answerStylesEditable}
                <SaveBar
                  dirty={stylesDirty}
                  pending={pending === 'estilo'}
                  saved={savedFor('estilo')}
                  error={failureFor('estilo')}
                  {hydrated}
                  sticky
                />
              {/if}
            </form>
          </div>
        {/key}
      </div>
    </div>
  {/if}

  {#if data.plataforma}
    <section class="card platform" aria-labelledby="plataforma">
      <form method="POST" action="?/plataforma" use:enhance={submit('plataforma')} data-testid="ajustes-plataforma">
        <div class="platform-head">
          <Icon name="plataforma" size={18} />
          <h2 id="plataforma">Plataforma</h2>
          <span class="scope-tag">Todos los ecosistemas</span>
        </div>
        <div class="platform-row">
          <label for="detectorFallback">Respaldo del detector</label>
          <select id="detectorFallback" name="detectorFallback" bind:value={fallback}>
            <option value="env">
              Según el entorno ({data.plataforma.detectorFallbackEnv === 'none'
                ? 'ninguno'
                : data.plataforma.detectorFallbackEnv === 'hosted'
                  ? 'modelo alojado'
                  : 'no válido'})
            </option>
            <option value="hosted">Modelo alojado</option>
            <option value="none">Ninguno</option>
          </select>
        </div>
        <SaveBar
          dirty={fallback !== fallbackChoice}
          pending={pending === 'plataforma'}
          saved={savedFor('plataforma')}
          error={failureFor('plataforma')}
          {hydrated}
        />
      </form>
    </section>
  {/if}
</div>

<style>
  .page {
    min-width: 0;
    width: min(60rem, 100%);
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
    color: var(--edc-color-ink);
    overflow-wrap: anywhere;
  }
  .notice {
    margin: 0;
    padding: 0.8rem 1rem;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-body);
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
  .chip:hover {
    color: var(--edc-color-ink);
  }
  .chip.current {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  .chip:focus-visible,
  .tab:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
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
    /* Room for the focus ring, which a scrolling box would clip. */
    padding: 3px;
    margin: -3px;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  /* Phone: the strip scrolls sideways; the fade says there is more. */
  @media (max-width: 47.99rem) {
    .tabs {
      scroll-padding-inline: 2.5rem;
      padding-inline-end: 2.5rem;
      mask-image: linear-gradient(to right, #000 calc(100% - 2.5rem), transparent);
    }
  }
  .tab {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0.5rem 0.85rem;
    border: 1px solid transparent;
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: var(--edc-color-ink-soft);
    font: inherit;
    font-size: var(--edc-text-md);
    font-weight: var(--edc-weight-semibold);
    white-space: nowrap;
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
  .tab-label {
    flex: 1;
    text-align: left;
  }
  .tab-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--edc-color-brand);
  }
  .tab-lock {
    color: var(--edc-color-ink-soft);
  }

  .card {
    min-width: 0;
    /* `clip`, not `hidden`: rounds the row hovers without becoming a scroll
       box, which would stop the save bar sticking to the screen. */
    overflow: clip;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  form[hidden],
  .panel[hidden] {
    display: none;
  }

  .readonly-note {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: var(--edc-space-3) var(--edc-space-4);
    border-bottom: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    border-radius: var(--edc-radius-3) var(--edc-radius-3) 0 0;
    font-size: var(--edc-text-sm);
    font-weight: var(--edc-weight-semibold);
    color: var(--edc-color-ink-soft);
  }
  .styles {
    display: grid;
    gap: var(--edc-space-5);
    padding: var(--edc-space-4);
  }
  .field {
    display: grid;
    gap: 0.4rem;
  }
  .field-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--edc-space-2);
  }
  .field label {
    font-size: var(--edc-text-base);
    font-weight: var(--edc-weight-semibold);
    color: var(--edc-color-ink);
  }
  .count {
    font-family: var(--edc-font-mono);
    font-size: var(--edc-text-xs);
    color: var(--edc-color-ink-soft);
  }
  .count.near {
    color: var(--edc-color-warning);
  }
  textarea,
  select {
    width: 100%;
    font: inherit;
    font-size: var(--edc-text-md);
    line-height: var(--edc-leading-normal);
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
  }
  textarea {
    resize: vertical;
    min-height: 6.5rem;
  }
  textarea::placeholder {
    color: var(--edc-color-ink-soft);
  }
  textarea[readonly] {
    border-color: var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-body);
    resize: none;
  }

  .platform-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: var(--edc-space-4) var(--edc-space-4) 0;
    color: var(--edc-color-ink-soft);
  }
  h2 {
    margin: 0;
    font-size: var(--edc-text-lg);
    font-weight: var(--edc-weight-bold);
    color: var(--edc-color-ink);
  }
  .scope-tag {
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-surface-soft);
    font-size: var(--edc-text-xs);
    font-weight: var(--edc-weight-semibold);
    color: var(--edc-color-ink-soft);
  }
  .platform-row {
    display: grid;
    gap: 0.4rem;
    padding: var(--edc-space-4);
  }
  .platform-row label {
    font-size: var(--edc-text-base);
    font-weight: var(--edc-weight-medium);
    color: var(--edc-color-ink);
  }
  select {
    min-height: 2.5rem;
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

  /* Desktop: the tabs become a column beside the card. */
  @media (min-width: 48rem) {
    .page {
      padding: var(--edc-space-8) var(--edc-space-6) var(--edc-space-12);
    }
    .settings {
      grid-template-columns: 13.5rem minmax(0, 1fr);
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
    .platform-row {
      grid-template-columns: minmax(0, 1fr) minmax(0, 18rem);
      align-items: center;
    }
    .platform {
      margin-left: calc(13.5rem + var(--edc-space-5));
    }
  }
</style>
