import type { z } from 'zod';
import type { AiTurn } from './types';

/** A structured answer (`responseFormat`) that can't be used: cut off, refused, not JSON, or the wrong shape. */
export class AiOutputError extends Error {
  constructor(
    message: string,
    /** What didn't match, as `path: problem` lines. */
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AiOutputError';
  }
}

/**
 * The object a structured request answered with, checked against its zod schema (which also enforces the
 * limits a provider's schema support leaves out, such as lengths). Throws AiOutputError otherwise.
 */
export function parseStructured<S extends z.ZodType>(turn: AiTurn, schema: S): z.output<S> {
  if (turn.stopReason === 'max_tokens')
    throw new AiOutputError('The answer was cut off before it finished.');
  if (turn.stopReason === 'refusal') throw new AiOutputError('The model declined to answer.');
  let value: unknown;
  try {
    value = JSON.parse(turn.text);
  } catch {
    throw new AiOutputError('The answer was not JSON.');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AiOutputError(
      'The answer did not have the expected shape.',
      parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(answer)'}: ${i.message}`),
    );
  return parsed.data;
}
