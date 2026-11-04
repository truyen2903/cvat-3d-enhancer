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
  private lifecycle: LifecycleManager | null = null;
  private currentConfig: EnhancerConfig | null = null;

  public constructor(commandRegistry: CommandRegistry, targetWindow: Window = window) {
    this.commandRegistry = commandRegistry;
    this.targetWindow = targetWindow;
  }

  public mount(context: FeatureContext): void {
    this.currentConfig = context.getConfig();
    this.lifecycle = new LifecycleManager();

    this.lifecycle.addEventListener(this.targetWindow, 'keydown', (event: KeyboardEvent) => {
      if (!this.currentConfig?.productivity.shortcutsEnabled) {
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

      const combo = formatKeyboardEventCombo(event);
      const prod = this.currentConfig.productivity;

      if (combo.toLowerCase() === prod.togglePanelShortcut.toLowerCase()) {
        event.preventDefault();
        void this.commandRegistry.execute('ui.togglePanel');
      } else if (combo.toLowerCase() === prod.quickResetCameraShortcut.toLowerCase()) {
        event.preventDefault();
        void this.commandRegistry.execute('runtime.resetDefaults');
      } else if (combo.toLowerCase() === prod.cycleColorByShortcut.toLowerCase()) {
        event.preventDefault();
        void this.commandRegistry.execute('annotation.cycleColorBy');
      }
    });
  }

  public onConfigChange(config: EnhancerConfig): void {
    this.currentConfig = config;
  }

  public async unmount(): Promise<void> {
    if (this.lifecycle) {
      await this.lifecycle.dispose();
      this.lifecycle = null;
    }
  }
}
