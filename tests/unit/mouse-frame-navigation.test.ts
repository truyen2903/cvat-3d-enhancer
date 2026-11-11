import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMouseFrameNavigation } from '../../src/integration/cvat/runtime/mouse-frame-navigation';

const dispatch = (target: Element, type: string, button: number): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  target.dispatchEvent(event);
  return event;
};
const fixture = () => {
  window.history.replaceState({}, '', '/tasks/1/jobs/2');
  document.body.innerHTML =
    '<div class="cvat-canvas3d-perspective"><canvas></canvas></div><span class="cvat-player-previous-button"></span><span class="cvat-player-next-button"></span><input><div class="ant-modal"><span class="modal-target"></span></div>';
  const previous = vi.fn(),
    next = vi.fn();
  document.querySelector('.cvat-player-previous-button')!.addEventListener('click', previous);
  document.querySelector('.cvat-player-next-button')!.addEventListener('click', next);
  return { target: document.querySelector('canvas')!, previous, next };
};
const clickSide = (target: Element, button: number) => {
  const down = dispatch(target, 'pointerdown', button);
  dispatch(target, 'mousedown', button);
  dispatch(target, 'pointerup', button);
  dispatch(target, 'mouseup', button);
  const aux = dispatch(target, 'auxclick', button);
  return { down, aux };
};

afterEach(() => {
  window.history.replaceState({}, '', '/');
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('mouse side buttons for CVAT frames', () => {
  it('moves one frame per press using native controls and prevents browser navigation', () => {
    const { target, previous, next } = fixture();
    const uninstall = installMouseFrameNavigation(document, window, () => true);
    try {
      const back = clickSide(target, 3),
        forward = clickSide(target, 4);
      expect(previous).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledOnce();
      expect(back.down.defaultPrevented && back.aux.defaultPrevented).toBe(true);
      expect(forward.down.defaultPrevented && forward.aux.defaultPrevented).toBe(true);
      clickSide(target, 3);
      expect(previous).toHaveBeenCalledTimes(2);
    } finally {
      uninstall();
    }
  });

  it('uses the active CVAT filtered navigation control', () => {
    const { target, next } = fixture();
    document.querySelector('.cvat-player-next-button')!.className =
      'cvat-player-next-button-filtered';
    const uninstall = installMouseFrameNavigation(document, window, () => true);
    try {
      clickSide(target, 4);
      expect(next).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it('leaves buttons to the browser outside 3D jobs, when disabled, in input fields or in a modal', () => {
    const { target, previous } = fixture();
    let enabled = false;
    const uninstall = installMouseFrameNavigation(document, window, () => enabled);
    try {
      expect(clickSide(target, 3).down.defaultPrevented).toBe(false);
      enabled = true;
      expect(clickSide(document.querySelector('input')!, 3).down.defaultPrevented).toBe(false);
      expect(clickSide(document.querySelector('.modal-target')!, 3).down.defaultPrevented).toBe(
        false
      );
      window.history.replaceState({}, '', '/tasks/1');
      expect(clickSide(target, 3).down.defaultPrevented).toBe(false);
      window.history.replaceState({}, '', '/tasks/1/jobs/2');
      document.querySelector('.cvat-canvas3d-perspective')!.remove();
      expect(clickSide(document.body, 3).down.defaultPrevented).toBe(false);
      expect(previous).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it('does not intercept when the player control is missing or disabled', () => {
    const { target, previous } = fixture();
    const control = document.querySelector('.cvat-player-previous-button')!;
    const uninstall = installMouseFrameNavigation(document, window, () => true);
    try {
      control.setAttribute('aria-disabled', 'true');
      expect(clickSide(target, 3).down.defaultPrevented).toBe(false);
      control.remove();
      expect(clickSide(target, 3).down.defaultPrevented).toBe(false);
      expect(previous).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it('releases a button without auxclick and removes listeners on shutdown', () => {
    vi.useFakeTimers();
    const { target, previous } = fixture();
    const uninstall = installMouseFrameNavigation(document, window, () => true);
    dispatch(target, 'mousedown', 3);
    dispatch(target, 'mouseup', 3);
    vi.runAllTimers();
    clickSide(target, 3);
    expect(previous).toHaveBeenCalledTimes(2);
    uninstall();
    expect(clickSide(target, 3).down.defaultPrevented).toBe(false);
    expect(previous).toHaveBeenCalledTimes(2);
  });
});
