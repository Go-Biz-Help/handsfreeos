import type { z } from 'zod';
import type { CommandDef, QueryDef } from './types';

export function defineCommand<I extends z.ZodType, O extends z.ZodType>(
  def: Omit<CommandDef<I, O>, 'kind'>,
): CommandDef<I, O> {
  return { kind: 'command', ...def };
}

export function defineQuery<I extends z.ZodType, O extends z.ZodType>(
  def: Omit<QueryDef<I, O>, 'kind'>,
): QueryDef<I, O> {
  return { kind: 'query', ...def };
}
