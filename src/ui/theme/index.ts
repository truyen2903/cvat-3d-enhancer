import type { WorkspaceThemePreset } from '../../shared/types';

export interface ThemePalette {
  readonly bg: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
}

export const THEME_PALETTES: Record<WorkspaceThemePreset, ThemePalette> = {
  'cvat-dark': {
    bg: '#0f172a',
    surface: '#1e293b',
    border: '#334155',
    text: '#f8fafc',
    muted: '#94a3b8',
    accent: '#38bdf8',
  },
  'midnight-slate': {
    bg: '#090d16',
    surface: '#111827',
    border: '#1f2937',
    text: '#f3f4f6',
    muted: '#9ca3af',
    accent: '#22d3ee',
  },
  'high-contrast': {
    bg: '#000000',
    surface: '#141414',
    border: '#525252',
    text: '#ffffff',
    muted: '#d4d4d4',
    accent: '#facc15',
  },
  'lidar-amber': {
    bg: '#14110b',
    surface: '#231e14',
    border: '#423723',
    text: '#fef3c7',
    muted: '#d6c39c',
    accent: '#f59e0b',
  },
};

export const SHADOW_PANEL_STYLESHEET = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
  color: var(--cvat-enhancer-text, #f8fafc);
  line-height: 1.4;
  font-size: 12px;
}

* {
  box-sizing: border-box;
}

.enhancer-shell {
  position: fixed;
  top: 64px;
  right: 16px;
  z-index: 2147483000;
  width: 356px;
  max-height: calc(100vh - 88px);
  display: flex;
  flex-direction: column;
  background: var(--cvat-enhancer-bg, #0f172a);
  color: var(--cvat-enhancer-text, #f8fafc);
  border: 1px solid var(--cvat-enhancer-border, #334155);
  border-radius: 10px;
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.enhancer-shell.collapsed {
  width: auto;
  max-height: none;
}

.enhancer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--cvat-enhancer-surface, #1e293b);
  border-bottom: 1px solid var(--cvat-enhancer-border, #334155);
  gap: 8px;
}

.enhancer-title {
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  gap: 6px;
}

.enhancer-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--cvat-enhancer-accent, #38bdf8);
  display: inline-block;
}

.enhancer-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 6px 8px;
  background: var(--cvat-enhancer-surface, #1e293b);
  border-bottom: 1px solid var(--cvat-enhancer-border, #334155);
}

.enhancer-tab-btn {
  background: transparent;
  color: var(--cvat-enhancer-muted, #94a3b8);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
}

.enhancer-tab-btn.active {
  color: var(--cvat-enhancer-text, #f8fafc);
  border-color: var(--cvat-enhancer-accent, #38bdf8);
  background: rgba(56, 189, 248, 0.12);
}

.enhancer-body {
  padding: 10px 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.enhancer-card {
  background: var(--cvat-enhancer-surface, #1e293b);
  border: 1px solid var(--cvat-enhancer-border, #334155);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.enhancer-card-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--cvat-enhancer-muted, #94a3b8);
}

.enhancer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.enhancer-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 999px;
  text-transform: uppercase;
}

.badge-supported {
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.4);
}

.badge-unsupported {
  background: rgba(239, 68, 68, 0.18);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.4);
}

.badge-unverified {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.enhancer-btn {
  background: var(--cvat-enhancer-surface, #1e293b);
  color: var(--cvat-enhancer-text, #f8fafc);
  border: 1px solid var(--cvat-enhancer-border, #334155);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.enhancer-btn:hover:not(:disabled) {
  border-color: var(--cvat-enhancer-accent, #38bdf8);
}

.enhancer-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.enhancer-btn-primary {
  background: var(--cvat-enhancer-accent, #38bdf8);
  color: #020617;
  border-color: transparent;
}

.enhancer-btn-danger {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.45);
}

.enhancer-input, .enhancer-select, .enhancer-textarea {
  background: var(--cvat-enhancer-bg, #0f172a);
  color: var(--cvat-enhancer-text, #f8fafc);
  border: 1px solid var(--cvat-enhancer-border, #334155);
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 11px;
  width: 100%;
}

.enhancer-muted {
  color: var(--cvat-enhancer-muted, #94a3b8);
  font-size: 11px;
}

.enhancer-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.enhancer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--cvat-enhancer-surface, #1e293b);
  border-top: 1px solid var(--cvat-enhancer-border, #334155);
  gap: 8px;
}
`;
