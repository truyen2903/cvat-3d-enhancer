import { afterEach, describe, expect, it, vi } from 'vitest';
import { QcMarginOverlay } from '../../src/integration/cvat/runtime/qc-margin-overlay';
import type { GuideCameraLike } from '../../src/integration/cvat/runtime/cuboid-base-guide';

afterEach(() => {
  document.body.replaceChildren();
  document.querySelectorAll('canvas.meow-qc-margin').forEach((el) => el.remove());
  vi.restoreAllMocks();
});

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const shrink = [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];
const camera: GuideCameraLike = {
  matrixWorldInverse: { elements: identity },
  projectionMatrix: { elements: shrink },
} as unknown as GuideCameraLike;
const box = [0, 0, 0, 0, 0, 0, 4, 2, 2];

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
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
  return { canvas, context, overlay: new QcMarginOverlay(document) };
}

const overlays = () => document.querySelectorAll<HTMLCanvasElement>('canvas.meow-qc-margin');

describe('QcMarginOverlay', () => {
  it('fills the outer and inner shell for a vehicles box', () => {
    const { canvas, context, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'vehicles' });
    expect(overlays()).toHaveLength(1);
    expect(context.fill).toHaveBeenCalledTimes(2);
  });

  it('draws nothing for an Animal box', () => {
    const { canvas, context, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'Animal' });
    expect(overlays()).toHaveLength(0);
    expect(context.fill).not.toHaveBeenCalled();
  });

  it('skips the redraw when nothing changed', () => {
    const { canvas, context, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'vehicles' });
    overlay.render(canvas, camera, { points: [...box], labelName: 'vehicles' });
    expect(context.fill).toHaveBeenCalledTimes(2);
  });

  it('redraws when the box size changes', () => {
    const { canvas, context, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'vehicles' });
    overlay.render(canvas, camera, { points: [0, 0, 0, 0, 0, 0, 5, 2, 2], labelName: 'vehicles' });
    expect(context.fill).toHaveBeenCalledTimes(4);
  });

  it('redraws when the label ratio changes', () => {
    const { canvas, context, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'vehicles' });
    overlay.render(canvas, camera, { points: box, labelName: 'pedestrian' });
    expect(context.fill).toHaveBeenCalledTimes(4);
  });

  it('clears once on null and hides the overlay', () => {
    const { canvas, context, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'vehicles' });
    context.clearRect.mockClear();
    overlay.render(canvas, camera, null);
    overlay.render(canvas, camera, null);
    expect(context.clearRect).toHaveBeenCalledTimes(1);
    expect(overlays()[0]!.style.display).toBe('none');
  });

  it('survives invalid points and corners behind the camera', () => {
    const { canvas, context, overlay } = setup();
    expect(() =>
      overlay.render(canvas, camera, {
        points: [0, 0, 0, 0, 0, 0, 4, NaN, 2],
        labelName: 'vehicles',
      })
    ).not.toThrow();
    expect(context.fill).not.toHaveBeenCalled();
    const behind = {
      matrixWorldInverse: { elements: identity },
      projectionMatrix: { elements: [...shrink.slice(0, 15), -1] },
    } as unknown as GuideCameraLike;
    expect(() =>
      overlay.render(canvas, behind, { points: box, labelName: 'vehicles' })
    ).not.toThrow();
  });

  it('still draws when corners fall outside the camera depth range', () => {
    const { canvas, context, overlay } = setup();
    const deep = {
      matrixWorldInverse: { elements: identity },
      projectionMatrix: { elements: [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1] },
    } as unknown as GuideCameraLike;
    overlay.render(canvas, deep, { points: box, labelName: 'vehicles' });
    expect(context.fill).toHaveBeenCalledTimes(2);
  });

  it('removes its canvases on dispose', () => {
    const { canvas, overlay } = setup();
    overlay.render(canvas, camera, { points: box, labelName: 'vehicles' });
    overlay.dispose();
    expect(overlays()).toHaveLength(0);
  });
});
