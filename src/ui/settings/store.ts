import { create } from 'zustand';
import type { ConfigurationScopeLevel } from '../../application/config';
import type { FeatureStatusEntry } from '../../core/feature-registry';
import { createInitialCapabilityMap } from '../../integration/cvat/runtime';
import { SYSTEM_DEFAULT_CONFIG } from '../../application/config';
import type {
  AuthenticationState,
  CvatRouteContext,
  CvatRuntimeSnapshot,
  EnhancerConfig,
  PartialEnhancerConfig,
  PresetDefinition,
} from '../../shared/types';
import type { CameraPresetAction } from '../../shared/constants';

export type PanelTabId =
  | 'overview'
  | 'appearance'
  | 'visualization-3d'
  | 'annotation'
  | 'presets'
  | 'advanced';

export interface PanelActionHandlers {
  readonly updateConfig: (
    level: ConfigurationScopeLevel,
    override: PartialEnhancerConfig
  ) => Promise<void>;
  readonly applyPreset: (presetId: string, level: ConfigurationScopeLevel) => Promise<void>;
  readonly resetToCvatDefaults: () => Promise<void>;
  readonly dispatchCameraAction: (action: CameraPresetAction) => Promise<void>;
  readonly refreshAuthAndRuntime: () => Promise<void>;
  readonly connectPat: (rawToken: string) => Promise<void>;
  readonly disconnectAuth: () => Promise<void>;
  readonly exportConfigJson: () => Promise<string>;
  readonly importConfigJson: (rawJson: string, level: ConfigurationScopeLevel) => Promise<void>;
}

export interface EnhancerUiState {
  readonly collapsed: boolean;
  readonly activeTab: PanelTabId;
  readonly activeScopeLevel: ConfigurationScopeLevel;
  readonly routeContext: CvatRouteContext;
  readonly authState: AuthenticationState;
  readonly runtimeSnapshot: CvatRuntimeSnapshot;
  readonly config: EnhancerConfig;
  readonly presets: readonly PresetDefinition[];
  readonly featureStatuses: readonly FeatureStatusEntry[];
  readonly statusBanner: string | null;
  readonly handlers: PanelActionHandlers | null;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setActiveTab: (tab: PanelTabId) => void;
  setActiveScopeLevel: (level: ConfigurationScopeLevel) => void;
  setStatusBanner: (message: string | null) => void;
  syncExternalState: (partial: Partial<Omit<EnhancerUiState, 'setCollapsed' | 'toggleCollapsed' | 'setActiveTab' | 'setActiveScopeLevel' | 'setStatusBanner' | 'syncExternalState'>>) => void;
}

export const useEnhancerUiStore = create<EnhancerUiState>((set) => ({
  collapsed: false,
  activeTab: 'overview',
  activeScopeLevel: 'global',
  routeContext: {
    origin: typeof window !== 'undefined' ? window.location.origin : 'https://app.cvat.ai',
    pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
    isCvatPage: false,
    is3DWorkspace: false,
    projectId: null,
    taskId: null,
    jobId: null,
  },
  authState: {
    status: 'unauthenticated',
    method: 'none',
    origin: null,
    user: null,
    lastCheckedAt: null,
    errorCode: null,
    errorMessage: null,
  },
  runtimeSnapshot: {
    detected: false,
    serverVersion: null,
    coreVersion: null,
    hasCvatUIPluginHook: false,
    has3DCanvasDom: false,
    hasPerspectiveCanvas: false,
    hasOrthographicViews: false,
    hasReduxStoreAccess: false,
    capabilities: createInitialCapabilityMap(),
  },
  config: SYSTEM_DEFAULT_CONFIG,
  presets: [],
  featureStatuses: [],
  statusBanner: null,
  handlers: null,
  setCollapsed: (collapsed) => set({ collapsed }),
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  setActiveTab: (activeTab) => set({ activeTab }),
  setActiveScopeLevel: (activeScopeLevel) => set({ activeScopeLevel }),
  setStatusBanner: (statusBanner) => set({ statusBanner }),
  syncExternalState: (partial) => set((s) => ({ ...s, ...partial })),
}));
