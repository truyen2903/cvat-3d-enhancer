import type { CommandDefinition, CommandRegistry } from '../../../core/command-registry';

export class CommandPaletteService {
  private readonly registry: CommandRegistry;

  public constructor(registry: CommandRegistry) {
    this.registry = registry;
  }

  public searchCommands(query: string): readonly CommandDefinition<unknown, unknown>[] {
    const normalized = query.trim().toLowerCase();
    const all = this.registry.list();
    if (!normalized) {
      return all;
    }
    return all.filter(
      (cmd) =>
        cmd.title.toLowerCase().includes(normalized) ||
        cmd.id.toLowerCase().includes(normalized) ||
        cmd.category.toLowerCase().includes(normalized)
    );
  }
}
