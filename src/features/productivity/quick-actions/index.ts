import type { CommandRegistry } from '../../../core/command-registry';
import type { CameraPresetAction } from '../../../shared/constants';

export interface QuickActionItem {
  readonly id: string;
  readonly label: string;
  readonly commandId: string;
  readonly payload?: unknown;
}

export const DEFAULT_QUICK_ACTIONS: readonly QuickActionItem[] = Object.freeze([
  {
    id: 'qa-zoom-in',
    label: 'Zoom In (+)',
    commandId: 'camera.action',
    payload: { action: 'ZOOM_IN' satisfies CameraPresetAction },
  },
  {
    id: 'qa-zoom-out',
    label: 'Zoom Out (-)',
    commandId: 'camera.action',
    payload: { action: 'ZOOM_OUT' satisfies CameraPresetAction },
  },
  {
    id: 'qa-rotate-left',
    label: 'Yaw Left',
    commandId: 'camera.action',
    payload: { action: 'ROTATE_LEFT' satisfies CameraPresetAction },
  },
  {
    id: 'qa-rotate-right',
    label: 'Yaw Right',
    commandId: 'camera.action',
    payload: { action: 'ROTATE_RIGHT' satisfies CameraPresetAction },
  },
  {
    id: 'qa-tilt-up',
    label: 'Pitch Up',
    commandId: 'camera.action',
    payload: { action: 'TILT_UP' satisfies CameraPresetAction },
  },
  {
    id: 'qa-tilt-down',
    label: 'Pitch Down',
    commandId: 'camera.action',
    payload: { action: 'TILT_DOWN' satisfies CameraPresetAction },
  },
  {
    id: 'qa-reset',
    label: 'Reset to CVAT Default',
    commandId: 'runtime.resetDefaults',
  },
]);

export async function runQuickAction(
  registry: CommandRegistry,
  item: QuickActionItem
): Promise<void> {
  await registry.execute(item.commandId, item.payload);
}
