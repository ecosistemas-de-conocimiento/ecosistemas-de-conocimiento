/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,svelte,ts,js}'],
  theme: {
    extend: {
      colors: {
        brand: 'var(--edc-color-brand)',
        'brand-strong': 'var(--edc-color-brand-strong)',
        accent: 'var(--edc-color-accent)',
        'accent-strong': 'var(--edc-color-accent-strong)',
        ink: 'var(--edc-color-ink)',
        'ink-body': 'var(--edc-color-ink-body)',
        'ink-soft': 'var(--edc-color-ink-soft)',
        surface: 'var(--edc-color-surface)',
        'surface-soft': 'var(--edc-color-surface-soft)',
        'surface-strong': 'var(--edc-color-surface-strong)',
        'surface-accent': 'var(--edc-color-surface-accent)',
        line: 'var(--edc-color-line)',
        'line-strong': 'var(--edc-color-line-strong)',
        // Decorative separators ONLY. `line` is deliberately dark because
        // Input/IconButton use it as a *control* boundary, which WCAG holds to
        // 3:1; using it for a hairline makes the UI look heavy. Anything that
        // is not the edge of a control belongs here instead.
        elevated: 'var(--edc-color-elevated-border)',
        // Text colours for `--edc-color-*` fills. ⚠ NOT for `--edc-gradient-*`
        // fills, which keep white — see the note in primitives/Button.svelte.
        'on-brand': 'var(--edc-color-on-brand)',
        'on-accent': 'var(--edc-color-on-accent)',
        'on-success': 'var(--edc-color-on-success)',
        'on-warning': 'var(--edc-color-on-warning)',
        'on-danger': 'var(--edc-color-on-danger)',
        'on-neutral': 'var(--edc-color-on-neutral)',
        success: 'var(--edc-color-success)',
        warning: 'var(--edc-color-warning)',
        danger: 'var(--edc-color-danger)',
      },
      fontFamily: {
        sans: ['var(--edc-font-body)'],
        mono: ['var(--edc-font-mono)'],
        display: ['var(--edc-font-display)'],
      },
      borderRadius: {
        DEFAULT: 'var(--edc-radius-1)',
        lg: 'var(--edc-radius-2)',
        xl: 'var(--edc-radius-3)',
        pill: 'var(--edc-radius-pill)',
      },
      boxShadow: {
        1: 'var(--edc-shadow-1)',
        2: 'var(--edc-shadow-2)',
        3: 'var(--edc-shadow-3)',
        hover: 'var(--edc-shadow-hover)',
      },
    },
  },
  plugins: [],
};
