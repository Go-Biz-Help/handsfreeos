import type { CommandDef, QueryDef } from './types';

export interface Registry {
  readonly commands: readonly CommandDef[];
  readonly queries: readonly QueryDef[];
  command(name: string): CommandDef | undefined;
  query(name: string): QueryDef | undefined;
}

export function createRegistry(
  commands: readonly CommandDef[],
  queries: readonly QueryDef[],
): Registry {
  const byName = <T extends { name: string }>(
    items: readonly T[],
    kind: string,
  ): Map<string, T> => {
    const map = new Map<string, T>();
    for (const item of items) {
      if (map.has(item.name)) throw new Error(`duplicate ${kind} ${item.name}`);
      map.set(item.name, item);
    }
    return map;
  };
  const c = byName(commands, 'command');
  const q = byName(queries, 'query');
  return { commands, queries, command: (n) => c.get(n), query: (n) => q.get(n) };
}

let composed: Registry | null = null;

/**
 * The registry `@hfos/core/server` composed (core's operations and every add-on's), handed over once as it loads. A
 * command that runs another by a name it stored, such as an approved AI teammate ask (round seven), finds it here:
 * core's commands can't import the composed list, which is built from them.
 */
export function bindRegistry(registry: Registry): void {
  composed = registry;
}

/** The composed registry, or null before `@hfos/core/server` has loaded. */
export const boundRegistry = (): Registry | null => composed;
