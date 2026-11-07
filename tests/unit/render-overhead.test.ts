import { describe, expect, it, vi } from 'vitest';
import {
  Cvat3dPreRenderEnhancer,
  type CvatInternalCanvas3dLike,
  type ThreeSceneLike,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

function fixture() {
  class Scene {
    background = { r: 0, g: 0, b: 0, set: vi.fn() };
    children = [
      {
        type: 'Points',
        geometry: {
          attributes: {
            position: { array: new Float32Array([0, 0, 0]) },
            color: { array: new Float32Array([1, 1, 1]) },
          },
        },
        material: { size: 0.05, sizeAttenuation: true, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
      },
    ];
  }
  const scene = new Scene() as ThreeSceneLike;
  const renderer = {
    render: vi.fn(),
    domElement: document.createElement('canvas'),
    setClearColor: vi.fn(),
  };
  const camera = {};
  const nativeRender = vi.fn(() => scene.onBeforeRender?.(renderer, scene, camera));
  const canvas: CvatInternalCanvas3dLike = {
    view: { views: { perspective: { scene, renderer } }, render: nativeRender, drawnObjects: {} },
    model: { data: { imageID: 1 } },
  };
  const enhancer = new Cvat3dPreRenderEnhancer();
  enhancer.ensureHooked(canvas);
  return { scene, Scene, renderer, camera, nativeRender, canvas, enhancer };
}

describe('render overhead', () => {
  it('does not rewrite background or upload point buffers during 300 steady camera renders', () => {
    const { scene, renderer, camera, canvas } = fixture();
    const position = scene.children[0]!.geometry!.attributes!.position!;
    const color = scene.children[0]!.geometry!.attributes!.color!;
    const upload = vi.fn();
    Object.defineProperty(position, 'needsUpdate', { set: upload });
    Object.defineProperty(color, 'needsUpdate', { set: upload });
    const colors = color.array.slice();
    const setColor = scene.background!.set;
    vi.mocked(setColor).mockClear();
    renderer.setClearColor.mockClear();
    for (let i = 0; i < 300; i++) {
      canvas.view!.render!();
      const points = scene.children[0]!;
      points.onBeforeRender?.(renderer, scene, camera, points.geometry, points.material);
    }
    expect(setColor).not.toHaveBeenCalled();
    expect(renderer.setClearColor).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(color.array).toEqual(colors);
  });

  it('redraws native scenes once while retaining redraw for standalone zoom scenes', () => {
    const { scene, Scene, renderer, camera, nativeRender, enhancer } = fixture();
    scene.onBeforeRender?.(renderer, scene, camera);
    const zoomScene = new Scene() as ThreeSceneLike;
    const zoomRenderer = { render: vi.fn(), domElement: document.createElement('canvas') };
    zoomScene.onBeforeRender?.(zoomRenderer, zoomScene, camera);
    nativeRender.mockClear();
    enhancer.requestViewsRedraw();
    expect(nativeRender).toHaveBeenCalledTimes(1);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(zoomRenderer.render).toHaveBeenCalledTimes(1);
  });

  it('updates cached background when toggled or replaced by a newly loaded frame', () => {
    const { scene, renderer, camera, enhancer, canvas } = fixture();
    enhancer.setOptions({ ...enhancer.getOptions(), whiteBackground: true }, canvas);
    expect(scene.background!.set).toHaveBeenLastCalledWith(0xffffff);
    const replacement = { r: 0, g: 0, b: 0, set: vi.fn() };
    scene.background = replacement;
    scene.onBeforeRender?.(renderer, scene, camera);
    expect(replacement.set).toHaveBeenCalledExactlyOnceWith(0xffffff);
  });
});
