import type { z } from 'zod';
import type { CommandDef, OfflineClass, QueryDef } from './types';

/** A command. Left out, `offline` is `online`: only a definition that says so may wait on a phone. */
export function defineCommand<I extends z.ZodType, O extends z.ZodType>(
  def: Omit<CommandDef<I, O>, 'kind' | 'offline'> & { readonly offline?: OfflineClass },
): CommandDef<I, O> {
  return { kind: 'command', ...def, offline: def.offline ?? 'online' };
}

export function defineQuery<I extends z.ZodType, O extends z.ZodType>(
  def: Omit<QueryDef<I, O>, 'kind'>,
): QueryDef<I, O> {
  return { kind: 'query', ...def };
}
