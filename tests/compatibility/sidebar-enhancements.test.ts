import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installSidebarEnhancements,
  installSidebarQuickFilterGuard,
  resolveSidebarObjectContext,
  sidebarHasRideState,
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
  const activateSingle = vi.fn();
  Object.assign(card, {
    __reactFiber$company: {
      memoizedProps: { children: null },
      return: {
        memoizedProps: { objectState: state, refreshAnnotations: refresh, focus, activateSingle },
      },
    },
  });
  return { card, state, save, refresh, focus, activateSingle };
}

describe('custom CVAT sidebar integration', () => {
  it('resolves live ObjectState from sidebar React props without any canvas or Redux store', () => {
    const { state } = cardWithState();
    expect(resolveSidebarObjectContext(document, 1)?.state).toBe(state);
    expect(resolveSidebarObjectContext(document, 2)).toBeNull();
  });
  it('refreshes customized sidebars with a fresh native state instead of a stale attribute snapshot', async () => {
    const { card, state, save } = cardWithState();
    const fresh: CvatObjectStateLike = { ...state, attributes: { 6260: 'true' } };
    save.mockReturnValue(fresh);
    const reset = vi.fn();
    state.updateFlags = { reset };
    const updateState = vi.fn();
    Object.assign(card, {
      __reactFiber$company: { memoizedProps: { objectState: state, updateState } },
    });
    await resolveSidebarObjectContext(document, 1)!.refresh!();
    expect(reset).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(0, state);
    expect(updateState).toHaveBeenCalledExactlyOnceWith(fresh);
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
    const { card, focus, activateSingle } = cardWithState();
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
      expect(activateSingle).toHaveBeenCalledOnce();
      expect(activateSingle.mock.invocationCallOrder[0]).toBeLessThan(
        focus.mock.invocationCallOrder[0]!
      );
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
  it('uses focusAndExpand on customized builds without invoking their combined filter handler', () => {
    const { card } = cardWithState();
    const focusAndExpand = vi.fn();
    Object.assign(card, { __reactFiber$company: { memoizedProps: { focusAndExpand } } });
    const native = vi.fn();
    card.addEventListener('dblclick', native);
    const remove = installSidebarQuickFilterGuard(document, window);
    try {
      card
        .querySelector('.label')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(focusAndExpand).toHaveBeenCalledOnce();
      expect(native).not.toHaveBeenCalled();
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

  it('resolves cardHint in O(1) with zero DOM queries and never calls querySelectorAll without cardHint', () => {
    const { card, state } = cardWithState();
    state.label = { attributes: [{ id: 6260, name: 'ride_state', mutable: true }] };

    const dataCard = document.createElement('div');
    dataCard.className = 'cvat-objects-sidebar-state-item';
    dataCard.dataset.clientId = '77';
    const dataState: CvatObjectStateLike = {
      clientID: 77,
      shapeType: 'cuboid',
      objectType: 'track',
    };
    Object.assign(dataCard, {
      __reactFiber$company: { memoizedProps: { objectState: dataState } },
    });
    document.body.appendChild(dataCard);

    const getByIdSpy = vi.spyOn(document, 'getElementById');
    const querySpy = vi.spyOn(document, 'querySelector');
    const queryAllSpy = vi.spyOn(document, 'querySelectorAll');

    try {
      expect(resolveSidebarObjectContext(document, 1, card)?.state).toBe(state);
      expect(sidebarHasRideState(document, 1, card)).toBe(true);
      expect(getByIdSpy).not.toHaveBeenCalled();
      expect(querySpy).not.toHaveBeenCalled();
      expect(queryAllSpy).not.toHaveBeenCalled();

      expect(resolveSidebarObjectContext(document, 1)?.state).toBe(state);
      expect(resolveSidebarObjectContext(document, 77)?.state).toBe(dataState);
      expect(resolveSidebarObjectContext(document, 9999)).toBeNull();
      expect(queryAllSpy).not.toHaveBeenCalled();
    } finally {
      getByIdSpy.mockRestore();
      querySpy.mockRestore();
      queryAllSpy.mockRestore();
    }
  });

  it('does not call target.closest on single clicks or primary-unrelated mouse buttons', () => {
    const { card } = cardWithState();
    const label = card.querySelector('.label')!;
    const closestSpy = vi.spyOn(label, 'closest');
    const remove = installSidebarQuickFilterGuard(document, window);
    try {
      label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1, button: 0 }));
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, button: 0 }));
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2, button: 2 }));
      expect(closestSpy).not.toHaveBeenCalled();
    } finally {
      remove();
      closestSpy.mockRestore();
    }
  });

  it('caches localStorage options and batches targeted sidebar mutations via requestAnimationFrame', async () => {
    const frames: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
    document.body.innerHTML = `
      <div class="cvat-objects-sidebar">
        <div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item">
          <span class="cvat-objects-sidebar-state-item-object-type-text">CUBOID TRACK</span>
        </div>
      </div>
      <div id="meow-toast-stack"></div>`;

    const dispose = installSidebarEnhancements(document, window);
    try {
      const initialReads = getItemSpy.mock.calls.length;
      expect(initialReads).toBeGreaterThan(0);

      // Unrelated toast mutation should not schedule a frame or re-parse storage
      document.getElementById('meow-toast-stack')!.appendChild(document.createElement('div'));
      await Promise.resolve();
      expect(frames).toHaveLength(0);
      expect(getItemSpy.mock.calls.length).toBe(initialReads);

      // Adding a new card in sidebar schedules one rAF and mounts without re-reading localStorage
      const newCard = document.createElement('div');
      newCard.id = 'cvat-objects-sidebar-state-item-2';
      newCard.className = 'cvat-objects-sidebar-state-item';
      newCard.innerHTML =
        '<span class="cvat-objects-sidebar-state-item-object-type-text">CUBOID TRACK</span>';
      document.querySelector('.cvat-objects-sidebar')!.appendChild(newCard);

      await Promise.resolve();
      expect(frames).toHaveLength(1);
      for (const cb of frames.splice(0)) cb(16);
      expect(newCard.querySelector('.cvat-3d-enhancer-dim-sync-row')).not.toBeNull();
      expect(getItemSpy.mock.calls.length).toBe(initialReads);
    } finally {
      dispose();
      rafSpy.mockRestore();
      getItemSpy.mockRestore();
    }
  });
});
