import type { BridgeCommandName, CameraPresetAction } from '../constants';

export type CapabilityId =
  | 'pointCloudAppearance'
  | 'pointSize'
  | 'colorMode'
  | 'cameraPresets'
  | 'gridVisibility'
  | 'coordinateAxes'
  | 'cuboidAppearance'
  | 'labelColors';

export type CapabilitySupportStatus = 'supported' | 'unsupported' | 'unverified';

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly name: string;
  readonly status: CapabilitySupportStatus;
  readonly verifiedBy: 'runtime-bridge' | 'dom-inspection' | 'none';
  readonly reason: string;
}

export type CapabilityMap = Record<CapabilityId, CapabilityDescriptor>;

export interface CvatRouteContext {
  readonly origin: string;
  readonly pathname: string;
  readonly isCvatPage: boolean;
  readonly is3DWorkspace: boolean;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly jobId: string | null;
}

export interface CvatRuntimeSnapshot {
  readonly detected: boolean;
  readonly serverVersion: string | null;
  readonly coreVersion: string | null;
  readonly hasCvatUIPluginHook: boolean;
  readonly has3DCanvasDom: boolean;
  readonly hasPerspectiveCanvas: boolean;
  readonly hasOrthographicViews: boolean;
  readonly hasReduxStoreAccess: boolean;
  readonly capabilities: CapabilityMap;
}

export type AuthMethod = 'session' | 'pat' | 'none';

export type AuthStatus = 'authenticated' | 'unauthenticated' | 'expired' | 'error' | 'checking';

export interface AuthenticatedUser {
  readonly id: number;
  readonly username: string;
  readonly email?: string;
  readonly isStaff?: boolean;
}

export interface AuthenticationState {
  readonly status: AuthStatus;
  readonly method: AuthMethod;
  readonly origin: string | null;
  readonly user: AuthenticatedUser | null;
  readonly lastCheckedAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type WorkspaceThemePreset = 'cvat-dark' | 'midnight-slate' | 'high-contrast' | 'lidar-amber';

export type CuboidColorBy = 'Label' | 'Instance' | 'Group';

export type CuboidOrientationVisibility = 'always' | 'selected' | 'never';

export interface AppearanceConfig {
  readonly themePreset: WorkspaceThemePreset;
  readonly canvasBackgroundColor: string;
  readonly panelAccentColor: string;
  readonly uiDensity: 'compact' | 'comfortable';
  readonly highContrastCrosshair: boolean;
}

export interface Visualization3DConfig {
  readonly cuboidOpacity: number;
  readonly selectedCuboidOpacity: number;
  readonly cuboidOutlinedBorders: boolean;
  readonly cuboidOutlineColor: string;
  readonly cuboidOrientationVisibility: CuboidOrientationVisibility;
  readonly controlPointsSize: number;
  readonly focusedObjectPadding: number;
  readonly pointCloudCssBrightness: number;
  readonly pointCloudCssContrast: number;
  readonly pointSizeValue: number;
  readonly gridVisible: boolean;
  readonly axesVisible: boolean;
}

export interface AnnotationToolsConfig {
  readonly colorBy: CuboidColorBy;
  readonly highlightActiveCuboidBorder: boolean;
  readonly labelColorOverrides: Record<string, string>;
}

export interface ProductivityConfig {
  readonly shortcutsEnabled: boolean;
  readonly togglePanelShortcut: string;
  readonly quickResetCameraShortcut: string;
  readonly cycleColorByShortcut: string;
}

export interface EnhancerConfig {
  readonly schemaVersion: number;
  readonly enabledFeatures: Record<string, boolean>;
  readonly appearance: AppearanceConfig;
  readonly visualization3d: Visualization3DConfig;
  readonly annotation: AnnotationToolsConfig;
  readonly productivity: ProductivityConfig;
}

export type DeepPartial<T> = {
  readonly [P in keyof T]?: T[P] extends Record<string, unknown>
    ? T[P] extends Record<string, string | boolean | number>
      ? T[P]
      : DeepPartial<T[P]>
    : T[P];
};

export type PartialEnhancerConfig = {
  readonly schemaVersion?: number;
  readonly enabledFeatures?: Record<string, boolean>;
  readonly appearance?: Partial<AppearanceConfig>;
  readonly visualization3d?: Partial<Visualization3DConfig>;
  readonly annotation?: Partial<AnnotationToolsConfig>;
  readonly productivity?: Partial<ProductivityConfig>;
};

export interface PresetDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly builtIn?: boolean;
  readonly config: PartialEnhancerConfig;
}

export interface BridgeRequestEnvelope<TPayload = unknown> {
  readonly channel: string;
  readonly direction: 'CONTENT_TO_PAGE';
  readonly requestId: string;
  readonly sessionToken: string;
  readonly command: BridgeCommandName;
  readonly timestamp: number;
  readonly payload: TPayload;
}

export interface BridgeResponseEnvelope<TResult = unknown> {
  readonly channel: string;
  readonly direction: 'PAGE_TO_CONTENT';
  readonly requestId: string;
  readonly sessionToken: string;
  readonly ok: boolean;
  readonly timestamp: number;
  readonly result?: TResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface CameraActionPayload {
  readonly action: CameraPresetAction;
}
