/**
 * The six-digit codes customers type to prove who they are: a website chat visitor (M18) and a client signing in to
 * their portal on a new device (Real Estate round two). The code goes only to something already on file, never to
 * what somebody typed. Only a hash is kept, bound to what it's for (`<visitor or access id>:<code>`), so a code for
 * one thing never opens another. A code lasts ten minutes, three go out an hour, and five wrong tries end it.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_MINUTES = 10;
export const CODES_PER_HOUR = 3;
export const CODE_TRIES = 5;

/** A fresh six-digit code. */
export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** What's kept of a code: sha256 of `<what it's for>:<code>`. */
export const codeHash = (boundTo: string, code: string): Buffer =>
  createHash('sha256').update(`${boundTo}:${code}`).digest();

/** Whether a typed code is the one kept, in constant time. */
export function codeMatches(kept: Uint8Array, boundTo: string, typed: string): boolean {
  const given = codeHash(boundTo, typed.trim());
  return kept.length === given.length && timingSafeEqual(Buffer.from(kept), given);
}

/** "•••• 42" for a phone, "d•••@example.com" for an address. */
export function maskContact(channel: 'sms' | 'email', to: string): string {
  if (channel === 'sms') return `•••• ${to.slice(-2)}`;
  const [name, domain] = to.split('@');
  return `${(name ?? '').slice(0, 1)}•••@${domain ?? ''}`;
}
