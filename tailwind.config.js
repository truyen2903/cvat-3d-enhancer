/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: 'var(--cvat-enhancer-bg, #0f172a)',
          surface: 'var(--cvat-enhancer-surface, #1e293b)',
          border: 'var(--cvat-enhancer-border, #334155)',
          text: 'var(--cvat-enhancer-text, #f8fafc)',
          muted: 'var(--cvat-enhancer-muted, #94a3b8)',
          accent: 'var(--cvat-enhancer-accent, #38bdf8)',
        },
      },
    },
  },
  plugins: [],
};
