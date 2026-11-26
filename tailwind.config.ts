import type { Config } from 'tailwindcss'

/**
 * GenAI design system.
 * Every colour resolves through a CSS variable so the whole product themes
 * light/dark from one place and white-label re-skinning is a token swap.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--bg) / <alpha-value>)',
          subtle: 'rgb(var(--bg-subtle) / <alpha-value>)',
          inset: 'rgb(var(--bg-inset) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          hover: 'rgb(var(--surface-hover) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--line) / <alpha-value>)',
          strong: 'rgb(var(--line-strong) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--ink-faint) / <alpha-value>)',
          invert: 'rgb(var(--ink-invert) / <alpha-value>)',
        },
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          DEFAULT: 'rgb(var(--brand-600) / <alpha-value>)',
          /* Solid fill + its guaranteed-legible text colour. */
          solid: 'rgb(var(--fill-brand) / <alpha-value>)',
          on: 'rgb(var(--fill-on-brand) / <alpha-value>)',
        },
        gold: {
          100: 'rgb(var(--gold-100) / <alpha-value>)',
          400: 'rgb(var(--gold-400) / <alpha-value>)',
          600: 'rgb(var(--gold-600) / <alpha-value>)',
          DEFAULT: 'rgb(var(--gold-400) / <alpha-value>)',
        },
        ok: {
          bg: 'rgb(var(--ok-bg) / <alpha-value>)',
          fg: 'rgb(var(--ok-fg) / <alpha-value>)',
          DEFAULT: 'rgb(var(--ok-fg) / <alpha-value>)',
        },
        warn: {
          bg: 'rgb(var(--warn-bg) / <alpha-value>)',
          fg: 'rgb(var(--warn-fg) / <alpha-value>)',
          DEFAULT: 'rgb(var(--warn-fg) / <alpha-value>)',
        },
        danger: {
          bg: 'rgb(var(--danger-bg) / <alpha-value>)',
          fg: 'rgb(var(--danger-fg) / <alpha-value>)',
          DEFAULT: 'rgb(var(--danger-fg) / <alpha-value>)',
        },
        info: {
          bg: 'rgb(var(--info-bg) / <alpha-value>)',
          fg: 'rgb(var(--info-fg) / <alpha-value>)',
          DEFAULT: 'rgb(var(--info-fg) / <alpha-value>)',
        },
        /* Categorical series for charts — accessible in both themes. */
        series: {
          1: 'rgb(var(--series-1) / <alpha-value>)',
          2: 'rgb(var(--series-2) / <alpha-value>)',
          3: 'rgb(var(--series-3) / <alpha-value>)',
          4: 'rgb(var(--series-4) / <alpha-value>)',
          5: 'rgb(var(--series-5) / <alpha-value>)',
          6: 'rgb(var(--series-6) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      },
      borderRadius: {
        card: '0.875rem',
        panel: '1.25rem',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
        focus: '0 0 0 2px rgb(var(--bg)), 0 0 0 4px rgb(var(--brand-500))',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--brand-500) / 0.4)' },
          '70%': { boxShadow: '0 0 0 8px rgb(var(--brand-500) / 0)' },
          '100%': { boxShadow: '0 0 0 0 rgb(var(--brand-500) / 0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.2s ease-out both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-ring': 'pulse-ring 2s infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
