import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../../src/core/command-registry';
import { EventBus } from '../../src/core/event-bus';
import { type FeatureContext, FeatureRegistry } from '../../src/core/feature-registry';
import { LifecycleManager } from '../../src/core/lifecycle-manager';
import { SYSTEM_DEFAULT_CONFIG } from '../../src/application/config';
import { createInitialCapabilityMap } from '../../src/integration/cvat/runtime';

describe('Core Architecture (LifecycleManager, EventBus, FeatureRegistry, CommandRegistry)', () => {
  it('cleans up registered listeners and disposables in reverse order', async () => {
    const lifecycle = new LifecycleManager();
    const order: number[] = [];

    lifecycle.registerCleanup(() => {
      order.push(1);
    });
    lifecycle.registerCleanup(() => {
      order.push(2);
    });

    await lifecycle.dispose();
    expect(order).toEqual([2, 1]);
    expect(lifecycle.isDisposed()).toBe(true);
  });

  it('emits and unsubscribes typed events cleanly', () => {
    const bus = new EventBus<{ ping: number }>();
    const fn = vi.fn();
    const off = bus.on('ping', fn);

    bus.emit('ping', 42);
    expect(fn).toHaveBeenCalledWith(42);

    off();
    bus.emit('ping', 99);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('blocks feature mounting when required capabilities are unsupported', async () => {
    const registry = new FeatureRegistry();
    const mountSpy = vi.fn();

    registry.register({
      id: 'point-size-feature',
      name: 'Point Size Feature',
      description: 'Test',
      requiredCapabilities: ['pointSize'],
      defaultEnabled: true,
      mount: mountSpy,
      unmount: vi.fn(),
    });

    const context: FeatureContext = {
      getConfig: () => SYSTEM_DEFAULT_CONFIG,
      getRuntimeSnapshot: () => ({
        detected: true,
        serverVersion: '2.81.0',
        coreVersion: '2.81.0',
        hasCvatUIPluginHook: true,
        has3DCanvasDom: true,
        hasPerspectiveCanvas: true,
        hasOrthographicViews: true,
        hasReduxStoreAccess: true,
        capabilities: createInitialCapabilityMap(),
      }),
      isCapabilitySupported: () => false,
    };

    await registry.reconcile(context);
    expect(mountSpy).not.toHaveBeenCalled();
    expect(registry.isMounted('point-size-feature')).toBe(false);
  });

  it('enforces capability checks before executing commands', async () => {
    const cmdRegistry = new CommandRegistry((cap) => cap === 'cameraPresets');
    const execSpy = vi.fn(() => 'done');

    cmdRegistry.register({
      id: 'camera.test',
      title: 'Camera Test',
      category: 'camera',
      requiredCapabilities: ['cameraPresets'],
      execute: execSpy,
    });

    cmdRegistry.register({
      id: 'grid.test',
      title: 'Grid Test',
      category: 'visualization',
      requiredCapabilities: ['gridVisibility'],
      execute: execSpy,
    });

    await expect(cmdRegistry.execute('camera.test')).resolves.toBe('done');
    await expect(cmdRegistry.execute('grid.test')).rejects.toThrow(/gridVisibility/);
    await expect(cmdRegistry.execute('unknown.command')).rejects.toThrow(/Rejected unknown command/);
  });
});
