import type { FeatureContext, FeatureModule } from '../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../integration/cvat/runtime';
import type { EnhancerConfig } from '../../shared/types';

export class AppearanceFeature implements FeatureModule {
  public readonly id = 'appearance';
  public readonly name = 'Workspace Appearance & Theme';
  public readonly description =
    'Applies custom 3D viewport background colors and theme presets without altering annotation data.';
  public readonly requiredCapabilities = ['pointCloudAppearance'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public async mount(context: FeatureContext): Promise<void> {
    await this.applyAppearance(context.getConfig(), context);
  }

  public async onConfigChange(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    await this.applyAppearance(config, context);
  }

  public async unmount(): Promise<void> {
    await this.runtimeAdapter.resetToCvatDefaults();
  }

  private async applyAppearance(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    if (!context.isCapabilitySupported('pointCloudAppearance')) {
      return;
    }
    await this.runtimeAdapter.applyVisualConfig({
      canvasBackgroundColor: config.appearance.canvasBackgroundColor,
    });
  }
}
