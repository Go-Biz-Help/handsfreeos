/**
 * Where each network's day is up to, told to HandsFreeOS as it changes (docs/outreach.md, decision 195), in the
 * background worker. The runners still work their day out themselves. HandsFreeOS works out the same day from what's
 * said here, with the same rules (packages/core/src/addons/outreach/plan.ts), to show the plan on Today.
 *
 * - **What's said** (`outreach.plan.note`) is the part of a runner's state the day is planned from: what's done, what
 *   was tried, what waits to be looked at again, and when it goes next. No message, and nobody's words.
 * - **When:** a couple of seconds after a runner's state changes in a way the plan can see (not at every line of a
 *   long read), and after a beat's answer, for one that couldn't go. What HandsFreeOS has is remembered while the
 *   browser is open, by a short mark, so the worker waking sends nothing twice.
 * - **Only the computer that works** says anything: one on standby has a day it isn't working.
 */
import { PLATFORM_KEYS, type Platform } from '@hfos/core/addons/outreach/networks';
import { planNoteKey, planStateOf, type PlanNoteInput } from '@hfos/core/addons/outreach/plan';
import {
  ALIGNABLE_STATE_KEY,
  AUTO_STATE_KEY,
  INSTAGRAM_STATE_KEY,
  isState,
  LINKEDIN_STATE_KEY,
  THREADS_STATE_KEY,
  X_STATE_KEY,
} from '../auto/plan';
import { NO_RESEARCH } from '../jobs/comment-research';
import { computer, keptFor, onBeat } from './live';
import { api, call, Refused, savingTo, type Place } from './session';

/** Where each network's runner keeps its state. */
export const PLAN_STATE_KEYS: Readonly<Record<Platform, string>> = {
  facebook: AUTO_STATE_KEY,
  linkedin: LINKEDIN_STATE_KEY,
  instagram: INSTAGRAM_STATE_KEY,
  alignable: ALIGNABLE_STATE_KEY,
  threads: THREADS_STATE_KEY,
  x: X_STATE_KEY,
};
/** The mark of what HandsFreeOS last kept for each network: only while the browser is open. */
export const PLAN_SENT_KEY = 'hfos.plan.sent';
/** How long after a change a note goes: changes close together go in one. */
const SOON_MS = 2_000;

/** The networks whose runner's state is among what changed in storage. */
export const planPlatforms = (changed: Readonly<Record<string, unknown>>): Platform[] =>
  PLATFORM_KEYS.filter((platform) => PLAN_STATE_KEYS[platform] in changed);

/** A short mark of a long text (FNV-1a, with its length): what was sent is remembered by it, never kept whole. */
export function shortMark(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * What to say of a runner's state as stored, and the mark it's remembered by: null when it's no runner's state. The
 * mark is whose it is and everything but the line, so a long read's every line doesn't send another.
 */
export function planNote(
  place: Place,
  stored: unknown,
): { readonly state: PlanNoteInput['state']; readonly mark: string } | null {
  if (!isState(stored)) return null;
  // The comment research is HandsFreeOS's own staff's: for everyone else it never runs, and isn't on the plan.
  const state = planStateOf(stored, { comment_research: NO_RESEARCH });
  return {
    state,
    mark: shortMark(`${place.userId}|${place.businessId}|${planNoteKey(state)}`),
  };
}

async function sentNow(): Promise<Partial<Record<Platform, string>>> {
  try {
    const value: unknown = (await chrome.storage.session.get(PLAN_SENT_KEY))[PLAN_SENT_KEY];
    return typeof value === 'object' && value !== null
      ? (value as Partial<Record<Platform, string>>)
      : {};
  } catch {
    return {};
  }
}

/** Says where one network's day is up to, when HandsFreeOS doesn't have it yet. */
async function tellOne(platform: Platform): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (!place) return;
  // Until a beat says this computer works, nothing's said: HandsFreeOS would keep none of it.
  const kept = await keptFor(place);
  if (!kept?.working) return;
  const key = PLAN_STATE_KEYS[platform];
  const stored: unknown = await chrome.storage.local
    .get(key)
    .then((found) => found[key])
    .catch(() => undefined);
  const note = planNote(place, stored);
  if (!note || (await sentNow())[platform] === note.mark) return;
  const me = await computer();
  let answer: { kept: boolean };
  try {
    answer = await call(
      api().POST('/v1/commands/outreach.plan.note', {
        body: { workspaceId: place.businessId, platform, computer: me.id, state: note.state },
      }),
      place.businessId,
    );
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    // No connection, or Social Outreach is off there: it goes after the next beat that's answered.
    return;
  }
  if (answer.kept)
    await chrome.storage.session
      .set({ [PLAN_SENT_KEY]: { ...(await sentNow()), [platform]: note.mark } })
      .catch(() => undefined);
}

let going: Promise<void> = Promise.resolve();
/** Says where each of these networks' days is up to, one at a time, after whatever is being said already. */
export function tellPlan(platforms: readonly Platform[] = PLATFORM_KEYS): Promise<void> {
  going = going.then(async () => {
    for (const platform of platforms)
      await tellOne(platform).catch((error: unknown) => {
        console.error('HandsFreeOS Social couldn’t tell HandsFreeOS where its day is up to', error);
      });
  });
  return going;
}

const soon = new Map<Platform, ReturnType<typeof setTimeout>>();
/** A note for a network in a couple of seconds: changes close together go in one. */
export function planSoon(platform: Platform): void {
  if (soon.has(platform)) return;
  soon.set(
    platform,
    setTimeout(() => {
      soon.delete(platform);
      void tellPlan([platform]);
    }, SOON_MS),
  );
}

// After every beat that's answered: a note that couldn't go, one cut short when the worker slept, and every
// network's the first time this computer is the one that works. One HandsFreeOS has already is never sent again.
onBeat(() => void tellPlan());
