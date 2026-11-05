/**
 * Which details a texting registration's checks were run on, as one short string (server only).
 *
 * **Why the server keeps it.** The owner's rule (2026-11-05): a registration goes to the carriers only when every row
 * on its last step is green, or after HandsFreeOS checked it by hand. The wizard greys out Send, but a greyed-out
 * button guards nothing on its own: the Assistant, an old tab or a direct call could still send. So the worker writes
 * down what its checks found for exactly which details (`registration.record_check`), and `registration.submit` sends
 * only details whose fingerprint was found all green.
 *
 * Both sides hash the details after the same schema (`BusinessProfile`) has read them, keys sorted, so the same
 * answers always give the same string. The ticks the business confirms are left out: they're checked at the send
 * itself, and ticking one shouldn't mean opening four websites again.
 */
import { createHash } from 'node:crypto';

/** The same value with every object's keys in order, so equal details serialize the same. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sorted(v);
    }
    return out;
  }
  return value;
}

/** The fingerprint of a registration's details: sha-256, in hex. */
export function registrationFingerprint(kind: string, business: object): string {
  const { confirmed: _ticks, ...rest } = business as Record<string, unknown>;
  return createHash('sha256')
    .update(JSON.stringify(sorted({ kind, business: rest })))
    .digest('hex');
}

/** How long a check stays good for a send: a day, so a site taken down since isn't vouched for. */
export const REGISTRATION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
