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
  type ClientRect,
  type ProjectionCamera,
  type ScreenBox,
} from './canvas-picking';
import {
  availableActions,
  resolvePair,
  type ActionAvailability,
  type MultiActionId,
} from './multi-object-actions';
import type { MeowToastKind } from './meow-toast';
import { decorateMeowSurface, ensureMeowStyle, setMeowIcon } from './meow-ui';

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
  /** 3D boxes of selected objects CVAT does not draw (outside or hidden by the filter). */
  private readonly knownBoxes = new Map<number, ArrayLike<number>>();
  private lastActive: number | null = null;
  private expectedActive: number | null | undefined;
  private drag: DragState | null = null;
  private suppressClick = false;
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;
  private rightDown: { x: number; y: number } | null = null;
  private marqueeEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private menuReturnFocus: HTMLElement | null = null;
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
    this.knownBoxes.clear();
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
    for (const id of this.knownBoxes.keys()) if (!next.has(id)) this.knownBoxes.delete(id);
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
      const points = this.host.getDrawnEntry(id)?.data.points ?? this.knownBoxes.get(id);
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
      ensureMeowStyle(this.doc);
      this.marqueeEl.className = `${UI_CLASS} meow-selection-marquee${drag.remove ? ' is-removing' : ''}`;
      this.marqueeEl.setAttribute('aria-hidden', 'true');
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
      this.host.toast('Canvas chưa sẵn sàng. Thử lại sau khi vẽ xong.', 'info');
      return;
    }
    const rect = drag.canvas.getBoundingClientRect();
    if (drag.marquee) {
      this.finishMarquee(
        drag.frame,
        camera,
        rect,
        normalizeBox(drag.startX, drag.startY, event.clientX, event.clientY),
        drag.remove
      );
      return;
    }
    const picked = pickNearestBox(camera, rect, event.clientX, event.clientY, this.drawnBoxes());
    if (picked === null) return;
    this.pick(picked, drag.remove);
  }

  /**
   * Marquee selects every object whose center projects into the rectangle. Drawn boxes are applied
   * immediately; the frame's unfiltered objects from cvat-core (outside tracks and objects hidden
   * by the filter) are added right after, once that in-memory read resolves.
   */
  private finishMarquee(
    frame: number | null,
    camera: ProjectionCamera,
    rect: ClientRect,
    box: ScreenBox,
    remove: boolean
  ): void {
    const drawn = this.drawnBoxes();
    const ids = selectCentersInBox(camera, rect, drawn, box);
    const next = new Set(this.selected);
    for (const id of ids) {
      if (remove) next.delete(id);
      else next.add(id);
    }
    this.setSelected(next);
    this.host.toast(
      `${remove ? 'Đã bỏ' : 'Đã chọn'} ${ids.length} object (đang chọn ${next.size})`,
      'info'
    );
    void this.addUndrawnInBox(frame, camera, rect, box, remove, drawn);
  }

  private async addUndrawnInBox(
    frame: number | null,
    camera: ProjectionCamera,
    rect: ClientRect,
    box: ScreenBox,
    remove: boolean,
    drawn: readonly PickableBox[]
  ): Promise<void> {
    const all = await this.host.listUnfilteredFrameObjects();
    if (!all || this.disposed || this.host.getFrame() !== frame) return;
    const drawnIds = new Set(drawn.map((item) => item.id));
    const undrawn = all.filter((item) => !drawnIds.has(item.id));
    const ids = selectCentersInBox(camera, rect, undrawn, box);
    if (!ids.length) return;
    const byId = new Map(undrawn.map((item) => [item.id, item.points] as const));
    const next = new Set(this.selected);
    for (const id of ids) {
      if (remove) {
        next.delete(id);
      } else {
        next.add(id);
        this.knownBoxes.set(id, byId.get(id)!);
      }
    }
    this.setSelected(next);
    this.host.toast(
      `${remove ? 'Bỏ' : 'Thêm'} ${ids.length} vật thể ngoài filter · ${next.size} chọn`,
      'info'
    );
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
    if (this.menuEl && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = [...this.menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      if (!items.length) return;
      const current = items.findIndex((item) => item === this.doc.activeElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      this.block(event);
      items[index]?.focus();
      return;
    }
    if (event.key !== 'Escape') return;
    if (this.drag) {
      this.cancelTransient();
      return;
    }
    if (this.menuEl) {
      this.block(event);
      this.closeMenu(true);
      return;
    }
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

  private labelFor(id: MultiActionId): string {
    const labels: Record<MultiActionId, string> = {
      'swap-geometry': 'Tráo',
      'swap-attributes': 'Tráo + attribute',
      'sync-source-target': 'Gốc → đích',
      'filter-only': 'Chỉ cụm này',
      'filter-add': 'Thêm vào filter',
      'filter-restore': `Trả về filter (${this.host.filterHistorySize()})`,
      hide: 'Ẩn',
      show: 'Hiện',
      'pin-bottom': 'Ghim đáy · frame này',
      'pin-bottom-forward': 'Ghim đáy · → cuối track',
      'sync-size': 'Kích thước · frame này',
      'sync-size-track': 'Kích thước · mọi frame',
      'place-by-anchor': 'Đặt theo mốc tĩnh',
      'add-surroundings': 'Thêm xung quanh',
      'set-source': 'Đặt làm gốc',
      clear: 'Bỏ chọn',
    };
    return labels[id];
  }

  private button(label: string, onClick: () => void, compact: boolean): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.className = compact
      ? 'meow-selection-button ant-btn ant-btn-default ant-btn-sm'
      : 'meow-selection-menu-item ant-dropdown-menu-item';
    if (!compact) {
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private actionButton(id: MultiActionId, title: string, compact: boolean): HTMLButtonElement {
    const button = this.button(this.labelFor(id), () => void this.invoke(id), compact);
    button.dataset.action = id;
    button.title = title;
    if (compact) {
      const icon = id === 'swap-geometry' ? 'swap' : id === 'filter-only' ? 'filter' : 'hide';
      setMeowIcon(button, icon);
      button.append(this.doc.createTextNode(this.labelFor(id)));
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
      this.host.toast('Thoát chế độ vẽ/gộp/tách/nhóm trước.', 'error');
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
    const drawnIds = new Set(this.drawnBoxes().map((item) => item.id));
    for (const id of ids)
      if (!next.has(id)) {
        next.add(id);
        added += 1;
        const known = boxes.find((item) => item.id === id);
        if (known && !drawnIds.has(id)) this.knownBoxes.set(id, known.points);
      }
    this.setSelected(next);
    this.host.toast(
      unfiltered
        ? `Thêm ${added} vật thể (kể cả bị filter ẩn)`
        : `Thêm ${added} vật thể đang hiện; chưa đọc được dữ liệu ngoài filter`,
      unfiltered ? 'success' : 'info'
    );
  }

  private showMenu(
    x: number,
    y: number,
    targetID: number | null,
    trigger?: HTMLButtonElement
  ): void {
    this.closeMenu();
    this.menuReturnFocus =
      trigger ?? (this.doc.activeElement instanceof HTMLElement ? this.doc.activeElement : null);
    const defs = availableActions(this.availability());
    const active = this.host.getActiveClientID();
    ensureMeowStyle(this.doc);
    const menu = this.doc.createElement('div');
    menu.className = `${UI_CLASS} meow-selection-menu ant-dropdown-menu ant-dropdown-menu-root ant-dropdown-menu-vertical`;
    menu.id = 'meow-selection-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Thao tác vùng chọn');
    decorateMeowSurface(menu);
    menu.style.left = `${Math.max(8, Math.min(x, this.win.innerWidth - 272))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, this.win.innerHeight - 480))}px`;
    const groups: [string, MultiActionId[]][] = [
      ['Cặp', ['swap-geometry', 'swap-attributes', 'sync-source-target']],
      ['Lọc', ['filter-only', 'filter-add', 'filter-restore']],
      ['Hiển thị', ['hide', 'show']],
      [
        'Theo gốc',
        ['pin-bottom', 'pin-bottom-forward', 'sync-size', 'sync-size-track', 'place-by-anchor'],
      ],
      ['Khác', ['add-surroundings', 'set-source', 'clear']],
    ];
    for (const [name, ids] of groups) {
      const actions = ids.flatMap((id) => {
        if (id === 'set-source') {
          if (targetID === null || targetID === active) return [];
          const button = this.button('Đặt làm gốc', () => void this.invoke(id, targetID), false);
          button.dataset.action = id;
          button.title = 'Dùng vật thể dưới con trỏ làm gốc';
          return [button];
        }
        const def = defs.find((item) => item.id === id);
        return def ? [this.actionButton(id, def.label, false)] : [];
      });
      if (!actions.length) continue;
      const group = this.doc.createElement('div');
      group.className = 'meow-selection-group ant-dropdown-menu-item-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', name);
      const heading = this.doc.createElement('div');
      heading.className = 'meow-selection-group-label';
      heading.textContent = name;
      group.append(heading, ...actions);
      menu.appendChild(group);
    }
    this.doc.body.appendChild(menu);
    this.menuEl = menu;
    this.toolbarEl?.querySelector('[aria-haspopup="menu"]')?.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  private closeMenu(restoreFocus = false): void {
    this.menuEl?.remove();
    this.menuEl = null;
    this.toolbarEl?.querySelector('[aria-haspopup="menu"]')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && this.menuReturnFocus?.isConnected) this.menuReturnFocus.focus();
    this.menuReturnFocus = null;
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
      ensureMeowStyle(this.doc);
      el.className = `${UI_CLASS} meow-selection-toolbar`;
      el.setAttribute('role', 'toolbar');
      el.setAttribute('aria-label', 'Vùng chọn');
      decorateMeowSurface(el);
      this.doc.body.appendChild(el);
      this.toolbarEl = el;
    }
    const el = this.toolbarEl;
    this.placeToolbar(el);
    const availability = this.availability();
    const label = this.doc.createElement('span');
    label.textContent = this.busy ? 'Đang xử lý…' : `${this.selected.size} chọn`;
    label.className = 'meow-selection-count';
    const children: HTMLElement[] = [label];
    if (!this.busy) {
      for (const id of ['swap-geometry', 'filter-only', 'hide'] as const) {
        const def = availableActions(availability).find((item) => item.id === id);
        if (def) children.push(this.actionButton(id, def.label, true));
      }
      const more = this.button('Thêm thao tác', () => this.openMenuFromToolbar(el, more), true);
      more.classList.add('meow-selection-icon-button');
      more.title = 'Thêm thao tác';
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', String(this.menuEl !== null));
      more.setAttribute('aria-controls', 'meow-selection-menu');
      setMeowIcon(more, 'more');
      const close = this.button('Bỏ chọn', () => void this.invoke('clear'), true);
      close.classList.add('meow-selection-icon-button');
      close.title = 'Bỏ chọn (Esc)';
      setMeowIcon(close, 'close');
      children.push(more, close);
    }
    el.replaceChildren(...children);
  }

  private openMenuFromToolbar(el: HTMLElement, trigger: HTMLButtonElement): void {
    const rect = el.getBoundingClientRect();
    this.showMenu(rect.left, rect.bottom + 4, null, trigger);
  }
}
