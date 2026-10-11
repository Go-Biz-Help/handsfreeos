/**
 * The steps the person takes on Facebook, noted in HandsFreeOS as they take them (docs/outreach.md, decisions 7 and
 * 8), in the background worker. A Facebook tab tells it each step (src/facebook/actions.ts), and it sends the step to
 * the business the panel saves to (`outreach.touch.save`) with the moment it was taken; and the same for their answer
 * to a friend request they got, Confirm or Delete (`outreach.friend.note`, decisions 10 to 13). While HandsFreeOS
 * can't be reached, these wait in the extension's own storage with their ids, oldest first, so sending one again never
 * notes it twice, and a message's place (a chat started, a follow-up) is worked out in the order they were sent.
 *
 * While the browser is open it also remembers the group each person was opened from, for a step taken later on their
 * own profile, whose address doesn't say which. Nothing is noted while the switch in the panel is off, or while
 * nobody is signed in with somewhere to save.
 *
 * A step the runner couldn't do there and then, handed to the person (`outreach.need.note`, decision 42), waits in the
 * same list, so it keeps its moment and goes in its turn.
 */
import { isApiErrorBody } from '@hfos/api-client';
import { APP_HEADERS } from '@hfos/core/mobile';
import { FRIEND_ANSWER_KEYS, TOUCH_KIND_KEYS } from '@hfos/core/addons/outreach/limits';
import type { Answered, Seen, Step, StepGroup } from '../facebook/actions';
import { profileKey } from '../facebook/urls';
import { NOTING_KEY, type TabNote } from '../messages';
import type { FriendNoteInput, NeedNoteInput, TouchInput, TouchSaved } from './messages';
import { isRepliesNote, noteReplies } from './replies';
import { friendNote, nameKey, touchSave, type Built } from './saves';
import { api, savingTo } from './session';

/** Steps waiting to be sent, kept across restarts. */
const WAITING_KEY = 'hfos.waiting';
/** The groups people were opened from: only while the browser is open. */
const GROUPS_KEY = 'hfos.groups';

/** The most steps kept waiting, more than a day's: past it, the oldest go. */
export const WAITING_MOST = 200;
/** How many people's groups are remembered, the latest kept. */
export const GROUPS_MOST = 300;

/**
 * What's sent: a step (`outreach.touch.save`), an answer to a friend request (`outreach.friend.note`), or a step the
 * runner couldn't do, handed to the person (`outreach.need.note`).
 */
type Sending =
  | { readonly op?: undefined; readonly input: TouchInput }
  | { readonly op: 'answer'; readonly input: FriendNoteInput }
  | { readonly op: 'need'; readonly input: NeedNoteInput };

/** A step waiting to be sent: its id and moment stay the same however many times it's sent. */
type Waiting = Sending & {
  readonly commandId: string;
  readonly occurredAt: string;
  /** Whose step it is: it's sent only while they're signed in. */
  readonly userId: string;
};

/** The group someone was opened from, by their profile, with their name to find them by when a link didn't match. */
export interface Remembered {
  readonly name: string | null;
  readonly group: StepGroup;
  readonly at: number;
}

/** What came of sending a step. */
export type Sent =
  | { readonly kind: 'saved'; readonly saved: Pick<TouchSaved, 'step' | 'repeated'> }
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
export function isTabNote(note: unknown): note is Exclude<TabNote, { type: 'hfos-looked' }> {
  if (!isObject(note)) return false;
  const withProfile = (person: unknown): person is Record<string, unknown> =>
    isObject(person) && isObject(person.profile);
  const named = (person: unknown) => withProfile(person) && typeof person.name === 'string';
  if (note.type === 'hfos-seen') return withProfile(note.seen) && isObject(note.seen.group);
  if (note.type === 'hfos-replies') return isRepliesNote(note);
  if (typeof note.at !== 'string') return false;
  if (note.type === 'hfos-answered')
    return (
      isObject(note.answered) &&
      (FRIEND_ANSWER_KEYS as readonly unknown[]).includes(note.answered.answer) &&
      named(note.answered.to)
    );
  return (
    note.type === 'hfos-noted' &&
    isObject(note.step) &&
    (TOUCH_KIND_KEYS as readonly unknown[]).includes(note.step.kind) &&
    named(note.step.to)
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

/** HandsFreeOS's answer to one sending: what it kept, as the panel shows it, or why not. */
async function post(entry: Waiting) {
  const headers = {
    [APP_HEADERS.commandId]: entry.commandId,
    [APP_HEADERS.occurredAt]: entry.occurredAt,
  };
  if (entry.op === 'answer') {
    const { data, error, response } = await api().POST('/v1/commands/outreach.friend.note', {
      body: entry.input,
      headers,
    });
    return { saved: data && { step: null, repeated: false }, error, response };
  }
  if (entry.op === 'need') {
    const { data, error, response } = await api().POST('/v1/commands/outreach.need.note', {
      body: entry.input,
      headers,
    });
    return { saved: data && { step: null, repeated: false }, error, response };
  }
  const { data, error, response } = await api().POST('/v1/commands/outreach.touch.save', {
    body: entry.input,
    headers,
  });
  return { saved: data && { step: data.step, repeated: data.repeated }, error, response };
}

async function sendOnce(entry: Waiting): Promise<Sent> {
  try {
    const { saved, error, response } = await post(entry);
    if (saved !== undefined && response.ok) return { kind: 'saved', saved };
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
  }
  // Someone else's steps wait for them to sign in again.
  const others = waiting.filter((entry) => entry.userId !== userId);
  await chrome.storage.local.set({ [WAITING_KEY]: [...others, ...left].slice(-WAITING_MOST) });
  return left.length === 0;
}

/**
 * Something the person did: sent to HandsFreeOS after anything still waiting, or kept to send when it can be reached.
 * What HandsFreeOS refuses (Social Outreach turned off, someone on the Don't pitch list) isn't kept.
 */
async function noteDone(
  at: string,
  build: (businessId: string) => Promise<Built<Sending>>,
): Promise<void> {
  if (!(await isNoting())) return;
  const to = await savingTo().catch(() => null);
  // Nobody signed in, or nowhere to save: nothing is noted.
  if (!to) return;
  const built = await build(to.businessId);
  if (!built.ok) return;
  const id = crypto.randomUUID();
  const occurredAt = momentOf(at, new Date());
  const entry: Waiting = { ...built.input, commandId: id, occurredAt, userId: to.userId };
  const clear = await sendWaiting(to.userId);
  const { sent, entry: last } = clear
    ? await send(entry)
    : { sent: { kind: 'later' } as Sent, entry };
  if (sent.kind === 'later')
    await chrome.storage.local.set({
      [WAITING_KEY]: [...(await waitingNow()), last].slice(-WAITING_MOST),
    });
}

/** A step the person took, with the group they found the person in when the page or the background knows it. */
function noteStep(step: Step, at: string): Promise<void> {
  return noteDone(at, async (businessId) => {
    const built = touchSave(step, businessId, rememberedFor(await groupsNow(), step));
    return built.ok ? { ok: true, input: { input: built.input } } : built;
  });
}

/** The person's answer to a friend request they got. */
function noteAnswer(answered: Answered, at: string): Promise<void> {
  return noteDone(at, async (businessId) => {
    const built = friendNote(answered, businessId);
    return built.ok ? { ok: true, input: { op: 'answer', input: built.input } } : built;
  });
}

/**
 * A step the runner couldn't do, handed to the person: sent after anything still waiting, or kept to send when
 * HandsFreeOS can be reached. It isn't one of the person's steps, so the panel's last steps don't list it; what
 * HandsFreeOS refuses (the person gone from the list meanwhile) is let go.
 */
export function noteNeed(input: NeedNoteInput, at = new Date().toISOString()): Promise<void> {
  return inTurn(async () => {
    const to = await savingTo().catch(() => null);
    if (!to || to.businessId !== input.workspaceId) return;
    const entry: Waiting = {
      op: 'need',
      input,
      commandId: crypto.randomUUID(),
      occurredAt: momentOf(at, new Date()),
      userId: to.userId,
    };
    const clear = await sendWaiting(to.userId);
    const { sent, entry: last } = clear
      ? await send(entry)
      : { sent: { kind: 'later' } as Sent, entry };
    if (sent.kind === 'later')
      await chrome.storage.local.set({
        [WAITING_KEY]: [...(await waitingNow()), last].slice(-WAITING_MOST),
      });
  }).catch((error: unknown) =>
    console.error('HandsFreeOS Social couldn’t hand a step over', error),
  );
}

/**
 * What a Facebook tab told the background: a step taken, a friend request answered, someone opened from a group, or
 * chats whose last message is theirs (./replies.ts).
 */
export function takeNote(note: Exclude<TabNote, { type: 'hfos-looked' }>): Promise<void> {
  if (note.type === 'hfos-replies')
    return isNoting()
      .then((on) => (on ? noteReplies(note) : undefined))
      .catch((error: unknown) =>
        console.error('HandsFreeOS Social couldn’t send the replies it saw', error),
      );
  const work =
    note.type === 'hfos-seen'
      ? async () => {
          const groups = withSeen(await groupsNow(), note.seen, Date.now());
          await chrome.storage.session.set({ [GROUPS_KEY]: groups });
        }
      : note.type === 'hfos-answered'
        ? () => noteAnswer(note.answered, note.at)
        : () => noteStep(note.step, note.at);
  return inTurn(work).catch((error: unknown) =>
    console.error('HandsFreeOS Social couldn’t note a step', note.type, error),
  );
}

// ------------------------------------------------------------------------------------------------- the beat

/** The person's steps that waited while HandsFreeOS couldn't be reached, sent with the minute's beat. */
export async function sendWaitingSteps(): Promise<void> {
  const to = await savingTo().catch(() => null);
  if (to) await inTurn(() => sendWaiting(to.userId)).catch(() => false);
}
