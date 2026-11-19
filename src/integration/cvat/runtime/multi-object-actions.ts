/**
 * Multi-object actions on the current frame: pure planners (what to write) plus a runner that
 * executes them through CVAT's official write path. Cuboid points: [x, y, z, rx, ry, rz, L, W, H].
 */
import type { CvatObjectStateLike } from './pre-render-enhancer';
import { trackKeyframes } from './track-editing';
import {
  applyCvatFilters,
  readCvatContext,
  readFrameStates,
  readUnfilteredFrameStates,
  refreshCvatAnnotations,
  writeStatesAtFrame,
  type CvatJobLike,
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
  | 'pin-bottom-forward'
  | 'sync-size'
  | 'sync-size-track'
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
  { id: 'pin-bottom', label: 'Ghim đáy theo gốc (frame này)', scope: 'cluster' },
  {
    id: 'pin-bottom-forward',
    label: 'Ghim đáy theo gốc (frame này → cuối track)',
    scope: 'cluster',
  },
  { id: 'sync-size', label: 'Đồng bộ kích thước theo gốc (frame này)', scope: 'cluster' },
  { id: 'sync-size-track', label: 'Đồng bộ kích thước theo gốc (mọi frame)', scope: 'cluster' },
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

/* ---------------------------------------------------------------- multi-frame planning */

/** Upper bound on frames one multi-frame action may touch (each frame is one native undo step). */
export const MAX_MULTI_FRAME_WRITES = 2000;

/**
 * Frames at which a target track must hold a keyframe so its bottom follows the source from
 * `frame` on: `frame` plus every later keyframe of either track. Between those frames both boxes
 * interpolate linearly, so `z - H/2` of the target stays on the source's bottom plane.
 */
export function forwardPinFrames(
  frame: number,
  targetKeyframes: readonly number[],
  sourceKeyframes: readonly number[]
): number[] {
  const frames = new Set<number>([frame]);
  for (const k of [...targetKeyframes, ...sourceKeyframes]) if (k > frame) frames.add(k);
  return [...frames].sort((a, b) => a - b);
}

/** Target box at one frame standing on the source's bottom plane, keeping its own H. */
export function pinBottomPoints(
  target: readonly number[],
  source: readonly number[]
): number[] | null {
  if (target.length < 9 || source.length < 9) return null;
  const next = [...target];
  next[2] = source[2]! - source[8]! / 2 + target[8]! / 2;
  return next;
}

/** Target box at one frame taking the source's L/W/H while keeping its own bottom plane. */
export function syncSizePoints(
  target: readonly number[],
  size: readonly [number, number, number]
): number[] | null {
  if (target.length < 9) return null;
  const next = [...target];
  next[2] = target[2]! - target[8]! / 2 + size[2] / 2;
  next[6] = size[0];
  next[7] = size[1];
  next[8] = size[2];
  return next;
}

/* ---------------------------------------------------------------- filters (JSONLogic) */

export type JsonLogic = Record<string, unknown>;

function sortedUnique(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((x, y) => x - y);
}

/** One `ObjectID == id` rule, exactly as CVAT's filter builder writes it. */
function objectIdRule(id: number): JsonLogic {
  return { '==': [{ var: 'objectID' }, id] };
}

/**
 * CVAT's `objectID` filter field is the object's clientID (the id shown in the sidebar). The
 * filter is an OR group of `ObjectID == id` rules: that is what CVAT's own Filter dialog produces
 * and can load back (`QbUtils.loadFromJsonLogic`), so the result shows up and stays editable in
 * CVAT's Filter UI instead of an opaque Meow-only expression.
 */
export function objectIdLogic(ids: Iterable<number>): JsonLogic {
  return { or: sortedUnique(ids).map(objectIdRule) };
}

function ruleKey(rule: unknown): string {
  return JSON.stringify(rule);
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

/**
 * `current OR ObjectID == id ...`; the optional keypoint filter (index 1) is preserved. When the
 * current filter already is an OR group the new rules are appended to it (no nesting, no
 * duplicates), so repeated "add" keeps one flat group in CVAT's Filter dialog.
 */
export function composeAddFilter(current: readonly unknown[], ids: Iterable<number>): unknown[] {
  const { logic, asString } = parseLogic(current[0]);
  const rules = objectIdLogic(ids).or as JsonLogic[];
  let merged: JsonLogic;
  if (!hasLogic(logic)) {
    merged = { or: rules };
  } else {
    const keys = Object.keys(logic);
    const existing: unknown[] =
      keys.length === 1 && keys[0] === 'or' && Array.isArray(logic.or) ? [...logic.or] : [logic];
    const seen = new Set(existing.map(ruleKey));
    for (const rule of rules) if (!seen.has(ruleKey(rule))) existing.push(rule);
    merged = { or: existing };
  }
  return [asString ? JSON.stringify(merged) : merged, ...current.slice(1)];
}

/** Replace the object filter with `ObjectID == id` rules for the selection. */
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
    if (
      def.id === 'pin-bottom' ||
      def.id === 'pin-bottom-forward' ||
      def.id === 'sync-size' ||
      def.id === 'sync-size-track'
    )
      return ctx.hasSource;
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

interface RunScope {
  readonly frame: number;
  readonly job: CvatJobLike;
}

const ABORTED = 'Đã đổi frame trong lúc xử lý, thao tác bị hủy (chưa ghi gì)';

export class MultiObjectRunner {
  public readonly filterHistory = new FilterHistory();
  private busy = false;
  private scope: RunScope | null = null;

  public constructor(private readonly host: MultiActionHost) {}

  public get isBusy(): boolean {
    return this.busy;
  }

  /** True while the frame and job captured at the start of the action are still current. */
  private isCurrent(): boolean {
    const scope = this.scope;
    if (!scope) return false;
    const ctx = readCvatContext(this.host.getStore());
    return ctx.frame === scope.frame && ctx.job === scope.job;
  }

  private async resolveStates(
    ids: readonly number[]
  ): Promise<{ states: Map<number, CvatObjectStateLike>; missing: number } | null> {
    const scope = this.scope!;
    const ctx = readCvatContext(this.host.getStore());
    const wanted = new Set(ids);
    const states = new Map<number, CvatObjectStateLike>();
    const take = (list: readonly CvatObjectStateLike[]): void => {
      for (const state of list) {
        if (
          typeof state.clientID === 'number' &&
          wanted.has(state.clientID) &&
          !states.has(state.clientID) &&
          (state.frame === undefined || state.frame === scope.frame)
        )
          states.set(state.clientID, state);
      }
    };
    take(ctx.states);
    if (states.size < wanted.size) {
      const all = await readUnfilteredFrameStates(this.host.getStore());
      if (!this.isCurrent()) return null;
      take(all ?? []);
    }
    return { states, missing: wanted.size - states.size };
  }

  private async commit(
    writes: readonly StateWrite[],
    strict: boolean
  ): Promise<WriteSummary | null> {
    const scope = this.scope!;
    if (!this.isCurrent()) {
      this.host.toast(ABORTED, 'error');
      return null;
    }
    const ctx = readCvatContext(this.host.getStore());
    const summary = await writeStatesAtFrame(writes, scope.frame, {
      job: scope.job,
      lastFrame: ctx.lastFrame,
      strict,
    });
    if (summary.written > 0 || summary.pinnedNeighbors > 0) {
      const refreshed = await refreshCvatAnnotations(
        this.host.getStore(),
        { frame: scope.frame, job: scope.job },
        ctx.groundTruthShown ? 'update' : 'fetch'
      );
      this.host.afterWrite();
      if (refreshed === 'failed')
        this.host.toast(
          'Đã ghi vào CVAT nhưng chưa làm mới giao diện; hãy đổi frame để cập nhật',
          'info'
        );
    }
    return summary;
  }

  private report(summary: WriteSummary, doneText: string, extra: string[] = []): void {
    const notes = [...extra];
    if (summary.skippedLocked) notes.push(`${summary.skippedLocked} object bị khóa`);
    if (summary.skippedOutside) notes.push(`${summary.skippedOutside} object outside`);
    if (summary.failed) notes.push(`${summary.failed} lỗi ghi`);
    if (summary.historyMode === 'per-object' && summary.undoSteps > 1)
      notes.push(`bản CVAT này không gộp undo: cần Ctrl+Z ${summary.undoSteps} lần`);
    if (summary.refused) {
      this.host.toast(
        `Đã hủy, chưa ghi gì (${notes.join(', ') || 'object không ghi được'})`,
        'error'
      );
      return;
    }
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
      const ctx = readCvatContext(this.host.getStore());
      const isWrite = !id.startsWith('filter');
      if (isWrite && ctx.workspace === 'Review') {
        this.host.toast('Không sửa được object trong workspace Review', 'error');
        return false;
      }
      if (ctx.frame === null || !ctx.job) {
        this.host.toast('Không đọc được frame hiện tại', 'error');
        return false;
      }
      this.scope = { frame: ctx.frame, job: ctx.job };
      return await this.dispatch(id, selection, activeID);
    } catch (error: unknown) {
      this.host.toast(error instanceof Error ? error.message : 'Thao tác thất bại', 'error');
      return false;
    } finally {
      this.scope = null;
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
      case 'pin-bottom-forward':
      case 'sync-size-track':
        return this.runClusterFrames(id, selection, activeID);
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
    const resolved = await this.resolveStates([pair.first, pair.second]);
    if (!resolved) {
      this.host.toast(ABORTED, 'error');
      return false;
    }
    const { states, missing } = resolved;
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
    // A swap must be all-or-nothing: writing only one side would duplicate geometry.
    const summary = await this.commit(plan.writes, true);
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
    const resolved = await this.resolveStates([activeID, ...others]);
    if (!resolved) {
      this.host.toast(ABORTED, 'error');
      return false;
    }
    const { states, missing } = resolved;
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
    const summary = await this.commit(plan.writes, false);
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

  /**
   * Cluster edits over many frames. Each frame is written through the same official path
   * (`saveStates`), so every written frame is one native undo step; the toast says how many.
   * - `sync-size-track`: every keyframe of each same-label target track takes the source's L/W/H
   *   (from the current frame) and keeps its own bottom. Only existing keyframes are written, so
   *   interpolated frames follow without new keyframes. Shapes are written on this frame only.
   * - `pin-bottom-forward`: from this frame to the end, each target stands on the source's bottom
   *   at this frame and at every later keyframe of either track (see `forwardPinFrames`); frame
   *   f-1 is pinned first when interpolated so earlier frames do not move.
   */
  private async runClusterFrames(
    id: 'pin-bottom-forward' | 'sync-size-track',
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
    const scope = this.scope!;
    const others = selection.filter((x) => x !== activeID);
    const resolved = await this.resolveStates([activeID, ...others]);
    if (!resolved) {
      this.host.toast(ABORTED, 'error');
      return false;
    }
    const source = resolved.states.get(activeID);
    const sourcePoints = source?.points;
    if (!source || !sourcePoints || sourcePoints.length < 9 || source.outside) {
      this.host.toast('Object gốc không có hộp 3D hợp lệ trên frame hiện tại', 'error');
      return false;
    }
    const keyframesOf = (state: CvatObjectStateLike): number[] | null => {
      if (state.objectType !== 'track') return null;
      try {
        return trackKeyframes(state);
      } catch {
        return null;
      }
    };
    const sourceKeyframes = keyframesOf(source) ?? [];
    const size: [number, number, number] = [sourcePoints[6]!, sourcePoints[7]!, sourcePoints[8]!];

    // frame -> clientIDs to write there, plus f-1 pins for the forward pin
    const plan = new Map<number, Set<number>>();
    const pinPrevious = new Set<number>();
    const add = (frame: number, clientID: number): void => {
      if (frame < 0 || (scope.job.stopFrame !== undefined && frame > scope.job.stopFrame)) return;
      let ids = plan.get(frame);
      if (!ids) plan.set(frame, (ids = new Set()));
      ids.add(clientID);
    };
    let skippedLabel = 0;
    let onlyThisFrame = 0;
    for (const otherID of others) {
      const target = resolved.states.get(otherID);
      if (!target) continue;
      if (id === 'sync-size-track' && !sameLabel(source, target)) {
        skippedLabel += 1;
        continue;
      }
      const keyframes = keyframesOf(target);
      if (!keyframes) {
        add(scope.frame, otherID);
        if (target.objectType === 'track') onlyThisFrame += 1;
        continue;
      }
      if (id === 'sync-size-track') {
        add(scope.frame, otherID);
        for (const k of keyframes) add(k, otherID);
      } else {
        for (const k of forwardPinFrames(scope.frame, keyframes, sourceKeyframes)) add(k, otherID);
        if (!keyframes.includes(scope.frame - 1)) pinPrevious.add(otherID);
      }
    }
    const frames = [...plan.keys()].sort((a, b) => a - b);
    if (!frames.length) {
      this.host.toast(
        skippedLabel
          ? `Không có object cùng label (bỏ qua ${skippedLabel})`
          : 'Chưa chọn object đích',
        'error'
      );
      return false;
    }
    if (frames.length + (pinPrevious.size ? 1 : 0) > MAX_MULTI_FRAME_WRITES) {
      this.host.toast(
        `Quá nhiều frame (${frames.length}); giới hạn ${MAX_MULTI_FRAME_WRITES} frame mỗi thao tác`,
        'error'
      );
      return false;
    }
    if (!this.isCurrent()) {
      this.host.toast(ABORTED, 'error');
      return false;
    }

    const ctx = readCvatContext(this.host.getStore());
    const total: WriteSummary = {
      written: 0,
      pinnedNeighbors: 0,
      skippedLocked: 0,
      skippedOutside: 0,
      failed: 0,
      refused: false,
      historyMode: 'none',
      undoSteps: 0,
    };
    const touched = new Set<number>();
    let sourceMissing = 0;
    const writeFrame = async (frame: number, writes: StateWrite[]): Promise<void> => {
      if (!writes.length) return;
      const summary = await writeStatesAtFrame(writes, frame, {
        job: scope.job,
        lastFrame: ctx.lastFrame,
        pinNeighbors: false,
      });
      total.written += summary.written;
      total.skippedLocked += summary.skippedLocked;
      total.skippedOutside += summary.skippedOutside;
      total.failed += summary.failed;
      total.undoSteps += summary.undoSteps;
      if (summary.historyMode !== 'none') total.historyMode = summary.historyMode;
      if (summary.written > 0) for (const w of writes) touched.add(w.state.clientID as number);
    };

    // Pin frame f-1 to its current (interpolated) values so earlier frames keep their geometry.
    if (pinPrevious.size && scope.frame - 1 >= 0) {
      const prevStates = await readFrameStates(scope.job, scope.frame - 1);
      const pins: StateWrite[] = [];
      for (const state of prevStates ?? []) {
        if (typeof state.clientID !== 'number' || !pinPrevious.has(state.clientID)) continue;
        if (state.outside || state.keyframe || !state.points || state.points.length < 9) continue;
        pins.push({ state, points: [...state.points] });
      }
      const before = total.written;
      await writeFrame(scope.frame - 1, pins);
      total.pinnedNeighbors += total.written - before;
      total.written = before;
    }

    for (const frame of frames) {
      const states = await readFrameStates(scope.job, frame);
      if (!states) {
        total.failed += plan.get(frame)!.size;
        continue;
      }
      const byId = new Map<number, CvatObjectStateLike>();
      for (const state of states)
        if (typeof state.clientID === 'number') byId.set(state.clientID, state);
      const sourceAt = byId.get(activeID);
      const writes: StateWrite[] = [];
      for (const clientID of plan.get(frame)!) {
        const target = byId.get(clientID);
        if (!target?.points || target.outside) continue;
        let next: number[] | null;
        if (id === 'sync-size-track') {
          next = syncSizePoints(target.points, size);
        } else {
          if (!sourceAt?.points || sourceAt.outside) {
            sourceMissing += 1;
            continue;
          }
          next = pinBottomPoints(target.points, sourceAt.points);
        }
        if (next) writes.push({ state: target, points: next });
      }
      await writeFrame(frame, writes);
    }

    if (total.written > 0 || total.pinnedNeighbors > 0) {
      if (this.isCurrent()) {
        await refreshCvatAnnotations(
          this.host.getStore(),
          { frame: scope.frame, job: scope.job },
          ctx.groundTruthShown ? 'update' : 'fetch'
        );
      }
      this.host.afterWrite();
    }
    const notes: string[] = [];
    if (skippedLabel) notes.push(`bỏ qua ${skippedLabel} object khác label`);
    if (onlyThisFrame)
      notes.push(`${onlyThisFrame} track không đọc được keyframe nên chỉ sửa frame này`);
    if (sourceMissing) notes.push(`${sourceMissing} lần gốc outside nên giữ nguyên`);
    if (total.undoSteps > 1)
      notes.push(`hoàn tác cần Ctrl+Z ${total.undoSteps} lần (mỗi frame một bước)`);
    this.report(
      total,
      `${id === 'pin-bottom-forward' ? 'Đã ghim đáy' : 'Đã đồng bộ kích thước'} ${touched.size} object trên ${frames.length} frame`,
      notes
    );
    return total.written > 0;
  }

  private async runHidden(hide: boolean, selection: readonly number[]): Promise<boolean> {
    const resolved = await this.resolveStates(selection);
    if (!resolved) {
      this.host.toast(ABORTED, 'error');
      return false;
    }
    const { states, missing } = resolved;
    const writes: StateWrite[] = [...states.values()].map((state) => ({ state, hidden: hide }));
    if (!writes.length) {
      this.host.toast('Không tìm thấy object trên frame hiện tại', 'error');
      return false;
    }
    // Locked objects are skipped: cvat-core's save() is a no-op for them (and reported as locked).
    const summary = await this.commit(writes, false);
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
    let popped: readonly unknown[] | undefined;
    if (id === 'filter-restore') {
      const previous = this.filterHistory.pop();
      if (!previous) {
        this.host.toast('Không có filter trước đó để khôi phục', 'info');
        return false;
      }
      popped = previous;
      next = previous;
    } else {
      if (!selection.length) return false;
      next =
        id === 'filter-add' ? composeAddFilter(current, selection) : composeOnlyFilter(selection);
    }
    const ok = await applyCvatFilters(store, next);
    if (ok && id !== 'filter-restore') this.filterHistory.push(current);
    else if (!ok && popped) this.filterHistory.push(popped);
    this.host.afterWrite();
    this.host.toast(
      ok
        ? id === 'filter-restore'
          ? 'Đã trả về filter trước'
          : `Đã lọc ${selection.length} object`
        : 'Không áp dụng được filter (không truy cập được Redux/job của CVAT, hoặc đang hiển thị Ground truth)',
      ok ? 'success' : 'error'
    );
    return ok;
  }
}
