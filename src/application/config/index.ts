import {
  ChromeLocalStorageAdapter,
  type KeyValueStorageAdapter,
} from '../../infrastructure/storage';
import {
  CURRENT_SCHEMA_VERSION,
  getProjectStorageKey,
  getTaskStorageKey,
  STORAGE_KEYS,
} from '../../shared/constants';
import {
  EnhancerConfigSchema,
  PartialEnhancerConfigSchema,
  PresetDefinitionSchema,
} from '../../shared/schemas';
import type {
  EnhancerConfig,
  PartialEnhancerConfig,
  PresetDefinition,
} from '../../shared/types';
import { assertNoPrototypePollution, isPlainObject, safeJsonParse } from '../../shared/utils';

export const SYSTEM_DEFAULT_CONFIG: EnhancerConfig = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  enabledFeatures: Object.freeze({
    appearance: true,
    'visualization-3d': true,
    'annotation-tools': true,
    productivity: true,
    presets: true,
  }),
  appearance: Object.freeze({
    themePreset: 'cvat-dark',
    canvasBackgroundColor: '#0f172a',
    panelAccentColor: '#38bdf8',
    uiDensity: 'compact',
    highContrastCrosshair: false,
  }),
  visualization3d: Object.freeze({
    cuboidOpacity: 40,
    selectedCuboidOpacity: 65,
    cuboidOutlinedBorders: true,
    cuboidOutlineColor: '#38bdf8',
    cuboidOrientationVisibility: 'always',
    controlPointsSize: 5,
    focusedObjectPadding: 50,
    pointCloudCssBrightness: 100,
    pointCloudCssContrast: 100,
    pointSizeValue: 0.05,
    gridVisible: true,
    axesVisible: true,
  }),
  annotation: Object.freeze({
    colorBy: 'Label',
    highlightActiveCuboidBorder: true,
    labelColorOverrides: Object.freeze({}),
  }),
  productivity: Object.freeze({
    shortcutsEnabled: true,
    togglePanelShortcut: 'Alt+Shift+E',
    quickResetCameraShortcut: 'Alt+Shift+R',
    cycleColorByShortcut: 'Alt+Shift+C',
  }),
});

export const BUILT_IN_PRESETS: readonly PresetDefinition[] = Object.freeze([
  {
    id: 'default-balanced',
    name: 'CVAT Balanced 3D',
    description: 'Default balanced 3D cuboid opacity and slate dark background.',
    builtIn: true,
    config: {
      appearance: {
        themePreset: 'cvat-dark',
        canvasBackgroundColor: '#0f172a',
      },
      visualization3d: {
        cuboidOpacity: 40,
        selectedCuboidOpacity: 65,
        cuboidOutlinedBorders: true,
        cuboidOutlineColor: '#38bdf8',
        pointCloudCssBrightness: 100,
        pointCloudCssContrast: 100,
      },
    },
  },
  {
    id: 'lidar-high-contrast',
    name: 'LiDAR High Contrast',
    description: 'High-contrast pitch-black canvas with sharp cuboid outlines and translucent fills.',
    builtIn: true,
    config: {
      appearance: {
        themePreset: 'high-contrast',
        canvasBackgroundColor: '#000000',
        highContrastCrosshair: true,
      },
      visualization3d: {
        cuboidOpacity: 20,
        selectedCuboidOpacity: 45,
        cuboidOutlinedBorders: true,
        cuboidOutlineColor: '#facc15',
        pointCloudCssBrightness: 115,
        pointCloudCssContrast: 120,
      },
    },
  },
  {
    id: 'dense-urban-inspection',
    name: 'Dense Urban Cuboids',
    description: 'Instance-colored cuboids with minimal fill opacity to inspect dense point clouds.',
    builtIn: true,
    config: {
      appearance: {
        themePreset: 'midnight-slate',
        canvasBackgroundColor: '#090d16',
      },
      visualization3d: {
        cuboidOpacity: 15,
        selectedCuboidOpacity: 50,
        cuboidOutlinedBorders: true,
        cuboidOutlineColor: '#22d3ee',
      },
      annotation: {
        colorBy: 'Instance',
      },
    },
  },
]);

/**
 * Migrates legacy configuration objects (e.g., schemaVersion 1 -> 2) before validation.
 */
export function migratePartialConfig(raw: unknown): PartialEnhancerConfig {
  assertNoPrototypePollution(raw);
  if (!isPlainObject(raw)) {
    throw new Error('Configuration payload must be a plain object.');
  }

  const clone: Record<string, unknown> = structuredClone(raw);
  const version = typeof clone.schemaVersion === 'number' ? clone.schemaVersion : 1;

  if (version === 1) {
    // Migration v1 -> v2:
    // In v1, `appearance.backgroundColor` was renamed to `appearance.canvasBackgroundColor`
    if (isPlainObject(clone.appearance) && typeof clone.appearance.backgroundColor === 'string') {
      clone.appearance = {
        ...clone.appearance,
        canvasBackgroundColor: clone.appearance.backgroundColor,
      };
      delete (clone.appearance as Record<string, unknown>).backgroundColor;
    }
    clone.schemaVersion = CURRENT_SCHEMA_VERSION;
  }

  return PartialEnhancerConfigSchema.parse(clone);
}

/**
 * Deeply merges a partial configuration override onto a base configuration.
 * Precedence: override > base.
 */
export function mergeEnhancerConfig(
  base: EnhancerConfig,
  override?: PartialEnhancerConfig | null
): EnhancerConfig {
  if (!override) {
    return base;
  }

  const validatedOverride = PartialEnhancerConfigSchema.parse(override);

  const merged: EnhancerConfig = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabledFeatures: {
      ...base.enabledFeatures,
      ...(validatedOverride.enabledFeatures ?? {}),
    },
    appearance: {
      ...base.appearance,
      ...(validatedOverride.appearance ?? {}),
    },
    visualization3d: {
      ...base.visualization3d,
      ...(validatedOverride.visualization3d ?? {}),
    },
    annotation: {
      ...base.annotation,
      ...(validatedOverride.annotation ?? {}),
      labelColorOverrides: {
        ...base.annotation.labelColorOverrides,
        ...(validatedOverride.annotation?.labelColorOverrides ?? {}),
      },
    },
    productivity: {
      ...base.productivity,
      ...(validatedOverride.productivity ?? {}),
    },
  };

  return EnhancerConfigSchema.parse(merged);
}

export interface ConfigurationScopeContext {
  readonly projectId?: string | number | null;
  readonly taskId?: string | number | null;
}

export type ConfigurationScopeLevel = 'global' | 'project' | 'task';

export class ConfigurationManager {
  private readonly storage: KeyValueStorageAdapter;

  public constructor(storage: KeyValueStorageAdapter = new ChromeLocalStorageAdapter()) {
    this.storage = storage;
  }

  public getSystemDefaults(): EnhancerConfig {
    return structuredClone(SYSTEM_DEFAULT_CONFIG);
  }

  public async getScopeOverride(
    level: ConfigurationScopeLevel,
    scopeContext: ConfigurationScopeContext = {}
  ): Promise<PartialEnhancerConfig | undefined> {
    const key = this.resolveStorageKey(level, scopeContext);
    const raw = await this.storage.get<unknown>(key);
    if (raw === undefined || raw === null) {
      return undefined;
    }
    return migratePartialConfig(raw);
  }

  public async setScopeOverride(
    level: ConfigurationScopeLevel,
    override: PartialEnhancerConfig,
    scopeContext: ConfigurationScopeContext = {}
  ): Promise<EnhancerConfig> {
    const validated = migratePartialConfig({
      ...override,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    const key = this.resolveStorageKey(level, scopeContext);
    const existing = await this.getScopeOverride(level, scopeContext);

    const nextOverride: PartialEnhancerConfig = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enabledFeatures: {
        ...(existing?.enabledFeatures ?? {}),
        ...(validated.enabledFeatures ?? {}),
      },
      appearance: {
        ...(existing?.appearance ?? {}),
        ...(validated.appearance ?? {}),
      },
      visualization3d: {
        ...(existing?.visualization3d ?? {}),
        ...(validated.visualization3d ?? {}),
      },
      annotation: {
        ...(existing?.annotation ?? {}),
        ...(validated.annotation ?? {}),
        labelColorOverrides: {
          ...(existing?.annotation?.labelColorOverrides ?? {}),
          ...(validated.annotation?.labelColorOverrides ?? {}),
        },
      },
      productivity: {
        ...(existing?.productivity ?? {}),
        ...(validated.productivity ?? {}),
      },
    };

    await this.storage.set(key, PartialEnhancerConfigSchema.parse(nextOverride));
    return this.resolveEffectiveConfig(scopeContext);
  }

  /**
   * Resolves effective configuration using strict hierarchical precedence:
   * Task > Project > Global > System Defaults
   */
  public async resolveEffectiveConfig(
    scopeContext: ConfigurationScopeContext = {}
  ): Promise<EnhancerConfig> {
    let effective = this.getSystemDefaults();

    const globalOverride = await this.getScopeOverride('global', scopeContext);
    effective = mergeEnhancerConfig(effective, globalOverride);

    if (scopeContext.projectId !== undefined && scopeContext.projectId !== null) {
      const projectOverride = await this.getScopeOverride('project', scopeContext);
      effective = mergeEnhancerConfig(effective, projectOverride);
    }

    if (scopeContext.taskId !== undefined && scopeContext.taskId !== null) {
      const taskOverride = await this.getScopeOverride('task', scopeContext);
      effective = mergeEnhancerConfig(effective, taskOverride);
    }

    return effective;
  }

  public async resetScope(
    level: ConfigurationScopeLevel | 'all',
    scopeContext: ConfigurationScopeContext = {}
  ): Promise<EnhancerConfig> {
    if (level === 'all') {
      await this.storage.remove(STORAGE_KEYS.GLOBAL);
      if (scopeContext.projectId) {
        await this.storage.remove(getProjectStorageKey(scopeContext.projectId));
      }
      if (scopeContext.taskId) {
        await this.storage.remove(getTaskStorageKey(scopeContext.taskId));
      }
      return this.getSystemDefaults();
    }

    const key = this.resolveStorageKey(level, scopeContext);
    await this.storage.remove(key);
    return this.resolveEffectiveConfig(scopeContext);
  }

  public async exportJson(scopeContext: ConfigurationScopeContext = {}): Promise<string> {
    const effective = await this.resolveEffectiveConfig(scopeContext);
    return JSON.stringify(effective, null, 2);
  }

  public async importJson(
    rawJson: string,
    targetLevel: ConfigurationScopeLevel = 'global',
    scopeContext: ConfigurationScopeContext = {}
  ): Promise<EnhancerConfig> {
    if (rawJson.length > 65_536) {
      throw new Error('Configuration JSON payload exceeds maximum allowed size (64 KB).');
    }
    const parsed = safeJsonParse<unknown>(rawJson);
    const migrated = migratePartialConfig(parsed);
    const key = this.resolveStorageKey(targetLevel, scopeContext);
    await this.storage.set(key, migrated);
    return this.resolveEffectiveConfig(scopeContext);
  }

  public async getPresets(): Promise<readonly PresetDefinition[]> {
    const customRaw = await this.storage.get<unknown>(STORAGE_KEYS.PRESETS);
    if (!Array.isArray(customRaw)) {
      return [...BUILT_IN_PRESETS];
    }
    const validatedCustom: PresetDefinition[] = [];
    for (const item of customRaw) {
      const res = PresetDefinitionSchema.safeParse(item);
      if (res.success) {
        validatedCustom.push({ ...res.data, builtIn: false });
      }
    }
    return [...BUILT_IN_PRESETS, ...validatedCustom];
  }

  public async saveCustomPreset(preset: PresetDefinition): Promise<readonly PresetDefinition[]> {
    const validated = PresetDefinitionSchema.parse(preset);
    if (BUILT_IN_PRESETS.some((p) => p.id === validated.id)) {
      throw new Error(`Cannot overwrite built-in preset "${validated.id}".`);
    }

    const customRaw = await this.storage.get<unknown>(STORAGE_KEYS.PRESETS);
    const existing: PresetDefinition[] = Array.isArray(customRaw)
      ? customRaw
          .map((item) => PresetDefinitionSchema.safeParse(item))
          .filter((r): r is { success: true; data: PresetDefinition } => r.success)
          .map((r) => r.data)
      : [];

    const filtered = existing.filter((p) => p.id !== validated.id);
    filtered.push({ ...validated, builtIn: false });
    await this.storage.set(STORAGE_KEYS.PRESETS, filtered);
    return this.getPresets();
  }

  public async applyPreset(
    presetId: string,
    targetLevel: ConfigurationScopeLevel = 'global',
    scopeContext: ConfigurationScopeContext = {}
  ): Promise<EnhancerConfig> {
    const allPresets = await this.getPresets();
    const found = allPresets.find((p) => p.id === presetId);
    if (!found) {
      throw new Error(`Preset "${presetId}" not found.`);
    }
    return this.setScopeOverride(targetLevel, found.config, scopeContext);
  }

  private resolveStorageKey(
    level: ConfigurationScopeLevel,
    scopeContext: ConfigurationScopeContext
  ): string {
    if (level === 'global') {
      return STORAGE_KEYS.GLOBAL;
    }
    if (level === 'project') {
      if (!scopeContext.projectId) {
        throw new Error('Project ID is required for project-level configuration.');
      }
      return getProjectStorageKey(scopeContext.projectId);
    }
    if (!scopeContext.taskId) {
      throw new Error('Task ID is required for task-level configuration.');
    }
    return getTaskStorageKey(scopeContext.taskId);
  }
}
