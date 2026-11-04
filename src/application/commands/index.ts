import type { ConfigurationManager, ConfigurationScopeContext } from '../config';
import type { CommandRegistry } from '../../core/command-registry';
import type { EventBus } from '../../core/event-bus';
import type { RuntimeManager } from '../../integration/cvat/runtime';
import type { CameraPresetAction } from '../../shared/constants';
import type { CuboidColorBy } from '../../shared/types';

export interface ApplicationCommandDeps {
  readonly commandRegistry: CommandRegistry;
  readonly runtimeManager: RuntimeManager;
  readonly configManager: ConfigurationManager;
  readonly eventBus: EventBus;
  readonly getScopeContext: () => ConfigurationScopeContext;
  readonly onConfigUpdated: () => Promise<void>;
}

const COLOR_BY_CYCLE: readonly CuboidColorBy[] = ['Label', 'Instance', 'Group'];

export function registerApplicationCommands(deps: ApplicationCommandDeps): void {
  const {
    commandRegistry,
    runtimeManager,
    configManager,
    eventBus,
    getScopeContext,
    onConfigUpdated,
  } = deps;

  commandRegistry.register<{ readonly action: CameraPresetAction }, void>({
    id: 'camera.action',
    title: 'Dispatch 3D Camera Step Action',
    category: 'camera',
    requiredCapabilities: ['cameraPresets'],
    execute: async (payload) => {
      await runtimeManager.getAdapter().dispatchCameraAction(payload.action);
    },
  });

  commandRegistry.register<undefined, void>({
    id: 'runtime.resetDefaults',
    title: 'Reset to CVAT Default Visuals',
    category: 'visualization',
    execute: async () => {
      await configManager.resetScope('all', getScopeContext());
      await runtimeManager.getAdapter().resetToCvatDefaults();
      await onConfigUpdated();
    },
  });

  commandRegistry.register<undefined, void>({
    id: 'annotation.cycleColorBy',
    title: 'Cycle Cuboid Color-By Mode (Label / Instance / Group)',
    category: 'annotation',
    requiredCapabilities: ['labelColors'],
    execute: async () => {
      const scope = getScopeContext();
      const current = await configManager.resolveEffectiveConfig(scope);
      const idx = COLOR_BY_CYCLE.indexOf(current.annotation.colorBy);
      const nextMode = COLOR_BY_CYCLE[(idx + 1) % COLOR_BY_CYCLE.length] ?? 'Label';
      await configManager.setScopeOverride(
        'global',
        {
          annotation: {
            colorBy: nextMode,
          },
        },
        scope
      );
      await onConfigUpdated();
    },
  });

  commandRegistry.register<undefined, void>({
    id: 'ui.togglePanel',
    title: 'Toggle CVAT 3D Enhancer Floating Panel',
    category: 'ui',
    execute: () => {
      eventBus.emit('ui:toggle-panel', undefined);
    },
  });
}
