import { removeMeowUi } from '../../src/integration/cvat/runtime/meow-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showMeowToast } from '../../src/integration/cvat/runtime/meow-toast';

describe('Meow toast notifications', () => {
  afterEach(() => {
    removeMeowUi(document);
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('acknowledges immediately, updates in place, and auto-dismisses on success', () => {
    vi.useFakeTimers();
    const toast = showMeowToast(document, 'Đang xử lý…', 'loading');
    const stack = document.getElementById('meow-toast-stack')!;
    expect(stack.getAttribute('aria-live')).toBe('polite');
    expect(getComputedStyle(stack).pointerEvents).toBe('none');
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
    expect(stack.childElementCount).toBe(3);
    expect(stack.lastElementChild?.textContent).toContain('t9');
  });
  it('keeps evicted asynchronous updates out of the stack and retains full text in a title', () => {
    const oldest = showMeowToast(document, 'Cũ', 'loading');
    for (let i = 0; i < 3; i++) showMeowToast(document, `Mới ${i}`, 'loading');
    oldest.update('Kết quả cũ', 'success');
    const stack = document.getElementById('meow-toast-stack')!;
    expect(stack.children).toHaveLength(3);
    expect(stack.textContent).not.toContain('Kết quả cũ');
    expect(stack.lastElementChild?.getAttribute('title')).toBe('Mới 2');
  });

  it('leaves errors longer and cleans up timers on teardown', () => {
    vi.useFakeTimers();
    showMeowToast(document, 'Lỗi', 'error');
    vi.advanceTimersByTime(3000);
    expect(document.querySelector('.meow-toast')).not.toBeNull();
    vi.advanceTimersByTime(2100);
    expect(document.querySelector('.meow-toast')).toBeNull();
    const pending = showMeowToast(document, 'Đang xử lý', 'loading');
    removeMeowUi(document);
    pending.update('Xong', 'success');
    expect(document.getElementById('meow-toast-stack')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
