/**
 * Fingerprints: a short, stable digest of the facts behind an item. A dismissed or snoozed item comes back only
 * when its fingerprint changes. Deterministic: the same facts give the same fingerprint, in any key order.
 * Readable when it fits (`attention_items.fingerprint` holds 200 characters), a hash when it doesn't.
 */
import type { AttentionKind } from './kinds';

export const FINGERPRINT_VERSION = 'v1';
export const FINGERPRINT_MAX = 200;

export type FingerprintFacts = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

/** cyrb53: a small, stable 53-bit string hash, as 14 hex digits. Browser-safe (no crypto needed). */
export function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** `kind|v1|key=value|…`, keys sorted; undefined keys left out, null written as "-". */
export function fingerprintOf(kind: AttentionKind, facts: FingerprintFacts): string {
  const body = Object.keys(facts)
    .filter((k) => facts[k] !== undefined)
    .sort()
    .map((k) => `${k}=${facts[k] === null ? '-' : String(facts[k])}`)
    .join('|');
  const full = `${kind}|${FINGERPRINT_VERSION}|${body}`;
  return full.length <= FINGERPRINT_MAX ? full : `${kind}|${FINGERPRINT_VERSION}|#${digest(body)}`;
}

/** A fingerprint that also covers others (what folded into an item that should bring it back). */
export function combineFingerprints(base: string, others: readonly string[]): string {
  if (others.length === 0) return base;
  const extra = digest([...others].sort().join('\n'));
  const joined = `${base}~${extra}`;
  if (joined.length <= FINGERPRINT_MAX) return joined;
  const kind = base.split('|')[0] ?? 'attention';
  return `${kind}|${FINGERPRINT_VERSION}|#${digest(base)}~${extra}`;
}
