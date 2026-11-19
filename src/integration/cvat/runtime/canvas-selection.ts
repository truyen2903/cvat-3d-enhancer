/**
 * Shift-based multi-selection on CVAT's main 3D perspective canvas (current frame only).
 *
 * Only the perspective view is handled. In Top / Side / Front (and zoomed ortho canvases) every
 * Shift gesture is left untouched for CVAT and Meow's own ortho editor.
 *
 * - Shift+click picks a target box; the source stays CVAT's own active object.
 * - Shift+left-drag draws a marquee (DOM overlay); Shift+Alt removes from the selection.
 * - Right-click inside the selection opens the Meow menu instead of CVAT's object menu.
 *
 * Every listener is event-driven; nothing runs per render frame or per Redux update while idle.
 * Interception only happens while Shift is held or while a Meow selection exists, so CVAT's native
 * rotate / truck / click / context-menu behavior is untouched otherwise.
 */
import type { CvatDrawnObjectEntry } from './pre-render-enhancer';
import {
  expandBox,
  insideBox,
  normalizeBox,
  pickNearestBox,
  projectedBounds,
  selectCentersInBox,
  type PickableBox,
  type ProjectionCamera,
} from './canvas-picking';
import {
  availableActions,
  resolvePair,
  type ActionAvailability,
  type MultiActionId,
} from './multi-object-actions';
import type { MeowToastKind } from './meow-toast';

/** Highlight color for selected boxes (stand-in for CVAT's private GROUPING_COLOR constant). */
export const SELECTION_HIGHLIGHT_COLOR = '#ffd400';
const DRAG_THRESHOLD_PX = 4;
const UI_CLASS = 'meow-selection-ui';
const CANVAS_SELECTOR = '.cvat-canvas3d-perspective';

export interface CanvasSelectionHost {
  isEnabled: () => boolean;
  /** False while CVAT is drawing / grouping / merging / splitting. */
  isIdle: () => boolean;
  getFrame: () => number | null;
  getActiveClientID: () => number | null;
  getCamera: (canvas: HTMLCanvasElement) => ProjectionCamera | null;
  getDrawnObjects: () => Readonly<Record<number, CvatDrawnObjectEntry | undefined>> | null;
  getDrawnEntry: (clientID: number) => CvatDrawnObjectEntry | null;
  restoreColor: (entry: CvatDrawnObjectEntry) => void;
  /** Every non-outside object of the current frame from data already in the browser, or null. */
  listUnfilteredFrameObjects: () => Promise<PickableBox[] | null>;
  filterHistorySize: () => number;
  runAction: (id: MultiActionId, ids: number[]) => Promise<void>;
  activate: (clientID: number) => void;
  toast: (message: string, kind: MeowToastKind) => void;
}

interface DragState {
  readonly canvas: HTMLCanvasElement;
  readonly startX: number;
  readonly startY: number;
  readonly frame: number | null;
  curX: number;
  curY: number;
  marquee: boolean;
  readonly remove: boolean;
}

export class CanvasSelectionController {
  private readonly selected = new Set<number>();
  private selectionFrame: number | null = null;
  private lastActive: number | null = null;
  private expectedActive: number | null | undefined;
  private drag: DragState | null = null;
  private suppressClick = false;
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;
  private rightDown: { x: number; y: number } | null = null;
  private marqueeEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private busy = false;
  private disposed = false;

  private static readonly WIN_EVENTS = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'mousemove',
    'click',
    'dblclick',
    'contextmenu',
    'keydown',
  ] as const;

  public constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly host: CanvasSelectionHost
  ) {
    for (const type of CanvasSelectionController.WIN_EVENTS)
      win.addEventListener(type, this.onEvent as EventListener, true);
    win.addEventListener('blur', this.cancelTransient);
    win.addEventListener('resize', this.repositionToolbar);
    doc.addEventListener('visibilitychange', this.cancelTransient);
  }

  /* ------------------------------------------------------------ public API */

  public get size(): number {
    return this.selected.size;
  }

  public ids(): number[] {
    return [...this.selected];
  }

  public has(id: number): boolean {
    return this.selected.has(id);
  }

  public clear(): void {
    this.cancelTransient();
    if (this.selected.size === 0) return;
    for (const id of this.selected) this.unhighlight(id);
    this.selected.clear();
    this.selectionFrame = null;
    this.expectedActive = undefined;
    this.renderToolbar();
  }

  /** Called from the existing Redux-update handler; no work unless a selection exists. */
  public contextChanged(frame: unknown, activeID: unknown): void {
    if (this.selected.size === 0) return;
    if (frame !== this.selectionFrame) {
      this.clear();
      return;
    }
    const active = typeof activeID === 'number' ? activeID : null;
    if (active === this.lastActive) return;
    if (this.expectedActive !== undefined && active === this.expectedActive) {
      this.expectedActive = undefined;
      this.lastActive = active;
      this.reapplyHighlight();
      this.renderToolbar();
      return;
    }
    this.clear();
  }

  /** CVAT redraws cuboids on `canvas.setup`, which resets their color; re-apply the highlight. */
  public onCanvasSetup(): void {
    if (this.selected.size === 0) return;
    if (this.host.getFrame() !== this.selectionFrame) this.clear();
    else this.reapplyHighlight();
  }

  public refreshEnabled(): void {
    if (!this.host.isEnabled()) this.clear();
  }

  public dispose(): void {
    this.disposed = true;
    this.clear();
    for (const type of CanvasSelectionController.WIN_EVENTS)
      this.win.removeEventListener(type, this.onEvent as EventListener, true);
    this.win.removeEventListener('blur', this.cancelTransient);
    this.win.removeEventListener('resize', this.repositionToolbar);
    this.doc.removeEventListener('visibilitychange', this.cancelTransient);
    if (this.suppressTimer !== null) clearTimeout(this.suppressTimer);
    this.suppressTimer = null;
    this.toolbarEl?.remove();
    this.toolbarEl = null;
  }

  /* ------------------------------------------------------------ selection model */

  private setSelected(next: Set<number>): void {
    const active = this.host.getActiveClientID();
    for (const id of this.selected) if (!next.has(id)) this.unhighlight(id);
    const wasEmpty = this.selected.size === 0;
    this.selected.clear();
    for (const id of next) this.selected.add(id);
    if (wasEmpty && next.size > 0) {
      this.selectionFrame = this.host.getFrame();
      this.lastActive = active;
      this.expectedActive = undefined;
    }
    if (next.size === 0) {
      this.selectionFrame = null;
      this.expectedActive = undefined;
    }
    this.reapplyHighlight();
    this.renderToolbar();
  }

  private reapplyHighlight(): void {
    const active = this.host.getActiveClientID();
    for (const id of this.selected) {
      const entry = this.host.getDrawnEntry(id);
      if (!entry) continue;
      if (id === active) this.host.restoreColor(entry);
      else entry.cuboid.setColor?.(SELECTION_HIGHLIGHT_COLOR);
    }
  }

  private unhighlight(id: number): void {
    const entry = this.host.getDrawnEntry(id);
    if (entry) this.host.restoreColor(entry);
  }

  private drawnBoxes(): PickableBox[] {
    const map = this.host.getDrawnObjects();
    const boxes: PickableBox[] = [];
    if (!map) return boxes;
    for (const key of Object.keys(map)) {
      const entry = map[Number(key)];
      const data = entry?.data;
      if (!data || data.hidden || data.outside || !data.points || data.points.length < 9) continue;
      boxes.push({ id: data.clientID, points: data.points });
    }
    return boxes;
  }

  private selectedBoxes(): PickableBox[] {
    const boxes: PickableBox[] = [];
    for (const id of this.selected) {
      const points = this.host.getDrawnEntry(id)?.data.points;
      if (points && points.length >= 9) boxes.push({ id, points });
    }
    return boxes;
  }

  /* ------------------------------------------------------------ events */

  private resolveCanvas(target: EventTarget | null): HTMLCanvasElement | null {
    const el = target instanceof Element ? target : null;
    if (!el || el.closest(`.${UI_CLASS}`)) return null;
    const canvas = el.closest('canvas');
    return canvas && canvas.closest(CANVAS_SELECTOR) ? canvas : null;
  }

  private armTarget(event: MouseEvent): HTMLCanvasElement | null {
    if (
      !event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.button !== 0 ||
      this.disposed ||
      !this.host.isEnabled() ||
      !this.host.isIdle()
    )
      return null;
    return this.resolveCanvas(event.target);
  }

  private block(event: Event): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private readonly onEvent = (event: Event): void => {
    switch (event.type) {
      case 'pointerdown':
        if (this.armTarget(event as MouseEvent)) event.stopImmediatePropagation();
        return;
      case 'mousedown':
        this.onMouseDown(event as MouseEvent);
        return;
      case 'pointerup':
        if (this.drag) event.stopImmediatePropagation();
        return;
      case 'mouseup':
        this.onMouseUp(event as MouseEvent);
        return;
      case 'mousemove':
        if (this.drag) this.onMouseMove(event as MouseEvent);
        return;
      case 'click':
        if (this.suppressClick) {
          this.suppressClick = false;
          this.block(event);
        }
        return;
      case 'dblclick':
        if (this.armTarget(event as MouseEvent)) this.block(event);
        return;
      case 'contextmenu':
        this.onContextMenu(event as MouseEvent);
        return;
      case 'keydown':
        this.onKeyDown(event as KeyboardEvent);
        return;
    }
  };

  private onMouseDown(event: MouseEvent): void {
    if (this.menuEl && !(event.target instanceof Element && event.target.closest(`.${UI_CLASS}`)))
      this.closeMenu();
    if (event.button === 2) {
      this.rightDown = this.selected.size > 0 ? { x: event.clientX, y: event.clientY } : null;
      return;
    }
    const canvas = this.armTarget(event);
    if (!canvas) return;
    event.stopImmediatePropagation();
    this.drag = {
      canvas,
      startX: event.clientX,
      startY: event.clientY,
      frame: this.host.getFrame(),
      curX: event.clientX,
      curY: event.clientY,
      marquee: false,
      remove: event.altKey,
    };
  }

  private onMouseMove(event: MouseEvent): void {
    const drag = this.drag!;
    // The button was released outside the window (no mouseup reached us): abandon the drag.
    if (event.buttons !== undefined && (event.buttons & 1) === 0) {
      this.cancelTransient();
      return;
    }
    drag.curX = event.clientX;
    drag.curY = event.clientY;
    if (
      !drag.marquee &&
      Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) >= DRAG_THRESHOLD_PX
    ) {
      drag.marquee = true;
      this.marqueeEl = this.doc.createElement('div');
      this.marqueeEl.className = UI_CLASS;
      this.marqueeEl.setAttribute('aria-hidden', 'true');
      this.marqueeEl.style.cssText =
        'position:fixed;z-index:2147482000;pointer-events:none;box-sizing:border-box;' +
        `border:1px solid ${drag.remove ? '#ff4d4f' : SELECTION_HIGHLIGHT_COLOR};` +
        `background:${drag.remove ? 'rgba(255,77,79,.12)' : 'rgba(255,212,0,.14)'};`;
      this.doc.body.appendChild(this.marqueeEl);
    }
    if (drag.marquee && this.marqueeEl) {
      const box = normalizeBox(drag.startX, drag.startY, drag.curX, drag.curY);
      const s = this.marqueeEl.style;
      s.left = `${box.left}px`;
      s.top = `${box.top}px`;
      s.width = `${box.right - box.left}px`;
      s.height = `${box.bottom - box.top}px`;
    }
    event.preventDefault();
  }

  private onMouseUp(event: MouseEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.marqueeEl?.remove();
    this.marqueeEl = null;
    this.block(event);
    this.suppressClick = true;
    if (this.suppressTimer !== null) clearTimeout(this.suppressTimer);
    this.suppressTimer = setTimeout(() => {
      this.suppressClick = false;
      this.suppressTimer = null;
    }, 100);
    // Mode or frame changed mid-gesture (CVAT entered draw/merge/..., frame stepped): do nothing.
    if (
      this.disposed ||
      !this.host.isEnabled() ||
      !this.host.isIdle() ||
      this.host.getFrame() !== drag.frame ||
      !drag.canvas.isConnected
    )
      return;
    const camera = this.host.getCamera(drag.canvas);
    if (!camera) {
      this.host.toast('Chưa có camera render để chiếu; hãy thử lại sau khi canvas vẽ xong', 'info');
      return;
    }
    const rect = drag.canvas.getBoundingClientRect();
    if (drag.marquee) {
      const ids = selectCentersInBox(
        camera,
        rect,
        this.drawnBoxes(),
        normalizeBox(drag.startX, drag.startY, event.clientX, event.clientY)
      );
      const next = new Set(this.selected);
      for (const id of ids) {
        if (drag.remove) next.delete(id);
        else next.add(id);
      }
      this.setSelected(next);
      this.host.toast(
        `${drag.remove ? 'Đã bỏ' : 'Đã chọn'} ${ids.length} object (đang chọn ${next.size})`,
        'info'
      );
      return;
    }
    const picked = pickNearestBox(camera, rect, event.clientX, event.clientY, this.drawnBoxes());
    if (picked === null) return;
    this.pick(picked, drag.remove);
  }

  /** Shift+click: pair-mode keeps at most one target besides the active source. */
  private pick(id: number, remove: boolean): void {
    const active = this.host.getActiveClientID();
    const next = new Set(this.selected);
    if (remove || next.has(id)) {
      next.delete(id);
    } else if (id !== active) {
      const targets = [...next].filter((x) => x !== active);
      if (targets.length === 1) next.delete(targets[0]!);
      next.add(id);
    }
    this.setSelected(next);
  }

  private onContextMenu(event: MouseEvent): void {
    const down = this.rightDown;
    this.rightDown = null;
    if (this.disposed || this.selected.size === 0 || !this.host.isEnabled()) return;
    if (!this.host.isIdle()) return; // CVAT's draw / group / merge / split own the right click
    const canvas = this.resolveCanvas(event.target);
    if (!canvas) return;
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const camera = this.host.getCamera(canvas);
    if (!camera) return;
    const rect = canvas.getBoundingClientRect();
    const boxes = this.selectedBoxes();
    const bounds = projectedBounds(camera, rect, boxes);
    if (!bounds || !insideBox(expandBox(bounds, 12), event.clientX, event.clientY)) return;
    this.block(event);
    const under = pickNearestBox(camera, rect, event.clientX, event.clientY, boxes);
    this.showMenu(event.clientX, event.clientY, under);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (this.drag) {
      this.cancelTransient();
      return;
    }
    if (this.menuEl) this.closeMenu();
    if (this.selected.size > 0) this.clear();
  }

  private readonly cancelTransient = (): void => {
    this.drag = null;
    this.marqueeEl?.remove();
    this.marqueeEl = null;
    this.closeMenu();
  };

  /* ------------------------------------------------------------ actions UI */

  private availability(): ActionAvailability {
    const ids = this.ids();
    const active = this.host.getActiveClientID();
    return {
      selectionSize: ids.length,
      pair: resolvePair(ids, active) !== null,
      hasSource: active !== null,
      filterHistorySize: this.host.filterHistorySize(),
    };
  }

  private labelFor(id: MultiActionId, fallback: string): string {
    return id === 'filter-restore' ? `${fallback} (${this.host.filterHistorySize()})` : fallback;
  }

  private button(label: string, onClick: () => void, compact: boolean): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = compact
      ? 'border:1px solid #d9d9d9;border-radius:4px;background:#fff;color:#1f1f1f;padding:2px 8px;font:12px/18px system-ui,sans-serif;cursor:pointer;'
      : 'display:block;width:100%;text-align:left;border:0;background:transparent;color:#1f1f1f;padding:6px 14px;font:13px/18px system-ui,sans-serif;cursor:pointer;';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    if (!compact) {
      button.addEventListener('mouseenter', () => (button.style.background = '#f0f5ff'));
      button.addEventListener('mouseleave', () => (button.style.background = 'transparent'));
    }
    return button;
  }

  private async invoke(id: MultiActionId, targetID: number | null = null): Promise<void> {
    this.closeMenu();
    if (id === 'clear') {
      this.clear();
      return;
    }
    if (id === 'set-source') {
      if (targetID !== null) {
        this.expectedActive = targetID;
        this.host.activate(targetID);
      }
      return;
    }
    if (this.busy || this.disposed) return;
    if (!this.host.isEnabled() || !this.host.isIdle()) {
      this.host.toast('Hãy thoát chế độ vẽ/gộp/tách/nhóm của CVAT trước khi dùng Meow', 'error');
      return;
    }
    this.busy = true;
    this.renderToolbar();
    try {
      if (id === 'add-surroundings') await this.addSurroundings();
      else await this.host.runAction(id, this.ids());
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.reapplyHighlight();
        this.renderToolbar();
      }
    }
  }

  private async addSurroundings(): Promise<void> {
    const canvas = this.doc.querySelector<HTMLCanvasElement>('.cvat-canvas3d-perspective canvas');
    const camera = canvas ? this.host.getCamera(canvas) : null;
    const bounds =
      canvas && camera
        ? projectedBounds(camera, canvas.getBoundingClientRect(), this.selectedBoxes())
        : null;
    if (!canvas || !camera || !bounds) {
      this.host.toast('Không chiếu được vùng chọn lên màn hình', 'error');
      return;
    }
    const frame = this.selectionFrame;
    const rect = canvas.getBoundingClientRect();
    const area = expandBox(
      bounds,
      Math.max(40, 0.25 * Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top))
    );
    const all = await this.host.listUnfilteredFrameObjects();
    const unfiltered = all !== null;
    const boxes = all ?? this.drawnBoxes();
    if (this.disposed || frame !== this.selectionFrame || this.host.getFrame() !== frame) return;
    const ids = selectCentersInBox(camera, rect, boxes, area);
    const next = new Set(this.selected);
    let added = 0;
    for (const id of ids)
      if (!next.has(id)) {
        next.add(id);
        added += 1;
      }
    this.setSelected(next);
    this.host.toast(
      unfiltered
        ? `Đã thêm ${added} vật thể xung quanh (gồm cả vật thể bị filter ẩn)`
        : `Đã thêm ${added} vật thể xung quanh; không đọc được dữ liệu chưa lọc nên chỉ lấy các object đang hiển thị`,
      unfiltered ? 'success' : 'info'
    );
  }

  private showMenu(x: number, y: number, targetID: number | null): void {
    this.closeMenu();
    const defs = availableActions(this.availability()).filter((d) => d.id !== 'clear');
    const active = this.host.getActiveClientID();
    const menu = this.doc.createElement('div');
    menu.className = UI_CLASS;
    menu.setAttribute('role', 'menu');
    menu.style.cssText =
      'position:fixed;z-index:2147483100;min-width:220px;padding:4px 0;background:#fff;border-radius:6px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.25);';
    menu.style.left = `${Math.min(x, this.win.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(y, this.win.innerHeight - 40 * (defs.length + 2))}px`;
    const header = this.doc.createElement('div');
    header.textContent = `Meow · ${this.selected.size} object`;
    header.style.cssText =
      'padding:4px 14px;font:600 11px/16px system-ui,sans-serif;color:#8c8c8c;';
    menu.appendChild(header);
    if (targetID !== null && targetID !== active)
      menu.appendChild(
        this.button('Đặt làm gốc', () => void this.invoke('set-source', targetID), false)
      );
    for (const def of defs)
      menu.appendChild(
        this.button(this.labelFor(def.id, def.label), () => void this.invoke(def.id), false)
      );
    menu.appendChild(this.button('Bỏ chọn (Esc)', () => void this.invoke('clear'), false));
    this.doc.body.appendChild(menu);
    this.menuEl = menu;
  }

  private closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  private readonly repositionToolbar = (): void => {
    if (this.toolbarEl) this.placeToolbar(this.toolbarEl);
  };

  private placeToolbar(el: HTMLElement): void {
    const canvas = this.doc.querySelector<HTMLCanvasElement>('.cvat-canvas3d-perspective canvas');
    const rect = canvas?.getBoundingClientRect();
    el.style.left = `${(rect?.left ?? 0) + 8}px`;
    el.style.top = `${(rect?.top ?? 0) + 8}px`;
  }

  private renderToolbar(): void {
    if (this.selected.size === 0 || this.disposed) {
      this.toolbarEl?.remove();
      this.toolbarEl = null;
      return;
    }
    if (!this.toolbarEl) {
      const el = this.doc.createElement('div');
      el.className = UI_CLASS;
      el.style.cssText =
        'position:fixed;z-index:2147482500;display:flex;flex-wrap:wrap;align-items:center;gap:4px;max-width:420px;' +
        'padding:4px 6px;background:rgba(255,255,255,.95);border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.25);';
      this.doc.body.appendChild(el);
      this.toolbarEl = el;
    }
    const el = this.toolbarEl;
    this.placeToolbar(el);
    const availability = this.availability();
    const label = this.doc.createElement('span');
    label.textContent = this.busy ? 'Meow · đang xử lý…' : `Meow · ${this.selected.size} object`;
    label.style.cssText = 'font:600 12px/18px system-ui,sans-serif;color:#1f1f1f;padding:0 4px;';
    const children: HTMLElement[] = [label];
    if (!this.busy) {
      for (const def of availableActions(availability)) {
        if (def.scope === 'pair' || def.id === 'filter-only' || def.id === 'hide')
          children.push(this.button(def.label, () => void this.invoke(def.id), true));
      }
      children.push(this.button('Hành động ▾', () => this.openMenuFromToolbar(el), true));
      children.push(this.button('✕', () => void this.invoke('clear'), true));
    }
    el.replaceChildren(...children);
  }

  private openMenuFromToolbar(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    this.showMenu(rect.left, rect.bottom + 4, null);
  }
}
