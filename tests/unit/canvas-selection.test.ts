import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasSelectionController,
  SELECTION_HIGHLIGHT_COLOR,
  type CanvasSelectionHost,
} from '../../src/integration/cvat/runtime/canvas-selection';
import {
  pickNearestBox,
  type PickableBox,
  selectCentersInBox,
  type ProjectionCamera,
} from '../../src/integration/cvat/runtime/canvas-picking';
import type { CvatDrawnObjectEntry } from '../../src/integration/cvat/runtime/pre-render-enhancer';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Orthographic identity camera: world (x, y) in [-1, 1] maps onto the 200 x 200 canvas.
const camera: ProjectionCamera = {
  projectionMatrix: { elements: identity },
  matrixWorldInverse: { elements: identity },
  matrixWorld: { elements: identity },
};
const RECT = { left: 0, top: 0, width: 200, height: 200 };
const client = (x: number, y: number): [number, number] => [100 + x * 100, 100 - y * 100];

function entry(id: number, x: number, y: number): CvatDrawnObjectEntry {
  return {
    data: {
      clientID: id,
      points: [x, y, 0, 0, 0, 0, 0.2, 0.2, 0.2],
      labelColor: '#123456',
      color: '#123456',
    },
    cuboid: { setColor: vi.fn() },
  };
}

function setup(enabled = true) {
  document.body.innerHTML =
    '<div class="cvat-canvas3d-perspective"><canvas></canvas></div><div class="other"></div>';
  const canvas = document.querySelector('canvas')!;
  canvas.getBoundingClientRect = () => ({
    ...RECT,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON() {},
  });
  const entries: Record<number, CvatDrawnObjectEntry> = {
    1: entry(1, 0, 0), // client (100, 100)
    2: entry(2, 0.5, 0), // (150, 100)
    3: entry(3, -0.5, 0.5), // (50, 50)
    4: entry(4, 0.8, -0.8), // (180, 180)
  };
  let active: number | null = 1;
  const host = {
    isEnabled: vi.fn(() => enabled),
    isIdle: vi.fn(() => true),
    getFrame: vi.fn(() => 5),
    getActiveClientID: vi.fn(() => active),
    getCamera: vi.fn(() => camera),
    getDrawnObjects: vi.fn(() => entries),
    getDrawnEntry: vi.fn((id: number) => entries[id] ?? null),
    restoreColor: vi.fn((e: CvatDrawnObjectEntry) => e.cuboid.setColor?.(e.data.labelColor!)),
    listUnfilteredFrameObjects: vi.fn(async (): Promise<PickableBox[] | null> => null),
    filterHistorySize: vi.fn(() => 0),
    runAction: vi.fn(async () => undefined),
    activate: vi.fn(),
    toast: vi.fn(),
  } satisfies CanvasSelectionHost;
  const native = vi.fn();
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu'])
    canvas.addEventListener(type, native);
  const controller = new CanvasSelectionController(document, window, host);
  const fire = (
    type: string,
    [x, y]: [number, number],
    init: MouseEventInit = {},
    target: Element = canvas
  ): MouseEvent => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  const shiftClick = (at: [number, number], init: MouseEventInit = {}) => {
    fire('pointerdown', at, { shiftKey: true, ...init });
    fire('mousedown', at, { shiftKey: true, ...init });
    fire('mouseup', at, { shiftKey: true, ...init });
    return fire('click', at, { shiftKey: true, ...init });
  };
  const shiftDrag = (from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
    fire('mousedown', from, { shiftKey: true, ...init });
    fire('mousemove', to, { shiftKey: true, buttons: 1, ...init });
    fire('mouseup', to, { shiftKey: true, ...init });
  };
  return {
    canvas,
    entries,
    host,
    native,
    controller,
    fire,
    shiftClick,
    shiftDrag,
    setActive: (id: number | null) => (active = id),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('canvas picking math', () => {
  it('selects only centers projected inside the rectangle and ignores points behind the camera', () => {
    const boxes = [
      { id: 1, points: [0, 0, 0, 0, 0, 0, 1, 1, 1] },
      { id: 2, points: [0.9, 0.9, 0, 0, 0, 0, 1, 1, 1] },
      { id: 3, points: [0, 0, 5, 0, 0, 0, 1, 1, 1] },
    ];
    const rect = { left: 80, top: 80, right: 120, bottom: 120 };
    expect(selectCentersInBox(camera, RECT, boxes, rect)).toEqual([1]);
  });
  it('picks the nearest oriented box under the pointer', () => {
    const boxes = [
      { id: 1, points: [0, 0, -0.9, 0, 0, 0, 0.4, 0.4, 0.2] },
      { id: 2, points: [0, 0, -0.5, 0, 0, 0, 0.4, 0.4, 0.2] },
    ];
    // Orthographic camera looks down -z, so z = -0.5 is nearer than z = -0.9.
    expect(pickNearestBox(camera, RECT, 100, 100, boxes)).toBe(2);
    expect(pickNearestBox(camera, RECT, 190, 10, boxes)).toBeNull();
  });
});

describe('CanvasSelectionController', () => {
  it('Shift+click picks a target with the highlight color and blocks CVAT activation', () => {
    const { controller, shiftClick, native, entries } = setup();
    const click = shiftClick(client(0.5, 0));
    expect(controller.ids()).toEqual([2]);
    expect(entries[2]!.cuboid.setColor).toHaveBeenCalledWith(SELECTION_HIGHLIGHT_COLOR);
    expect(native).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    controller.dispose();
  });

  it('Shift+click on the selected target deselects it and picking another replaces it (max pair)', () => {
    const { controller, shiftClick, entries } = setup();
    shiftClick(client(0.5, 0));
    shiftClick(client(-0.5, 0.5));
    expect(controller.ids()).toEqual([3]);
    expect(entries[2]!.cuboid.setColor).toHaveBeenLastCalledWith('#123456');
    shiftClick(client(-0.5, 0.5));
    expect(controller.size).toBe(0);
    controller.dispose();
  });

  it('does not intercept without Shift, with other buttons or outside the canvas', () => {
    const { controller, fire, native, canvas } = setup();
    fire('pointerdown', client(0.5, 0));
    fire('mousedown', client(0.5, 0));
    fire('mouseup', client(0.5, 0));
    fire('click', client(0.5, 0));
    fire('mousedown', client(0.5, 0), { shiftKey: true, button: 2 });
    fire('mousedown', client(0.5, 0), { shiftKey: true }, document.querySelector('.other')!);
    expect(native).toHaveBeenCalledTimes(4 + 1);
    expect(controller.size).toBe(0);
    expect(canvas.isConnected).toBe(true);
    controller.dispose();
  });

  it('marquee also takes outside / filtered-out objects of the frame inside the rectangle', async () => {
    const t = setup();
    t.host.listUnfilteredFrameObjects.mockResolvedValueOnce([
      { id: 2, points: [0.5, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2] },
      { id: 50, points: [0.6, -0.2, 0, 0, 0, 0, 0.2, 0.2, 0.2] },
      { id: 51, points: [-0.9, -0.9, 0, 0, 0, 0, 0.2, 0.2, 0.2] },
    ]);
    t.shiftDrag([130, 70], [199, 199]);
    expect(t.controller.has(2)).toBe(true);
    expect(t.controller.has(4)).toBe(true);
    await vi.waitFor(() => expect(t.controller.has(50)).toBe(true));
    expect(t.controller.has(51)).toBe(false);
    t.controller.dispose();
  });

  it('marquee adds, then Shift+Alt removes, and never rotates the camera (events blocked)', () => {
    const { controller, shiftDrag, native, entries } = setup();
    shiftDrag([120, 80], [190, 190]); // box 2 (150,100) and 4 (180,180)
    expect(controller.ids().sort()).toEqual([2, 4]);
    expect(document.querySelector('.meow-selection-ui[aria-hidden]')).toBeNull();
    shiftDrag([30, 30], [70, 70]); // box 3 added
    expect(controller.ids().sort()).toEqual([2, 3, 4]);
    shiftDrag([120, 80], [160, 120], { altKey: true }); // remove box 2
    expect(controller.ids().sort()).toEqual([3, 4]);
    expect(native).not.toHaveBeenCalled();
    expect(entries[2]!.cuboid.setColor).toHaveBeenLastCalledWith('#123456');
    controller.dispose();
  });

  it('shows a marquee overlay only during the drag', () => {
    const { controller, fire, canvas } = setup();
    fire('mousedown', [10, 10], { shiftKey: true });
    fire('mousemove', [60, 60], { shiftKey: true, buttons: 1 });
    expect(document.querySelector('.meow-selection-ui')).not.toBeNull();
    fire('mouseup', [60, 60], { shiftKey: true });
    expect(document.querySelector('.meow-selection-ui[aria-hidden]')).toBeNull();
    expect(canvas.isConnected).toBe(true);
    controller.dispose();
  });

  it('shows a compact toolbar with three primary actions and accessible overflow', () => {
    const { controller, shiftClick, host } = setup();
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    shiftClick(client(0.5, 0));
    const toolbar = document.querySelector('[role="toolbar"]')!;
    expect(toolbar.textContent).toContain('1 chọn');
    expect(toolbar.querySelectorAll('button')).toHaveLength(5);
    expect(toolbar.querySelector('[data-action="swap-attributes"]')).toBeNull();
    toolbar.querySelector<HTMLButtonElement>('[data-action="filter-only"]')!.click();
    expect(host.runAction).toHaveBeenCalledWith('filter-only', [2]);
    controller.dispose();
  });

  it('focuses menu actions and restores the overflow trigger on Escape', () => {
    const { controller, shiftClick } = setup();
    shiftClick(client(0.5, 0));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click();
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(actions[0]);
    actions[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(actions[1]);
    actions[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(controller.ids()).toEqual([2]);
    controller.dispose();
  });

  it('groups applicable menu actions and closes the menu with Escape', () => {
    const { controller, shiftClick, fire } = setup();
    shiftClick(client(0.5, 0));
    fire('contextmenu', client(0.5, 0), { button: 2 });
    const menu = document.querySelector('[role="menu"]')!;
    expect(
      [...menu.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label'))
    ).toEqual(['Cặp', 'Lọc', 'Hiển thị', 'Theo gốc', 'Khác']);
    expect(menu.querySelector('[data-action="filter-restore"]')).toBeNull();
    expect(menu.querySelector('[data-action="swap-attributes"]')?.getAttribute('title')).toContain(
      'attribute'
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(controller.ids()).toEqual([2]);
    controller.dispose();
  });

  it('lists the static anchor action last in Theo gốc only when a source exists', () => {
    const { controller, shiftClick, fire, setActive } = setup();
    shiftClick(client(0.5, 0));
    fire('contextmenu', client(0.5, 0), { button: 2 });
    let menu = document.querySelector('[role="menu"]')!;
    const group = menu.querySelector('[role="group"][aria-label="Theo gốc"]')!;
    const item = group.querySelector('[data-action="place-by-anchor"]')!;
    expect(item.textContent).toBe('Đặt theo mốc tĩnh');
    expect(group.lastElementChild).toBe(item);
    expect(
      [...menu.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))
    ).toEqual(['Cặp', 'Lọc', 'Hiển thị', 'Theo gốc', 'Khác']);
    expect(
      document.querySelector('.meow-selection-toolbar [data-action="place-by-anchor"]')
    ).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    setActive(null);
    fire('contextmenu', client(0.5, 0), { button: 2 });
    menu = document.querySelector('[role="menu"]')!;
    expect(menu.querySelector('[data-action="place-by-anchor"]')).toBeNull();
    controller.dispose();
  });

  it('opens the Meow menu on right-click inside the selection and leaves CVAT alone otherwise', () => {
    const { controller, shiftClick, fire, host } = setup();
    const before = fire('contextmenu', client(0.5, 0), { button: 2 });
    expect(before.defaultPrevented).toBe(false);
    shiftClick(client(0.5, 0));
    const outside = fire('contextmenu', [5, 195], { button: 2 });
    expect(outside.defaultPrevented).toBe(false);
    const inside = fire('contextmenu', client(0.5, 0), { button: 2 });
    expect(inside.defaultPrevented).toBe(true);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.querySelector('[data-action="swap-geometry"]')?.getAttribute('title')).toBe(
      'Tráo vị trí + kích thước'
    );
    expect(menu.textContent).toContain('Chỉ cụm này');
    const swap = [...menu.querySelectorAll('button')].find(
      (b) => b.dataset.action === 'swap-geometry'
    )!;
    swap.click();
    expect(host.runAction).toHaveBeenCalledWith('swap-geometry', [2]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    controller.dispose();
  });

  it('offers "Đặt làm gốc" for another selected object under the cursor and activates it', () => {
    const { controller, fire, shiftClick, host } = setup();
    shiftClick(client(0.5, 0));
    fire('contextmenu', client(0.5, 0), { button: 2 });
    [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((b) => b.textContent === 'Đặt làm gốc')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.activate).toHaveBeenCalledWith(2);
    controller.dispose();
  });

  it('ignores a context menu that follows a right-button camera drag', () => {
    const { controller, shiftClick, fire } = setup();
    shiftClick(client(0.5, 0));
    fire('mousedown', client(0.5, 0), { button: 2 });
    const event = fire('contextmenu', [client(0.5, 0)[0] + 40, 100], { button: 2 });
    expect(event.defaultPrevented).toBe(false);
    controller.dispose();
  });

  it('Esc, frame change and activating another object clear the selection', () => {
    const { controller, shiftClick, setActive } = setup();
    shiftClick(client(0.5, 0));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(controller.size).toBe(0);

    shiftClick(client(0.5, 0));
    controller.contextChanged(6, 1);
    expect(controller.size).toBe(0);

    shiftClick(client(0.5, 0));
    controller.contextChanged(5, 1);
    expect(controller.size).toBe(1);
    setActive(3);
    controller.contextChanged(5, 3);
    expect(controller.size).toBe(0);
    controller.dispose();
  });

  it('keeps the selection when the source is changed through "Đặt làm gốc"', () => {
    const { controller, shiftClick, fire, setActive } = setup();
    shiftClick(client(0.5, 0));
    fire('contextmenu', client(0.5, 0), { button: 2 });
    [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((b) => b.textContent === 'Đặt làm gốc')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    setActive(2);
    controller.contextChanged(5, 2);
    expect(controller.size).toBe(1);
    controller.dispose();
  });

  it('adds surroundings from unfiltered frame data and reports the fallback otherwise', async () => {
    const { controller, shiftClick, fire, host } = setup();
    shiftClick(client(0.5, 0));
    host.listUnfilteredFrameObjects.mockResolvedValueOnce([
      { id: 2, points: [0.5, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2] },
      { id: 99, points: [0.6, 0.05, 0, 0, 0, 0, 0.2, 0.2, 0.2] }, // hidden by the CVAT filter
      { id: 98, points: [-0.9, -0.9, 0, 0, 0, 0, 0.2, 0.2, 0.2] },
    ]);
    fire('contextmenu', client(0.5, 0), { button: 2 });
    [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((b) => b.dataset.action === 'add-surroundings')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(controller.has(99)).toBe(true));
    expect(controller.has(98)).toBe(false);
    expect(host.toast).toHaveBeenLastCalledWith(expect.stringContaining('bị filter'), 'success');
    controller.dispose();
  });

  it('does nothing while idle: plain pointer traffic never touches the host', () => {
    const { controller, fire, host } = setup();
    for (let i = 0; i < 50; i++) {
      fire('mousemove', [i, i]);
      fire('mousedown', [i, i]);
      fire('mouseup', [i, i]);
      fire('contextmenu', [i, i], { button: 2 });
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    controller.contextChanged(5, 1);
    controller.onCanvasSetup();
    for (const fn of [
      host.getCamera,
      host.getDrawnObjects,
      host.getDrawnEntry,
      host.getActiveClientID,
      host.getFrame,
      host.restoreColor,
    ])
      expect(fn).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('respects the Workspace switch and cleans up every listener and node on dispose', () => {
    const disabled = setup(false);
    disabled.shiftClick(client(0.5, 0));
    expect(disabled.controller.size).toBe(0);
    expect(disabled.native).toHaveBeenCalled();
    disabled.controller.dispose();

    const { controller, shiftClick, native, fire } = setup();
    shiftClick(client(0.5, 0));
    expect(document.querySelector('.meow-selection-ui')).not.toBeNull();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    controller.dispose();
    expect(removeSpy.mock.calls.filter(([, , capture]) => capture === true)).toHaveLength(9);
    expect(document.querySelector('.meow-selection-ui')).toBeNull();
    native.mockClear();
    fire('mousedown', client(0.5, 0), { shiftKey: true });
    expect(native).toHaveBeenCalledTimes(1);
    removeSpy.mockRestore();
  });
});

describe('CanvasSelectionController robustness and scope', () => {
  it('leaves Shift gestures on Top / Side / Front and zoomed ortho canvases to CVAT', () => {
    const { controller, host, shiftClick, shiftDrag } = setup();
    for (const cls of [
      'cvat-canvas3d-topview',
      'cvat-canvas3d-sideview',
      'cvat-canvas3d-frontview',
    ]) {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div class="${cls}"><canvas class="${cls}-c"></canvas></div>`
      );
      const ortho = document.querySelector<HTMLCanvasElement>(`.${cls}-c`)!;
      const native = vi.fn();
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'])
        ortho.addEventListener(type, native);
      const fire = (type: string, init: MouseEventInit = {}): MouseEvent => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 100,
          button: 0,
          shiftKey: true,
          ...init,
        });
        ortho.dispatchEvent(event);
        return event;
      };
      fire('pointerdown');
      const down = fire('mousedown');
      fire('mousemove', { buttons: 1, clientX: 140, clientY: 140 });
      const up = fire('mouseup', { clientX: 140, clientY: 140 });
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
      expect(native).toHaveBeenCalledTimes(3);
    }
    expect(controller.size).toBe(0);
    expect(host.getCamera).not.toHaveBeenCalled();
    expect(document.querySelector('.meow-selection-ui')).toBeNull();
    // the perspective canvas still works
    shiftClick(client(0.5, 0));
    shiftDrag(client(-0.6, 0.6), client(-0.4, 0.4));
    expect(controller.size).toBe(2);
    controller.dispose();
  });

  it('does not open the Meow context menu while CVAT is in a draw/merge/split mode', () => {
    const { controller, shiftClick, fire, host } = setup();
    shiftClick(client(0.5, 0));
    host.isIdle.mockReturnValue(false);
    const event = fire('contextmenu', client(0.5, 0), { button: 2 });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    controller.dispose();
  });

  it('refuses to run a menu action when CVAT left the idle mode after the menu opened', () => {
    const { controller, shiftClick, fire, host } = setup();
    shiftClick(client(0.5, 0));
    fire('contextmenu', client(0.5, 0), { button: 2 });
    host.isIdle.mockReturnValue(false);
    [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((b) => b.dataset.action === 'swap-geometry')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.runAction).not.toHaveBeenCalled();
    expect(host.toast).toHaveBeenLastCalledWith(expect.stringContaining('Thoát chế độ'), 'error');
    controller.dispose();
  });

  it('drops a marquee when the frame or mode changes before the button is released', () => {
    const { controller, fire, host } = setup();
    fire('mousedown', client(-0.9, 0.9), { shiftKey: true });
    fire('mousemove', client(0.9, -0.9), { shiftKey: true, buttons: 1 });
    host.getFrame.mockReturnValue(6);
    fire('mouseup', client(0.9, -0.9), { shiftKey: true });
    expect(controller.size).toBe(0);
    expect(document.querySelector('.meow-selection-ui')).toBeNull();

    host.getFrame.mockReturnValue(5);
    fire('mousedown', client(-0.9, 0.9), { shiftKey: true });
    fire('mousemove', client(0.9, -0.9), { shiftKey: true, buttons: 1 });
    host.isIdle.mockReturnValue(false);
    fire('mouseup', client(0.9, -0.9), { shiftKey: true });
    expect(controller.size).toBe(0);
    controller.dispose();
  });

  it('abandons a drag whose button was released outside the window', () => {
    const { controller, fire } = setup();
    fire('mousedown', client(-0.9, 0.9), { shiftKey: true });
    fire('mousemove', client(0.2, -0.2), { shiftKey: true, buttons: 1 });
    expect(document.querySelector('.meow-selection-ui')).not.toBeNull();
    fire('mousemove', client(0.3, -0.3), { shiftKey: true, buttons: 0 });
    expect(document.querySelector('.meow-selection-ui')).toBeNull();
    fire('mouseup', client(0.9, -0.9), { shiftKey: true });
    expect(controller.size).toBe(0);
    controller.dispose();
  });

  it('removes the marquee overlay and menu when disposed mid-gesture', () => {
    const { controller, fire, shiftClick } = setup();
    shiftClick(client(0.5, 0));
    fire('contextmenu', client(0.5, 0), { button: 2 });
    fire('mousedown', client(-0.9, 0.9), { shiftKey: true });
    fire('mousemove', client(0.2, -0.2), { shiftKey: true, buttons: 1 });
    controller.dispose();
    expect(document.querySelector('.meow-selection-ui')).toBeNull();
  });

  it('a marquee that catches nothing leaves an empty selection and no toolbar', () => {
    const { controller, shiftDrag } = setup();
    shiftDrag(client(0.9, 0.9), client(0.95, 0.95));
    expect(controller.size).toBe(0);
    expect(document.querySelector('.meow-selection-ui')).toBeNull();
    controller.dispose();
  });
});
