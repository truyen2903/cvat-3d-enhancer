import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OrthoViewMaximizer,
  resolveOrthoViewFromKeyEvent,
} from '../../src/integration/cvat/runtime/ortho-view-maximizer';

const press = (code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const ev = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

describe('Ortho view maximizer (keys 1/2/3)', () => {
  let uninstall: () => void = () => undefined;
  let maximizer: OrthoViewMaximizer;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="workspace">
        <div class="cvat-canvas3d-perspective"><canvas></canvas></div>
        <div class="cvat-canvas3d-orthographic-views">
          <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-topview" style="height: 50%"><canvas></canvas></div>
          <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-sideview"><canvas></canvas></div>
          <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-frontview"><canvas></canvas></div>
        </div>
      </div>
      <input id="txt" />`;
    maximizer = new OrthoViewMaximizer(document, window);
    uninstall = maximizer.install();
  });

  afterEach(() => {
    uninstall();
  });

  it('maps digit keys without modifiers only', () => {
    expect(resolveOrthoViewFromKeyEvent(new KeyboardEvent('keydown', { code: 'Digit1' }))).toBe('top');
    expect(resolveOrthoViewFromKeyEvent(new KeyboardEvent('keydown', { code: 'Numpad2' }))).toBe('side');
    expect(resolveOrthoViewFromKeyEvent(new KeyboardEvent('keydown', { code: 'Digit3' }))).toBe('front');
    expect(
      resolveOrthoViewFromKeyEvent(new KeyboardEvent('keydown', { code: 'Digit1', ctrlKey: true }))
    ).toBeNull();
    expect(resolveOrthoViewFromKeyEvent(new KeyboardEvent('keydown', { code: 'Digit4' }))).toBeNull();
  });

  it('toggles maximize on the same key and restores original inline styles', () => {
    const top = document.querySelector<HTMLElement>('.cvat-canvas3d-topview')!;
    const ev = press('Digit1');
    expect(ev.defaultPrevented).toBe(true);
    expect(maximizer.getMaximizedView()).toBe('top');
    expect(top.style.position).toBe('fixed');
    expect(top.classList.contains('cvat-3d-enhancer-view-maximized')).toBe(true);

    press('Digit1');
    expect(maximizer.getMaximizedView()).toBeNull();
    expect(top.style.position).toBe('');
    expect(top.style.height).toBe('50%');
    expect(top.classList.contains('cvat-3d-enhancer-view-maximized')).toBe(false);
  });

  it('switches directly between views and restores with Escape', () => {
    const top = document.querySelector<HTMLElement>('.cvat-canvas3d-topview')!;
    const side = document.querySelector<HTMLElement>('.cvat-canvas3d-sideview')!;
    press('Digit1');
    press('Digit2');
    expect(maximizer.getMaximizedView()).toBe('side');
    expect(top.style.position).toBe('');
    expect(side.style.position).toBe('fixed');

    press('Digit3');
    expect(maximizer.getMaximizedView()).toBe('front');
    expect(side.style.position).toBe('');

    press('Escape');
    expect(maximizer.getMaximizedView()).toBeNull();
  });

  it('ignores keys typed in inputs and when no 3D views exist', () => {
    const input = document.getElementById('txt')!;
    press('Digit1', {}, input);
    expect(maximizer.getMaximizedView()).toBeNull();

    document.querySelectorAll('.cvat-canvas3d-orthographic-view').forEach((el) => el.remove());
    const ev = press('Digit1');
    expect(ev.defaultPrevented).toBe(false);
    expect(maximizer.getMaximizedView()).toBeNull();
  });
});
