import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CAMERA_PRESET_ACTIONS, type CameraPresetAction } from '../../shared/constants';
import type {
  CuboidColorBy,
  CuboidOrientationVisibility,
  WorkspaceThemePreset,
} from '../../shared/types';
import {
  AuthStatusCard,
  CapabilityBadge,
  CapabilityStatusRow,
  ScopeSelectorBar,
} from '../components';
import { type PanelTabId, useEnhancerUiStore } from '../settings/store';
import { SHADOW_PANEL_STYLESHEET, THEME_PALETTES } from '../theme';

const TABS: { readonly id: PanelTabId; readonly label: string }[] = [
  { id: 'overview', label: '1. Overview' },
  { id: 'appearance', label: '2. Appearance' },
  { id: 'visualization-3d', label: '3. 3D Visuals' },
  { id: 'annotation', label: '4. Annotation' },
  { id: 'presets', label: '5. Presets' },
  { id: 'advanced', label: '6. Advanced' },
];

const OverviewTab: React.FC = () => {
  const runtimeSnapshot = useEnhancerUiStore((s) => s.runtimeSnapshot);
  const routeContext = useEnhancerUiStore((s) => s.routeContext);
  const handlers = useEnhancerUiStore((s) => s.handlers);

  const capabilities = Object.values(runtimeSnapshot.capabilities);

  return (
    <>
      <AuthStatusCard />

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">CVAT 3D Runtime Status</span>
          <button
            type="button"
            className="enhancer-btn"
            onClick={() => handlers && void handlers.refreshAuthAndRuntime()}
          >
            Probe Runtime
          </button>
        </div>
        <div className="enhancer-row">
          <span className="enhancer-muted">Server Version:</span>
          <span>{runtimeSnapshot.serverVersion ?? 'Unverified'}</span>
        </div>
        <div className="enhancer-row">
          <span className="enhancer-muted">3D Workspace Active:</span>
          <span>{routeContext.is3DWorkspace ? 'Yes' : 'No'}</span>
        </div>
        <div className="enhancer-row">
          <span className="enhancer-muted">CVAT Redux Store Bridge:</span>
          <span>{runtimeSnapshot.hasReduxStoreAccess ? 'Connected' : 'Standby'}</span>
        </div>
      </div>

      <div className="enhancer-card">
        <div className="enhancer-card-title">Verified Capability Matrix</div>
        {capabilities.map((cap) => (
          <CapabilityStatusRow key={cap.id} cap={cap} />
        ))}
      </div>
    </>
  );
};

const AppearanceTab: React.FC = () => {
  const config = useEnhancerUiStore((s) => s.config);
  const activeScopeLevel = useEnhancerUiStore((s) => s.activeScopeLevel);
  const runtimeSnapshot = useEnhancerUiStore((s) => s.runtimeSnapshot);
  const handlers = useEnhancerUiStore((s) => s.handlers);

  const isSupported = runtimeSnapshot.capabilities.pointCloudAppearance.status === 'supported';

  const updateAppearance = (patch: Partial<typeof config.appearance>) => {
    if (!handlers) return;
    void handlers.updateConfig(activeScopeLevel, {
      appearance: patch,
    });
  };

  return (
    <>
      <ScopeSelectorBar />

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">Workspace Theme & Canvas</span>
          <CapabilityBadge status={runtimeSnapshot.capabilities.pointCloudAppearance.status} />
        </div>

        <label className="enhancer-row" style={{ marginTop: '4px' }}>
          <span>Panel Theme Preset</span>
          <select
            className="enhancer-select"
            style={{ width: '150px' }}
            value={config.appearance.themePreset}
            onChange={(e) =>
              updateAppearance({ themePreset: e.target.value as WorkspaceThemePreset })
            }
          >
            <option value="cvat-dark">CVAT Dark Slate</option>
            <option value="midnight-slate">Midnight Slate</option>
            <option value="high-contrast">High Contrast</option>
            <option value="lidar-amber">LiDAR Amber</option>
          </select>
        </label>

        <label className="enhancer-row" style={{ marginTop: '4px' }}>
          <span>3D Canvas Background</span>
          <input
            type="color"
            disabled={!isSupported}
            value={config.appearance.canvasBackgroundColor}
            onChange={(e) => updateAppearance({ canvasBackgroundColor: e.target.value })}
          />
        </label>

        {!isSupported && (
          <div className="enhancer-muted">
            Canvas background control will activate automatically once a CVAT 3D viewport is open.
          </div>
        )}
      </div>
    </>
  );
};

const Visualization3DTab: React.FC = () => {
  const config = useEnhancerUiStore((s) => s.config);
  const activeScopeLevel = useEnhancerUiStore((s) => s.activeScopeLevel);
  const runtimeSnapshot = useEnhancerUiStore((s) => s.runtimeSnapshot);
  const handlers = useEnhancerUiStore((s) => s.handlers);

  const caps = runtimeSnapshot.capabilities;
  const pcFilterSupported = caps.pointCloudAppearance.status === 'supported';
  const cameraSupported = caps.cameraPresets.status === 'supported';

  const updateVis = (patch: Partial<typeof config.visualization3d>) => {
    if (!handlers) return;
    void handlers.updateConfig(activeScopeLevel, {
      visualization3d: patch,
    });
  };

  return (
    <>
      <ScopeSelectorBar />

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">Pre-Render 3D Point Cloud Options</span>
          <CapabilityBadge status={caps.cuboidAppearance.status} />
        </div>
        <div className="enhancer-muted" style={{ fontSize: '10px' }}>
          Synced with CVAT Settings → Workspace (`localStorage.clientSettings`) & executed once per frame change.
        </div>

        <label className="enhancer-row">
          <span>White 3D Background (Nền trắng)</span>
          <input
            type="checkbox"
            checked={Boolean(config.visualization3d.whiteBackground)}
            onChange={(e) => updateVis({ whiteBackground: e.target.checked })}
          />
        </label>

        <label className="enhancer-row">
          <span>Point Scattering Control (Độ tán xạ)</span>
          <input
            type="checkbox"
            checked={Boolean(config.visualization3d.enableScattering)}
            onChange={(e) => updateVis({ enableScattering: e.target.checked })}
          />
        </label>

        <label className="enhancer-row">
          <span>Color Points Inside Box (Màu point theo box)</span>
          <input
            type="checkbox"
            checked={Boolean(config.visualization3d.colorPointsByCuboid)}
            onChange={(e) => updateVis({ colorPointsByCuboid: e.target.checked })}
          />
        </label>
      </div>

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">Point Cloud WebGL Filter</span>
          <CapabilityBadge status={caps.pointCloudAppearance.status} />
        </div>

        <label className="enhancer-row">
          <span>Brightness ({config.visualization3d.pointCloudCssBrightness}%)</span>
          <input
            type="range"
            min={50}
            max={180}
            disabled={!pcFilterSupported}
            value={config.visualization3d.pointCloudCssBrightness}
            onChange={(e) => updateVis({ pointCloudCssBrightness: Number(e.target.value) })}
          />
        </label>

        <label className="enhancer-row">
          <span>Contrast ({config.visualization3d.pointCloudCssContrast}%)</span>
          <input
            type="range"
            min={50}
            max={180}
            disabled={!pcFilterSupported}
            value={config.visualization3d.pointCloudCssContrast}
            onChange={(e) => updateVis({ pointCloudCssContrast: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">Camera Step Actions</span>
          <CapabilityBadge status={caps.cameraPresets.status} />
        </div>
        <div className="enhancer-grid-2">
          {CAMERA_PRESET_ACTIONS.map((action: CameraPresetAction) => (
            <button
              key={action}
              type="button"
              disabled={!cameraSupported}
              className="enhancer-btn"
              onClick={() => handlers && void handlers.dispatchCameraAction(action)}
            >
              {action.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="enhancer-card">
        <div className="enhancer-card-title">Unsupported 3D Scene Internals (CVAT v2.81.0)</div>
        <CapabilityStatusRow cap={caps.pointSize} />
        <CapabilityStatusRow cap={caps.colorMode} />
        <CapabilityStatusRow cap={caps.gridVisibility} />
        <CapabilityStatusRow cap={caps.coordinateAxes} />
      </div>
    </>
  );
};

const AnnotationTab: React.FC = () => {
  const config = useEnhancerUiStore((s) => s.config);
  const activeScopeLevel = useEnhancerUiStore((s) => s.activeScopeLevel);
  const runtimeSnapshot = useEnhancerUiStore((s) => s.runtimeSnapshot);
  const handlers = useEnhancerUiStore((s) => s.handlers);

  const cuboidSupported = runtimeSnapshot.capabilities.cuboidAppearance.status === 'supported';
  const labelColorsSupported = runtimeSnapshot.capabilities.labelColors.status === 'supported';

  const updateVis = (patch: Partial<typeof config.visualization3d>) => {
    if (!handlers) return;
    void handlers.updateConfig(activeScopeLevel, {
      visualization3d: patch,
    });
  };

  const updateAnnotation = (patch: Partial<typeof config.annotation>) => {
    if (!handlers) return;
    void handlers.updateConfig(activeScopeLevel, {
      annotation: patch,
    });
  };

  return (
    <>
      <ScopeSelectorBar />

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">Cuboid Appearance (Canvas3d.configure)</span>
          <CapabilityBadge status={runtimeSnapshot.capabilities.cuboidAppearance.status} />
        </div>

        <label className="enhancer-row">
          <span>Cuboid Opacity ({config.visualization3d.cuboidOpacity}%)</span>
          <input
            type="range"
            min={0}
            max={100}
            disabled={!cuboidSupported}
            value={config.visualization3d.cuboidOpacity}
            onChange={(e) => updateVis({ cuboidOpacity: Number(e.target.value) })}
          />
        </label>

        <label className="enhancer-row">
          <span>Selected Opacity ({config.visualization3d.selectedCuboidOpacity}%)</span>
          <input
            type="range"
            min={0}
            max={100}
            disabled={!cuboidSupported}
            value={config.visualization3d.selectedCuboidOpacity}
            onChange={(e) => updateVis({ selectedCuboidOpacity: Number(e.target.value) })}
          />
        </label>

        <label className="enhancer-row">
          <span>Outlined Cuboid Borders</span>
          <input
            type="checkbox"
            disabled={!cuboidSupported}
            checked={config.visualization3d.cuboidOutlinedBorders}
            onChange={(e) => updateVis({ cuboidOutlinedBorders: e.target.checked })}
          />
        </label>

        <label className="enhancer-row">
          <span>Cuboid Outline Color</span>
          <input
            type="color"
            disabled={!cuboidSupported}
            value={config.visualization3d.cuboidOutlineColor}
            onChange={(e) => updateVis({ cuboidOutlineColor: e.target.value })}
          />
        </label>

        <label className="enhancer-row">
          <span>Orientation Arrows</span>
          <select
            className="enhancer-select"
            style={{ width: '130px' }}
            disabled={!cuboidSupported}
            value={config.visualization3d.cuboidOrientationVisibility}
            onChange={(e) =>
              updateVis({
                cuboidOrientationVisibility: e.target.value as CuboidOrientationVisibility,
              })
            }
          >
            <option value="always">Always</option>
            <option value="selected">Selected Only</option>
            <option value="never">Never</option>
          </select>
        </label>

        <label className="enhancer-row">
          <span>Control Points Size ({config.visualization3d.controlPointsSize})</span>
          <input
            type="range"
            min={1}
            max={20}
            disabled={!cuboidSupported}
            value={config.visualization3d.controlPointsSize}
            onChange={(e) => updateVis({ controlPointsSize: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="enhancer-card">
        <div className="enhancer-row">
          <span className="enhancer-card-title">Color-By Mode</span>
          <CapabilityBadge status={runtimeSnapshot.capabilities.labelColors.status} />
        </div>

        <label className="enhancer-row">
          <span>Color Cuboids By</span>
          <select
            className="enhancer-select"
            style={{ width: '130px' }}
            disabled={!labelColorsSupported}
            value={config.annotation.colorBy}
            onChange={(e) => updateAnnotation({ colorBy: e.target.value as CuboidColorBy })}
          >
            <option value="Label">Label</option>
            <option value="Instance">Instance</option>
            <option value="Group">Group</option>
          </select>
        </label>
      </div>
    </>
  );
};

const PresetsTab: React.FC = () => {
  const presets = useEnhancerUiStore((s) => s.presets);
  const activeScopeLevel = useEnhancerUiStore((s) => s.activeScopeLevel);
  const handlers = useEnhancerUiStore((s) => s.handlers);
  const setStatusBanner = useEnhancerUiStore((s) => s.setStatusBanner);
  const [jsonBuffer, setJsonBuffer] = useState('');

  const handleExport = async () => {
    if (!handlers) return;
    const exported = await handlers.exportConfigJson();
    setJsonBuffer(exported);
    setStatusBanner('Configuration exported to JSON editor below.');
  };

  const handleImport = async () => {
    if (!handlers || !jsonBuffer.trim()) return;
    try {
      await handlers.importConfigJson(jsonBuffer, activeScopeLevel);
      setStatusBanner(`Configuration imported into ${activeScopeLevel} scope.`);
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : 'Invalid configuration JSON.');
    }
  };

  return (
    <>
      <ScopeSelectorBar />

      <div className="enhancer-card">
        <div className="enhancer-card-title">Visualization Presets</div>
        {presets.map((preset) => (
          <div
            key={preset.id}
            style={{
              borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
              paddingBottom: '6px',
              marginBottom: '4px',
            }}
          >
            <div className="enhancer-row">
              <span style={{ fontWeight: 600 }}>{preset.name}</span>
              <button
                type="button"
                className="enhancer-btn enhancer-btn-primary"
                onClick={() => handlers && void handlers.applyPreset(preset.id, activeScopeLevel)}
              >
                Apply
              </button>
            </div>
            <div className="enhancer-muted">{preset.description}</div>
          </div>
        ))}
      </div>

      <div className="enhancer-card">
        <div className="enhancer-card-title">Import / Export Configuration JSON</div>
        <div className="enhancer-row">
          <button type="button" className="enhancer-btn" onClick={() => void handleExport()}>
            Export Current JSON
          </button>
          <button
            type="button"
            className="enhancer-btn enhancer-btn-primary"
            onClick={() => void handleImport()}
          >
            Import to {activeScopeLevel}
          </button>
        </div>
        <textarea
          rows={5}
          className="enhancer-textarea"
          placeholder="Paste validated configuration JSON here..."
          value={jsonBuffer}
          onChange={(e) => setJsonBuffer(e.target.value)}
        />
      </div>
    </>
  );
};

const AdvancedSettingsTab: React.FC = () => {
  const config = useEnhancerUiStore((s) => s.config);
  const featureStatuses = useEnhancerUiStore((s) => s.featureStatuses);
  const activeScopeLevel = useEnhancerUiStore((s) => s.activeScopeLevel);
  const handlers = useEnhancerUiStore((s) => s.handlers);

  const toggleFeature = (featureId: string, enabled: boolean) => {
    if (!handlers) return;
    void handlers.updateConfig(activeScopeLevel, {
      enabledFeatures: {
        ...config.enabledFeatures,
        [featureId]: enabled,
      },
    });
  };

  return (
    <>
      <ScopeSelectorBar />

      <div className="enhancer-card">
        <div className="enhancer-card-title">Independent Feature Modules</div>
        {featureStatuses.map((feat) => (
          <div
            key={feat.id}
            style={{
              borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
              paddingBottom: '6px',
              marginBottom: '4px',
            }}
          >
            <div className="enhancer-row">
              <span style={{ fontWeight: 600 }}>{feat.name}</span>
              <input
                type="checkbox"
                checked={feat.enabledInConfig}
                onChange={(e) => toggleFeature(feat.id, e.target.checked)}
              />
            </div>
            <div className="enhancer-muted">{feat.description}</div>
            {feat.blockedByCapabilities.length > 0 && (
              <div className="enhancer-muted" style={{ color: '#fbbf24' }}>
                Blocked by capabilities: {feat.blockedByCapabilities.join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="enhancer-card">
        <div className="enhancer-card-title">Keyboard Shortcuts</div>
        <div className="enhancer-row">
          <span>Enable Shortcuts</span>
          <input
            type="checkbox"
            checked={config.productivity.shortcutsEnabled}
            onChange={(e) =>
              handlers &&
              void handlers.updateConfig(activeScopeLevel, {
                productivity: { shortcutsEnabled: e.target.checked },
              })
            }
          />
        </div>
        <div className="enhancer-row">
          <span className="enhancer-muted">Toggle Panel:</span>
          <code>{config.productivity.togglePanelShortcut}</code>
        </div>
        <div className="enhancer-row">
          <span className="enhancer-muted">Reset Visuals:</span>
          <code>{config.productivity.quickResetCameraShortcut}</code>
        </div>
        <div className="enhancer-row">
          <span className="enhancer-muted">Cycle Color-By:</span>
          <code>{config.productivity.cycleColorByShortcut}</code>
        </div>
      </div>
    </>
  );
};

export const FloatingPanelApp: React.FC = () => {
  const collapsed = useEnhancerUiStore((s) => s.collapsed);
  const toggleCollapsed = useEnhancerUiStore((s) => s.toggleCollapsed);
  const activeTab = useEnhancerUiStore((s) => s.activeTab);
  const setActiveTab = useEnhancerUiStore((s) => s.setActiveTab);
  const config = useEnhancerUiStore((s) => s.config);
  const statusBanner = useEnhancerUiStore((s) => s.statusBanner);
  const setStatusBanner = useEnhancerUiStore((s) => s.setStatusBanner);
  const handlers = useEnhancerUiStore((s) => s.handlers);

  const palette = THEME_PALETTES[config.appearance.themePreset] ?? THEME_PALETTES['cvat-dark'];

  const cssVariables: React.CSSProperties = {
    '--cvat-enhancer-bg': palette.bg,
    '--cvat-enhancer-surface': palette.surface,
    '--cvat-enhancer-border': palette.border,
    '--cvat-enhancer-text': palette.text,
    '--cvat-enhancer-muted': palette.muted,
    '--cvat-enhancer-accent': config.appearance.panelAccentColor || palette.accent,
  } as React.CSSProperties;

  if (collapsed) {
    return (
      <div className="enhancer-shell collapsed" style={cssVariables}>
        <div className="enhancer-header" style={{ borderBottom: 'none' }}>
          <span className="enhancer-title">
            <span className="enhancer-dot" />
            CVAT 3D
          </span>
          <button type="button" className="enhancer-btn" onClick={toggleCollapsed}>
            Expand
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="enhancer-shell" style={cssVariables} data-testid="cvat-enhancer-floating-panel">
      <div className="enhancer-header">
        <span className="enhancer-title">
          <span className="enhancer-dot" />
          CVAT 3D Enhancer
        </span>
        <button type="button" className="enhancer-btn" onClick={toggleCollapsed}>
          Collapse
        </button>
      </div>

      <div className="enhancer-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`enhancer-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {statusBanner && (
        <div
          style={{
            padding: '6px 10px',
            background: 'rgba(56, 189, 248, 0.15)',
            borderBottom: '1px solid rgba(56, 189, 248, 0.3)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{statusBanner}</span>
          <button
            type="button"
            className="enhancer-btn"
            style={{ padding: '1px 5px' }}
            onClick={() => setStatusBanner(null)}
          >
            ×
          </button>
        </div>
      )}

      <div className="enhancer-body">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'appearance' && <AppearanceTab />}
        {activeTab === 'visualization-3d' && <Visualization3DTab />}
        {activeTab === 'annotation' && <AnnotationTab />}
        {activeTab === 'presets' && <PresetsTab />}
        {activeTab === 'advanced' && <AdvancedSettingsTab />}
      </div>

      <div className="enhancer-footer">
        <span className="enhancer-muted">Non-destructive 3D overlay</span>
        <button
          type="button"
          className="enhancer-btn enhancer-btn-danger"
          onClick={() => handlers && void handlers.resetToCvatDefaults()}
        >
          Reset to CVAT Default
        </button>
      </div>
    </div>
  );
};

export interface MountedShadowPanel {
  unmount(): void;
}

/**
 * Mounts the floating panel inside an isolated Shadow DOM host so CVAT native styles
 * and extension styles never collide.
 */
export function mountFloatingPanelShadowHost(doc: Document = document): MountedShadowPanel {
  const existing = doc.getElementById('cvat-3d-enhancer-shadow-host');
  if (existing) {
    existing.remove();
  }

  const host = doc.createElement('div');
  host.id = 'cvat-3d-enhancer-shadow-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = doc.createElement('style');
  styleEl.textContent = SHADOW_PANEL_STYLESHEET;
  shadow.appendChild(styleEl);

  const mountNode = doc.createElement('div');
  shadow.appendChild(mountNode);
  doc.body.appendChild(host);

  const root: Root = createRoot(mountNode);
  root.render(
    <React.StrictMode>
      <FloatingPanelApp />
    </React.StrictMode>
  );

  return {
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
