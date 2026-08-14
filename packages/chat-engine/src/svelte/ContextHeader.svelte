<svelte:options runes={true} />

<script lang="ts">
  /**
   * Scope multiselect shell — domain-agnostic. EVERYTHING is injected; the
   * component never reaches into a store, a route, or an i18n bundle:
   *   - `scope`        the live scope (refs); `org`-only / empty = tenant-wide
   *   - `searchFn`     an async search (consumer debounces or not — we debounce
   *                    the calls here); returns `ContextSearchResult[]`
   *   - `onapply`      called with the chosen refs to persist
   *   - `registry`     kind labels/emoji
   *   - `labels`       all UI strings
   *
   * No routes, no store, no product-specific deep-links.
   */
  import type {
    ContextRef,
    ContextScope,
    ContextSearchResult,
    MentionRefLike,
    KindRegistry,
  } from "@edc/chat-engine/core";
  import {
    kindEmoji as resolveKindEmoji,
    kindLabel as resolveKindLabel,
  } from "@edc/chat-engine/core";

  interface HeaderLabels {
    edit: string;
    scopeTenantWide: string;
    scopeEmpty: string;
    pickerTitle: string;
    pickerTenantWide: string;
    pickerTenantWideHint: string;
    searchPlaceholder: string;
    searchLabel: string;
    searchResultsLabel: string;
    searching: string;
    noResults: string;
    selected: string;
    remove: string;
    cancel: string;
    apply: string;
    saving: string;
  }

  interface Props {
    scope: ContextScope;
    registry: KindRegistry;
    searchFn: (term: string) => Promise<ContextSearchResult[]>;
    onapply: (refs: ContextRef[]) => Promise<void> | void;
    labels: HeaderLabels;
    /** Hide the header entirely (e.g. no active thread). Default true. */
    visible?: boolean;
    /** Kind id treated as the tenant-wide sentinel. Default "org". */
    tenantKind?: string;
    /** Debounce for search calls (ms). Default 200. */
    debounceMs?: number;
    /**
     * Resolve a scope ref to its display label for the trigger chips. ADDITIVE
     * (≥0.3.0): fixes the `Kind #id` papercut for persisted scopes that have no
     * inline `ref.label`. Resolution order per chip:
     *   1. `ref.label` (if the persisted ref carries it)
     *   2. `resolveChipLabel(ref)` (if provided and returns a non-empty string)
     *   3. the legacy `"<Kind> #<id>"` fallback (backward compatible)
     * Pure/synchronous — the consumer typically reads from an in-memory map it
     * already has (e.g. its entity store) keyed by `${kind}:${id}`.
     */
    resolveChipLabel?: (ref: ContextRef) => string | null | undefined;
  }

  const {
    scope,
    registry,
    searchFn,
    onapply,
    labels,
    visible = true,
    tenantKind = "org",
    debounceMs = 200,
    resolveChipLabel,
  }: Props = $props();

  const RESULTS_ID = "chat-context-search-list";

  let open = $state(false);
  let saving = $state(false);

  let draftRefs = $state<MentionRefLike[]>([]);
  let tenantWide = $state(true);

  let query = $state("");
  let results = $state<ContextSearchResult[]>([]);
  let searching = $state(false);
  let activeIndex = $state(0);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;
  let searchInputRef: HTMLInputElement | undefined = $state();

  function isTenantWide(s: ContextScope): boolean {
    const refs = s.refs ?? [];
    return refs.length === 0 || refs.every((r) => r.kind === tenantKind);
  }

  function refToChip(ref: ContextRef): MentionRefLike {
    // Prefer the entity's real label: inline `ref.label` → injected resolver →
    // the legacy "<Kind> #<id>" fallback (so old persisted scopes still render).
    const resolved = resolveChipLabel?.(ref);
    const fallback =
      ref.id != null
        ? `${resolveKindLabel(registry, ref.kind)} #${ref.id}`
        : resolveKindLabel(registry, ref.kind);
    const label =
      (ref.label && ref.label.trim()) ||
      (resolved && resolved.trim()) ||
      fallback;
    return { kind: ref.kind, id: ref.id ?? ref.kind, label };
  }

  const isScopeTenantWide = $derived(isTenantWide(scope));
  const displayChips = $derived<MentionRefLike[]>(
    isScopeTenantWide
      ? []
      : (scope.refs ?? [])
          .filter((r) => r.kind !== tenantKind)
          .map(refToChip),
  );

  function openPicker(): void {
    tenantWide = isTenantWide(scope);
    draftRefs = tenantWide
      ? []
      : (scope.refs ?? [])
          .filter((r) => r.kind !== tenantKind)
          .map(refToChip);
    query = "";
    results = [];
    activeIndex = 0;
    open = true;
    queueMicrotask(() => searchInputRef?.focus());
  }

  function closePicker(): void {
    open = false;
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchSeq++;
  }

  function runSearch(term: string): void {
    const seq = ++searchSeq;
    searching = true;
    void Promise.resolve(searchFn(term))
      .then((rows) => {
        if (seq !== searchSeq) return;
        results = rows.filter(
          (r) =>
            !draftRefs.some(
              (d) => d.kind === r.kind && String(d.id) === String(r.id),
            ),
        );
        activeIndex = 0;
        searching = false;
      })
      .catch(() => {
        if (seq !== searchSeq) return;
        results = [];
        searching = false;
      });
  }

  function onQueryInput(): void {
    if (searchTimer) clearTimeout(searchTimer);
    const term = query.trim();
    if (!term) {
      searchSeq++;
      results = [];
      searching = false;
      return;
    }
    searchTimer = setTimeout(() => runSearch(term), debounceMs);
  }

  function pickTenantWide(): void {
    tenantWide = true;
    draftRefs = [];
    results = [];
    query = "";
  }

  function addResult(result: ContextSearchResult): void {
    if (
      !draftRefs.some(
        (d) => d.kind === result.kind && String(d.id) === String(result.id),
      )
    ) {
      draftRefs = [
        ...draftRefs,
        {
          kind: result.kind,
          id: result.id,
          label: result.label,
          ...(result.sublabel ? { sublabel: result.sublabel } : {}),
          ...(result.scopeId != null ? { scopeId: result.scopeId } : {}),
        },
      ];
    }
    tenantWide = false;
    results = results.filter(
      (r) => !(r.kind === result.kind && String(r.id) === String(result.id)),
    );
    query = "";
    activeIndex = 0;
    searchInputRef?.focus();
  }

  function removeDraft(chip: MentionRefLike): void {
    draftRefs = draftRefs.filter(
      (d) => !(d.kind === chip.kind && String(d.id) === String(chip.id)),
    );
    if (draftRefs.length === 0) tenantWide = true;
  }

  async function apply(): Promise<void> {
    // Persist the picked label alongside kind/id (ADDITIVE) so the trigger chip
    // shows the real entity name on reload without a resolver. A consumer that
    // wants the lean {kind,id} shape can strip `label` in its `onapply`.
    const refs: ContextRef[] =
      tenantWide || draftRefs.length === 0
        ? [{ kind: tenantKind }]
        : draftRefs.map((d) => ({
            kind: d.kind,
            id: d.id,
            ...(d.label && d.label.trim() ? { label: d.label } : {}),
          }));
    saving = true;
    try {
      await onapply(refs);
      closePicker();
    } catch {
      // Consumer surfaces the error; keep the picker open to retry.
    } finally {
      saving = false;
    }
  }

  function onSearchKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length > 0) activeIndex = (activeIndex + 1) % results.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length > 0) {
        activeIndex = (activeIndex - 1 + results.length) % results.length;
      }
      return;
    }
    if (e.key === "Enter") {
      const choice = results[activeIndex];
      if (choice) {
        e.preventDefault();
        addResult(choice);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
    }
  }

  const activeOptionId = $derived(
    results.length > 0 ? `${RESULTS_ID}-opt-${activeIndex}` : undefined,
  );
</script>

{#if visible}
  <div class="context-header" data-testid="chat-context-header">
    <button
      type="button"
      class="context-header-trigger"
      data-testid="chat-context-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={labels.edit}
      onclick={() => (open ? closePicker() : openPicker())}
    >
      <span class="context-header-scope" data-testid="chat-context-scope">
        {#if isScopeTenantWide}
          <span class="context-scope-chip is-org">
            <span aria-hidden="true">{resolveKindEmoji(registry, tenantKind)}</span>
            <span>{labels.scopeTenantWide}</span>
          </span>
        {:else if displayChips.length === 0}
          <span class="context-scope-muted">{labels.scopeEmpty}</span>
        {:else}
          {#each displayChips as chip (`${chip.kind}:${chip.id}`)}
            <span class="context-scope-chip">
              <span aria-hidden="true">{resolveKindEmoji(registry, chip.kind)}</span>
              <span class="context-scope-chip-label" title={chip.label}>
                {chip.label}
              </span>
            </span>
          {/each}
        {/if}
      </span>
      <span class="context-header-edit" aria-hidden="true">⌄</span>
    </button>

    {#if open}
      <div
        class="context-picker"
        role="dialog"
        aria-label={labels.pickerTitle}
        data-testid="chat-context-picker"
      >
        <p class="context-picker-title">{labels.pickerTitle}</p>

        <button
          type="button"
          class="context-org-option {tenantWide ? 'is-selected' : ''}"
          data-testid="chat-context-orgwide"
          aria-pressed={tenantWide}
          onclick={pickTenantWide}
        >
          <span class="context-org-emoji" aria-hidden="true">
            {resolveKindEmoji(registry, tenantKind)}
          </span>
          <span class="context-org-text">
            <span class="context-org-name">{labels.pickerTenantWide}</span>
            <span class="context-org-hint">{labels.pickerTenantWideHint}</span>
          </span>
          {#if tenantWide}<span class="context-org-check" aria-hidden="true">✓</span
            >{/if}
        </button>

        <div class="context-search">
          <input
            type="text"
            class="context-search-input"
            data-testid="chat-context-search"
            bind:this={searchInputRef}
            bind:value={query}
            oninput={onQueryInput}
            onkeydown={onSearchKeyDown}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.searchLabel}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={RESULTS_ID}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
          />
          {#if query.trim()}
            <ul
              id={RESULTS_ID}
              class="context-results"
              role="listbox"
              aria-label={labels.searchResultsLabel}
            >
              {#if searching && results.length === 0}
                <li class="context-results-status" aria-disabled="true">
                  {labels.searching}
                </li>
              {:else if results.length === 0}
                <li class="context-results-status" aria-disabled="true">
                  {labels.noResults}
                </li>
              {:else}
                {#each results as result, i (`${result.kind}:${result.id}`)}
                  <li
                    id={`${RESULTS_ID}-opt-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    class="context-result {i === activeIndex ? 'is-active' : ''}"
                    data-testid="chat-context-result"
                    onmousedown={(e) => {
                      e.preventDefault();
                      addResult(result);
                    }}
                    onmouseenter={() => (activeIndex = i)}
                  >
                    <span class="context-result-kind">
                      {resolveKindLabel(registry, result.kind)}
                    </span>
                    <span class="context-result-label">{result.label}</span>
                    {#if result.sublabel}
                      <span class="context-result-sublabel">
                        {result.sublabel}
                      </span>
                    {/if}
                  </li>
                {/each}
              {/if}
            </ul>
          {/if}
        </div>

        {#if !tenantWide && draftRefs.length > 0}
          <div class="context-selected">
            <p class="context-selected-label">{labels.selected}</p>
            <div class="context-selected-chips" role="list">
              {#each draftRefs as chip (`${chip.kind}:${chip.id}`)}
                <span
                  class="context-chip"
                  role="listitem"
                  data-testid="chat-context-selected-chip"
                >
                  <span class="context-chip-kind">
                    {resolveKindLabel(registry, chip.kind)}
                  </span>
                  <span class="context-chip-label" title={chip.label}>
                    {chip.label}
                  </span>
                  <button
                    type="button"
                    class="context-chip-remove"
                    aria-label={`${labels.remove}: ${chip.label}`}
                    onclick={() => removeDraft(chip)}
                  >
                    ×
                  </button>
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <div class="context-actions">
          <button
            type="button"
            class="context-btn is-ghost"
            data-testid="chat-context-cancel"
            onclick={closePicker}
            disabled={saving}
          >
            {labels.cancel}
          </button>
          <button
            type="button"
            class="context-btn is-primary"
            data-testid="chat-context-apply"
            onclick={apply}
            disabled={saving}
          >
            {saving ? labels.saving : labels.apply}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .context-header {
    position: relative;
  }

  .context-header-trigger {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.3rem 0.45rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 0.5rem;
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink);
    cursor: pointer;
    text-align: left;
    font-family: var(--edc-font-body);
  }
  .context-header-trigger:hover,
  .context-header-trigger:focus-visible {
    border-color: var(--edc-color-brand);
  }

  .context-header-scope {
    flex: 1 1 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    min-width: 0;
  }

  .context-header-edit {
    flex: 0 0 auto;
    color: var(--edc-color-ink-soft);
    font-size: 0.9rem;
  }

  .context-scope-chip,
  .context-scope-chip.is-org {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    max-width: 100%;
    padding: 0.15rem 0.45rem;
    border-radius: 999px;
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-ink);
    font-size: 0.76rem;
  }
  .context-scope-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .context-scope-muted {
    color: var(--edc-color-ink-soft);
    font-size: 0.78rem;
  }

  .context-picker {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    right: 0;
    z-index: 30;
    display: grid;
    gap: 0.6rem;
    padding: 0.7rem;
    background: var(--edc-color-surface);
    border: 1px solid var(--edc-color-line);
    border-radius: 0.6rem;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  }

  .context-picker-title {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--edc-color-ink-soft);
  }

  .context-org-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.55rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 0.5rem;
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink);
    cursor: pointer;
    text-align: left;
    font-family: var(--edc-font-body);
  }
  .context-org-option.is-selected {
    border-color: var(--edc-color-brand);
    background: color-mix(
      in srgb,
      var(--edc-color-brand) 10%,
      var(--edc-color-surface-soft)
    );
  }
  .context-org-emoji {
    flex: 0 0 auto;
    font-size: 1rem;
  }
  .context-org-text {
    flex: 1 1 auto;
    display: grid;
    min-width: 0;
  }
  .context-org-name {
    font-size: 0.84rem;
    font-weight: 600;
  }
  .context-org-hint {
    font-size: 0.74rem;
    color: var(--edc-color-ink-soft);
  }
  .context-org-check {
    flex: 0 0 auto;
    color: var(--edc-color-brand);
    font-weight: 700;
  }

  .context-search {
    position: relative;
    display: grid;
    gap: 0.3rem;
  }
  .context-search-input {
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 0.5rem;
    font-family: var(--edc-font-body);
    font-size: 0.84rem;
    color: var(--edc-color-ink);
    background: var(--edc-color-surface-soft);
  }
  .context-search-input:focus {
    outline: none;
    border-color: var(--edc-color-brand);
    box-shadow: 0 0 0 3px
      color-mix(in srgb, var(--edc-color-brand) 12%, transparent);
  }

  .context-results {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--edc-color-line);
    border-radius: 0.5rem;
    background: var(--edc-color-surface);
  }
  .context-results-status {
    padding: 0.45rem 0.55rem;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
  .context-result {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.35rem;
    cursor: pointer;
    font-size: 0.84rem;
    color: var(--edc-color-ink);
  }
  .context-result.is-active {
    background: color-mix(in srgb, var(--edc-color-brand) 12%, transparent);
  }
  .context-result-kind {
    flex: 0 0 auto;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--edc-color-brand);
  }
  .context-result-label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .context-result-sublabel {
    flex: 0 1 auto;
    font-size: 0.74rem;
    color: var(--edc-color-ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-selected {
    display: grid;
    gap: 0.3rem;
  }
  .context-selected-label {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--edc-color-ink-soft);
  }
  .context-selected-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .context-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 100%;
    padding: 0.2rem 0.2rem 0.2rem 0.5rem;
    border: 1px solid var(--edc-color-line);
    border-radius: 999px;
    background: var(--edc-color-surface-soft);
    font-size: 0.76rem;
    color: var(--edc-color-ink);
  }
  .context-chip-kind {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--edc-color-brand);
  }
  .context-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .context-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--edc-color-ink-soft);
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
  .context-chip-remove:hover {
    background: var(--edc-color-line);
    color: var(--edc-color-ink);
  }

  .context-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .context-btn {
    padding: 0.4rem 0.85rem;
    border-radius: 0.4rem;
    font-family: var(--edc-font-body);
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
  }
  .context-btn.is-ghost {
    border: 1px solid var(--edc-color-line);
    background: transparent;
    color: var(--edc-color-ink);
  }
  .context-btn.is-primary {
    border: 0;
    background: var(--edc-color-brand);
    color: white;
  }
  .context-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
