<svelte:options runes={true} />

<script lang="ts">
  /**
   * The chat's three panes, and the one place that decides how they collapse.
   *
   * 🔴 WIDE (>= 64rem): the three sit side by side, exactly as before — the
   * conversation list, the chat, the documents panel, each with its own
   * collapse control. Nothing about the desktop layout changed.
   *
   * 🔴 NARROW (< 64rem): the chat takes the whole width. The other two become
   * OVERLAY DRAWERS opened from two word-labelled buttons above the chat. The
   * reasoning, the rejected alternatives and every string live in `$lib/layout.ts`
   * so vitest can assert them — this file only draws them.
   *
   * ⚠ THE CHAT IS NEVER UNMOUNTED. A drawer covers it; it does not replace it.
   * That is the whole point: the scroll position and whatever is half-typed in
   * the composer survive a trip to the documents panel.
   *
   * ⚠ CSS DOES THE HIDING, NOT JAVASCRIPT. The media queries below are the
   * authority on which layout is on screen, so the first paint is right even
   * before hydration. `narrow` (from `matchMedia`) only drives what cannot be
   * expressed in CSS: which element is `inert`, and whether the panes should
   * render their desktop collapse rails.
   */
  import Sidebar from './Sidebar.svelte';
  import Chat from './Chat.svelte';
  import DocsPanel from './DocsPanel.svelte';
  import {
    CLOSE_PANEL_LABEL,
    MOBILE_PANEL_BAR_LABEL,
    MOBILE_PANEL_TOGGLES,
    NARROW_MEDIA_QUERY,
    isPanelOpen,
    toggleMobilePanel,
    type MobilePanel,
  } from '$lib/layout';

  let open = $state<MobilePanel>('none');

  /**
   * ⚠ Starts `false` so server-rendered HTML matches the desktop branch; the
   * effect corrects it on mount. Nothing VISIBLE depends on it — the media
   * queries already hid the drawers — so there is no flash, only a beat before
   * `inert` is applied.
   */
  let narrow = $state(false);

  $effect(() => {
    const mq = window.matchMedia(NARROW_MEDIA_QUERY);
    const sync = () => {
      narrow = mq.matches;
      // 🔴 Growing past the breakpoint must close the drawer. Otherwise the
      // desktop layout comes back with an invisible `open` state still set,
      // and the next narrow resize pops a drawer the reader never asked for.
      if (!mq.matches) open = 'none';
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  /** Where focus goes back to when a drawer closes. */
  let toggleButtons: Record<string, HTMLButtonElement | undefined> = $state({});
  let drawerEls: Record<string, HTMLElement | undefined> = $state({});

  function toggle(panel: MobilePanel) {
    const next = toggleMobilePanel(open, panel);
    open = next;
    if (next !== 'none') {
      // Move focus into the drawer, or a keyboard user is left tabbing the
      // chat behind an overlay they just opened.
      queueMicrotask(() => drawerEls[next]?.focus());
    }
  }

  function close() {
    const wasOpen = open;
    open = 'none';
    if (wasOpen !== 'none') queueMicrotask(() => toggleButtons[wasOpen]?.focus());
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open !== 'none') {
      e.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- ⚠ Buttons only — deliberately NOT a navigation landmark. The app already
     has two named ones (the primary menu and the conversation list) and these
     two buttons go nowhere; they open panels. See `$lib/layout.ts`. -->
<div class="panel-bar" aria-label={MOBILE_PANEL_BAR_LABEL} role="group">
  {#each MOBILE_PANEL_TOGGLES as t (t.panel)}
    {@const expanded = isPanelOpen(open, t.panel)}
    <button
      type="button"
      class="panel-bar-btn"
      class:expanded
      aria-expanded={expanded}
      aria-controls={t.panelId}
      onclick={() => toggle(t.panel)}
      bind:this={toggleButtons[t.panel]}
      data-testid={`panel-toggle-${t.panel}`}
      data-interactive
    >
      <!-- 🔴 The word IS the control. The caret is decoration and is hidden
           from assistive tech; it also marks the open state with a SHAPE, so
           "open" is not carried by the accent colour alone. -->
      <span class="panel-bar-label">{t.label}</span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>
  {/each}
</div>

<div class="workspace" class:drawer-open={open !== 'none'}>
  <!-- The scrim. `aria-hidden` + `tabindex="-1"`: it is a click target for
       people using a mouse, never a stop in the tab order. Escape and the
       drawer's own "Cerrar" button are the keyboard routes out. -->
  <div
    class="scrim"
    aria-hidden="true"
    tabindex="-1"
    onclick={close}
    data-testid="panel-scrim"
  ></div>

  {#each MOBILE_PANEL_TOGGLES as t (t.panel)}
    {@const expanded = isPanelOpen(open, t.panel)}
    <div
      id={t.panelId}
      class="pane pane-{t.panel}"
      class:open={expanded}
      aria-label={t.drawerLabel}
      role="group"
      tabindex="-1"
      inert={narrow && !expanded ? true : undefined}
      bind:this={drawerEls[t.panel]}
      data-testid={`panel-${t.panel}`}
    >
      <!-- Only exists in drawer mode; hidden by CSS on a wide screen, where
           each pane already has its own collapse control.

           ⚠ NO TITLE HERE, ON PURPOSE. Both panes already print their own
           heading ("Conversaciones", "Documentos") a few pixels below, and the
           button the reader just pressed says the same word again. A fourth
           copy is noise on the screen that has the least room for it. The
           drawer's `aria-label` carries the name for assistive tech. -->
      <div class="drawer-head">
        <button type="button" class="drawer-close" onclick={close} data-interactive>
          {CLOSE_PANEL_LABEL}
        </button>
      </div>
      {#if t.panel === 'conversations'}
        <Sidebar forceExpanded={narrow} />
      {:else}
        <DocsPanel forceExpanded={narrow} />
      {/if}
    </div>
  {/each}

  <!-- ⚠ Written between the two drawers in the DOM but pulled to the middle
       with `order`, so a screen reader meets the conversation list, then the
       chat, then the documents — the reading order of the wide layout. -->
  <div class="pane pane-chat">
    <Chat hidePanelButtons={narrow} />
  </div>
</div>

<style>
  /* ── Wide: exactly the previous three-column layout ────────────────────── */
  .workspace {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .pane {
    display: flex;
    min-height: 0;
  }
  .pane-conversations {
    order: 1;
  }
  .pane-chat {
    order: 2;
    flex: 1;
    min-width: 0;
  }
  .pane-documents {
    order: 3;
  }
  .pane:focus {
    outline: none;
  }

  /* The narrow-screen furniture does not exist on a wide screen. */
  .panel-bar,
  .scrim,
  .drawer-head {
    display: none;
  }

  /* ── Narrow: chat full width, the other two overlay it ─────────────────── */
  /* ⚠ 63.99rem must stay in step with NARROW_MAX_WIDTH_REM in $lib/layout.ts.
     `@media` cannot read a custom property; the test pins the two together. */
  @media (max-width: 63.99rem) {
    /* 🔴 MEASURED: without this the page was 703px wide at a 380px viewport.
       A closed drawer is parked at `translateX(±101%)` — off-screen, but still
       part of the scrollable area — and the root layout's `.app-main` scrolls,
       so the reader could swipe sideways into a drawer that is supposed to be
       shut. Clipping here is what makes "closed" mean closed. The panes'
       own vertical scrolling is unaffected: they are their own scroll
       containers. */
    .workspace {
      overflow: hidden;
    }
    .panel-bar {
      display: flex;
      flex: none;
      gap: var(--edc-space-2);
      padding: var(--edc-space-2) var(--edc-space-3);
      border-bottom: 1px solid var(--edc-color-line);
      background: var(--edc-color-surface);
    }
    .panel-bar-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      /* A comfortable phone target, same bar as the primary nav. */
      min-height: 2.6rem;
      padding: 0.4rem 0.8rem;
      border: 1px solid var(--edc-color-line);
      border-radius: var(--edc-radius-2);
      background: var(--edc-color-surface);
      color: var(--edc-color-ink-body);
      font-size: var(--edc-text-md);
      font-weight: var(--edc-weight-semibold);
    }
    /* 🔴 The open state is marked THREE ways — the accent fill, the accent
       border, and the caret flipping to point up. Colour alone fails a
       colour-blind reader and washes out on a cheap screen in daylight, which
       is the screen this product is used on. */
    .panel-bar-btn.expanded {
      border-color: var(--edc-color-brand);
      background: var(--edc-color-brand-soft);
      color: var(--edc-color-brand-strong);
    }
    .panel-bar-btn.expanded .caret {
      transform: rotate(180deg);
    }
    .caret {
      display: inline-block;
      font-size: 0.8em;
      line-height: 1;
    }

    .scrim {
      display: block;
      position: absolute;
      inset: 0;
      z-index: var(--edc-z-overlay);
      background: color-mix(in srgb, var(--edc-color-ink) 45%, transparent);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--edc-motion-base) var(--edc-ease-standard);
    }
    .workspace.drawer-open .scrim {
      opacity: 1;
      pointer-events: auto;
    }

    /* The chat is the ground floor and always fills the width. */
    .pane-chat {
      flex: 1;
      min-width: 0;
    }

    .pane-conversations,
    .pane-documents {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: var(--edc-z-popover);
      flex-direction: column;
      /* Never wider than the screen, and never so wide the chat behind it
         disappears entirely — the sliver of chat is what tells a reader the
         conversation is still there. */
      width: min(20rem, calc(100% - 3rem));
      background: var(--edc-color-surface);
      box-shadow: var(--edc-shadow-3);
      transition: transform var(--edc-motion-base) var(--edc-ease-standard);
    }
    .pane-conversations {
      left: 0;
      transform: translateX(-101%);
    }
    .pane-documents {
      right: 0;
      transform: translateX(101%);
    }
    .pane-conversations.open,
    .pane-documents.open {
      transform: translateX(0);
    }

    .drawer-head {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex: none;
      padding: var(--edc-space-2) var(--edc-space-3);
      border-bottom: 1px solid var(--edc-color-elevated-border);
    }
    /* ⚠ The word "Cerrar", not a “×”. */
    .drawer-close {
      min-height: 2.4rem;
      padding: 0.35rem 0.8rem;
      border: 1px solid var(--edc-color-line);
      border-radius: var(--edc-radius-2);
      background: var(--edc-color-surface);
      color: var(--edc-color-ink-body);
      font-size: var(--edc-text-sm);
      font-weight: var(--edc-weight-semibold);
    }

    /* The panes' own fixed widths are a desktop concern. Inside a drawer they
       have to fill it. `:global` because the width lives on the child
       component's own root element. */
    .pane-conversations :global(> aside),
    .pane-documents :global(> aside) {
      width: 100%;
      flex: 1;
      min-height: 0;
      border: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pane-conversations,
    .pane-documents,
    .scrim {
      transition: none;
    }
  }
</style>
