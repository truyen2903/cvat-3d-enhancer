import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import type { Cvat3DRuntimeAdapter } from '../../../integration/cvat/runtime';
import type { CameraPresetAction } from '../../../shared/constants';

export class CameraPresetsFeature implements FeatureModule {
  public readonly id = 'camera-presets';
  public readonly name = '3D Camera Step & Preset Controls';
  public readonly description =
    'Dispatches verified CVAT 3D camera movement, zoom, tilt, and rotation actions via Canvas3d.keyControls.';
  public readonly requiredCapabilities = ['cameraPresets'] as const;
  public readonly defaultEnabled = true;

  private readonly runtimeAdapter: Cvat3DRuntimeAdapter;

  public constructor(runtimeAdapter: Cvat3DRuntimeAdapter) {
    this.runtimeAdapter = runtimeAdapter;
  }

  public mount(_context: FeatureContext): void {
    // Camera controls are triggered on-demand via verified commands
  }

  public unmount(): void {
    // Stateless command dispatcher
  }

  public async executeCameraAction(
    action: CameraPresetAction,
    context: FeatureContext
  ): Promise<void> {
    if (!context.isCapabilitySupported('cameraPresets')) {
      throw new Error('Camera presets capability is not supported in the current runtime.');
    }
    await this.runtimeAdapter.dispatchCameraAction(action);
  }
}
