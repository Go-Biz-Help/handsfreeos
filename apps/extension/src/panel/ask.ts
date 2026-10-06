/**
 * The side panel's line to the background worker, which holds the sign-in and makes every call to HandsFreeOS
 * (src/hfos/messages.ts). Never throws: when the background can't answer, the answer says what to do.
 */
import type { HfosAnswer, HfosAsk, HfosValues } from '../hfos/messages';

export async function ask<T extends HfosAsk>(
  message: T,
): Promise<HfosAnswer<HfosValues[T['type']]>> {
  try {
    const answer: unknown = await chrome.runtime.sendMessage(message);
    if (answer) return answer as HfosAnswer<HfosValues[T['type']]>;
  } catch {
    // The extension was reloaded under the panel.
  }
  return {
    ok: false,
    problem: {
      message: 'The extension was updated or restarted. Close this panel and open it again.',
      rule: null,
      status: null,
      recheck: false,
    },
  };
}
