/**
 * What the person asks of this computer from HandsFreeOS (docs/outreach.md, decision 43; the rules in
 * packages/core/src/addons/outreach/asks.ts), HandsFreeOS's side: taking the next ask, saying how it's going, and how
 * it ended. ../asks/run.ts does them.
 *
 * - **Taking:** only the computer that works for the person gets one, the oldest first, each network's line its own
 *   (`platform`). It says which ask it has under way on that line, so HandsFreeOS ends any other it handed here before
 *   on that network (Chrome restarted mid-way) as lost, and never another network's.
 * - **How it's going:** a new state (working, needs you, typing, a code) goes at once; a new line alone at most every
 *   `ASK_LINE_SECONDS`. The answer says whether the person pressed Stop, their answer to a step handed to them, and
 *   the code from their email they typed, once.
 * - **The end** goes with its own id and moment. With no connection it waits here (at most 20) and goes with the next
 *   beat; one refused for good is let go. Each says whose it is, so one person's never goes as another's.
 */
import {
  ASK_LINE_SECONDS,
  type AskEndInput,
  type AskProgressOutput,
  type AskResult,
  type AskTakeOutput,
  type TAKEN_ASK_STATES,
} from '@hfos/core/addons/outreach/asks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { APP_HEADERS } from '@hfos/core/mobile';
import { samePlace } from './live';
import { ASK_EVENTS } from './messages';
import { outcomeOf } from './noting';
import { api, call, savingTo, type Place } from './session';

/** Facebook's ask under way here, for the panel; left at a restart, it's ended as lost. */
export const ASK_KEY = 'hfos.ask';
/** Each network's ask under way: Facebook's where it always was, another network's beside it. */
export const askKeyOf = (platform: Platform): string =>
  platform === 'facebook' ? ASK_KEY : `${ASK_KEY}.${platform}`;
/** Ends HandsFreeOS hasn't taken yet. */
export const ASK_ENDS_KEY = 'hfos.ask.ends';
export const ASK_ENDS_MOST = 20;

export interface KeptAsk extends Place {
  readonly askId: string;
  /** Its network: Facebook's when an older build kept it. */
  readonly platform?: Platform;
  readonly kind: string;
  readonly about: string | null;
  readonly state: (typeof TAKEN_ASK_STATES)[number];
  readonly line: string | null;
  /** When it was taken. */
  readonly at: number;
}

export interface WaitingEnd extends Place {
  readonly askId: string;
  readonly commandId: string;
  readonly occurredAt: string;
  readonly state: 'done' | 'failed';
  readonly line: string;
  readonly result: AskResult | null;
}

// ------------------------------------------------------------------------------------------------- the workings

/**
 * Whether a change heard on the live channel is about the person's asks, and what it means here: `take` for a new one
 * (this computer may be the one to do it), `under_way` for a stop or an answer to the one it's doing; null otherwise.
 */
export function askEventFor(
  payload: { readonly type?: unknown; readonly actorId?: unknown; readonly entityId?: unknown },
  userId: string | null,
  underway: string | null,
): 'take' | 'under_way' | null {
  if (!userId || typeof payload.type !== 'string' || !ASK_EVENTS.has(payload.type)) return null;
  if (payload.actorId !== userId) return null;
  if (payload.type === 'outreach.ask.made') return 'take';
  return underway !== null && payload.entityId === underway ? 'under_way' : null;
}

/** Whether a progress is due: a new state at once, a new line at most every `ASK_LINE_SECONDS`. */
export function lineDue(lastSentAt: number | null, now: number, stateChanged: boolean): boolean {
  return stateChanged || lastSentAt === null || now - lastSentAt >= ASK_LINE_SECONDS * 1000;
}

/** The ends waiting, with one added: a newer end for the same ask takes its place, the oldest let go past the most. */
export function withEnd(ends: readonly WaitingEnd[], end: WaitingEnd): WaitingEnd[] {
  return [...ends.filter((e) => e.askId !== end.askId), end].slice(-ASK_ENDS_MOST);
}

// ------------------------------------------------------------------------------------------------- storage

const write = (values: Record<string, unknown>) =>
  chrome.storage.local.set(values).catch(() => undefined);

/** A network's ask under way, as kept (Facebook's unless said). */
export async function keptAsk(platform: Platform = 'facebook'): Promise<KeptAsk | null> {
  const key = askKeyOf(platform);
  try {
    const found: unknown = (await chrome.storage.local.get(key))[key];
    return found && typeof found === 'object' ? (found as KeptAsk) : null;
  } catch {
    return null;
  }
}

/** Keeps a network's ask under way (Facebook's unless said), or forgets it with null. */
export const keepAsk = (ask: KeptAsk | null, platform: Platform = 'facebook') => {
  const key = askKeyOf(platform);
  return ask ? write({ [key]: ask }) : chrome.storage.local.remove(key).catch(() => undefined);
};

async function endsNow(): Promise<WaitingEnd[]> {
  try {
    const found: unknown = (await chrome.storage.local.get(ASK_ENDS_KEY))[ASK_ENDS_KEY];
    return Array.isArray(found) ? (found as WaitingEnd[]) : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------------------------- HandsFreeOS

/**
 * The next ask for this computer on a network's line: null when there's none, or another computer of theirs works.
 * Each network's line takes only its own.
 */
export async function take(
  place: Place,
  installId: string,
  underway: string | null,
  platform: Platform = 'facebook',
): Promise<AskTakeOutput> {
  return call(
    api().POST('/v1/commands/outreach.ask.take', {
      body: { workspaceId: place.businessId, installId, underway, platform },
    }),
    place.businessId,
  );
}

/** How it's going: whether the person pressed Stop, their answer to a step handed to them, and a code they typed. */
export function progress(
  place: Place,
  askId: string,
  state: KeptAsk['state'],
  line: string,
): Promise<AskProgressOutput> {
  return call(
    api().POST('/v1/commands/outreach.ask.progress', {
      body: { workspaceId: place.businessId, askId, state, line },
    }),
    place.businessId,
  );
}

/** Sends an end: whether HandsFreeOS has it (or refused it for good), or it should wait. */
async function sendEnd(end: WaitingEnd): Promise<'sent' | 'later'> {
  const body: AskEndInput = {
    workspaceId: end.businessId,
    askId: end.askId,
    state: end.state,
    line: end.line,
    result: end.result,
  };
  try {
    const { data, error, response } = await api().POST('/v1/commands/outreach.ask.end', {
      body,
      headers: {
        [APP_HEADERS.commandId]: end.commandId,
        [APP_HEADERS.occurredAt]: end.occurredAt,
      },
    });
    if (data && response.ok) return 'sent';
    return outcomeOf(response.status, error).kind === 'refused' ? 'sent' : 'later';
  } catch {
    return 'later';
  }
}

/** Ends an ask: sent now, or kept to go with the next beat. */
export async function endAsk(
  place: Place,
  askId: string,
  state: WaitingEnd['state'],
  line: string,
  result: AskResult | null = null,
): Promise<void> {
  const end: WaitingEnd = {
    ...place,
    askId,
    commandId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    state,
    line,
    result,
  };
  // Only as its own person, to its own business: signed in as anyone else here, it waits for them.
  const theirs = samePlace(await savingTo().catch(() => null), place);
  if (theirs && (await sendEnd(end)) === 'sent') return;
  await write({ [ASK_ENDS_KEY]: withEnd(await endsNow(), end) });
}

/** The ends that waited, for this person and business, sent now; each let go once it's taken or refused for good. */
export async function sendWaitingEnds(place: Place): Promise<void> {
  const ends = await endsNow();
  if (!ends.length) return;
  const gone = new Set<string>();
  for (const end of ends)
    if (end.userId === place.userId && end.businessId === place.businessId)
      if ((await sendEnd(end)) === 'sent') gone.add(end.commandId);
  if (!gone.size) return;
  // Others may have been added meanwhile: only the ones sent go.
  await write({ [ASK_ENDS_KEY]: (await endsNow()).filter((e) => !gone.has(e.commandId)) });
}

/** Stop, pressed in the panel. */
export function cancel(place: Place, askId: string): Promise<unknown> {
  return call(
    api().POST('/v1/commands/outreach.ask.cancel', {
      body: { workspaceId: place.businessId, askId },
    }),
    place.businessId,
  );
}
