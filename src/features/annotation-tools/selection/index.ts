import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../../integration/cvat/runtime';
import type { EnhancerConfig } from '../../../shared/types';

export class SelectionEnhancementFeature implements FeatureModule {
  public readonly id = 'selection-enhancement';
  public readonly name = 'Active Cuboid Selection Highlight';
  public readonly description =
    'Enhances selected cuboid opacity contrast relative to unselected cuboids.';
  public readonly requiredCapabilities = ['cuboidAppearance'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public async mount(context: FeatureContext): Promise<void> {
    await this.applySelectionStyle(context.getConfig(), context);
  }

  public async onConfigChange(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    await this.applySelectionStyle(config, context);
  }

  public unmount(): void {
    // Handled by runtime reset
  }

  private async applySelectionStyle(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    if (!context.isCapabilitySupported('cuboidAppearance')) {
      return;
    }
    await this.runtimeAdapter.applyVisualConfig({
      selectedShapeOpacity: config.visualization3d.selectedCuboidOpacity,
    });
  }
}
