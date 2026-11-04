import type { CapabilityId, CvatRuntimeSnapshot, EnhancerConfig } from '../shared/types';
import { rootLogger } from './logger';

export interface FeatureContext {
  readonly getConfig: () => EnhancerConfig;
  readonly getRuntimeSnapshot: () => CvatRuntimeSnapshot;
  readonly isCapabilitySupported: (capability: CapabilityId) => boolean;
}

export interface FeatureModule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly defaultEnabled: boolean;
  mount(context: FeatureContext): Promise<void> | void;
  onConfigChange?(config: EnhancerConfig, context: FeatureContext): Promise<void> | void;
  unmount(): Promise<void> | void;
}

export interface FeatureStatusEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabledInConfig: boolean;
  readonly mounted: boolean;
  readonly blockedByCapabilities: readonly CapabilityId[];
  readonly lastError: string | null;
}

/**
 * Manages independent lifecycles of extension features.
 * Each feature can be enabled/disabled independently and is verified against runtime capabilities.
 */
export class FeatureRegistry {
  private readonly features = new Map<string, FeatureModule>();
  private readonly mountedFeatures = new Set<string>();
  private readonly errors = new Map<string, string>();
  private readonly log = rootLogger.child('feature-registry');

  public register(feature: FeatureModule): () => void {
    if (this.features.has(feature.id)) {
      throw new Error(`Feature "${feature.id}" is already registered.`);
    }
    this.features.set(feature.id, feature);
    return () => {
      void this.unmountFeature(feature.id);
      this.features.delete(feature.id);
    };
  }

  public get(featureId: string): FeatureModule | undefined {
    return this.features.get(featureId);
  }

  public isMounted(featureId: string): boolean {
    return this.mountedFeatures.has(featureId);
  }

  public async reconcile(context: FeatureContext): Promise<void> {
    const config = context.getConfig();
    for (const [id, feature] of this.features.entries()) {
      const enabled = config.enabledFeatures[id] ?? feature.defaultEnabled;
      const missingCaps = feature.requiredCapabilities.filter(
        (cap) => !context.isCapabilitySupported(cap)
      );

      if (enabled && missingCaps.length === 0) {
        if (!this.mountedFeatures.has(id)) {
          await this.mountFeature(feature, context);
        } else if (feature.onConfigChange) {
          try {
            await feature.onConfigChange(config, context);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Feature config update failed';
            this.errors.set(id, msg);
            this.log.error(`Error updating config for feature "${id}"`, err);
          }
        }
      } else if (this.mountedFeatures.has(id)) {
        await this.unmountFeature(id);
      }
    }
  }

  public async mountFeature(feature: FeatureModule, context: FeatureContext): Promise<boolean> {
    const missingCaps = feature.requiredCapabilities.filter(
      (cap) => !context.isCapabilitySupported(cap)
    );
    if (missingCaps.length > 0) {
      this.log.info(
        `Skipping mount for feature "${feature.id}" due to unsupported capabilities: ${missingCaps.join(', ')}`
      );
      return false;
    }

    try {
      await feature.mount(context);
      this.mountedFeatures.add(feature.id);
      this.errors.delete(feature.id);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Mount failed';
      this.errors.set(feature.id, msg);
      this.log.error(`Failed to mount feature "${feature.id}"`, err);
      return false;
    }
  }

  public async unmountFeature(featureId: string): Promise<void> {
    if (!this.mountedFeatures.has(featureId)) {
      return;
    }
    const feature = this.features.get(featureId);
    this.mountedFeatures.delete(featureId);
    if (!feature) {
      return;
    }
    try {
      await feature.unmount();
    } catch (err) {
      this.log.error(`Error unmounting feature "${featureId}"`, err);
    }
  }

  public async unmountAll(): Promise<void> {
    for (const id of Array.from(this.mountedFeatures)) {
      await this.unmountFeature(id);
    }
  }

  public getStatusList(context: FeatureContext): readonly FeatureStatusEntry[] {
    const config = context.getConfig();
    return Array.from(this.features.values()).map((feature) => {
      const enabledInConfig = config.enabledFeatures[feature.id] ?? feature.defaultEnabled;
      const blockedByCapabilities = feature.requiredCapabilities.filter(
        (cap) => !context.isCapabilitySupported(cap)
      );
      return {
        id: feature.id,
        name: feature.name,
        description: feature.description,
        enabledInConfig,
        mounted: this.mountedFeatures.has(feature.id),
        blockedByCapabilities,
        lastError: this.errors.get(feature.id) ?? null,
      };
    });
  }
}
