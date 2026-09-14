/**
 * Stable ids for workflow steps and branches, and `{"$ph": "key"}` placeholders that stand in for workspace
 * ids (stages, tags, calendars, people…) in recipes and agency templates. Browser-safe.
 */
import { z } from 'zod';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const STEP_ID_RE = /^s_[a-z0-9]{8}$/;
export const BRANCH_ID_RE = /^b_[a-z0-9]{8}$/;

export const StepId = z
  .string()
  .regex(STEP_ID_RE, { error: 'A step id is s_ and 8 lowercase letters or digits.' });
export const BranchId = z
  .string()
  .regex(BRANCH_ID_RE, { error: 'A branch id is b_ and 8 lowercase letters or digits.' });

function randomChars(count: number, random?: () => number): string {
  let out = '';
  if (random) {
    for (let i = 0; i < count; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return out;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** A new step id. Ids are made once and never change, so live runs, diffs and template updates can follow them. */
export function newStepId(random?: () => number): string {
  return `s_${randomChars(8, random)}`;
}

export function newBranchId(random?: () => number): string {
  return `b_${randomChars(8, random)}`;
}

export const PLACEHOLDER_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

/** A named stand-in for a workspace id; installing a recipe or template maps each key to a real id. */
export const Placeholder = z.strictObject({
  $ph: z.string().regex(PLACEHOLDER_KEY_RE, { error: 'Placeholder keys are lowercase words.' }),
});
export type Placeholder = z.infer<typeof Placeholder>;

export function isPlaceholder(value: unknown): value is Placeholder {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $ph?: unknown }).$ph === 'string' &&
    Object.keys(value).length === 1
  );
}

/** A workspace id or a placeholder for one. */
export const Ref = z.union([z.uuid(), Placeholder]);
export type Ref = z.infer<typeof Ref>;

/** What a reference points at. */
export const REF_KINDS = [
  'pipeline',
  'stage',
  'tag',
  'calendar',
  'service',
  'user',
  'workflow',
] as const;
export type RefKind = (typeof REF_KINDS)[number];
