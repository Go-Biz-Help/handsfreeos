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
