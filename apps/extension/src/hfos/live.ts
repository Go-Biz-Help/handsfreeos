/**
 * What the extension tells HandsFreeOS (docs/outreach.md, decision 41), in the background worker: this computer, what
 * it's doing right now, and each step it takes, so the app can show it live; and the person's day, which HandsFreeOS
 * keeps and the runner follows (packages/core/src/addons/outreach/live.ts).
 *
 * - **This computer** has an id made once and kept in the extension's storage, and a plain name ("Chrome on
 *   Windows"). Only the person's most recently used computer works; the beat's answer says whether this is the one.
 * - **The beat** (`outreach.live.beat`) goes every minute while Chrome is open and someone is signed in (the
 *   `hfos-beat` alarm), soon after the runner's state changes, a step is fed, or the person uses this computer. A new
 *   state, a step or the person's use goes within a couple of seconds; a new line alone at most every 20 seconds.
 * - **The feed:** each step the runner takes waits here, with its own id, until a beat's answer says HandsFreeOS has
 *   it. Lines, a waiting press and the last answer each say whose they are (the person and the business), so one
 *   person's never goes as another's, nor to another business.
 * - **Start my day and Stop for today** pressed in the panel go to HandsFreeOS (`outreach.day.start|stop`) with this
 *   computer's id. With no connection the press waits, keeping its moment, and goes with the next beat; one refused
 *   for good is let go.
 */
import { isApiErrorBody } from '@hfos/api-client';
import {
  BEAT_MINUTES,
  clipLine,
  computerName,
  LINE_BEAT_SECONDS,
  LIVE_STEPS_SENT_MOST,
  LIVE_STEPS_UNSENT_MOST,
  type LiveBeatOutput,
  type LiveDay,
  type ReportedState,
} from '@hfos/core/addons/outreach/live';
import type { AutomationSettings } from '@hfos/core/addons/outreach/automation';
import { APP_HEADERS } from '@hfos/core/mobile';
import { AUTO_STATE_KEY, isState, type AutoState } from '../auto/plan';
import { SETTINGS_KEY } from './follow';
import type { Automation, Problem } from './messages';
import { outcomeOf } from './noting';
import { api, call, Refused, savingTo, type Place } from './session';

export const COMPUTER_KEY = 'hfos.computer';
export const LIVE_KEY = 'hfos.live';
export const LIVE_STEPS_KEY = 'hfos.live.steps';
export const LIVE_ACTIVE_KEY = 'hfos.live.active';
export const LIVE_PRESS_KEY = 'hfos.live.press';
export const BEAT_ALARM = 'hfos-beat';

/** A beat's answer kept: what the runner and the panel follow, and whose it is. */
export interface Kept extends LiveBeatOutput, Place {
  readonly at: number;
}

/** A line for the feed, waiting to be sent. */
export interface Unsent extends Place {
  readonly id: string;
  readonly at: string;
  readonly kind: 'done' | 'passed' | 'job';
  readonly line: string;
}

/** A press of Start my day or Stop for today that HandsFreeOS hasn't taken yet: the latest wins. */
export interface Press extends Place {
  readonly kind: 'start' | 'stop';
  readonly commandId: string;
  readonly occurredAt: string;
}

/** What this computer last told HandsFreeOS, so a line alone doesn't go more than every so often. */
export interface Told {
  readonly state: ReportedState;
  readonly line: string | null;
  readonly nextAt: string | null;
  readonly at: number;
}

export interface Status {
  readonly state: ReportedState;
  readonly line: string | null;
  readonly lineAt: string | null;
  readonly nextAt: string | null;
}

// ------------------------------------------------------------------------------------------------- the workings

export const samePlace = (a: Place | null | undefined, b: Place | null | undefined): boolean =>
  !!a && !!b && a.userId === b.userId && a.businessId === b.businessId;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * What the runner shows, as HandsFreeOS takes it; `standing` when another computer of the person's works. A long line
 * (an error's words, a warning quoted) is cut short, so a beat is never refused for its wording.
 */
export function reportedStatus(
  state: AutoState,
  settings: Pick<AutomationSettings, 'sending'> | null,
  standing = false,
): Status {
  const kept = {
    line: state.line === null ? null : clipLine(state.line),
    lineAt: iso(state.lineAt),
    nextAt: iso(state.nextAt),
  };
  const shown = (s: ReportedState): Status => ({ state: s, ...kept });
  if (settings?.sending === 'off') return shown('off');
  if (state.stopped) return shown('stopped');
  if (standing) return shown('standby');
  if (state.working) return shown('working');
  if (state.needs) return shown('trouble');
  if (state.nextAt !== null) return shown('waiting');
  return shown('idle');
}

/** The feed with a line added, the oldest let go past the most kept. */
export const withStep = (unsent: readonly Unsent[], step: Unsent): Unsent[] =>
  [...unsent, step].slice(-LIVE_STEPS_UNSENT_MOST);

/**
 * What the runner's day should become to follow HandsFreeOS's: nothing while a press here waits to be sent, for
 * another day, or after a warning seen here (that stop is never undone). Null when it's as it should be.
 */
export function dayChange(
  local: Pick<AutoState, 'day' | 'started' | 'stopped'>,
  server: LiveDay,
  pending: boolean,
): Partial<AutoState> | null {
  if (pending || local.day !== server.date || local.stopped === 'warning') return null;
  if (server.state === 'stopped') {
    const why = server.why ?? 'person';
    return !local.started && local.stopped === why ? null : { started: false, stopped: why };
  }
  if (server.state === 'started')
    return local.started && !local.stopped ? null : { started: true, stopped: null };
  // Nothing pressed today: it goes by the working hours.
  return local.started || local.stopped ? { started: false, stopped: null } : null;
}

/**
 * What a beat's answer means for the runner: whether it should look again (`wake`), and whether what it's doing should
 * end now (`halt`): the day stopped elsewhere, or another computer works now. A once-a-day job under way ends at its
 * next page, and no next step goes.
 */
export function wakeFor(
  before: Pick<LiveBeatOutput, 'working'> | null,
  answer: Pick<LiveBeatOutput, 'working' | 'day'>,
  local: Pick<AutoState, 'day' | 'started' | 'stopped'> | null,
  pending: boolean,
): { readonly wake: boolean; readonly halt: boolean } {
  const flipped = before ? before.working !== answer.working : !answer.working;
  const change = local ? dayChange(local, answer.day, pending) : null;
  return {
    wake: flipped || change !== null,
    halt: !answer.working || (change !== null && change.stopped != null),
  };
}

/**
 * Whether a change heard on the live channel is for this computer to look at: the signed-in person's own, and not
 * this computer's own beat coming back.
 */
export function liveEventFor(
  payload: { readonly type?: unknown; readonly actorId?: unknown; readonly entityId?: unknown },
  userId: string | null,
  ownComputerId: string | null,
): boolean {
  if (!userId || payload.actorId !== userId) return false;
  return !(payload.type === 'outreach.live.changed' && payload.entityId === ownComputerId);
}

/**
 * How long to wait before telling HandsFreeOS: now for the first beat, a heartbeat, the person's use, a step to send
 * or a new state; a line alone at most every so often; -1 when there's nothing new.
 */
export function beatWait(
  last: Told | null,
  now: Status,
  more: { readonly steps: number; readonly active: boolean; readonly force: boolean },
  at: number,
): number {
  if (more.force || more.steps || more.active || !last || last.state !== now.state) return 0;
  const nextSame =
    last.nextAt === now.nextAt ||
    (last.nextAt !== null &&
      now.nextAt !== null &&
      Math.abs(Date.parse(last.nextAt) - Date.parse(now.nextAt)) < 5_000);
  if (last.line === now.line && nextSame) return -1;
  return Math.max(0, last.at + LINE_BEAT_SECONDS * 1000 - at);
}

// ------------------------------------------------------------------------------------------------- storage

async function read<T>(key: string, shape: (v: unknown) => v is T, otherwise: T): Promise<T> {
  try {
    const value: unknown = (await chrome.storage.local.get(key))[key];
    return shape(value) ? value : otherwise;
  } catch {
    return otherwise;
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const write = (values: Record<string, unknown>) =>
  chrome.storage.local.set(values).catch(() => undefined);

const keptNow = async () => (await read(LIVE_KEY, isObject, null)) as Kept | null;
const unsentNow = async () => (await read(LIVE_STEPS_KEY, isList, [])) as Unsent[];
const pressNow = async () => (await read(LIVE_PRESS_KEY, isObject, null)) as Press | null;
const activeNow = async () =>
  (await read(LIVE_ACTIVE_KEY, isObject, null)) as (Place & { at: number }) | null;

/** The last answer, when it's for this person and business. */
export async function keptFor(place: Place | null): Promise<Kept | null> {
  const kept = await keptNow();
  return samePlace(kept, place) ? kept : null;
}

/** Whether a press here for this person and business waits to be sent. */
export async function pressWaiting(place: Place | null): Promise<boolean> {
  return samePlace(await pressNow(), place);
}

/** This computer's id, made once: calls at the same time share the one being made. */
let making: Promise<string> | null = null;
function installId(): Promise<string> {
  making ??= (async () => {
    const kept = (await read(COMPUTER_KEY, isObject, null)) as { id?: unknown } | null;
    if (typeof kept?.id === 'string') return kept.id;
    const id = crypto.randomUUID();
    await write({ [COMPUTER_KEY]: { id } });
    return id;
  })().finally(() => {
    making = null;
  });
  return making;
}

/** This computer: its id, made once, and its name. */
export async function computer(): Promise<{ id: string; name: string; version: string }> {
  const id = await installId();
  const os = await chrome.runtime
    .getPlatformInfo()
    .then((p) => p.os as string)
    .catch(() => null);
  return { id, name: computerName(os), version: chrome.runtime.getManifest().version.slice(0, 20) };
}

// ------------------------------------------------------------------------------------------------- the beat

/**
 * Called when a beat's answer means the runner should look again (../auto/run.ts sets it); `halt` when what it's
 * doing should end now.
 */
let wake: (halt: boolean) => void = () => undefined;
export function onWake(fn: (halt: boolean) => void): void {
  wake = fn;
}

let told: Told | null = null;
let running: Promise<Kept | null> | null = null;
let trailing: boolean | null = null;
let later: ReturnType<typeof setTimeout> | null = null;

/** Sends a press of Start or Stop: what came of it. */
async function sendPress(
  press: Press,
  installId: string,
): Promise<
  | { readonly kind: 'done'; readonly day: LiveDay }
  | { readonly kind: 'later' }
  | { readonly kind: 'refused'; readonly problem: Problem }
> {
  const options = {
    body: { workspaceId: press.businessId, installId },
    headers: {
      [APP_HEADERS.commandId]: press.commandId,
      [APP_HEADERS.occurredAt]: press.occurredAt,
    },
  };
  try {
    const { data, error, response } =
      press.kind === 'start'
        ? await api().POST('/v1/commands/outreach.day.start', options)
        : await api().POST('/v1/commands/outreach.day.stop', options);
    if (data && response.ok) return { kind: 'done', day: data };
    const out = outcomeOf(response.status, error);
    if (out.kind !== 'refused') return { kind: 'later' };
    const body: unknown = error;
    const said = isApiErrorBody(body) ? body.error : null;
    return {
      kind: 'refused',
      problem: {
        message: out.why,
        rule: said?.rule ?? null,
        status: response.status,
        recheck: false,
      },
    };
  } catch {
    return { kind: 'later' };
  }
}

/** A press kept while HandsFreeOS couldn't be reached: sent now, and let go once it's taken or refused for good. */
async function sendWaitingPress(place: Place, installId: string): Promise<void> {
  const press = await pressNow();
  if (!press || !samePlace(press, place)) return;
  const sent = await sendPress(press, installId);
  if (sent.kind === 'later') return;
  // A newer press may have come meanwhile: only this one goes.
  if ((await pressNow())?.commandId === press.commandId)
    await chrome.storage.local.remove(LIVE_PRESS_KEY).catch(() => undefined);
}

/** One beat: what it shows, the lines waiting, and whether the person used it; the answer kept. */
async function beatOnce(
  force: boolean,
  override?: Pick<Status, 'state' | 'line'>,
): Promise<Kept | null> {
  const place = await savingTo().catch(() => null);
  if (!place) return null;
  const kept = await keptFor(place);
  if (!kept) await chrome.storage.local.remove(LIVE_KEY).catch(() => undefined);
  const me = await computer();
  await sendWaitingPress(place, me.id);
  const state = await read<AutoState | null>(
    AUTO_STATE_KEY,
    (v): v is AutoState | null => isState(v),
    null,
  );
  const settings = (await read(SETTINGS_KEY, isObject, null)) as Automation | null;
  const active = await activeNow();
  const isActive = samePlace(active, place);
  const steps = (await unsentNow())
    .filter((s) => samePlace(s, place))
    .slice(0, LIVE_STEPS_SENT_MOST);
  const shown: Status = override
    ? {
        ...override,
        line: override.line === null ? null : clipLine(override.line),
        lineAt: new Date().toISOString(),
        nextAt: null,
      }
    : state
      ? reportedStatus(state, settings?.settings ?? null, kept ? !kept.working : false)
      : { state: 'idle', line: null, lineAt: null, nextAt: null };
  const wait = beatWait(told, shown, { steps: steps.length, active: isActive, force }, Date.now());
  if (wait < 0) return kept;
  if (wait > 0) {
    if (!later) later = setTimeout(() => ((later = null), void beat()), wait);
    return kept;
  }
  let answer: LiveBeatOutput;
  try {
    answer = await call(
      api().POST('/v1/commands/outreach.live.beat', {
        body: {
          workspaceId: place.businessId,
          computer: { id: me.id, name: me.name, version: me.version },
          active: isActive,
          status: shown,
          steps: steps.map(({ id, at, kind, line }) => ({ id, at, kind, line })),
        },
      }),
      place.businessId,
    );
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    // No connection, or Social Outreach is off there: everything waits for the next beat.
    return kept;
  }
  told = { state: shown.state, line: shown.line, nextAt: shown.nextAt, at: Date.now() };
  const keptIds = new Set(answer.stepsKept);
  await write({ [LIVE_STEPS_KEY]: (await unsentNow()).filter((s) => !keptIds.has(s.id)) });
  // Used again while this went: that one goes with the next beat.
  if (isActive && (await activeNow())?.at === active!.at)
    await chrome.storage.local.remove(LIVE_ACTIVE_KEY).catch(() => undefined);
  const next: Kept = {
    ...answer,
    userId: place.userId,
    businessId: place.businessId,
    at: Date.now(),
  };
  await write({ [LIVE_KEY]: next });
  const then = wakeFor(kept, next, state, await pressWaiting(place));
  if (then.wake) wake(then.halt);
  return next;
}

/**
 * Tells HandsFreeOS where things stand, one beat at a time: one asked for while another goes follows it. `force`
 * sends it whatever changed (the minute's heartbeat). The answer, or the last one kept when it couldn't go.
 */
export function beat(force = false): Promise<Kept | null> {
  if (running) {
    trailing = (trailing ?? false) || force;
    return running;
  }
  const go = beatOnce(force).catch((error: unknown) => {
    console.error('HandsFreeOS Social couldn’t tell HandsFreeOS how it’s going', error);
    return null;
  });
  running = go.finally(() => {
    running = null;
    if (trailing !== null) {
      const again = trailing;
      trailing = null;
      void beat(again);
    }
  });
  return running;
}

let soon: ReturnType<typeof setTimeout> | null = null;
/** A beat in a couple of seconds: changes close together go in one. */
export function beatSoon(): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => ((soon = null), void beat()), 2_000);
}

/** The person used this computer just now (the panel, a step of their own, signing in): it becomes the one that works. */
export async function markActive(): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (!place) return;
  await write({ [LIVE_ACTIVE_KEY]: { ...place, at: Date.now() } });
  beatSoon();
}

/** A step for the feed. */
export async function feed(kind: Unsent['kind'], line: string): Promise<void> {
  const place = await savingTo().catch(() => null);
  if (!place) return;
  const step: Unsent = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind,
    line: clipLine(line),
    ...place,
  };
  await write({ [LIVE_STEPS_KEY]: withStep(await unsentNow(), step) });
  beatSoon();
}

/** HandsFreeOS's word on whether this computer works and on the day: fresh, or a beat now. */
export async function liveNow(place: Place): Promise<Kept | null> {
  const kept = await keptFor(place);
  if (kept && Date.now() - kept.at < 10_000) return kept;
  return (await beat(true)) ?? kept;
}

/**
 * Start my day or Stop for today, pressed here: kept in HandsFreeOS, which this computer then works for. With no
 * connection it waits and goes with the next beat.
 */
export async function pressDay(
  kind: Press['kind'],
): Promise<
  | { readonly kind: 'done'; readonly day: LiveDay }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly problem: Problem }
> {
  const place = await savingTo();
  if (!place)
    return {
      kind: 'refused',
      problem: {
        message: 'Sign in to HandsFreeOS in the panel first.',
        rule: null,
        status: null,
        recheck: true,
      },
    };
  const press: Press = {
    kind,
    commandId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    ...place,
  };
  const me = await computer();
  const sent = await sendPress(press, me.id);
  if (sent.kind === 'later') {
    await write({ [LIVE_PRESS_KEY]: press });
    return { kind: 'waiting' };
  }
  // A press that waited is older than this one: it's let go.
  if (samePlace(await pressNow(), place))
    await chrome.storage.local.remove(LIVE_PRESS_KEY).catch(() => undefined);
  if (sent.kind !== 'done') return sent;
  // The answer kept follows the press at once: the day as HandsFreeOS keeps it now, and this computer the one that
  // works, so the runner never goes by the day as it was before.
  const kept = await keptFor(place);
  if (kept)
    await write({
      [LIVE_KEY]: { ...kept, day: sent.day, working: true, workingName: null, at: Date.now() },
    });
  beatSoon();
  return { kind: 'done', day: sent.day };
}

/** Before signing out: one last beat that says so, so the app doesn't call this computer offline. Then forgets it. */
export async function signOff(): Promise<void> {
  await Promise.race([
    beatOnce(true, { state: 'signed_out', line: 'Signed out of the extension' }).catch(() => null),
    new Promise((done) => setTimeout(done, 5_000)),
  ]);
  told = null;
  await chrome.storage.local.remove([LIVE_KEY, LIVE_ACTIVE_KEY]).catch(() => undefined);
}

/** The minute's heartbeat alarm, while someone is signed in. */
export async function keepBeating(on: boolean): Promise<void> {
  try {
    const alarm = await chrome.alarms.get(BEAT_ALARM);
    if (on && !alarm) await chrome.alarms.create(BEAT_ALARM, { periodInMinutes: BEAT_MINUTES });
    if (!on && alarm) await chrome.alarms.clear(BEAT_ALARM);
  } catch {
    // The next wake tries again.
  }
}

/** A change heard on the live channel (./follow.ts): the person's own day or computers may have moved. */
export async function heard(payload: Record<string, unknown>): Promise<void> {
  const place = await savingTo().catch(() => null);
  const kept = await keptFor(place);
  if (liveEventFor(payload, place?.userId ?? null, kept?.computerId ?? null)) await beat(true);
}
