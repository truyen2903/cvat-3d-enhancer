import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';

/**
 * CVAT v2.81.0 does not instantiate a Three.js GridHelper in the 3D scene (`settings.workspace.grid`
 * only affects the 2D SVG canvas). Because `gridVisibility` is marked unsupported by CapabilityRegistry,
 * FeatureRegistry will block this module from mounting until a future CVAT runtime exposes scene access.
 */
export class GridVisibilityFeature implements FeatureModule {
  public readonly id = 'grid-visibility';
  public readonly name = '3D Ground Grid Visibility';
  public readonly description =
    'Controls 3D ground grid visibility when supported by the target CVAT 3D runtime.';
  public readonly requiredCapabilities = ['gridVisibility'] as const;
  public readonly defaultEnabled = false;

  public mount(context: FeatureContext): void {
    if (!context.isCapabilitySupported('gridVisibility')) {
      throw new Error('Grid visibility is unsupported in CVAT v2.81.0 3D runtime.');
    }
  }

  public unmount(): void {
    // No-op
  }
}
