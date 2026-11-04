import { describe, expect, it } from 'vitest';
import { ConfigurationManager, SYSTEM_DEFAULT_CONFIG } from '../../src/application/config';
import { InMemoryStorageAdapter } from '../../src/infrastructure/storage';

describe('Hierarchical Configuration System', () => {
  it('enforces Task > Project > Global > System Defaults precedence with partial merging', async () => {
    const storage = new InMemoryStorageAdapter();
    const manager = new ConfigurationManager(storage);

    // 1. Default
    const initial = await manager.resolveEffectiveConfig({ projectId: '10', taskId: '20' });
    expect(initial).toEqual(SYSTEM_DEFAULT_CONFIG);

    // 2. Global override
    await manager.setScopeOverride('global', {
      visualization3d: { cuboidOpacity: 55 },
      annotation: { colorBy: 'Instance' },
    });

    const afterGlobal = await manager.resolveEffectiveConfig({ projectId: '10', taskId: '20' });
    expect(afterGlobal.visualization3d.cuboidOpacity).toBe(55);
    expect(afterGlobal.annotation.colorBy).toBe('Instance');

    // 3. Project override
    await manager.setScopeOverride(
      'project',
      {
        visualization3d: { cuboidOpacity: 30, selectedCuboidOpacity: 80 },
      },
      { projectId: '10' }
    );

    const afterProject = await manager.resolveEffectiveConfig({ projectId: '10', taskId: '20' });
    expect(afterProject.visualization3d.cuboidOpacity).toBe(30);
    expect(afterProject.visualization3d.selectedCuboidOpacity).toBe(80);
    expect(afterProject.annotation.colorBy).toBe('Instance'); // Inherited from Global

    // 4. Task override (highest precedence)
    await manager.setScopeOverride(
      'task',
      {
        visualization3d: { cuboidOpacity: 12 },
      },
      { projectId: '10', taskId: '20' }
    );

    const afterTask = await manager.resolveEffectiveConfig({ projectId: '10', taskId: '20' });
    expect(afterTask.visualization3d.cuboidOpacity).toBe(12);
    expect(afterTask.visualization3d.selectedCuboidOpacity).toBe(80); // Inherited from Project
    expect(afterTask.annotation.colorBy).toBe('Instance'); // Inherited from Global
  });

  it('migrates schemaVersion 1 legacy payloads to schemaVersion 2', async () => {
    const storage = new InMemoryStorageAdapter();
    const manager = new ConfigurationManager(storage);

    const v1Json = JSON.stringify({
      schemaVersion: 1,
      appearance: {
        backgroundColor: '#112233',
      },
    });

    const migrated = await manager.importJson(v1Json, 'global');
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.appearance.canvasBackgroundColor).toBe('#112233');
  });

  it('supports built-in and custom presets', async () => {
    const storage = new InMemoryStorageAdapter();
    const manager = new ConfigurationManager(storage);

    const afterPreset = await manager.applyPreset('lidar-high-contrast', 'global');
    expect(afterPreset.appearance.canvasBackgroundColor).toBe('#000000');
    expect(afterPreset.visualization3d.cuboidOutlineColor).toBe('#facc15');
  });
});
