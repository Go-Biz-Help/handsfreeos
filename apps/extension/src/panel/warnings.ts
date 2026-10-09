/**
 * Facebook's warnings (docs/outreach.md, decision 25): each one the panel sees on a page is noted in HandsFreeOS, once
 * a day, which halves the person's daily limits for a week and keeps friend requests off their list for two days. The
 * extension then does nothing more for them that day: reading their chats, cancelling and unfriending, and working on
 * its own (src/auto/run.ts) all stop. The runner notes the ones it sees itself; the panel hears of those too.
 */
import { keepWarning, warnedNow, warningInput, WARNED_KEY } from '../hfos/warned';
import { ask } from './ask';

const heard = new Set<() => void>();

/** Whether Facebook warned the person today, as the extension saw: if so, it does nothing more for them. */
export async function warnedToday(): Promise<readonly string[] | null> {
  return (await warnedNow())?.words ?? null;
}

/** Calls `then` whenever a warning is noted, here or by the runner, so the panel's sections can say so. */
export function onWarning(then: () => void): void {
  if (!heard.size)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && WARNED_KEY in changes) for (const each of heard) each();
    });
  heard.add(then);
}

/**
 * Notes Facebook's warning words in HandsFreeOS, once a day for the same words, in the business it saves to. Never
 * throws: a warning that couldn't be sent still stops the extension for the day.
 */
export async function noteWarnings(words: readonly string[], url: string | null): Promise<void> {
  if (!words.length) return;
  const fresh = await keepWarning(words);
  if (!fresh.length) return;
  const account = await ask({ type: 'hfos-account' });
  const businessId = account.ok && account.value.signedIn ? account.value.businessId : null;
  if (businessId) await ask({ type: 'hfos-warning', input: warningInput(businessId, fresh, url) });
  // Again, now HandsFreeOS has it: its lists say so.
  for (const then of heard) then();
}
