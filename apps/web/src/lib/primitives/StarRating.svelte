<svelte:options runes={true} />

<script lang="ts">
  /**
   * A 1–5 star rating INPUT (not decoration), built as an ARIA radio group.
   *
   * Accessibility contract:
   *  - `role="radiogroup"` + one `role="radio"` per star, so a screen reader
   *    announces "3 estrellas, seleccionado, 3 de 5" rather than a row of
   *    unlabelled buttons.
   *  - Roving tabindex: the group takes ONE tab stop. Tab lands on the current
   *    value (or the first star when unrated); arrows move within the group.
   *  - Down/Right = next, Up/Left = previous, Home/End = the ends of the scale
   *    (`starMoveForKey`).
   *  - ⚠ Arrows MOVE FOCUS ONLY. They do not commit. Selection-follows-focus is
   *    the usual radio-group behaviour, but here every selection is a network
   *    write: walking from 1 to 5 would fire five writes, and each one would
   *    lock the group (`busy`) and swallow the next key press. The APG allows
   *    exactly this exception — focus-only movement plus an explicit Space or
   *    Enter to select — and it is what makes the keyboard path usable at all.
   *  - The group itself carries `tabindex="-1"`: focusable from script, never
   *    a Tab stop (the roving star stays the only one). Svelte's
   *    `a11y_interactive_supports_focus` asks for it on a `radiogroup`.
   *  - The stars are `aria-hidden` glyphs; every accessible name comes from
   *    `optionLabel`, never from the ★ character.
   *
   * Presentational only: it renders `value` and reports a pick through
   * `onRate`. Persistence, optimistic state and rollback belong to the caller.
   */
  import {
    MIN_STARS,
    STAR_VALUES,
    isValidStars,
    nextStarFocus,
    starMoveForKey,
  } from '$lib/ratings';

  type Props = {
    /** Current rating, or null/0 when unrated. */
    value?: number | null;
    /** Accessible name for the whole group. */
    label: string;
    /** Accessible name for one star. */
    optionLabel?: (stars: number) => string;
    disabled?: boolean;
    /** A write is in flight: still navigable, not re-writable. */
    busy?: boolean;
    size?: 'sm' | 'md';
    dataTestId?: string;
    onRate?: (stars: number) => void;
  };

  let {
    value = null,
    label,
    optionLabel = (stars: number) => `${stars} ${stars === 1 ? 'estrella' : 'estrellas'}`,
    disabled = false,
    busy = false,
    size = 'sm',
    dataTestId,
    onRate,
  }: Props = $props();

  const buttons: (HTMLButtonElement | undefined)[] = [];

  /**
   * 0 when unrated. `isValidStars` and not a bare range check: a fractional
   * `value` would otherwise match no star, and every `tabindex` would end up
   * `-1` — a widget unreachable by Tab.
   */
  const current = $derived(isValidStars(value) ? value : 0);
  const locked = $derived(disabled || busy);

  /**
   * Where the roving tab stop sits while the user is navigating the group.
   * `null` = not navigating, so the stop follows the committed value.
   */
  let focusStar = $state<number | null>(null);
  const tabStar = $derived(focusStar ?? (current || MIN_STARS));

  /** Hover/focus preview fill. Falls back to the committed value. */
  let preview = $state(0);
  const shown = $derived(preview || current);

  function select(n: number): void {
    if (locked) return;
    onRate?.(n);
  }

  /** Focus only — see the contract note above on why this does not commit. */
  function moveFocusTo(n: number): void {
    focusStar = n;
    preview = n;
    buttons[n - 1]?.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // NOT gated on `locked`: navigation stays alive while a write is in flight,
    // so a slow save never eats the user's key presses. Only `select` blocks.
    const move = starMoveForKey(event.key);
    if (!move) return;
    event.preventDefault();
    // `current || null` so an UNRATED group has no position: the first arrow
    // press then lands on star one instead of stepping past it.
    moveFocusTo(nextStarFocus(focusStar ?? (current || null), move));
  }

  /** Leaving the group entirely: hand the tab stop back to the real value. */
  function onFocusOut(event: FocusEvent & { currentTarget: HTMLElement }): void {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    focusStar = null;
    preview = 0;
  }
</script>

<div
  class={`star-rating size-${size} ${locked ? 'is-locked' : ''}`}
  role="radiogroup"
  tabindex="-1"
  aria-label={label}
  aria-disabled={locked ? 'true' : undefined}
  aria-busy={busy ? 'true' : undefined}
  data-testid={dataTestId}
  onkeydown={onKeyDown}
  onfocusout={onFocusOut}
  onmouseleave={() => (preview = focusStar ?? 0)}
>
  {#each STAR_VALUES as n (n)}
    <button
      bind:this={buttons[n - 1]}
      type="button"
      role="radio"
      class={`star ${shown >= n ? 'is-on' : ''}`}
      aria-checked={current === n}
      aria-label={optionLabel(n)}
      tabindex={n === tabStar ? 0 : -1}
      aria-disabled={locked ? 'true' : undefined}
      data-testid={dataTestId ? `${dataTestId}-${n}` : undefined}
      onclick={() => select(n)}
      onmouseenter={() => {
        if (!locked) preview = n;
      }}
      onfocus={() => {
        focusStar = n;
        preview = n;
      }}
    >
      <span aria-hidden="true">{shown >= n ? '★' : '☆'}</span>
    </button>
  {/each}
</div>

<style>
  .star-rating {
    display: inline-flex;
    align-items: center;
    gap: 0.05rem;
  }

  /* Focusable only from script (`tabindex="-1"`): no ring of its own. */
  .star-rating:focus {
    outline: none;
  }

  .star {
    background: none;
    border: none;
    padding: 0 0.05rem;
    line-height: 1;
    cursor: pointer;
    color: var(--edc-color-ink-soft);
    border-radius: var(--edc-radius-1);
    transition:
      color var(--edc-motion-fast) var(--edc-ease-standard),
      transform var(--edc-motion-fast) var(--edc-ease-standard);
  }

  .star.is-on {
    color: var(--edc-color-warning);
  }

  .star:not([aria-disabled='true']):hover {
    transform: scale(1.12);
  }

  .star:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  /* Kept focusable while a write is in flight (see `locked`), so the group
     never loses its tab stop mid-save — the handlers do the blocking. */
  .star[aria-disabled='true'] {
    cursor: default;
  }

  .is-locked {
    opacity: 0.65;
  }

  .size-sm .star {
    font-size: 0.95rem;
  }

  .size-md .star {
    font-size: 1.25rem;
  }
</style>
