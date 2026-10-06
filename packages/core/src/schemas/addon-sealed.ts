/**
 * Sealed values an add-on keeps (round seven): seen again only through the worker, which keeps each time in the
 * history.
 */
import { z } from 'zod';
import { addonId } from './addon';
import { isoDateTime, uuid } from './common';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Not a sealed value’s name.');

export const AddonSealedViewedInput = z.object({
  workspaceId: uuid,
  addonId,
  key,
  /** The record it's kept on (a listing), whose history says it was viewed. */
  recordId: uuid,
  /** The add-on's own row holding it (one lockbox). */
  itemId: uuid,
  /** Who was shown it. */
  viewedBy: uuid,
});
export const AddonSealedViewedOutput = z.object({ viewedAt: isoDateTime });
