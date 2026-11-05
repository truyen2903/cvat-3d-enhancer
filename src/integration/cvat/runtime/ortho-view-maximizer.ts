/**
 * Orthographic view maximizer for the CVAT 3D workspace.
 *
 * Keyboard shortcuts (no modifiers, ignored while typing in inputs):
 *   1 -> maximize TOP view
 *   2 -> maximize SIDE view
 *   3 -> maximize FRONT view
 * Pressing the same key again (or Escape) restores the original layout. Pressing another
 * digit switches the maximized view directly.
 *
 * Implementation is purely visual and non-destructive: the view wrapper is temporarily
 * pinned with `position: fixed` over the whole 3D workspace area (the closest ancestor that
 * also contains the perspective view). All touched inline styles are saved and restored
 * exactly, so React-managed DOM is never re-parented. CVAT's render loop resizes the
 * renderer/camera automatically from `canvas.parentElement` client size each frame; a
 * synthetic window `resize` event is also dispatched as a safety net.
 */

import { CVAT_DOM_SELECTORS } from '../../../shared/constants';

export type OrthoViewName = 'top' | 'side' | 'front';

export const ORTHO_VIEW_KEY_MAPPING: Readonly<Record<string, OrthoViewName>> = {
  Digit1: 'top',
  Numpad1: 'top',
  Digit2: 'side',
  Numpad2: 'side',
  Digit3: 'front',
  Numpad3: 'front',
};

const ORTHO_VIEW_CHAR_MAPPING: Readonly<Record<string, OrthoViewName>> = {
  '1': 'top',
  '2': 'side',
  '3': 'front',
};

const VIEW_SELECTORS: Readonly<Record<OrthoViewName, string>> = {
  top: CVAT_DOM_SELECTORS.TOP_VIEW_WRAPPER,
  side: CVAT_DOM_SELECTORS.SIDE_VIEW_WRAPPER,
  front: CVAT_DOM_SELECTORS.FRONT_VIEW_WRAPPER,
};

const MAXIMIZED_CLASS = 'cvat-3d-enhancer-view-maximized';
const MAXIMIZED_Z_INDEX = '1000';

const STYLE_PROPS = [
  'position',
  'top',
  'left',
  'width',
  'height',
  'max-width',
  'max-height',
  'z-index',
  'margin',
  'transform',
] as const;

interface SavedInlineStyle {
  readonly el: HTMLElement;
  readonly values: Record<string, { value: string; priority: string }>;
}

export function resolveOrthoViewFromKeyEvent(event: KeyboardEvent): OrthoViewName | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) {
    return null;
  }
  return ORTHO_VIEW_KEY_MAPPING[event.code] ?? ORTHO_VIEW_CHAR_MAPPING[event.key] ?? null;
}

export function isEditableEventTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function saveInlineStyle(el: HTMLElement, props: readonly string[]): SavedInlineStyle {
  const values: SavedInlineStyle['values'] = {};
  for (const prop of props) {
    values[prop] = {
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
    };
  }
  return { el, values };
}

function restoreInlineStyle(saved: SavedInlineStyle): void {
  for (const [prop, { value, priority }] of Object.entries(saved.values)) {
    if (value) {
      saved.el.style.setProperty(prop, value, priority);
    } else {
      saved.el.style.removeProperty(prop);
    }
  }
}

export class OrthoViewMaximizer {
  private readonly doc: Document;
  private readonly win: Window;
  private maximized: OrthoViewName | null = null;
  private viewEl: HTMLElement | null = null;
  private workspaceEl: HTMLElement | null = null;
  private savedStyles: SavedInlineStyle[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private readonly onChange: ((view: OrthoViewName | null) => void) | undefined;

  public constructor(
    doc: Document = document,
    win: Window = window,
    onChange?: (view: OrthoViewName | null) => void
  ) {
    this.doc = doc;
    this.win = win;
    this.onChange = onChange;
  }

  public getMaximizedView(): OrthoViewName | null {
    return this.maximized;
  }

  /** Installs the global keyboard shortcuts. Returns an uninstall function. */
  public install(): () => void {
    const onKeyDown = Object.assign(
      (event: KeyboardEvent): void => {
        this.handleKeyDown(event);
      },
      { __cvat3dEnhancerInternalKeyListener: true }
    );
    const onWindowResize = (event: Event): void => {
      // Ignore our own synthetic resize events
      if (event.isTrusted) {
        this.updateGeometry();
      }
    };
    this.win.addEventListener('keydown', onKeyDown, true);
    this.doc.addEventListener('keydown', onKeyDown, true);
    this.win.addEventListener('resize', onWindowResize);
    return () => {
      this.win.removeEventListener('keydown', onKeyDown, true);
      this.doc.removeEventListener('keydown', onKeyDown, true);
      this.win.removeEventListener('resize', onWindowResize);
      this.restore();
    };
  }

  public handleKeyDown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented && event.code !== 'Escape') {
      return false;
    }
    if (isEditableEventTarget(event.target)) {
      return false;
    }

    if (event.code === 'Escape' && this.maximized) {
      this.restore();
      return true;
    }

    const view = resolveOrthoViewFromKeyEvent(event);
    if (!view || !this.findViewElement(view)) {
      return false;
    }

    this.toggle(view);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return true;
  }

  public toggle(view: OrthoViewName): void {
    if (this.maximized === view && this.viewEl?.isConnected) {
      this.restore();
      return;
    }
    this.maximize(view);
  }

  public maximize(view: OrthoViewName): boolean {
    this.restore();

    const viewEl = this.findViewElement(view);
    if (!viewEl) {
      return false;
    }
    const workspaceEl = this.findWorkspaceElement(viewEl);
    if (!workspaceEl) {
      return false;
    }

    this.viewEl = viewEl;
    this.workspaceEl = workspaceEl;
    this.maximized = view;

    // Save + raise z-index of every ancestor between the view and the workspace, so that
    // stacking contexts created by sibling containers (e.g. grid items) never cover the view.
    this.savedStyles.push(saveInlineStyle(viewEl, STYLE_PROPS));
    for (let el = viewEl.parentElement; el && el !== workspaceEl; el = el.parentElement) {
      this.savedStyles.push(saveInlineStyle(el, ['z-index']));
      el.style.setProperty('z-index', MAXIMIZED_Z_INDEX, 'important');
    }

    viewEl.classList.add(MAXIMIZED_CLASS);
    viewEl.style.setProperty('position', 'fixed', 'important');
    viewEl.style.setProperty('z-index', MAXIMIZED_Z_INDEX, 'important');
    viewEl.style.setProperty('margin', '0', 'important');
    viewEl.style.setProperty('max-width', 'none', 'important');
    viewEl.style.setProperty('max-height', 'none', 'important');
    viewEl.style.setProperty('transform', 'none', 'important');
    this.updateGeometry();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateGeometry());
      this.resizeObserver.observe(workspaceEl);
    }

    this.notifyResize();
    this.onChange?.(view);
    return true;
  }

  public restore(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (!this.maximized && this.savedStyles.length === 0) {
      return;
    }
    // Restore in reverse order of saving
    for (let i = this.savedStyles.length - 1; i >= 0; i -= 1) {
      restoreInlineStyle(this.savedStyles[i]!);
    }
    this.viewEl?.classList.remove(MAXIMIZED_CLASS);
    this.savedStyles = [];
    this.viewEl = null;
    this.workspaceEl = null;
    this.maximized = null;
    this.notifyResize();
    this.onChange?.(null);
  }

  private updateGeometry(): void {
    const viewEl = this.viewEl;
    const workspaceEl = this.workspaceEl;
    if (!viewEl || !workspaceEl) {
      return;
    }
    if (!viewEl.isConnected || !workspaceEl.isConnected) {
      this.restore();
      return;
    }

    const target = workspaceEl.getBoundingClientRect();
    viewEl.style.setProperty('top', `${target.top}px`, 'important');
    viewEl.style.setProperty('left', `${target.left}px`, 'important');
    viewEl.style.setProperty('width', `${target.width}px`, 'important');
    viewEl.style.setProperty('height', `${target.height}px`, 'important');

    // A transformed ancestor turns `position: fixed` into "relative to that ancestor";
    // compensate for the resulting offset so the view always lands over the workspace.
    const actual = viewEl.getBoundingClientRect();
    const dx = actual.left - target.left;
    const dy = actual.top - target.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      viewEl.style.setProperty('top', `${target.top - dy}px`, 'important');
      viewEl.style.setProperty('left', `${target.left - dx}px`, 'important');
    }
  }

  private notifyResize(): void {
    try {
      this.win.dispatchEvent(new Event('resize'));
    } catch {
      // Ignore: CVAT's render loop also picks up the new size on the next frame
    }
  }

  private findViewElement(view: OrthoViewName): HTMLElement | null {
    return this.doc.querySelector<HTMLElement>(VIEW_SELECTORS[view]);
  }

  /** Closest ancestor that also contains the perspective view = whole 3D workspace area. */
  private findWorkspaceElement(viewEl: HTMLElement): HTMLElement | null {
    const perspective = this.doc.querySelector(CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER);
    for (let el = viewEl.parentElement; el; el = el.parentElement) {
      if (perspective && el.contains(perspective)) {
        return el;
      }
      if (el === this.doc.body) {
        break;
      }
    }
    return viewEl.parentElement;
  }
}
