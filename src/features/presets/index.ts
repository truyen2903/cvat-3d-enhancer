import type { ConfigurationManager } from '../../application/config';
import type { FeatureContext, FeatureModule } from '../../core/feature-registry';
import type { PresetDefinition } from '../../shared/types';

export class PresetsFeature implements FeatureModule {
  public readonly id = 'presets';
  public readonly name = 'Visualization Presets Engine';
  public readonly description =
    'Manages built-in and custom 3D visualization presets across Global, Project, and Task scopes.';
  public readonly requiredCapabilities = [] as const;
  public readonly defaultEnabled = true;

  private readonly configManager: ConfigurationManager;

  public constructor(configManager: ConfigurationManager) {
    this.configManager = configManager;
  }

  public mount(_context: FeatureContext): void {
    // Presets are loaded and applied via ConfigurationManager
  }

  public unmount(): void {
    // Stateless
  }

  public async listPresets(): Promise<readonly PresetDefinition[]> {
    return this.configManager.getPresets();
  }
}
