import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPerfSpan,
  endPerfSpan,
  getPerfReport,
  installPerfProbeConsole,
  isPerfProbeEnabled,
  setPerfProbeEnabled,
  timePerf,
} from '../../src/integration/cvat/runtime/perf-probe';

type ProbeApi = {
  start: () => string;
  stop: () => string;
  reset: () => string;
  report: () => ReturnType<typeof getPerfReport>;
};

afterEach(() => {
  setPerfProbeEnabled(false);
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('perf probe', () => {
  it('is disabled by default and records nothing', () => {
    expect(isPerfProbeEnabled()).toBe(false);
    expect(timePerf('meow.x', () => 7)).toBe(7);
    beginPerfSpan('span');
    endPerfSpan('span');
    expect(getPerfReport()).toEqual([]);
  });

  it('records counts, totals and spans when enabled, and rethrows errors', () => {
    setPerfProbeEnabled(true);
    timePerf('meow.a', () => undefined);
    timePerf('meow.a', () => undefined);
    expect(() =>
      timePerf('cvat.b', () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    beginPerfSpan('span.frame');
    endPerfSpan('span.frame');
    endPerfSpan('span.frame');
    const rows = Object.fromEntries(getPerfReport().map((row) => [row.name, row.count]));
    expect(rows).toEqual({ 'meow.a': 2, 'cvat.b': 1, 'span.frame': 1 });
  });

  it('exposes a console API that persists the enabled state and cleans up', () => {
    const remove = installPerfProbeConsole(window);
    const api = (window as unknown as { meowPerf: ProbeApi }).meowPerf;
    api.start();
    expect(isPerfProbeEnabled()).toBe(true);
    expect(window.localStorage.getItem('meowPerf')).toBe('1');
    timePerf('meow.c', () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
    expect(api.report().map((row) => row.name)).toEqual(['meow.c']);
    api.stop();
    expect(isPerfProbeEnabled()).toBe(false);
    expect(window.localStorage.getItem('meowPerf')).toBeNull();

    window.localStorage.setItem('meowPerf', '1');
    remove();
    const removeAgain = installPerfProbeConsole(window);
    expect(isPerfProbeEnabled()).toBe(true);
    removeAgain();
    expect(isPerfProbeEnabled()).toBe(false);
    expect((window as unknown as { meowPerf?: ProbeApi }).meowPerf).toBeUndefined();
  });
});
