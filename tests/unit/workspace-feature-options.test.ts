import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Cvat3dPreRenderEnhancer,
  DEFAULT_CVAT_3D_RENDER_OPTIONS,
  injectCvatWorkspaceSettingsControls,
  readRenderOptionsFromClientSettings,
  writeRenderOptionsToClientSettings,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';
import {
  WORKSPACE_FEATURE_KEYS,
  normalizeWorkspaceFeatureOptions,
} from '../../src/integration/cvat/runtime/workspace-feature-options';
import { injectCvatObjectDimensionSyncControls } from '../../src/integration/cvat/runtime/object-dimension-controls';
import { installSidebarQuickFilterGuard } from '../../src/integration/cvat/runtime/sidebar-enhancements';
import { CuboidBaseGuide } from '../../src/integration/cvat/runtime/cuboid-base-guide';
import { OrthoCuboidEditor } from '../../src/integration/cvat/runtime/ortho-cuboid-editor';

afterEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.useRealTimers();
});
const disabled = Object.fromEntries(WORKSPACE_FEATURE_KEYS.map((key) => [key, false]));
const result = {
  clientID: 1,
  dimension: 'H' as const,
  targetValue: 2,
  syncedFrames: 1,
  skippedAttributeMismatchFrames: 0,
};

describe('recent Workspace feature options', () => {
  it('defaults legacy settings to enabled, validates booleans and preserves disabled flags through CVAT overwrites', () => {
    expect(
      normalizeWorkspaceFeatureOptions({ enableDimensionSync: 'false' }).enableDimensionSync
    ).toBe(true);
    writeRenderOptionsToClientSettings({ ...DEFAULT_CVAT_3D_RENDER_OPTIONS, ...disabled });
    window.localStorage.setItem(
      'clientSettings',
      JSON.stringify({
        workspace: { cvat3dEnhancer: DEFAULT_CVAT_3D_RENDER_OPTIONS },
        player: { frameStep: 3 },
      })
    );
    const restored = readRenderOptionsFromClientSettings();
    for (const key of WORKSPACE_FEATURE_KEYS) expect(restored[key]).toBe(false);
    const healed = JSON.parse(window.localStorage.getItem('clientSettings')!);
    expect(healed.player.frameStep).toBe(3);
    for (const key of WORKSPACE_FEATURE_KEYS)
      expect(healed.workspace.cvat3dEnhancer[key]).toBe(false);
  });

  it('mounts all eight options, toggles them independently, and resyncs existing controls', () => {
    document.body.innerHTML = '<div class="cvat-workspace-settings"></div>';
    let options = { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
    const mount = () =>
      injectCvatWorkspaceSettingsControls(
        document,
        () => options,
        (next) => {
          options = writeRenderOptionsToClientSettings(next);
        }
      );
    mount();
    for (const key of WORKSPACE_FEATURE_KEYS) {
      const input = document.querySelector<HTMLInputElement>(`input[data-enhancer-opt="${key}"]`)!;
      expect(input.checked).toBe(true);
      input.checked = false;
      input.dispatchEvent(new Event('change'));
      expect(options[key]).toBe(false);
    }
    options = { ...options, ...normalizeWorkspaceFeatureOptions({}) };
    mount();
    for (const key of WORKSPACE_FEATURE_KEYS)
      expect(
        document.querySelector<HTMLInputElement>(`input[data-enhancer-opt="${key}"]`)!.checked
      ).toBe(true);
    expect(document.querySelectorAll('[data-enhancer-workspace-settings]')).toHaveLength(1);
  });

  it('upgrades an existing settings panel with missing controls', () => {
    document.body.innerHTML =
      '<div class="cvat-workspace-settings"><div data-enhancer-workspace-settings="true"><input data-enhancer-opt="whiteBackground"></div></div>';
    injectCvatWorkspaceSettingsControls(document, () => DEFAULT_CVAT_3D_RENDER_OPTIONS, vi.fn());
    expect(document.querySelectorAll('input[data-enhancer-opt]')).toHaveLength(15);
  });

  it('independently removes and restores dimension sync and heading flip controls', () => {
    document.body.innerHTML =
      '<div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item"></div>';
    const sync = () => result;
    injectCvatObjectDimensionSyncControls(document, sync, { enableDimensionSync: false });
    expect(document.querySelectorAll('[data-enhancer-sync-dim]')).toHaveLength(1);
    expect(document.querySelector('[data-enhancer-sync-dim="FLIP_180"]')).not.toBeNull();
    injectCvatObjectDimensionSyncControls(document, sync, { enableHeadingFlip: false });
    expect(document.querySelectorAll('[data-enhancer-sync-dim]')).toHaveLength(3);
    expect(document.querySelector('[data-enhancer-sync-dim="FLIP_180"]')).toBeNull();
    injectCvatObjectDimensionSyncControls(document, sync, {
      enableDimensionSync: false,
      enableHeadingFlip: false,
    });
    expect(document.querySelector('.cvat-3d-enhancer-dim-sync-row')).toBeNull();
    injectCvatObjectDimensionSyncControls(document, sync);
    expect(document.querySelectorAll('[data-enhancer-sync-dim]')).toHaveLength(4);
  });

  it('restores native double-click handling immediately when the filter override is disabled', () => {
    document.body.innerHTML = '<div class="cvat-objects-sidebar-state-item">Car</div>';
    const card = document.querySelector('div')!;
    const focus = vi.fn(),
      native = vi.fn();
    Object.assign(card, { __reactFiber$fixture: { memoizedProps: { focus } } });
    card.addEventListener('dblclick', native);
    let enabled = true;
    const remove = installSidebarQuickFilterGuard(document, window, () => enabled);
    try {
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(focus).toHaveBeenCalledOnce();
      expect(native).not.toHaveBeenCalled();
      enabled = false;
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      expect(native).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });

  it('toggles the 20% main point increase without affecting orthographic point size or zoom attenuation', () => {
    const material = () => ({
      size: 0.05,
      sizeAttenuation: true,
      color: { r: 1, g: 1, b: 1, set: vi.fn() },
    });
    const main = { type: 'Points', material: material() },
      top = { type: 'Points', material: material() };
    const canvas = {
      view: {
        views: {
          perspective: { scene: { background: null, children: [main] } },
          top: { scene: { background: null, children: [top] } },
        },
        drawnObjects: {},
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer();
    enhancer.ensureHooked(canvas);
    expect(main.material.size).toBeCloseTo(0.06);
    enhancer.setOptions({ ...enhancer.getOptions(), enlargePerspectivePoints: false }, canvas);
    expect(main.material.size).toBe(0.05);
    expect(main.material.sizeAttenuation).toBe(true);
    expect(top.material.size).toBe(3.5);
  });

  it('hides and restores the base guide without removing its render hooks', () => {
    document.body.innerHTML = '<canvas></canvas>';
    const canvas = document.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 217,
      height: 233,
      right: 217,
      bottom: 233,
      x: 0,
      y: 0,
      toJSON() {},
    });
    const camera = {
      left: -10,
      right: 10,
      top: 10,
      bottom: -10,
      matrixWorld: { elements: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, -10, 0, 1] },
    };
    let enabled = true;
    const guide = new CuboidBaseGuide(document, () => enabled);
    try {
      guide.update(canvas, camera, [0, 0, 0, 0, 0, 0, 4, 2, 2]);
      const svg = document.querySelector<SVGSVGElement>('.cvat-3d-enhancer-base-guide')!;
      enabled = false;
      guide.refresh();
      expect(svg.style.display).toBe('none');
      enabled = true;
      guide.refresh();
      expect(svg.style.display).toBe('block');
    } finally {
      guide.clear();
    }
  });

  it('switches keyboard sensitivity, commit timing and native shortcuts without reinstalling', () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div class="cvat-canvas3d-topview"><canvas width="1000" height="1000"></canvas></div>';
    const camera = {
      left: -5,
      right: 5,
      top: 5,
      bottom: -5,
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1] },
    };
    const preview = vi.fn(),
      commit = vi.fn(),
      native = vi.fn();
    const options = { enabled: true, highSensitivity: false, immediateCommit: false };
    const editor = new OrthoCuboidEditor(
      {
        getKeyboardOptions: () => options,
        getMaximizedView: () => null,
        getActivePoints: () => ({ clientID: 1, points: [0, 0, 0, 0, 0, 0, 4, 2, 1] }),
        getViewCamera: () => camera,
        previewPoints: preview,
        commitPoints: commit,
      },
      document,
      window
    );
    const remove = editor.install();
    document.addEventListener('keydown', native);
    const key = (type: string) =>
      document.body.dispatchEvent(new KeyboardEvent(type, { bubbles: true, code: 'KeyD' }));
    try {
      document
        .querySelector('canvas')!
        .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      key('keydown');
      key('keyup');
      expect(preview.mock.calls[0]![1][0]).toBeCloseTo(0.0125);
      expect(commit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(commit).toHaveBeenCalledOnce();
      options.highSensitivity = true;
      options.immediateCommit = true;
      key('keydown');
      key('keyup');
      expect(preview.mock.calls[1]![1][0]).toBeCloseTo(0.025);
      expect(commit).toHaveBeenCalledTimes(2);
      options.enabled = false;
      key('keydown');
      expect(preview).toHaveBeenCalledTimes(2);
      expect(native).toHaveBeenCalledOnce();
    } finally {
      remove();
      document.removeEventListener('keydown', native);
    }
  });
});
