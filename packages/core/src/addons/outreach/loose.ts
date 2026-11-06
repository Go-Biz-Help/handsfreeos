/**
 * A save that changes only what it's given (the Assistant changing one choice or one part of a playbook): an object's
 * own fields, each optional and without its default, so a part left out stays left out and the handler keeps what's
 * saved for it. Browser-safe and pure.
 */
import { z } from 'zod';

type Unwrapped<T> = T extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : T;
export type Loosened<S extends Record<string, z.ZodType>> = {
  [K in keyof S]: z.ZodOptional<Unwrapped<S[K]> extends z.ZodType ? Unwrapped<S[K]> : never>;
};

/** `o`'s fields, each optional, none with a default. Refinements across fields are the handler's to check after. */
export function loosened<S extends Record<string, z.ZodType>>(
  o: z.ZodObject<S>,
): z.ZodObject<Loosened<S>> {
  const shape = Object.fromEntries(
    Object.entries(o.shape as Record<string, z.ZodType>).map(([k, s]) => [
      k,
      (s instanceof z.ZodDefault ? (s.unwrap() as z.ZodType) : s).optional(),
    ]),
  );
  return z.object(shape) as unknown as z.ZodObject<Loosened<S>>;
}

/** Only the parts given: a key whose value is undefined says nothing. */
export const givenOnly = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
