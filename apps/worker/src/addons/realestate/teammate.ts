/**
 * Fair housing on the AI teammate's replies (round seven; Chris 2026-10-05: fair housing checks run on its replies).
 * The same two checks a client update gets: the fixed list of words, then the model's read. Each flag says what was
 * found, why it could read as a preference, and a safer way to say it, for the person the reply then waits for. When
 * the model can't be asked, the words alone decide: a reply isn't held for want of a second opinion.
 */
import { checkWords } from '@hfos/core/addons/realestate/fair-housing';
import type { AddonScopeContext, TeammateReplyToCheck } from '../types';
import { modelCheck } from './client-updates';

export async function checkTeammateReply(
  ctx: AddonScopeContext,
  reply: TeammateReplyToCheck,
): Promise<readonly string[]> {
  const words = checkWords(reply.text);
  const model = await modelCheck(ctx, 'A reply to a client', reply.text);
  const seen = new Set<string>();
  const found: string[] = [];
  for (const f of [...words, ...model.flags]) {
    const key = f.phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(`Fair housing: “${f.phrase}”. ${f.reason} ${f.safer}`);
  }
  return found;
}
