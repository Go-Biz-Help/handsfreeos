import { z } from 'zod';
import { HfosError } from '../errors';
import { findAddon, type Catalog } from './graph';
import type { AddonSealedValue } from './manifest';

/**
 * Sealed values (round seven): what an add-on declares in its manifest's `sealed` (a lockbox's code) reaches a
 * command only as the worker sealed it. A sealed value reads `sealed:v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url,
 * AES-256-GCM, the worker's key); what's inside also names the business, add-on and value it was sealed for, so it
 * opens nowhere else. Nothing but the worker can open one.
 */

export const SEALED_PREFIX = 'sealed:';

const SEALED_TOKEN =
  /^sealed:v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{1,8000}$/;

/** Whether a value is one the worker sealed (its shape; only the worker can tell it opens). */
export const isSealed = (value: string): boolean => SEALED_TOKEN.test(value);

/** What a sealed value holds: the value, and the business, add-on and value it was sealed for. */
export interface SealedContents {
  readonly v: string;
  readonly w: string;
  readonly a: string;
  readonly k: string;
}

/**
 * The input field for a sealed value: only what the worker sealed gets through. Anything else is refused with what
 * to do, so the code itself never reaches a command, its history or a log.
 */
export function sealedValue(label: string) {
  return z
    .string()
    .max(8200)
    .regex(SEALED_TOKEN, {
      error: `The ${label.toLowerCase()} has to be locked before it’s saved, and this one wasn’t. Type it again in the app, which locks it on the way.`,
    });
}

/** A sealed value an add-on declares, or a refusal saying there's no such thing to seal. */
export function sealedOf(catalog: Catalog, addonId: string, key: string): AddonSealedValue {
  const declared = findAddon(catalog, addonId)?.sealed?.find((v) => v.key === key);
  if (!declared)
    throw HfosError.rule(
      'addon_sealed_unknown',
      404,
      'That add-on doesn’t keep anything sealed under that name. Refresh the page and try again.',
    );
  return declared;
}
