import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../../integration/cvat/runtime';
import type { EnhancerConfig } from '../../../shared/types';

export class CuboidVisualizationFeature implements FeatureModule {
  public readonly id = 'visualization-3d';
  public readonly name = '3D Cuboid Visualization';
  public readonly description =
    'Configures cuboid fill opacity, selected cuboid opacity, outline borders, outline color, and orientation arrows via CVAT Redux / Canvas3d.configure().';
  public readonly requiredCapabilities = ['cuboidAppearance'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public async mount(context: FeatureContext): Promise<void> {
    await this.syncCuboidVisuals(context.getConfig(), context);
  }

  public async onConfigChange(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    await this.syncCuboidVisuals(config, context);
  }

  public async unmount(): Promise<void> {
    await this.runtimeAdapter.resetToCvatDefaults();
  }

  private async syncCuboidVisuals(config: EnhancerConfig, context: FeatureContext): Promise<void> {
    if (!context.isCapabilitySupported('cuboidAppearance')) {
      return;
    }
    const vis = config.visualization3d;
    await this.runtimeAdapter.applyVisualConfig({
      shapeOpacity: vis.cuboidOpacity,
      selectedShapeOpacity: vis.selectedCuboidOpacity,
      outlinedBorders: vis.cuboidOutlinedBorders,
      outlineColor: vis.cuboidOutlineColor,
      orientationVisibility: vis.cuboidOrientationVisibility,
      controlPointsSize: vis.controlPointsSize,
      focusedObjectPadding: vis.focusedObjectPadding,
      whiteBackground: vis.whiteBackground,
      enableScattering: vis.enableScattering,
      colorPointsByCuboid: vis.colorPointsByCuboid,
    });
  }
}
