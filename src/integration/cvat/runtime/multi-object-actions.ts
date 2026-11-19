/**
 * Multi-object actions on the current frame: pure planners (what to write) plus a runner that
 * executes them through CVAT's official write path. Cuboid points: [x, y, z, rx, ry, rz, L, W, H].
 */
import type { CvatObjectStateLike } from './pre-render-enhancer';
import {
  applyCvatFilters,
  readCvatContext,
  readUnfilteredFrameStates,
  refreshCvatAnnotations,
  writeStatesAtFrame,
  type CvatStoreLike,
  type StateWrite,
  type WriteSummary,
} from './cvat-annotation-write';
import type { MeowToastKind } from './meow-toast';

export type MultiActionId =
  | 'swap-geometry'
  | 'swap-attributes'
  | 'sync-source-target'
  | 'filter-add'
  | 'filter-only'
  | 'filter-restore'
  | 'hide'
  | 'show'
  | 'pin-bottom'
  | 'sync-size'
  | 'add-surroundings'
  | 'set-source'
  | 'clear';

export interface MultiActionDef {
  readonly id: MultiActionId;
  readonly label: string;
  readonly scope: 'pair' | 'cluster' | 'selection';
}

export const MULTI_ACTIONS: readonly MultiActionDef[] = [
  { id: 'swap-geometry', label: 'Tráo vị trí + kích thước', scope: 'pair' },
  { id: 'swap-attributes', label: 'Tráo cả attribute', scope: 'pair' },
  { id: 'sync-source-target', label: 'Đồng bộ gốc → đích', scope: 'pair' },
  { id: 'filter-add', label: 'Thêm cụm vào filter hiện tại', scope: 'cluster' },
  { id: 'filter-only', label: 'Chỉ lọc cụm này', scope: 'cluster' },
  { id: 'filter-restore', label: 'Trả về filter trước', scope: 'cluster' },
  { id: 'hide', label: 'Ẩn cụm', scope: 'cluster' },
  { id: 'show', label: 'Hiện lại cụm', scope: 'cluster' },
  { id: 'pin-bottom', label: 'Ghim đáy theo gốc', scope: 'cluster' },
  { id: 'sync-size', label: 'Đồng bộ kích thước theo gốc', scope: 'cluster' },
  { id: 'add-surroundings', label: 'Thêm vật thể xung quanh', scope: 'selection' },
  { id: 'set-source', label: 'Đặt làm gốc', scope: 'selection' },
  { id: 'clear', label: 'Bỏ chọn', scope: 'selection' },
];

/* ---------------------------------------------------------------- pure planning */

function validPoints(state: CvatObjectStateLike): number[] | null {
  const p = state.points;
  return Array.isArray(p) && p.length >= 9 && p.slice(0, 9).every(Number.isFinite) ? [...p] : null;
}

export function mutableAttributeIds(state: CvatObjectStateLike): number[] {
  return (state.label?.attributes ?? []).filter((a) => a.mutable).map((a) => a.id);
}

export function sameLabel(a: CvatObjectStateLike, b: CvatObjectStateLike): boolean {
  if (a.label?.id !== undefined && b.label?.id !== undefined) return a.label.id === b.label.id;
  return a.label?.name !== undefined && a.label.name === b.label?.name;
}

function pickMutable(from: CvatObjectStateLike, ids: readonly number[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const id of ids) {
    const value = from.attributes?.[id];
    if (typeof value === 'string') out[id] = value;
  }
  return out;
}

export interface PlanResult {
  readonly writes: StateWrite[];
  /** Attribute copy was refused because labels differ. */
  readonly attributesBlocked: boolean;
  /** Objects skipped because they have no valid cuboid points or another label. */
  readonly skipped: number;
}

export function planSwap(
  a: CvatObjectStateLike,
  b: CvatObjectStateLike,
  withAttributes: boolean
): PlanResult {
  const pa = validPoints(a);
  const pb = validPoints(b);
  if (!pa || !pb) return { writes: [], attributesBlocked: false, skipped: 1 };
  const swapped = (own: number[], other: number[]): number[] => [
    ...other.slice(0, 9),
    ...own.slice(9),
  ];
  const attributesBlocked = withAttributes && !sameLabel(a, b);
  const copyAttributes = withAttributes && !attributesBlocked;
  const ids = copyAttributes ? mutableAttributeIds(a) : [];
  return {
    writes: [
      {
        state: a,
        points: swapped(pa, pb),
        ...(copyAttributes ? { attributes: pickMutable(b, ids), occluded: !!b.occluded } : {}),
      },
      {
        state: b,
        points: swapped(pb, pa),
        ...(copyAttributes ? { attributes: pickMutable(a, ids), occluded: !!a.occluded } : {}),
      },
    ],
    attributesBlocked,
    skipped: 0,
  };
}

/** Target gets the source's L/W/H, mutable attributes and occluded; never position or yaw. */
export function planSourceSync(
  source: CvatObjectStateLike,
  target: CvatObjectStateLike
): PlanResult {
  const ps = validPoints(source);
  const pt = validPoints(target);
  if (!ps || !pt) return { writes: [], attributesBlocked: false, skipped: 1 };
  const next = [...pt];
  next[6] = ps[6]!;
  next[7] = ps[7]!;
  next[8] = ps[8]!;
  const attributesBlocked = !sameLabel(source, target);
  return {
    writes: [
      {
        state: target,
        points: next,
        occluded: !!source.occluded,
        ...(attributesBlocked
          ? {}
          : { attributes: pickMutable(source, mutableAttributeIds(source)) }),
      },
    ],
    attributesBlocked,
    skipped: 0,
  };
}

/** Each other box keeps its own H and stands on the source's bottom plane. */
export function planBottomAlign(
  source: CvatObjectStateLike,
  others: readonly CvatObjectStateLike[]
): PlanResult {
  const ps = validPoints(source);
  if (!ps) return { writes: [], attributesBlocked: false, skipped: others.length };
  const bottom = ps[2]! - ps[8]! / 2;
  const writes: StateWrite[] = [];
  let skipped = 0;
  for (const other of others) {
    const p = validPoints(other);
    if (!p) {
      skipped += 1;
      continue;
    }
    const next = [...p];
    next[2] = bottom + p[8]! / 2;
    writes.push({ state: other, points: next });
  }
  return { writes, attributesBlocked: false, skipped };
}

/** Same-label boxes take the source's L/W/H and keep their own bottom plane. */
export function planSizeSync(
  source: CvatObjectStateLike,
  others: readonly CvatObjectStateLike[]
): PlanResult {
  const ps = validPoints(source);
  if (!ps) return { writes: [], attributesBlocked: false, skipped: others.length };
  const writes: StateWrite[] = [];
  let skipped = 0;
  for (const other of others) {
    const p = validPoints(other);
    if (!p || !sameLabel(source, other)) {
      skipped += 1;
      continue;
    }
    const next = [...p];
    next[2] = p[2]! - p[8]! / 2 + ps[8]! / 2;
    next[6] = ps[6]!;
    next[7] = ps[7]!;
    next[8] = ps[8]!;
    writes.push({ state: other, points: next });
  }
  return { writes, attributesBlocked: false, skipped };
}

/* ---------------------------------------------------------------- filters (JSONLogic) */

export type JsonLogic = Record<string, unknown>;

function sortedUnique(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((x, y) => x - y);
}

/** CVAT's `objectID` filter field is the object's clientID (the id shown in the sidebar). */
export function objectIdLogic(ids: Iterable<number>): JsonLogic {
  return { in: [{ var: 'objectID' }, sortedUnique(ids)] };
}

function parseLogic(entry: unknown): { logic: JsonLogic | null; asString: boolean } {
  if (typeof entry === 'string') {
    try {
      const parsed: unknown = JSON.parse(entry);
      if (typeof parsed === 'object' && parsed !== null)
        return { logic: parsed as JsonLogic, asString: true };
    } catch {
      // unparsable filter text is treated as absent
    }
    return { logic: null, asString: true };
  }
  return {
    logic: typeof entry === 'object' && entry !== null ? (entry as JsonLogic) : null,
    asString: false,
  };
}

function hasLogic(logic: JsonLogic | null): logic is JsonLogic {
  return logic !== null && Object.keys(logic).length > 0;
}

/** `current OR (objectID in ids)`; the optional keypoint filter (index 1) is preserved. */
export function composeAddFilter(current: readonly unknown[], ids: Iterable<number>): unknown[] {
  const { logic, asString } = parseLogic(current[0]);
  const idLogic = objectIdLogic(ids);
  const merged = hasLogic(logic) ? { or: [logic, idLogic] } : idLogic;
  return [asString ? JSON.stringify(merged) : merged, ...current.slice(1)];
}

/** Replace the object filter with `objectID in ids`. */
export function composeOnlyFilter(ids: Iterable<number>): unknown[] {
  return [objectIdLogic(ids)];
}

/** Small LIFO of previous filters so Meow's filter edits can be undone independently. */
export class FilterHistory {
  private readonly stack: (readonly unknown[])[] = [];
  public constructor(private readonly limit = 10) {}
  public push(filters: readonly unknown[]): void {
    this.stack.push([...filters]);
    if (this.stack.length > this.limit) this.stack.shift();
  }
  public pop(): readonly unknown[] | undefined {
    return this.stack.pop();
  }
  public get size(): number {
    return this.stack.length;
  }
  public clear(): void {
    this.stack.length = 0;
  }
}

/* ---------------------------------------------------------------- availability */

export interface ActionAvailability {
  readonly selectionSize: number;
  readonly pair: boolean;
  readonly hasSource: boolean;
  readonly filterHistorySize: number;
}

export function availableActions(ctx: ActionAvailability): MultiActionDef[] {
  return MULTI_ACTIONS.filter((def) => {
    if (def.scope === 'pair') return ctx.pair && (def.id !== 'sync-source-target' || ctx.hasSource);
    if (def.id === 'filter-restore') return ctx.filterHistorySize > 0;
    if (def.id === 'pin-bottom' || def.id === 'sync-size') return ctx.hasSource;
    if (def.id === 'set-source') return false; // offered by the menu only when a target is under the cursor
    return ctx.selectionSize > 0;
  });
}

/** (source, target) when exactly one selected object differs from the active one. */
export function resolvePair(
  selection: readonly number[],
  activeID: number | null
): { source: number | null; first: number; second: number } | null {
  if (activeID !== null) {
    const others = selection.filter((id) => id !== activeID);
    return others.length === 1 ? { source: activeID, first: activeID, second: others[0]! } : null;
  }
  return selection.length === 2
    ? { source: null, first: selection[0]!, second: selection[1]! }
    : null;
}

/* ---------------------------------------------------------------- runner */

export interface MultiActionHost {
  getStore: () => CvatStoreLike | null;
  /** Called once after a batch finished writing and Redux was refreshed. */
  afterWrite: () => void;
  toast: (message: string, kind: MeowToastKind) => void;
}

export class MultiObjectRunner {
  public readonly filterHistory = new FilterHistory();
  private busy = false;

  public constructor(private readonly host: MultiActionHost) {}

  public get isBusy(): boolean {
    return this.busy;
  }

  private async resolveStates(
    ids: readonly number[]
  ): Promise<{ states: Map<number, CvatObjectStateLike>; missing: number }> {
    const ctx = readCvatContext(this.host.getStore());
    const wanted = new Set(ids);
    const states = new Map<number, CvatObjectStateLike>();
    for (const state of ctx.states) {
      if (typeof state.clientID === 'number' && wanted.has(state.clientID))
        states.set(state.clientID, state);
    }
    if (states.size < wanted.size) {
      const all = await readUnfilteredFrameStates(this.host.getStore());
      for (const state of all ?? []) {
        if (
          typeof state.clientID === 'number' &&
          wanted.has(state.clientID) &&
          !states.has(state.clientID)
        )
          states.set(state.clientID, state);
      }
    }
    return { states, missing: wanted.size - states.size };
  }

  private async commit(writes: readonly StateWrite[]): Promise<WriteSummary | null> {
    const ctx = readCvatContext(this.host.getStore());
    if (ctx.frame === null) {
      this.host.toast('Không đọc được frame hiện tại', 'error');
      return null;
    }
    const summary = await writeStatesAtFrame(writes, ctx.frame, ctx.lastFrame);
    const synced = await refreshCvatAnnotations(this.host.getStore(), 'update');
    this.host.afterWrite();
    if (!synced && summary.written > 0)
      this.host.toast(
        'Đã ghi vào CVAT nhưng chưa làm mới giao diện; hãy đổi frame để cập nhật',
        'info'
      );
    return summary;
  }

  private report(summary: WriteSummary, doneText: string, extra: string[] = []): void {
    const notes = [...extra];
    if (summary.skippedLocked) notes.push(`${summary.skippedLocked} object bị khóa`);
    if (summary.skippedOutside) notes.push(`${summary.skippedOutside} object outside`);
    if (summary.failed) notes.push(`${summary.failed} lỗi ghi`);
    const text = notes.length ? `${doneText} (${notes.join(', ')})` : doneText;
    this.host.toast(text, summary.written > 0 && summary.failed === 0 ? 'success' : 'error');
  }

  /** Executes one action; returns false when it did not apply. Never throws. */
  public async run(
    id: MultiActionId,
    selection: readonly number[],
    activeID: number | null
  ): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      return await this.dispatch(id, selection, activeID);
    } catch (error: unknown) {
      this.host.toast(error instanceof Error ? error.message : 'Thao tác thất bại', 'error');
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(
    id: MultiActionId,
    selection: readonly number[],
    activeID: number | null
  ): Promise<boolean> {
    switch (id) {
      case 'swap-geometry':
      case 'swap-attributes':
      case 'sync-source-target':
        return this.runPair(id, selection, activeID);
      case 'filter-add':
      case 'filter-only':
      case 'filter-restore':
        return this.runFilter(id, selection);
      case 'hide':
      case 'show':
        return this.runHidden(id === 'hide', selection);
      case 'pin-bottom':
      case 'sync-size':
        return this.runCluster(id, selection, activeID);
      default:
        return false;
    }
  }

  private async runPair(
    id: 'swap-geometry' | 'swap-attributes' | 'sync-source-target',
    selection: readonly number[],
    activeID: number | null
  ): Promise<boolean> {
    const pair = resolvePair(selection, activeID);
    if (!pair) {
      this.host.toast('Cần đúng 2 object: gốc (đang chọn) và 1 đích (Shift+click)', 'error');
      return false;
    }
    if (id === 'sync-source-target' && pair.source === null) {
      this.host.toast('Hãy chọn object gốc bằng click thường trước', 'error');
      return false;
    }
    const { states, missing } = await this.resolveStates([pair.first, pair.second]);
    const first = states.get(pair.first);
    const second = states.get(pair.second);
    if (missing > 0 || !first || !second) {
      this.host.toast('Không tìm thấy object trên frame hiện tại', 'error');
      return false;
    }
    const plan =
      id === 'sync-source-target'
        ? planSourceSync(first, second)
        : planSwap(first, second, id === 'swap-attributes');
    if (!plan.writes.length) {
      this.host.toast('Object không có hộp 3D hợp lệ', 'error');
      return false;
    }
    const summary = await this.commit(plan.writes);
    if (!summary) return false;
    const notes = plan.attributesBlocked
      ? [
          'khác label nên không chép attribute, chỉ ' +
            (id === 'swap-attributes' ? 'tráo hình học' : 'đồng bộ kích thước'),
        ]
      : [];
    this.report(
      summary,
      id === 'sync-source-target' ? 'Đã đồng bộ gốc → đích' : 'Đã tráo 2 object',
      notes
    );
    return summary.written > 0;
  }

  private async runCluster(
    id: 'pin-bottom' | 'sync-size',
    selection: readonly number[],
    activeID: number | null
  ): Promise<boolean> {
    if (activeID === null) {
      this.host.toast(
        'Chưa có object gốc: click thường vào một object (hoặc chuột phải → Đặt làm gốc)',
        'error'
      );
      return false;
    }
    const others = selection.filter((x) => x !== activeID);
    const { states, missing } = await this.resolveStates([activeID, ...others]);
    const source = states.get(activeID);
    if (!source) {
      this.host.toast('Không tìm thấy object gốc trên frame hiện tại', 'error');
      return false;
    }
    const targets = others.map((x) => states.get(x)).filter((s): s is CvatObjectStateLike => !!s);
    const plan =
      id === 'pin-bottom' ? planBottomAlign(source, targets) : planSizeSync(source, targets);
    if (!plan.writes.length) {
      this.host.toast(
        plan.skipped ? `Không có object phù hợp (bỏ qua ${plan.skipped})` : 'Chưa chọn object đích',
        'error'
      );
      return false;
    }
    const summary = await this.commit(plan.writes);
    if (!summary) return false;
    const notes: string[] = [];
    if (plan.skipped)
      notes.push(
        `bỏ qua ${plan.skipped} ${id === 'sync-size' ? 'object khác label' : 'object lỗi'}`
      );
    if (missing) notes.push(`${missing} object không có trên frame`);
    this.report(
      summary,
      `${id === 'pin-bottom' ? 'Đã ghim đáy' : 'Đã đồng bộ kích thước'} ${summary.written} object`,
      notes
    );
    return summary.written > 0;
  }

  private async runHidden(hide: boolean, selection: readonly number[]): Promise<boolean> {
    const { states, missing } = await this.resolveStates(selection);
    const writes: StateWrite[] = [...states.values()].map((state) => ({ state, hidden: hide }));
    if (!writes.length) {
      this.host.toast('Không tìm thấy object trên frame hiện tại', 'error');
      return false;
    }
    // Visibility is a UI flag in CVAT (the sidebar eye); locked objects can still be hidden.
    const summary = await this.commit(writes);
    if (!summary) return false;
    this.report(
      summary,
      hide ? `Đã ẩn ${summary.written} object` : `Đã hiện ${summary.written} object`,
      missing ? [`${missing} object không có trên frame`] : []
    );
    return summary.written > 0;
  }

  private async runFilter(
    id: 'filter-add' | 'filter-only' | 'filter-restore',
    selection: readonly number[]
  ): Promise<boolean> {
    const store = this.host.getStore();
    const current = readCvatContext(store).filters;
    let next: readonly unknown[];
    if (id === 'filter-restore') {
      const previous = this.filterHistory.pop();
      if (!previous) {
        this.host.toast('Không có filter trước đó để khôi phục', 'info');
        return false;
      }
      next = previous;
    } else {
      if (!selection.length) return false;
      next =
        id === 'filter-add' ? composeAddFilter(current, selection) : composeOnlyFilter(selection);
      this.filterHistory.push(current);
    }
    const ok = await applyCvatFilters(store, next);
    this.host.afterWrite();
    this.host.toast(
      ok
        ? id === 'filter-restore'
          ? 'Đã trả về filter trước'
          : `Đã lọc ${selection.length} object`
        : 'Không áp dụng được filter (không truy cập được Redux/job của CVAT)',
      ok ? 'success' : 'error'
    );
    return ok;
  }
}
