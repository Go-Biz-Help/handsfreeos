/**
 * Each network's warnings seen today (docs/outreach.md, decision 25), kept in the extension's own storage, where the
 * panel (panel/status.ts, panel/networks.ts), the runner that works on its own (auto/run.ts) and what's asked from
 * HandsFreeOS (asks/run.ts, which also listens for one kept while it goes) look before doing anything: after one, the
 * extension does nothing more for the person on that network that day.
 *
 * Chris's rule (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Each network on its own"): a warning on one
 * network never affects another. So each network's are kept apart, under its name (`{ facebook, linkedin }`), and
 * read by the network asking. A record kept by a build before networks (`{ day, words }`) is Facebook's.
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { facebook } from '../networks/facebook/kit';

export const WARNED_KEY = 'hfos.warned';

export interface Warned {
  /** The day it was seen, in the person's own time: "2026-10-09". */
  readonly day: string;
  readonly words: readonly string[];
}

/** Each network's warnings, as kept. */
export type WarnedByNetwork = Partial<Record<Platform, Warned>>;

const today = () => new Date().toLocaleDateString('en-CA');

const isWarned = (value: unknown): value is Warned =>
  typeof (value as Warned | null)?.day === 'string' &&
  Array.isArray((value as Warned | null)?.words);

/** What's kept, by network: an older build's single record is Facebook's, the only network it knew. */
export function warnedByNetwork(kept: unknown): WarnedByNetwork {
  if (typeof kept !== 'object' || kept === null) return {};
  if (isWarned(kept)) return { [facebook.platform]: kept };
  return Object.fromEntries(
    Object.entries(kept).filter(([platform, warned]) => platform in NETWORKS && isWarned(warned)),
  ) as WarnedByNetwork;
}

async function keptNow(): Promise<WarnedByNetwork> {
  try {
    return warnedByNetwork((await chrome.storage.local.get(WARNED_KEY))[WARNED_KEY]);
  } catch {
    return {};
  }
}

/** A network's warnings today (Facebook's unless said), or null when it had none. */
export async function warnedNow(platform: Platform = facebook.platform): Promise<Warned | null> {
  const warned = (await keptNow())[platform];
  return warned?.day === today() ? warned : null;
}

/**
 * Keeps a network's warning words seen just now (Facebook's unless said): the ones not seen on it before today, which
 * are for HandsFreeOS to note. The other networks' stay as they were.
 */
export async function keepWarning(
  words: readonly string[],
  platform: Platform = facebook.platform,
): Promise<string[]> {
  const kept = await keptNow();
  const had = kept[platform]?.day === today() ? kept[platform] : null;
  const fresh = words.filter((w) => !had?.words.includes(w));
  if (!fresh.length) return [];
  const warned: Warned = { day: today(), words: [...(had?.words ?? []), ...fresh] };
  await chrome.storage.local
    .set({ [WARNED_KEY]: { ...kept, [platform]: warned } })
    .catch(() => undefined);
  return fresh;
}

/** The note HandsFreeOS takes of them: a few words, its network, and the page when it's that network's own. */
export function warningInput(
  workspaceId: string,
  words: readonly string[],
  url: string | null,
  platform: Platform = facebook.platform,
) {
  return {
    workspaceId,
    platform,
    words: words.slice(0, 5).map((w) => w.slice(0, 300)),
    url: url && NETWORKS[platform].link.test(url) && url.length <= 500 ? url : null,
  };
}
