import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installSidebarQuickFilterGuard,
  resolveSidebarObjectContext,
  syncSidebarObjectDimension,
} from '../../src/integration/cvat/runtime/sidebar-enhancements';
import type { CvatObjectStateLike } from '../../src/integration/cvat/runtime/pre-render-enhancer';

afterEach(() => {
  document.body.innerHTML = '';
});
function cardWithState() {
  document.body.innerHTML =
    '<div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item"><span class="label">Car</span><button>Lock</button><input></div><button class="cvat-quick-filter-clear">Clear #1</button>';
  const card = document.getElementById('cvat-objects-sidebar-state-item-1')!;
  const points = [0, 0, 0, 0, 0, 0, 4, 2, 1.5];
  const save = vi.fn((_frame: number, value: CvatObjectStateLike) => value);
  const state: CvatObjectStateLike = {
    clientID: 1,
    shapeType: 'cuboid',
    objectType: 'track',
    frame: 0,
    points,
    attributes: {},
    updateFlags: {},
    __internal: {
      save,
      export: () => ({
        shapes: [
          { frame: 0, points: [...points] },
          { frame: 5, points: [0, 0, 0, 0, 0, 0, 3, 1, 1] },
        ],
      }),
    },
  };
  const refresh = vi.fn();
  const focus = vi.fn();
  Object.assign(card, {
    __reactFiber$company: {
      memoizedProps: { children: null },
      return: { memoizedProps: { objectState: state, refreshAnnotations: refresh, focus } },
    },
  });
  return { card, state, save, refresh, focus };
}

describe('custom CVAT sidebar integration', () => {
  it('resolves live ObjectState from sidebar React props without any canvas or Redux store', () => {
    const { state } = cardWithState();
    expect(resolveSidebarObjectContext(document, 1)?.state).toBe(state);
    expect(resolveSidebarObjectContext(document, 2)).toBeNull();
  });

  it.each(['H', 'W', 'L', 'FLIP_180'] as const)(
    'persists %s through the sidebar API and refreshes native annotations',
    async (dimension) => {
      const { save, refresh } = cardWithState();
      const result = await syncSidebarObjectDimension(document, 1, dimension);
      expect(result.syncedFrames).toBeGreaterThan(0);
      expect(save).toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledOnce();
    }
  );

  it('preserves CVAT native focus while blocking the combined filter handler', () => {
    const { card, focus } = cardWithState();
    const doubleClick = vi.fn(),
      click = vi.fn(),
      clear = vi.fn();
    card.addEventListener('dblclick', doubleClick);
    card.addEventListener('click', click);
    document.querySelector('.cvat-quick-filter-clear')!.addEventListener('click', clear);
    const remove = installSidebarQuickFilterGuard(document, window);
    try {
      const label = card.querySelector('.label')!;
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 2 }));
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(click).toHaveBeenCalledOnce();
      expect(doubleClick).not.toHaveBeenCalled();
      expect(focus).toHaveBeenCalledOnce();
      card.querySelector<HTMLButtonElement>('button')!.click();
      expect(click).toHaveBeenCalledTimes(2);
      document.querySelector<HTMLButtonElement>('.cvat-quick-filter-clear')!.click();
      expect(clear).toHaveBeenCalledOnce();
      card
        .querySelector('input')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(doubleClick).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect(doubleClick).toHaveBeenCalledTimes(2);
  });
  it('leaves double-click behavior intact if a custom build does not expose native focus', () => {
    document.body.innerHTML = '<div class="cvat-objects-sidebar-state-item">Car</div>';
    const card = document.querySelector('div')!;
    const native = vi.fn();
    card.addEventListener('dblclick', native);
    const remove = installSidebarQuickFilterGuard(document, window);
    try {
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(native).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });

  it('does not focus when double-clicking object buttons or label selectors', () => {
    const { card, focus } = cardWithState();
    const button = card.querySelector('button')!;
    const native = vi.fn();
    button.addEventListener('dblclick', native);
    const remove = installSidebarQuickFilterGuard(document, window);
    try {
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(native).toHaveBeenCalledOnce();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });
});
