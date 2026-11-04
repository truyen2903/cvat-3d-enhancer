/**
 * Shared constants for CVAT 3D Enhancer.
 * Zero secrets or credentials are permitted in this module.
 */

export const EXTENSION_NAMESPACE = 'cvat-enhancer' as const;

export const CURRENT_SCHEMA_VERSION = 2 as const;

export const STORAGE_KEYS = {
  GLOBAL: `${EXTENSION_NAMESPACE}:global`,
  PRESETS: `${EXTENSION_NAMESPACE}:presets`,
  PROJECT_PREFIX: `${EXTENSION_NAMESPACE}:project:`,
  TASK_PREFIX: `${EXTENSION_NAMESPACE}:task:`,
  SESSION_PAT_PREFIX: `${EXTENSION_NAMESPACE}:session-pat:`,
  AUTHORIZED_ORIGINS: `${EXTENSION_NAMESPACE}:authorized-origins`,
} as const;

export function getProjectStorageKey(projectId: string | number): string {
  return `${STORAGE_KEYS.PROJECT_PREFIX}${String(projectId)}`;
}

export function getTaskStorageKey(taskId: string | number): string {
  return `${STORAGE_KEYS.TASK_PREFIX}${String(taskId)}`;
}

export function getSessionPatStorageKey(origin: string): string {
  return `${STORAGE_KEYS.SESSION_PAT_PREFIX}${origin}`;
}

export const DEFAULT_AUTHORIZED_ORIGINS: readonly string[] = [
  'https://app.cvat.ai',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
] as const;

export const BRIDGE_CHANNEL = 'CVAT_3D_ENHANCER_BRIDGE_V1' as const;

export const BRIDGE_COMMANDS = [
  'BRIDGE_HANDSHAKE',
  'DETECT_RUNTIME',
  'GET_CAPABILITIES',
  'APPLY_CANVAS_VISUAL_CONFIG',
  'DISPATCH_CAMERA_ACTION',
  'SET_CANVAS_BACKGROUND',
  'RESET_TO_CVAT_DEFAULT',
] as const;

export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number];

export const CAMERA_PRESET_ACTIONS = [
  'ZOOM_IN',
  'ZOOM_OUT',
  'MOVE_UP',
  'MOVE_DOWN',
  'MOVE_LEFT',
  'MOVE_RIGHT',
  'TILT_UP',
  'TILT_DOWN',
  'ROTATE_LEFT',
  'ROTATE_RIGHT',
] as const;

export type CameraPresetAction = (typeof CAMERA_PRESET_ACTIONS)[number];

export const CVAT_DOM_SELECTORS = {
  ROOT_CONTAINER: '#root, #cvat-ui, .cvat-app-wrapper',
  PERSPECTIVE_WRAPPER: '.cvat-canvas3d-perspective',
  PERSPECTIVE_CANVAS_CONTAINER: '.cvat-canvas3d-perspective .cvat-canvas-container',
  TOP_VIEW_WRAPPER: '.cvat-canvas3d-topview',
  SIDE_VIEW_WRAPPER: '.cvat-canvas3d-sideview',
  FRONT_VIEW_WRAPPER: '.cvat-canvas3d-frontview',
  ORTHOGRAPHIC_VIEW: '.cvat-canvas3d-orthographic-view',
  ANNOTATION_HEADER: '.cvat-annotation-header, .cvat-header',
} as const;
