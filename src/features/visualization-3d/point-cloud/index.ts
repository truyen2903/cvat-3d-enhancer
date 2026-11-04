import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../../integration/cvat/runtime';
import type { EnhancerConfig } from '../../../shared/types';

export class PointCloudAppearanceFeature implements FeatureModule {
  public readonly id = 'point-cloud';
  public readonly name = 'Point Cloud Visual Filter';
  public readonly description =
    'Adjusts 3D WebGL canvas brightness and contrast filters non-destructively. (Note: internal Three.js PointsMaterial.size and shader color modes are encapsulated inside CVAT v2.81.0 Canvas3dViewImpl and reported as unsupported).';
  public readonly requiredCapabilities = ['pointCloudAppearance'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public async mount(context: FeatureContext): Promise<void> {
    await this.applyFilter(context.getConfig(), context);
  }

  public async onConfigChange(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    await this.applyFilter(config, context);
  }

  public async unmount(): Promise<void> {
    await this.runtimeAdapter.applyVisualConfig({
      pointCloudCssBrightness: 100,
      pointCloudCssContrast: 100,
    });
  }

  private async applyFilter(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    if (!context.isCapabilitySupported('pointCloudAppearance')) {
      return;
    }
    await this.runtimeAdapter.applyVisualConfig({
      pointCloudCssBrightness: config.visualization3d.pointCloudCssBrightness,
      pointCloudCssContrast: config.visualization3d.pointCloudCssContrast,
    });
  }
}
