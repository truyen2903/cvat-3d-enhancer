import type { CapabilityId } from '../shared/types';
import { rootLogger } from './logger';

export interface CommandDefinition<TPayload = unknown, TResult = void> {
  readonly id: string;
  readonly title: string;
  readonly category: 'camera' | 'visualization' | 'appearance' | 'annotation' | 'ui' | 'presets';
  readonly requiredCapabilities?: readonly CapabilityId[];
  readonly execute: (payload: TPayload) => Promise<TResult> | TResult;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition<unknown, unknown>>();
  private readonly capabilityChecker?: (cap: CapabilityId) => boolean;
  private readonly log = rootLogger.child('command-registry');

  public constructor(capabilityChecker?: (cap: CapabilityId) => boolean) {
    this.capabilityChecker = capabilityChecker;
  }

  public register<TPayload = unknown, TResult = void>(
    definition: CommandDefinition<TPayload, TResult>
  ): () => void {
    if (this.commands.has(definition.id)) {
      throw new Error(`Command "${definition.id}" is already registered.`);
    }
    this.commands.set(definition.id, definition as CommandDefinition<unknown, unknown>);
    return () => {
      this.commands.delete(definition.id);
    };
  }

  public has(commandId: string): boolean {
    return this.commands.has(commandId);
  }

  public list(): readonly CommandDefinition<unknown, unknown>[] {
    return Array.from(this.commands.values());
  }

  public async execute<TPayload = unknown, TResult = unknown>(
    commandId: string,
    payload?: TPayload
  ): Promise<TResult> {
    const command = this.commands.get(commandId);
    if (!command) {
      throw new Error(`Rejected unknown command: "${commandId}"`);
    }

    if (command.requiredCapabilities && this.capabilityChecker) {
      for (const cap of command.requiredCapabilities) {
        if (!this.capabilityChecker(cap)) {
          throw new Error(
            `Cannot execute command "${commandId}": required runtime capability "${cap}" is not supported.`
          );
        }
      }
    }

    this.log.debug(`Executing command "${commandId}"`);
    return (await command.execute(payload)) as TResult;
  }

  public clear(): void {
    this.commands.clear();
  }
}
