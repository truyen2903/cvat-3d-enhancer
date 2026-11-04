import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';

/**
 * CVAT v2.81.0 instantiates `new THREE.AxesHelper(5)` inside private `Canvas3dViewImpl.addScene`
 * without a toggle or reference. Marked as requiring `coordinateAxes` capability so FeatureRegistry
 * prevents false activation.
 */
export class CoordinateAxesFeature implements FeatureModule {
  public readonly id = 'coordinate-axes';
  public readonly name = '3D Coordinate Axes Visibility';
  public readonly description =
    'Controls 3D coordinate axes helper visibility when exposed by the CVAT 3D runtime.';
  public readonly requiredCapabilities = ['coordinateAxes'] as const;
  public readonly defaultEnabled = false;

  public mount(context: FeatureContext): void {
    if (!context.isCapabilitySupported('coordinateAxes')) {
      throw new Error('Coordinate axes toggling is unsupported in CVAT v2.81.0 3D runtime.');
    }
  }

  public unmount(): void {
    // No-op
  }
}
