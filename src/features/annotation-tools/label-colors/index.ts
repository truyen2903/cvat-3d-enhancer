import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../../integration/cvat/runtime';
import type { EnhancerConfig } from '../../../shared/types';

export class LabelColorsFeature implements FeatureModule {
  public readonly id = 'annotation-tools';
  public readonly name = 'Cuboid Color-By Mode';
  public readonly description =
    'Switches 3D cuboid coloring scheme between Label, Instance, and Group without mutating annotation data.';
  public readonly requiredCapabilities = ['labelColors'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public async mount(context: FeatureContext): Promise<void> {
    await this.applyColorBy(context.getConfig(), context);
  }

  public async onConfigChange(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    await this.applyColorBy(config, context);
  }

  public unmount(): void {
    // Reset handled via runtime reset command
  }

  private async applyColorBy(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    if (!context.isCapabilitySupported('labelColors')) {
      return;
    }
    await this.runtimeAdapter.applyVisualConfig({
      colorBy: config.annotation.colorBy,
    });
  }
}
