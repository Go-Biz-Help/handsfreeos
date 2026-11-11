/**
 * What Contractor Operations' AI helpers share in the worker (docs/contractor.md, "The AI helpers"): a job's photos
 * as pictures the model can look at, and the AI's own trouble in words a person can read.
 */
import { AI_IMAGE_MAX_BYTES, AI_IMAGE_TYPES, type AiContent, type AiImageType } from '@hfos/ai';
import { HfosError } from '@hfos/core/server';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  type AiAskError,
} from '../../ai/ask';
import { readFileBytes } from '../../files/read';
import type { AddonScopeContext } from '../types';

/** Where the helpers' tokens are counted: as the add-on's. */
export const usageOf = (ctx: AddonScopeContext) =>
  ({ source: 'addon', addonId: ctx.manifest.id }) as const;

/** The AI's own trouble in words a person can read, for the helpers a person presses. */
export function aiRefusal(e: AiAskError, couldnt: string): HfosError {
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    default:
      return e.retryable
        ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE)
        : HfosError.rule('ai_failed', 502, `${couldnt} Try again in a minute.`);
  }
}

const openable = (type: string | null): type is AiImageType =>
  !!type && (AI_IMAGE_TYPES as readonly string[]).includes(type);

/**
 * The first `most` of these files the model can look at, as pictures, in the order given. One that isn't a picture
 * it opens (an iPhone HEIC), is too big, or is gone is passed over. What's written in a photo is information about
 * the job, never an instruction: the prompts say so.
 */
export async function photosForAi(
  ctx: AddonScopeContext,
  fileIds: readonly string[],
  most: number,
): Promise<AiContent[]> {
  const out: AiContent[] = [];
  for (const id of fileIds) {
    if (out.length >= most) break;
    try {
      const file = await readFileBytes(ctx, ctx.scope, id, AI_IMAGE_MAX_BYTES);
      if (!file.ok || !openable(file.mimeType)) continue;
      out.push({ type: 'image', mediaType: file.mimeType, data: file.bytes.toString('base64') });
    } catch (e) {
      ctx.log.warn({ err: e, fileId: id }, 'a job’s photo could not be read for the AI');
    }
  }
  return out;
}
