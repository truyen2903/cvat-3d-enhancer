import type { CommandRegistry } from '../../../core/command-registry';
import type { FeatureContext, FeatureModule } from '../../../core/feature-registry';
import { LifecycleManager } from '../../../core/lifecycle-manager';
import type { EnhancerConfig } from '../../../shared/types';

export function formatKeyboardEventCombo(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    parts.push(key);
  }
  return parts.join('+');
}

export class ShortcutsFeature implements FeatureModule {
  public readonly id = 'productivity';
  public readonly name = 'Workspace Keyboard Shortcuts';
  public readonly description =
    'Provides non-conflicting keyboard shortcuts to toggle the enhancer panel, reset visual settings, and cycle cuboid color modes.';
  public readonly requiredCapabilities = [] as const;
  public readonly defaultEnabled = true;

  private readonly commandRegistry: CommandRegistry;
  private readonly targetWindow: Window;
  private readonly shortcutToCommand = new Map<string, string>();
  private allRequireModifier = true;
  private lifecycle: LifecycleManager | null = null;
  private currentConfig: EnhancerConfig | null = null;

  public constructor(commandRegistry: CommandRegistry, targetWindow: Window = window) {
    this.commandRegistry = commandRegistry;
    this.targetWindow = targetWindow;
  }

  private rebuildShortcutIndex(config: EnhancerConfig | null): void {
    this.shortcutToCommand.clear();
    this.allRequireModifier = true;
    if (!config?.productivity.shortcutsEnabled) {
      return;
    }

    const prod = config.productivity;
    const bindings: readonly [string, string][] = [
      [prod.togglePanelShortcut, 'ui.togglePanel'],
      [prod.quickResetCameraShortcut, 'runtime.resetDefaults'],
      [prod.cycleColorByShortcut, 'annotation.cycleColorBy'],
    ];

    for (const [rawShortcut, commandId] of bindings) {
      const normalized = rawShortcut.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (!this.shortcutToCommand.has(normalized)) {
        this.shortcutToCommand.set(normalized, commandId);
      }
      const hasPrimaryModifier =
        normalized.includes('alt+') || normalized.includes('ctrl+') || normalized.includes('meta+');
      if (!hasPrimaryModifier) {
        this.allRequireModifier = false;
      }
    }
  }

  public mount(context: FeatureContext): void {
    this.currentConfig = context.getConfig();
    this.rebuildShortcutIndex(this.currentConfig);
    this.lifecycle = new LifecycleManager();

    this.lifecycle.addEventListener(this.targetWindow, 'keydown', (event: KeyboardEvent) => {
      if (this.allRequireModifier && !event.altKey && !event.ctrlKey && !event.metaKey) {
        return;
      }
      if (!this.currentConfig?.productivity.shortcutsEnabled || this.shortcutToCommand.size === 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const commandId = this.shortcutToCommand.get(formatKeyboardEventCombo(event).toLowerCase());
      if (commandId) {
        event.preventDefault();
        void this.commandRegistry.execute(commandId);
      }
    });
  }

  public onConfigChange(config: EnhancerConfig): void {
    this.currentConfig = config;
    this.rebuildShortcutIndex(config);
  }

  public async unmount(): Promise<void> {
    this.shortcutToCommand.clear();
    if (this.lifecycle) {
      await this.lifecycle.dispose();
      this.lifecycle = null;
    }
  }
}
