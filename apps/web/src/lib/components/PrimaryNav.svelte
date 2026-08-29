<svelte:options runes={true} />

<script lang="ts">
  /**
   * The app's one primary navigation bar.
   *
   * 🔴 ONE SURFACE, IN THE ROOT LAYOUT. Before this, moving between the chat,
   * the library and the admin view meant finding a link buried in a panel
   * footer or at the bottom of the conversation list — different in each
   * section, invisible from most of them. Putting the menu in `+layout.svelte`
   * is what makes it the SAME menu everywhere, which is the only reason a menu
   * is learnable at all.
   *
   * ⚠ NO ICON-ONLY BUTTONS, NO HAMBURGER. Every destination is a word, at every
   * width. This product's readers are people for whom a glyph is a guess; a
   * three-line square that hides the whole menu behind an unlabelled control is
   * the single most common way an app becomes unnavigable for them. On a narrow
   * screen the row scrolls sideways instead of collapsing.
   *
   * ⚠ EVERY ITEM IS A PLAIN `<a href>`. Tab reaches them, Enter follows them,
   * and middle-click opens them in a tab — all for free, and none of it true of
   * a `<div onclick>`. `aria-current="page"` is set from `isCurrentSection`, so
   * a screen reader announces where it is rather than only showing it.
   *
   * The items, the labels and the current-section rule are in `$lib/nav.ts` so
   * they can be asserted — this file only draws them.
   */
  import { page } from '$app/stores';
  import {
    isCurrentSection,
    MAIN_CONTENT_ID,
    PRIMARY_NAV_LABEL,
    SKIP_TO_CONTENT_LABEL,
    visibleNavItems,
  } from '$lib/nav';

  // ⚠ Two arguments, two different sources. `user` carries `isPlatformAdmin`,
  // a field on the backend's user record. `canReviewHolds` is an answer the
  // root layout's server load computed for this request — see `$lib/nav.ts`.
  const items = $derived(
    visibleNavItems($page.data.user, { canReviewHolds: $page.data.canReviewHolds }),
  );
  const pathname = $derived($page.url.pathname);
</script>

<!-- ⚠ First thing in the tab order, visible only when focused. Without it a
     keyboard user tabs the whole menu again on every single page. -->
<a class="skip" href={`#${MAIN_CONTENT_ID}`}>{SKIP_TO_CONTENT_LABEL}</a>

<nav class="primary-nav" aria-label={PRIMARY_NAV_LABEL} data-testid="primary-nav">
  <ul class="items">
    {#each items as item (item.href)}
      {@const current = isCurrentSection(pathname, item.href)}
      <li>
        <a
          class="item"
          class:current
          href={item.href}
          title={item.hint}
          aria-current={current ? 'page' : undefined}
          data-interactive
          data-testid={`nav-${item.href === '/' ? 'chat' : item.href.slice(1)}`}
        >
          <span class="label">{item.label}</span>
          <!-- The hint is `aria-hidden` because it is already the link's
               `title`; announcing it twice makes the menu twice as long to
               listen to. -->
          <span class="hint" aria-hidden="true">{item.hint}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .skip {
    position: absolute;
    left: -9999px;
    top: 0;
    z-index: 50;
    padding: 0.5rem 0.9rem;
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    border: 1px solid var(--edc-color-brand-outline);
    border-radius: var(--edc-radius-2);
    font-size: 0.85rem;
    font-weight: 700;
    text-decoration: none;
  }
  .skip:focus {
    left: 0.5rem;
    top: 0.5rem;
  }

  .primary-nav {
    flex: none;
    border-bottom: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface);
  }

  .items {
    display: flex;
    align-items: stretch;
    gap: 0.15rem;
    margin: 0;
    padding: 0 0.5rem;
    list-style: none;
    /* ⚠ The narrow-screen answer. Three word-labels do not fit on a small
       phone, so the row scrolls; it never hides behind a menu button. */
    overflow-x: auto;
    scrollbar-width: none;
  }
  .items::-webkit-scrollbar {
    display: none;
  }

  .item {
    display: block;
    /* ⚠ A comfortable target on a phone, not a 20px line of text. */
    min-height: 2.9rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 3px solid transparent;
    color: var(--edc-color-ink-soft);
    text-decoration: none;
    white-space: nowrap;
  }
  .item:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }
  /* Keyboard focus must be visible on its own, without relying on the
     current-section colour. */
  .item:focus-visible {
    outline: 2px solid var(--edc-color-brand-outline);
    outline-offset: -2px;
  }

  /* 🔴 THE CURRENT SECTION IS MARKED TWICE — colour AND an underline bar.
     Colour alone fails for a colour-blind reader and washes out on a cheap
     screen in daylight, which is the screen this product is used on. */
  .item.current {
    color: var(--edc-color-brand-strong);
    border-bottom-color: var(--edc-color-brand);
    background: var(--edc-color-brand-soft);
  }

  .label {
    display: block;
    font-family: var(--edc-font-display);
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .item.current .label {
    color: var(--edc-color-brand-strong);
  }

  .hint {
    display: block;
    font-size: 0.7rem;
    line-height: 1.2;
    color: var(--edc-color-ink-soft);
  }

  /* On a phone the hints would push the bar to a third of the screen. The
     label stays; the explanation lives in the link's `title`. */
  @media (max-width: 40rem) {
    .hint {
      display: none;
    }
    .item {
      min-height: 2.6rem;
      display: flex;
      align-items: center;
    }
  }
</style>
