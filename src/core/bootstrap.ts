import { registerApplicationCommands } from '../application/commands';
import { ConfigurationManager, type ConfigurationScopeLevel } from '../application/config';
import { CommandRegistry } from './command-registry';
import { EventBus } from './event-bus';
import { type FeatureContext, FeatureRegistry } from './feature-registry';
import { LifecycleManager } from './lifecycle-manager';
import { rootLogger } from './logger';
import { LabelColorsFeature } from '../features/annotation-tools/label-colors';
import { ObjectAppearanceFeature } from '../features/annotation-tools/object-appearance';
import { SelectionEnhancementFeature } from '../features/annotation-tools/selection';
import { AppearanceFeature } from '../features/appearance';
import { PresetsFeature } from '../features/presets';
import { ShortcutsFeature } from '../features/productivity/shortcuts';
import { CoordinateAxesFeature } from '../features/visualization-3d/axes';
import { CameraPresetsFeature } from '../features/visualization-3d/camera';
import { CuboidVisualizationFeature } from '../features/visualization-3d/cuboid';
import { GridVisibilityFeature } from '../features/visualization-3d/grid';
import { PointCloudAppearanceFeature } from '../features/visualization-3d/point-cloud';
import { AuthenticationManager } from '../infrastructure/authentication';
import { getExtensionRuntimeUrl, loadAuthorizedOrigins } from '../infrastructure/browser';
import { PageBridge } from '../integration/cvat/bridge';
import { VersionDetector } from '../integration/cvat/compatibility';
import { RuntimeDetector } from '../integration/cvat/detector';
import { CvatDomAdapter } from '../integration/cvat/dom';
import {
  detectActiveZoomedOrthoView,
  isEditableEventTarget,
  resolveNudgeKeyCode,
} from '../integration/cvat/runtime/ortho-cuboid-editor';
import {
  CapabilityRegistry,
  CvatV2RuntimeAdapter,
  RuntimeManager,
} from '../integration/cvat/runtime';
import type { CameraPresetAction } from '../shared/constants';
import type { EnhancerConfig, PartialEnhancerConfig } from '../shared/types';
import { useEnhancerUiStore } from '../ui/settings/store';

export interface BootstrapController {
  dispose(): Promise<void>;
}

const log = rootLogger.child('bootstrap');

function injectPageBridgeScript(doc: Document, sessionToken: string): () => void {
  const scriptUrl = getExtensionRuntimeUrl('assets/page-bridge.js');
  if (!scriptUrl) {
    return () => undefined;
  }

  const scriptEl = doc.createElement('script');
  scriptEl.type = 'module';
  scriptEl.src = scriptUrl;
  scriptEl.dataset.cvatEnhancerBridgeToken = sessionToken;
  let loaded = false;
  let disposed = false;
  const cleanupEl = () => {
    loaded = true;
    if (disposed) {
      scriptEl.remove();
    }
  };
  scriptEl.addEventListener('load', cleanupEl, { once: true });
  scriptEl.addEventListener('error', cleanupEl, { once: true });
  (doc.head || doc.documentElement).appendChild(scriptEl);

  return () => {
    disposed = true;
    if (loaded) {
      scriptEl.remove();
    }
  };
}

export async function bootstrapContentExtension(): Promise<BootstrapController> {
  const lifecycle = new LifecycleManager();
  const eventBus = new EventBus();

  // Inject page bridge synchronously at document_start so pre-render hooks and white background
  // styles attach before CVAT mounts its first 3D WebGL frame
  const bridge = new PageBridge(window);
  lifecycle.registerCleanup(bridge.attach());
  lifecycle.registerCleanup(injectPageBridgeScript(document, bridge.getSessionToken()));

  // Also register a synchronous window capture listener at document_start so that even if a page
  // listener was attached before page-bridge ES module finished loading, W/A/S/D/Q/E are suppressed
  // whenever an orthographic view is maximized.
  const onEarlyZoomKeyCapture = (event: KeyboardEvent): void => {
    const code = resolveNudgeKeyCode(event);
    if (!code || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    if (isEditableEventTarget(event.target)) {
      return;
    }
    if (detectActiveZoomedOrthoView(document, null)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    window.addEventListener(type, onEarlyZoomKeyCapture, true);
    document.addEventListener(type, onEarlyZoomKeyCapture, true);
  }
  lifecycle.registerCleanup(() => {
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      window.removeEventListener(type, onEarlyZoomKeyCapture, true);
      document.removeEventListener(type, onEarlyZoomKeyCapture, true);
    }
  });

  const authorizedOrigins = await loadAuthorizedOrigins();
  const runtimeDetector = new RuntimeDetector(authorizedOrigins);
  const routeContext = runtimeDetector.detectRouteContext();

  if (!routeContext.isCvatPage) {
    await lifecycle.dispose();
    return {
      dispose: async () => {
        await lifecycle.dispose();
      },
    };
  }

  const domAdapter = new CvatDomAdapter(document);
  const versionDetector = new VersionDetector(authorizedOrigins);
  const capabilityRegistry = new CapabilityRegistry();
  const runtimeAdapter = new CvatV2RuntimeAdapter(
    bridge,
    domAdapter,
    versionDetector,
    capabilityRegistry
  );
  const runtimeManager = new RuntimeManager(runtimeAdapter, capabilityRegistry);
  const configManager = new ConfigurationManager();
  const authManager = new AuthenticationManager({
    authorizedOrigins,
    onStateChange: (authState) => {
      eventBus.emit('auth:updated', authState);
      useEnhancerUiStore.getState().syncExternalState({ authState });
    },
  });

  const commandRegistry = new CommandRegistry((cap) => runtimeManager.isCapabilitySupported(cap));
  const featureRegistry = new FeatureRegistry();

  let currentConfig: EnhancerConfig = configManager.getSystemDefaults();
  let currentRoute = routeContext;

  const getScopeContext = () => ({
    projectId: currentRoute.projectId,
    taskId: currentRoute.taskId,
  });

  const featureContext: FeatureContext = {
    getConfig: () => currentConfig,
    getRuntimeSnapshot: () => runtimeManager.getSnapshot(),
    isCapabilitySupported: (cap) => runtimeManager.isCapabilitySupported(cap),
  };

  // Register independent feature modules
  featureRegistry.register(new AppearanceFeature(runtimeAdapter));
  featureRegistry.register(new PointCloudAppearanceFeature(runtimeAdapter));
  featureRegistry.register(new CameraPresetsFeature(runtimeAdapter));
  featureRegistry.register(new GridVisibilityFeature());
  featureRegistry.register(new CoordinateAxesFeature());
  featureRegistry.register(new CuboidVisualizationFeature(runtimeAdapter));
  featureRegistry.register(new LabelColorsFeature(runtimeAdapter));
  featureRegistry.register(new ObjectAppearanceFeature(runtimeAdapter));
  featureRegistry.register(new SelectionEnhancementFeature(runtimeAdapter));
  featureRegistry.register(new ShortcutsFeature(commandRegistry, window));
  featureRegistry.register(new PresetsFeature(configManager));

  const syncAll = async () => {
    currentRoute = runtimeDetector.detectRouteContext();
    currentConfig = await configManager.resolveEffectiveConfig(getScopeContext());
    const runtimeSnapshot = await runtimeManager.refresh();
    const presets = await configManager.getPresets();
    const featureStatuses = featureRegistry.getStatusList(featureContext);

    useEnhancerUiStore.getState().syncExternalState({
      routeContext: currentRoute,
      config: currentConfig,
      runtimeSnapshot,
      presets,
      featureStatuses,
    });
  };

  registerApplicationCommands({
    commandRegistry,
    runtimeManager,
    configManager,
    eventBus,
    getScopeContext,
    onConfigUpdated: syncAll,
  });

  const unsubscribeToggle = eventBus.on('ui:toggle-panel', () => {
    useEnhancerUiStore.getState().toggleCollapsed();
  });
  lifecycle.registerCleanup(unsubscribeToggle);

  useEnhancerUiStore.getState().syncExternalState({
    handlers: {
      updateConfig: async (level: ConfigurationScopeLevel, override: PartialEnhancerConfig) => {
        await configManager.setScopeOverride(level, override, getScopeContext());
        await syncAll();
      },
      applyPreset: async (presetId: string, level: ConfigurationScopeLevel) => {
        await configManager.applyPreset(presetId, level, getScopeContext());
        await syncAll();
      },
      resetToCvatDefaults: async () => {
        await commandRegistry.execute('runtime.resetDefaults');
      },
      dispatchCameraAction: async (action: CameraPresetAction) => {
        await commandRegistry.execute('camera.action', { action });
      },
      refreshAuthAndRuntime: async () => {
        await authManager.detectAuthentication(window.location.origin);
        await syncAll();
      },
      connectPat: async (rawToken: string) => {
        await authManager.connectWithPersonalAccessToken(window.location.origin, rawToken);
      },
      disconnectAuth: async () => {
        await authManager.disconnect(window.location.origin);
      },
      exportConfigJson: async () => {
        return configManager.exportJson(getScopeContext());
      },
      importConfigJson: async (rawJson: string, level: ConfigurationScopeLevel) => {
        await configManager.importJson(rawJson, level, getScopeContext());
        await syncAll();
      },
    },
  });

  // Remove any legacy floating panel host so all 3D features remain stealthily integrated inside CVAT native UI
  const removeLegacyFloatingHost = () => {
    const existingHost = document.getElementById('cvat-3d-enhancer-shadow-host');
    if (existingHost) {
      existingHost.remove();
    }
  };
  removeLegacyFloatingHost();

  lifecycle.registerCleanup(async () => {
    await featureRegistry.unmountAll();
    commandRegistry.clear();
    eventBus.clear();
  });

  // Initial detection of authentication and 3D runtime
  try {
    await authManager.detectAuthentication(window.location.origin);
    await syncAll();
  } catch (err) {
    log.error('Initial bootstrap synchronization error', err);
  }

  // Observe SPA DOM transitions to detect when user enters/exits a 3D annotation job
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  lifecycle.observeMutations(
    document.documentElement,
    { childList: true, subtree: true },
    () => {
      removeLegacyFloatingHost();
      const nextRoute = runtimeDetector.detectRouteContext();
      if (
        nextRoute.pathname !== currentRoute.pathname ||
        nextRoute.is3DWorkspace !== currentRoute.is3DWorkspace
      ) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void syncAll();
        }, 250);
      }
    }
  );
  lifecycle.registerCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  return {
    dispose: async () => {
      await lifecycle.dispose();
    },
  };
}
