import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackGhostOverlay } from '../../src/integration/cvat/runtime/track-ghost-overlay';
import type { CvatObjectStateLike } from '../../src/integration/cvat/runtime/pre-render-enhancer';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
  const context = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
  const exportTrack = vi.fn(() => ({
    shapes: [0, 4].map((frame) => ({ frame, points: [frame, 0, 0, 0, 0, 0, 4, 2, 1] })),
  }));
  const state: CvatObjectStateLike = {
    clientID: 1,
    frame: 2,
    objectType: 'track',
    shapeType: 'cuboid',
    points: [2, 0, 0, 0, 0, 0, 4, 2, 1],
    __internal: { export: exportTrack },
  };
  const resolve = vi.fn(() => ({ state, canvas }));
  let enabled = true;
  const ghosts = new TrackGhostOverlay(document, () => enabled, resolve);
  const hold = () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', altKey: true, cancelable: true })
    );
  return {
    ghosts,
    canvas,
    hold,
    exportTrack,
    resolve,
    context,
    disable: () => {
      enabled = false;
    },
  };
}

const identity = { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };

describe('held track ghosts', () => {
  it.each(['release', 'alt release', 'blur', 'frame', 'object', 'disable'] as const)(
    'cleans up on %s',
    (reason) => {
      const { ghosts, hold, disable } = setup();
      hold();
      expect(document.querySelector('.meow-track-ghosts')).not.toBeNull();
      if (reason === 'release') window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG' }));
      if (reason === 'alt release')
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      if (reason === 'frame') ghosts.contextChanged(3, 1);
      if (reason === 'object') ghosts.contextChanged(2, 7);
      if (reason === 'disable') {
        disable();
        ghosts.refreshEnabled();
      }
      expect(document.querySelector('.meow-track-ghosts')).toBeNull();
      ghosts.dispose();
    }
  );
  it('reuses geometry, overlay, context and projection buffers across render ticks; idle never reads tracks', () => {
    const { ghosts, canvas, hold, exportTrack, resolve, context } = setup();
    const camera = { projectionMatrix: identity, matrixWorldInverse: identity };
    ghosts.render(canvas, camera);
    expect(resolve).not.toHaveBeenCalled();
    hold();
    const overlay = document.querySelector('.meow-track-ghosts');
    const create = vi.spyOn(document, 'createElement');
    for (let i = 0; i < 100; i++) ghosts.render(canvas, camera);
    expect(exportTrack).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector('.meow-track-ghosts')).toBe(overlay);
    expect(context.stroke).toHaveBeenCalled();
    ghosts.dispose();
    hold();
    expect(document.querySelector('.meow-track-ghosts')).toBeNull();
  });
  it('ignores editable targets, repeat and disabled option', () => {
    const { ghosts, hold, disable, exportTrack } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, code: 'KeyG', altKey: true })
    );
    expect(exportTrack).not.toHaveBeenCalled();
    disable();
    hold();
    expect(exportTrack).not.toHaveBeenCalled();
    ghosts.dispose();
  });
});
