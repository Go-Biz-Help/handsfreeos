/**
 * Facebook's warnings seen today (docs/outreach.md, decision 25), kept in the extension's own storage, where the
 * panel (panel/warnings.ts) and the runner that works on its own (auto/run.ts) both look before doing anything: after
 * one, the extension does nothing more for the person that day.
 */
export const WARNED_KEY = 'hfos.warned';

export interface Warned {
  /** The day it was seen, in the person's own time: "2026-10-09". */
  readonly day: string;
  readonly words: readonly string[];
}

const today = () => new Date().toLocaleDateString('en-CA');

/** Today's warnings, or null when there were none. */
export async function warnedNow(): Promise<Warned | null> {
  try {
    const stored = (await chrome.storage.local.get(WARNED_KEY))[WARNED_KEY] as Warned | undefined;
    return stored?.day === today() && Array.isArray(stored.words) ? stored : null;
  } catch {
    return null;
  }
}

/** Keeps warning words seen just now: the ones not seen before today, which are for HandsFreeOS to note. */
export async function keepWarning(words: readonly string[]): Promise<string[]> {
  const had = await warnedNow();
  const fresh = words.filter((w) => !had?.words.includes(w));
  if (!fresh.length) return [];
  const warned: Warned = { day: today(), words: [...(had?.words ?? []), ...fresh] };
  await chrome.storage.local.set({ [WARNED_KEY]: warned }).catch(() => undefined);
  return fresh;
}

/** The note HandsFreeOS takes of them: a few words, and the page when it's Facebook's own. */
export function warningInput(workspaceId: string, words: readonly string[], url: string | null) {
  return {
    workspaceId,
    platform: 'facebook' as const,
    words: words.slice(0, 5).map((w) => w.slice(0, 300)),
    url: url?.startsWith('https://www.facebook.com/') && url.length <= 500 ? url : null,
  };
}
