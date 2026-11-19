/**
 * Opt-in timing probe for diagnosing lag on real CVAT jobs.
 *
 * Disabled by default: every probe call is a single boolean check. Enable from the page console:
 *   meowPerf.start()   // reset counters and start measuring (persists across reloads)
 *   meowPerf.report()  // print a table of where time went (CVAT native vs Meow)
 *   meowPerf.stop()    // stop measuring and forget the setting
 */

interface PerfStat {
  count: number;
  totalMs: number;
  maxMs: number;
}

const STORAGE_KEY = 'meowPerf';
export const PERF_FRAME_SPAN = 'span.frameLoad (image_changed→canvas.setup)';
export const PERF_CLICK_SPAN = 'span.click→shape_activated';
const stats = new Map<string, PerfStat>();
const marks = new Map<string, number>();
let enabled = false;
let longTaskMs = 0;
let longTaskCount = 0;
let longTaskObserver: PerformanceObserver | null = null;
let startedAt = 0;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function isPerfProbeEnabled(): boolean {
  return enabled;
}

export function recordPerf(name: string, ms: number): void {
  if (!enabled) return;
  const stat = stats.get(name);
  if (stat) {
    stat.count += 1;
    stat.totalMs += ms;
    if (ms > stat.maxMs) stat.maxMs = ms;
  } else {
    stats.set(name, { count: 1, totalMs: ms, maxMs: ms });
  }
}

/** Times `fn` under `name` when the probe is enabled; otherwise just calls it. */
export function timePerf<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = now();
  try {
    return fn();
  } finally {
    recordPerf(name, now() - start);
  }
}

/** Starts a user-visible interval (e.g. frame load) that `endPerfSpan` closes. */
export function beginPerfSpan(name: string): void {
  if (enabled) marks.set(name, now());
}

export function endPerfSpan(name: string): void {
  if (!enabled) return;
  const start = marks.get(name);
  if (start === undefined) return;
  marks.delete(name);
  recordPerf(name, now() - start);
}

function startLongTaskObserver(): void {
  if (longTaskObserver || typeof PerformanceObserver === 'undefined') return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskMs += entry.duration;
        longTaskCount += 1;
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: false });
  } catch {
    longTaskObserver = null;
  }
}

function reset(): void {
  stats.clear();
  marks.clear();
  longTaskMs = 0;
  longTaskCount = 0;
  startedAt = now();
}

export function setPerfProbeEnabled(next: boolean): void {
  enabled = next;
  if (next) {
    reset();
    startLongTaskObserver();
  } else {
    longTaskObserver?.disconnect();
    longTaskObserver = null;
  }
}

export interface PerfReportRow {
  readonly name: string;
  readonly count: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
}

export function getPerfReport(): PerfReportRow[] {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return [...stats.entries()]
    .map(([name, stat]) => ({
      name,
      count: stat.count,
      totalMs: round(stat.totalMs),
      avgMs: round(stat.totalMs / stat.count),
      maxMs: round(stat.maxMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Exposes `window.meowPerf` and restores the enabled state from localStorage. */
export function installPerfProbeConsole(win: Window): () => void {
  try {
    if (win.localStorage.getItem(STORAGE_KEY) === '1') setPerfProbeEnabled(true);
  } catch {
    // Storage may be blocked; the console API still works for this page load.
  }
  const api = {
    start: (): string => {
      setPerfProbeEnabled(true);
      try {
        win.localStorage.setItem(STORAGE_KEY, '1');
      } catch {
        // Ignore storage errors
      }
      return 'Meow perf probe: đang đo. Thao tác (Next frame, click…) rồi gõ meowPerf.report()';
    },
    stop: (): string => {
      setPerfProbeEnabled(false);
      try {
        win.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore storage errors
      }
      return 'Meow perf probe: đã tắt';
    },
    reset: (): string => {
      reset();
      return 'Meow perf probe: đã xóa số liệu';
    },
    report: (): PerfReportRow[] => {
      const rows = getPerfReport();
      const elapsed = Math.round(now() - startedAt);
      console.log(
        `[Meow perf] ${elapsed} ms đã đo; long tasks: ${longTaskCount} lần, ${Math.round(longTaskMs)} ms. ` +
          'cvat.* = code gốc CVAT (có thể gồm hook Meow bên trong), meow.* = riêng Meow.'
      );
      console.table(rows);
      return rows;
    },
  };
  (win as unknown as { meowPerf?: typeof api }).meowPerf = api;
  return () => {
    setPerfProbeEnabled(false);
    delete (win as unknown as { meowPerf?: typeof api }).meowPerf;
  };
}
