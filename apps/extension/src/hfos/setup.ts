/**
 * The extension's first run (docs/outreach.md, decision 45 and the owner's answer 21a): Social Outreach's setup lives
 * in HandsFreeOS, so the extension only sends people there.
 *
 * - **It tells HandsFreeOS it's signed in** (`outreach.setup.save` with `extension`), so the setup's install step
 *   ticks live: at a sign-in or a business picked, and otherwise at most every few hours while someone is signed in,
 *   so a build updated over an old sign-in shows up too. Best effort: nothing waits on it, and a refusal is tried
 *   again only after the same few hours.
 * - **It opens the setup in a tab** at a sign-in or a business picked, for a first-timer there (HandsFreeOS's answer
 *   to the report says so: `firstTime`, never saved their own settings and never started the setup), once per person
 *   and business on this computer. Without an answer it goes by the settings it follows.
 */
import { outreachSetupPath, type SetupOutput } from '@hfos/core/addons/outreach/setup';
import { config } from './config';
import type { Automation } from './messages';
import { api, call, Refused, savingTo, type Place } from './session';

/** Which people and businesses this computer opened the setup for: { "<userId>:<businessId>": ms }. */
export const SETUP_OPENED_KEY = 'hfos.setupOpened';
/** When this computer last told HandsFreeOS it's signed in, by person and business. */
export const SETUP_REPORTED_KEY = 'hfos.setupReported';
/** How often a sign-in that carries on is told again. */
export const REPORT_EVERY_MS = 6 * 3_600_000;
/** People and businesses kept in each, the newest. */
const KEPT = 20;

/** HandsFreeOS's setup for a business, opened from the extension. */
export function setupUrl(webUrl: string, businessId: string): string {
  return `${webUrl.replace(/\/+$/, '')}${outreachSetupPath(businessId, { from: 'extension' })}`;
}

/** What HandsFreeOS answered the report with: whether they're a first-timer there. */
export type SetupAnswer = Pick<SetupOutput, 'firstTime'>;

/**
 * Whether they're a first-timer there: HandsFreeOS's answer says, which keeps their own settings saved for good. With
 * no answer (an API without the setup, or one that refused), only settings saved by an owner or admin last, or none,
 * leave them one: the closest the settings it follows can say.
 */
export function firstTimer(
  answer: SetupAnswer | null,
  found: Pick<Automation, 'saved' | 'changedBy'>,
): boolean {
  if (answer) return answer.firstTime;
  return !(found.saved && found.changedBy === null);
}

/** Whether to open the setup: a first-timer there, and this computer hasn't opened it for them. */
export function shouldOpenSetup(
  answer: SetupAnswer | null,
  found: Pick<Automation, 'saved' | 'changedBy'>,
  opened: Readonly<Record<string, number>>,
  key: string,
  webUrl: string,
): boolean {
  return Boolean(webUrl) && firstTimer(answer, found) && opened[key] === undefined;
}

/** The kept stamps with this one, the newest `KEPT`. */
export function stamped(
  kept: Readonly<Record<string, number>>,
  key: string,
  at: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries({ ...kept, [key]: at })
      .sort((a, b) => b[1] - a[1])
      .slice(0, KEPT),
  );
}

async function keptAt(storageKey: string): Promise<Record<string, number>> {
  const value: unknown = (await chrome.storage.local.get(storageKey))[storageKey];
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === 'number',
    ),
  );
}

const keyOf = (place: Place) => `${place.userId}:${place.businessId}`;

/** What the report came to: whether Social Outreach is on there, and HandsFreeOS's answer when it gave one. */
export interface Reported {
  readonly on: boolean;
  readonly answer: SetupAnswer | null;
}

/**
 * Tells HandsFreeOS the extension is signed in for them there: now (`now`), or when it's been a few hours. `on` is
 * false only when Social Outreach is off there. Any answer, a refusal too, waits the few hours before it's sent again
 * (a runner's wake comes every half minute); only a lost connection is tried again at the next wake.
 */
export async function reportSignedIn(
  place: Place,
  now: boolean,
  at = Date.now(),
): Promise<Reported> {
  const reported = await keptAt(SETUP_REPORTED_KEY);
  const last = reported[keyOf(place)];
  if (!now && last !== undefined && at - last < REPORT_EVERY_MS) return { on: true, answer: null };
  const stamp = () =>
    chrome.storage.local.set({ [SETUP_REPORTED_KEY]: stamped(reported, keyOf(place), at) });
  try {
    const answer: SetupAnswer = await call(
      api().POST('/v1/commands/outreach.setup.save', {
        body: { workspaceId: place.businessId, extension: true },
      }),
      place.businessId,
    );
    await stamp();
    return { on: true, answer };
  } catch (error) {
    const refused = error instanceof Refused ? error.problem : null;
    // HandsFreeOS answered (no answer has no status): not again for a while.
    if (refused?.status !== null && refused?.status !== undefined) await stamp();
    return { on: refused?.rule !== 'addon_inactive', answer: null };
  }
}

/** The first runs under way, one after another, so two at once (a sign-in, then a business picked) open one tab. */
let running: Promise<void> = Promise.resolve();

/**
 * After the settings are followed: tells HandsFreeOS it's signed in, and at a sign-in or a business picked
 * (`signedIn`), opens the setup for a first-timer there, once on this computer.
 */
export function firstRun(found: Automation | null, signedIn: boolean): Promise<void> {
  const next = running.then(() => runOnce(found, signedIn));
  running = next.catch(() => undefined);
  return next;
}

async function runOnce(found: Automation | null, signedIn: boolean): Promise<void> {
  const place = await savingTo();
  if (!place) return;
  const { on, answer } = await reportSignedIn(place, signedIn);
  if (!signedIn || !found || !on) return;
  const opened = await keptAt(SETUP_OPENED_KEY);
  if (!shouldOpenSetup(answer, found, opened, keyOf(place), config.webUrl)) return;
  await chrome.storage.local.set({
    [SETUP_OPENED_KEY]: stamped(opened, keyOf(place), Date.now()),
  });
  await chrome.tabs.create({ url: setupUrl(config.webUrl, place.businessId), active: true });
}
