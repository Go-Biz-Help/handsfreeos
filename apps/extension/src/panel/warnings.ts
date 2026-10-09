/**
 * Facebook's warnings (docs/outreach.md, decision 25): each one the panel sees on a page is noted in HandsFreeOS, once
 * a day, which halves the person's daily limits for a week and keeps friend requests off their list for two days. The
 * extension then does nothing more for them that day: reading their chats, cancelling and unfriending all stop.
 */
import { ask } from './ask';

const KEY = 'hfos.warned';

interface Warned {
  /** The day it was seen, in the person's own time: "2026-10-09". */
  readonly day: string;
  readonly words: readonly string[];
}

const today = () => new Date().toLocaleDateString('en-CA');

let warned: Warned | null = null;
const heard = new Set<() => void>();

async function load(): Promise<Warned | null> {
  if (warned?.day === today()) return warned;
  try {
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Warned | undefined;
    warned = stored?.day === today() ? stored : null;
  } catch {
    warned = null;
  }
  return warned;
}

/** Whether Facebook warned the person today, as the panel saw: if so, the extension does nothing more for them. */
export async function warnedToday(): Promise<readonly string[] | null> {
  return (await load())?.words ?? null;
}

/** Calls `then` whenever a warning is noted, so the panel's sections can say so. */
export function onWarning(then: () => void): void {
  heard.add(then);
}

/**
 * Notes Facebook's warning words in HandsFreeOS, once a day for the same words, in the business it saves to. Never
 * throws: a warning that couldn't be sent still stops the extension for the day.
 */
export async function noteWarnings(words: readonly string[], url: string | null): Promise<void> {
  if (!words.length) return;
  const had = await load();
  const fresh = words.filter((w) => !had?.words.includes(w));
  if (!fresh.length) return;
  warned = { day: today(), words: [...(had?.words ?? []), ...fresh] };
  await chrome.storage.local.set({ [KEY]: warned }).catch(() => undefined);
  const account = await ask({ type: 'hfos-account' });
  const businessId = account.ok && account.value.signedIn ? account.value.businessId : null;
  if (businessId)
    await ask({
      type: 'hfos-warning',
      input: {
        workspaceId: businessId,
        platform: 'facebook',
        words: fresh.slice(0, 5).map((w) => w.slice(0, 300)),
        url: url?.startsWith('https://www.facebook.com/') && url.length <= 500 ? url : null,
      },
    });
  for (const then of heard) then();
}
