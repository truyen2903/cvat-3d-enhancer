import { afterEach, describe, expect, it, vi } from 'vitest';
import { showMeowToast } from '../../src/integration/cvat/runtime/meow-toast';

describe('Meow toast notifications', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('acknowledges immediately, updates in place, and auto-dismisses on success', () => {
    vi.useFakeTimers();
    const toast = showMeowToast(document, 'Đang xử lý…', 'loading');
    const stack = document.getElementById('meow-toast-stack')!;
    expect(stack.getAttribute('aria-live')).toBe('polite');
    expect(stack.style.pointerEvents).toBe('none');
    expect(stack.textContent).toContain('Đang xử lý…');
    vi.advanceTimersByTime(10000);
    expect(stack.childElementCount).toBe(1);

    toast.update('Xong', 'success');
    expect(stack.textContent).toContain('Xong');
    expect(stack.firstElementChild?.getAttribute('data-kind')).toBe('success');
    vi.advanceTimersByTime(3000);
    expect(stack.childElementCount).toBe(0);
  });

  it('caps the visible stack', () => {
    for (let i = 0; i < 10; i += 1) showMeowToast(document, `t${i}`, 'loading');
    const stack = document.getElementById('meow-toast-stack')!;
    expect(stack.childElementCount).toBe(4);
    expect(stack.lastElementChild?.textContent).toContain('t9');
  });
});
