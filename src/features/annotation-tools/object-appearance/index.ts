import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../../integration/cvat/runtime';
import type { EnhancerConfig } from '../../../shared/types';

export class ObjectAppearanceFeature implements FeatureModule {
  public readonly id = 'object-appearance';
  public readonly name = '3D Control Points & Focus Padding';
  public readonly description =
    'Configures orthographic resize/rotation helper point size and object focus padding.';
  public readonly requiredCapabilities = ['cuboidAppearance'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public async mount(context: FeatureContext): Promise<void> {
    await this.applySettings(context.getConfig(), context);
  }

  public async onConfigChange(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    await this.applySettings(config, context);
  }

  public unmount(): void {
    // Managed by runtime reset
  }

  private async applySettings(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    if (!context.isCapabilitySupported('cuboidAppearance')) {
      return;
    }
    await this.runtimeAdapter.applyVisualConfig({
      controlPointsSize: config.visualization3d.controlPointsSize,
      focusedObjectPadding: config.visualization3d.focusedObjectPadding,
    });
  }
}
