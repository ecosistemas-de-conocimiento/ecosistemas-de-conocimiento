<script lang="ts">
  import { Button } from '$lib/primitives';
  import { ChatMentionMenu } from '@edc/chat-engine/svelte';
  import { detectMention, type ContextSearchResult } from '@edc/chat-engine/core';
  import { CHAT_KIND_REGISTRY } from '$lib/engine/registry';
  import { searchContext } from '$lib/engine/client';
  import type { ContextRef } from '$lib/types';

  let {
    busy = false,
    sessionId,
    onsend,
    oncancel,
  }: {
    busy?: boolean;
    sessionId: string;
    /** Send the message text + the `@`-mention refs attached to it. */
    onsend: (text: string, refs: ContextRef[]) => void;
    oncancel?: () => void;
  } = $props();

  let text = $state('');
  let textarea: HTMLTextAreaElement | undefined = $state();

  // Refs the user has @-mentioned in the current draft. Keyed by `@label`; we
  // re-derive which survive at send time (a deleted token drops its ref).
  let pickedRefs = $state<ContextRef[]>([]);

  // ── @-mention menu state ───────────────────────────────────────────────────
  let menuOpen = $state(false);
  let menuResults = $state<ContextSearchResult[]>([]);
  let menuLoading = $state(false);
  let menuActive = $state(0);
  let mentionStart = $state(-1);
  let mentionEnd = $state(-1);
  let searchSeq = 0;

  async function refreshMention(): Promise<void> {
    if (!textarea) {
      menuOpen = false;
      return;
    }
    const caret = textarea.selectionStart ?? text.length;
    const m = detectMention(text, caret, CHAT_KIND_REGISTRY);
    if (!m) {
      menuOpen = false;
      mentionStart = -1;
      return;
    }
    mentionStart = m.start;
    mentionEnd = m.end;
    menuOpen = true;
    menuActive = 0;
    menuLoading = true;
    const seq = ++searchSeq;
    const results = await searchContext({
      q: m.term,
      kind: m.kind ?? undefined,
      sessionId,
    });
    if (seq !== searchSeq) return; // stale
    menuResults = results;
    menuLoading = false;
  }

  function pickResult(r: ContextSearchResult): void {
    if (mentionStart < 0) return;
    const before = text.slice(0, mentionStart);
    const after = text.slice(mentionEnd);
    const token = `@${r.label}`;
    const insertion = `${token} `;
    text = `${before}${insertion}${after}`;
    pickedRefs = [
      ...pickedRefs,
      { kind: r.kind, id: r.id, label: r.label, sublabel: r.sublabel, scopeId: r.scopeId },
    ];
    menuOpen = false;
    mentionStart = -1;
    // Restore caret just after the inserted token.
    const caret = before.length + insertion.length;
    queueMicrotask(() => {
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      }
    });
  }

  function send() {
    const value = text.trim();
    if (!value || busy) return;
    // Keep only refs whose `@label` still appears in the sent text.
    const surviving = pickedRefs.filter((r) => value.includes(`@${r.label}`));
    onsend(value, surviving);
    text = '';
    pickedRefs = [];
    menuOpen = false;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (menuOpen && menuResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        menuActive = (menuActive + 1) % menuResults.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        menuActive = (menuActive - 1 + menuResults.length) % menuResults.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const r = menuResults[menuActive];
        if (r) pickResult(r);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        menuOpen = false;
        mentionStart = -1;
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (busy) {
        oncancel?.();
      } else {
        send();
      }
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      oncancel?.();
    }
  }

  function onInput() {
    void refreshMention();
  }
</script>

<div class="border-t border-line bg-surface backdrop-blur p-3">
  <div class="flex gap-2 items-end max-w-3xl mx-auto relative">
    {#if menuOpen}
      <div class="mention-anchor" data-testid="mention-menu">
        <ChatMentionMenu
          results={menuResults}
          loading={menuLoading}
          activeIndex={menuActive}
          listId="composer-mentions"
          registry={CHAT_KIND_REGISTRY}
          labels={{ listLabel: 'Menciones', searching: 'Buscando…', noResults: 'Sin resultados' }}
          onselect={pickResult}
          onhover={(i) => (menuActive = i)}
        />
      </div>
    {/if}
    <textarea
      bind:this={textarea}
      rows={1}
      bind:value={text}
      onkeydown={onKeyDown}
      oninput={onInput}
      onkeyup={onInput}
      onclick={onInput}
      placeholder={busy
        ? 'Generando…  (Esc o Detener para cancelar)'
        : 'Escribe un mensaje…  (@ para mencionar · Enter envía, Shift+Enter salto de línea)'}
      class="composer-input"
      data-testid="composer-input"
      disabled={busy}
    ></textarea>
    {#if busy}
      <Button
        tone="danger"
        variant="solid"
        size="md"
        label="Detener"
        dataTestId="composer-stop"
        onClick={() => oncancel?.()}
      >
        {#snippet leading()}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        {/snippet}
      </Button>
    {:else}
      <Button
        tone="brand"
        variant="solid"
        size="md"
        label="Enviar"
        disabled={!text.trim()}
        dataTestId="composer-send"
        onClick={send}
      />
    {/if}
  </div>
</div>

<style>
  /* Anchor box for the engine's ChatMentionMenu, which positions itself
     absolutely at `bottom: 100%` of its offset parent. We give it a
     zero-height relative box spanning the composer width so the menu floats
     directly above the textarea. */
  .mention-anchor {
    position: absolute;
    left: 0;
    right: 3.5rem;
    bottom: 100%;
    height: 0;
    z-index: 30;
  }
  .composer-input {
    flex: 1;
    resize: none;
    min-height: 40px;
    max-height: 10rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface-glass-strong);
    color: var(--edc-color-ink);
    font-family: var(--edc-font-body);
    font-size: 0.875rem;
    outline: none;
    transition:
      border-color var(--edc-motion-fast) var(--edc-ease-standard),
      box-shadow var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .composer-input::placeholder {
    color: color-mix(in srgb, var(--edc-color-ink-soft) 82%, transparent);
  }
  .composer-input:focus {
    border-color: var(--edc-color-brand-outline);
    box-shadow: 0 0 0 4px var(--edc-focus-ring);
  }
  .composer-input:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
</style>
