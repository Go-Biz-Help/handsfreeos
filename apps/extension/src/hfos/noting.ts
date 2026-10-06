/**
 * The steps the person takes on Facebook, noted in HandsFreeOS as they take them (docs/outreach.md, decisions 7 and
 * 8), in the background worker. A Facebook tab tells it each step (src/facebook/actions.ts), and it sends the step to
 * the business the panel saves to (`outreach.touch.save`) with the moment it was taken. While HandsFreeOS can't be
 * reached, steps wait in the extension's own storage with their ids, oldest first, so sending one again never notes
 * it twice, and a message's place (a chat started, a follow-up) is worked out in the order they were sent.
 *
 * While the browser is open it also remembers the group each person was opened from, for a step taken later on their
 * own profile, whose address doesn't say which. Nothing is noted while the switch in the panel is off, or while
 * nobody is signed in with somewhere to save.
 */
import { isApiErrorBody } from '@hfos/api-client';
import { APP_HEADERS } from '@hfos/core/mobile';
import { TOUCH_KIND_KEYS } from '@hfos/core/addons/outreach/limits';
import type { Seen, Step, StepGroup } from '../facebook/actions';
import { profileKey } from '../facebook/urls';
import { NOTING_KEY, type TabNote } from '../messages';
import { config } from './config';
import type {
  HfosAnswer,
  HfosAsk,
  Noted,
  Today,
  Touched,
  TouchInput,
  TouchSaved,
} from './messages';
import { nameKey, touchSave } from './saves';
import { answerWith, api, call, Refused, savingTo } from './session';

/** Steps waiting to be sent, kept across restarts. */
const WAITING_KEY = 'hfos.waiting';
/** The groups people were opened from, and the last steps noted: only while the browser is open. */
const GROUPS_KEY = 'hfos.groups';
const RECENT_KEY = 'hfos.recent';

/** The most steps kept waiting, more than a day's: past it, the oldest go. */
export const WAITING_MOST = 200;
/** How many people's groups are remembered, the latest kept. */
export const GROUPS_MOST = 300;
/** How many of the last steps the panel lists. */
export const RECENT_MOST = 5;

/** A step waiting to be sent: its id and moment stay the same however many times it's sent. */
interface Waiting {
  readonly commandId: string;
  readonly occurredAt: string;
  /** Whose step it is: it's sent only while they're signed in. */
  readonly userId: string;
  readonly input: TouchInput;
}

/** The group someone was opened from, by their profile, with their name to find them by when a link didn't match. */
export interface Remembered {
  readonly name: string | null;
  readonly group: StepGroup;
  readonly at: number;
}

/** One of the last steps, with the business it went to and the id it was sent with. */
interface Kept extends Noted {
  readonly id: string;
  readonly businessId: string;
}

/** What came of sending a step. */
export type Sent =
  | { readonly kind: 'saved'; readonly saved: TouchSaved }
  /** Saved at the same moment as another for the same person: send it again, under a new id. */
  | { readonly kind: 'again' }
  /** HandsFreeOS couldn't take it now: keep it waiting. */
  | { readonly kind: 'later' }
  | { readonly kind: 'refused'; readonly why: string };

/** What came of a step HandsFreeOS didn't keep, from its answer: null when nothing came back at all. */
export function outcomeOf(status: number | null, body: unknown): Exclude<Sent, { kind: 'saved' }> {
  if (status === null) return { kind: 'later' };
  const said = isApiErrorBody(body) ? body.error : null;
  if (said?.rule === 'outreach_saved_at_once') return { kind: 'again' };
  if (status >= 500 || status === 401 || status === 426 || status === 429) return { kind: 'later' };
  if (said?.disposition === 'retry') return { kind: 'later' };
  return { kind: 'refused', why: said?.message ?? 'HandsFreeOS couldn’t keep it.' };
}

/**
 * The group the background remembers someone by: by their profile, else by their name when only one person opened
 * had it (their link gave a number where the profile shows a username).
 */
export function rememberedFor(
  groups: Readonly<Record<string, Remembered>>,
  step: Step,
): StepGroup | null {
  const byProfile = groups[profileKey(step.to.profile)];
  if (byProfile) return byProfile.group;
  const named = Object.values(groups).filter(
    (seen) => seen.name !== null && nameKey(seen.name) === nameKey(step.to.name),
  );
  return named.length === 1 ? named[0]!.group : null;
}

/** The groups remembered with someone opened just now, the oldest let go past the most kept. */
export function withSeen(
  groups: Readonly<Record<string, Remembered>>,
  seen: Seen,
  at: number,
): Record<string, Remembered> {
  const next = {
    ...groups,
    [profileKey(seen.profile)]: { name: seen.name, group: seen.group, at },
  };
  const keys = Object.keys(next);
  if (keys.length <= GROUPS_MOST) return next;
  const oldest = keys.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, keys.length - GROUPS_MOST);
  for (const key of oldest) delete next[key];
  return next;
}

/** When a tab said the step was taken, as HandsFreeOS takes it: now, if what it said can't be right. */
export function momentOf(at: string, now: Date): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) || ms > now.getTime() + 60_000
    ? now.toISOString()
    : new Date(ms).toISOString();
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Whether a tab's note has the shape of one. The tab's script is the extension's own; what it read was a page's. */
export function isTabNote(note: unknown): note is TabNote {
  if (!isObject(note)) return false;
  const withProfile = (person: unknown): person is Record<string, unknown> =>
    isObject(person) && isObject(person.profile);
  if (note.type === 'hfos-seen') return withProfile(note.seen) && isObject(note.seen.group);
  if (note.type !== 'hfos-noted' || !isObject(note.step) || typeof note.at !== 'string')
    return false;
  const { kind, to } = note.step;
  return (
    (TOUCH_KIND_KEYS as readonly unknown[]).includes(kind) &&
    withProfile(to) &&
    typeof to.name === 'string'
  );
}

// ------------------------------------------------------------------------------------------------- storage

async function stored<T>(
  area: chrome.storage.StorageArea,
  key: string,
  shape: (value: unknown) => value is T,
  otherwise: T,
): Promise<T> {
  try {
    const value: unknown = (await area.get(key))[key];
    return shape(value) ? value : otherwise;
  } catch {
    return otherwise;
  }
}

const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const waitingNow = async () =>
  (await stored(chrome.storage.local, WAITING_KEY, isList, [])) as Waiting[];
const groupsNow = async () =>
  (await stored(chrome.storage.session, GROUPS_KEY, isObject, {})) as Record<string, Remembered>;
const recentNow = async () =>
  (await stored(chrome.storage.session, RECENT_KEY, isList, [])) as Kept[];

export async function isNoting(): Promise<boolean> {
  try {
    return (await chrome.storage.local.get(NOTING_KEY))[NOTING_KEY] !== false;
  } catch {
    return true;
  }
}

let turn: Promise<unknown> = Promise.resolve();

/** One at a time: two steps noted at once never both take the waiting list and write it back. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = turn.then(work, work);
  turn = next.catch(() => undefined);
  return next;
}

// ------------------------------------------------------------------------------------------------- sending

async function sendOnce(entry: Waiting): Promise<Sent> {
  try {
    const { data, error, response } = await api().POST('/v1/commands/outreach.touch.save', {
      body: entry.input,
      headers: {
        [APP_HEADERS.commandId]: entry.commandId,
        [APP_HEADERS.occurredAt]: entry.occurredAt,
      },
    });
    if (data !== undefined && response.ok) return { kind: 'saved', saved: data };
    return outcomeOf(response.status, error);
  } catch {
    // No answer: no connection, or the sign-in couldn't be refreshed.
    return { kind: 'later' };
  }
}

/** Sends a step, and once more under a new id when it met another being saved at the same moment. */
async function send(entry: Waiting): Promise<{ readonly sent: Sent; readonly entry: Waiting }> {
  const sent = await sendOnce(entry);
  if (sent.kind !== 'again') return { sent, entry };
  const again = { ...entry, commandId: crypto.randomUUID() };
  const second = await sendOnce(again);
  return { sent: second.kind === 'again' ? { kind: 'later' } : second, entry: again };
}

/** The last steps, with one changed by `change` (found by its id) or added at the top. */
async function keepRecent(
  id: string,
  change: (kept: Kept | undefined) => Kept | null,
): Promise<void> {
  const recent = await recentNow();
  const at = recent.findIndex((kept) => kept.id === id);
  const next = change(at === -1 ? undefined : recent[at]);
  if (!next) return;
  const list = at === -1 ? [next, ...recent] : recent.map((kept, i) => (i === at ? next : kept));
  await chrome.storage.session.set({ [RECENT_KEY]: list.slice(0, RECENT_MOST) });
}

const keptAs = (sent: Sent): Pick<Noted, 'state' | 'step' | 'repeated' | 'why'> =>
  sent.kind === 'saved'
    ? { state: 'saved', step: sent.saved.step, repeated: sent.saved.repeated, why: null }
    : sent.kind === 'refused'
      ? { state: 'not_saved', step: null, repeated: false, why: sent.why }
      : { state: 'waiting', step: null, repeated: false, why: null };

/** Sends the person's steps that are waiting, oldest first, while HandsFreeOS takes them. True when none are left. */
async function sendWaiting(userId: string): Promise<boolean> {
  const waiting = await waitingNow();
  const theirs = waiting.filter((entry) => entry.userId === userId);
  if (!theirs.length) return true;
  const left: Waiting[] = [];
  for (const [i, entry] of theirs.entries()) {
    const { sent, entry: last } = await send(entry);
    if (sent.kind === 'later') {
      left.push(last, ...theirs.slice(i + 1));
      break;
    }
    await keepRecent(entry.commandId, (kept) =>
      kept ? { ...kept, ...keptAs(sent), id: last.commandId } : null,
    );
  }
  // Someone else's steps wait for them to sign in again.
  const others = waiting.filter((entry) => entry.userId !== userId);
  await chrome.storage.local.set({ [WAITING_KEY]: [...others, ...left].slice(-WAITING_MOST) });
  return left.length === 0;
}

/** Tells the extension's pages the day's numbers have changed. Nobody may be listening. */
function tellPages(): void {
  chrome.runtime.sendMessage({ type: 'hfos-touched' } satisfies Touched).catch(() => undefined);
}

/**
 * A step the person took: sent to HandsFreeOS after any still waiting, or kept to send when it can be reached. A
 * step HandsFreeOS refuses (Social Outreach turned off, say) isn't kept: the panel's last steps say why.
 */
async function noteStep(step: Step, at: string): Promise<void> {
  if (!(await isNoting())) return;
  const to = await savingTo().catch(() => null);
  // Nobody signed in, or nowhere to save: nothing is noted.
  if (!to) return;
  const built = touchSave(step, to.businessId, rememberedFor(await groupsNow(), step));
  const id = crypto.randomUUID();
  const occurredAt = momentOf(at, new Date());
  const base = {
    id,
    businessId: to.businessId,
    kind: step.kind,
    name: step.to.name,
    at: occurredAt,
  };
  if (!built.ok) {
    await keepRecent(id, () => ({ ...base, ...keptAs({ kind: 'refused', why: built.why }) }));
    return tellPages();
  }
  const entry: Waiting = { commandId: id, occurredAt, userId: to.userId, input: built.input };
  const clear = await sendWaiting(to.userId);
  const { sent, entry: last } = clear
    ? await send(entry)
    : { sent: { kind: 'later' } as Sent, entry };
  if (sent.kind === 'later')
    await chrome.storage.local.set({
      [WAITING_KEY]: [...(await waitingNow()), last].slice(-WAITING_MOST),
    });
  await keepRecent(id, () => ({ ...base, ...keptAs(sent), id: last.commandId }));
  tellPages();
}

/** What a Facebook tab told the background: a step taken, or someone opened from a group. */
export function takeNote(note: TabNote): void {
  const work =
    note.type === 'hfos-seen'
      ? async () => {
          const groups = withSeen(await groupsNow(), note.seen, Date.now());
          await chrome.storage.session.set({ [GROUPS_KEY]: groups });
        }
      : () => noteStep(note.step, note.at);
  inTurn(work).catch((error: unknown) =>
    console.error('HandsFreeOS Social couldn’t note a step', note.type, error),
  );
}

// ------------------------------------------------------------------------------------------------- the day

/**
 * The person's day so far, sending what's waiting first: their numbers, the last steps, and the switch. When
 * HandsFreeOS can't give the numbers, the rest still comes, with why.
 */
async function today(): Promise<Today> {
  const noting = await isNoting();
  const to = await savingTo();
  const none = { activity: null, trouble: null, waiting: 0, recent: [] };
  if (!to) return { ...none, businessId: null, webUrl: config.webUrl, noting };
  await inTurn(() => sendWaiting(to.userId)).catch(() => false);
  const waiting = (await waitingNow()).filter((entry) => entry.userId === to.userId);
  const recent = (await recentNow())
    .filter((kept) => kept.businessId === to.businessId)
    .map(({ id: _id, businessId: _business, ...noted }) => noted);
  let activity: Today['activity'] = null;
  let trouble: string | null = null;
  try {
    activity = await call(
      api().POST('/v1/queries/outreach.activity', {
        body: { workspaceId: to.businessId, period: 'today', everyone: false },
      }),
      to.businessId,
    );
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    trouble = error.problem.message;
  }
  return {
    activity,
    trouble,
    businessId: to.businessId,
    webUrl: config.webUrl,
    noting,
    waiting: waiting.length,
    recent,
  };
}

/** The panel's asks about the day on Facebook, and its switch. Never throws: what went wrong comes back as a problem. */
export function answerNoting(
  ask: Extract<HfosAsk, { readonly type: 'hfos-today' | 'hfos-noting' }>,
): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    if (ask.type === 'hfos-noting')
      await chrome.storage.local.set({ [NOTING_KEY]: ask.on === true });
    return today();
  });
}
