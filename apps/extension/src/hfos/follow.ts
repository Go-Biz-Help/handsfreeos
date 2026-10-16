/**
 * The extension follows the person's settings in HandsFreeOS (docs/outreach.md, decisions 37 to 40): it keeps none of
 * its own. It loads them when the person signs in, at every step the runner takes, and within seconds of a change,
 * from the same live channel the web app listens on (`workspace:<id>`, which carries only that something changed,
 * never what). A change to anyone's choices, or to the business's, has it ask HandsFreeOS again for the person's own.
 *
 * What the content script and the panel read from the extension's storage (noting the person's steps, reading chats
 * as they're opened, looking for posts while scrolling) is written here from those settings, so they change with
 * them. The live channel keeps the background awake while Chrome is open; when it can't connect, the next step's
 * look is the fallback.
 *
 * The same channel brings the person's day and computers (decision 41): Start my day or Stop for today pressed in the
 * app, another computer of theirs used, a warning seen on one. Those go to ./live.ts, whose beat asks HandsFreeOS
 * where things stand and wakes the runner.
 *
 * And what waits for the person (decisions 40 and 42): a message drafted, OK'd or sent, a step handed over or done, a
 * friend request answered. Those go to ./waiting.ts, which asks again and keeps the icon's number and the pop-ups.
 *
 * And what the person asks of their computer from HandsFreeOS (decision 43): an ask made, stopped or answered. Those go
 * to ../asks/run.ts, which takes and does them.
 */
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js';
import { MARK_POSTS_KEY, NOTING_KEY, READ_CHATS_KEY } from '../messages';
import { config } from './config';
import { ASK_EVENTS, WAITING_EVENTS, type Automation } from './messages';
import { api, call, savingTo, token } from './session';

/** The person's settings as last loaded, for the panel's summary. */
export const SETTINGS_KEY = 'hfos.settings';
export { MARK_POSTS_KEY, READ_CHATS_KEY };
/** The changes that can move the person's settings. */
const SETTINGS_EVENTS = new Set(['outreach.automation.saved', 'addon.settings_saved']);
/**
 * The changes that can move the person's day or which of their computers works (decision 41): Start my day or Stop
 * for today pressed anywhere, another computer of theirs used, or a Facebook warning seen on one (./live.ts).
 */
const LIVE_EVENTS = new Set([
  'outreach.day.started',
  'outreach.day.stopped',
  'outreach.live.changed',
  'outreach.warning.seen',
]);

let live: RealtimeClient | null = null;
let channel: RealtimeChannel | null = null;
/** The business the channel listens to. */
let listening: string | null = null;
/** Called when the settings change, to wake the runner (../auto/run.ts). */
let changed: () => void = () => undefined;
/** Called with a change to the person's day or computers, for ./live.ts to look at. */
let livened: (payload: Record<string, unknown>) => void = () => undefined;
/** Called with a change that may move what waits for the person, for ./waiting.ts to look at. */
let waited: (payload: Record<string, unknown>) => void = () => undefined;

/** Called with an ask made, stopped or answered, for ../asks/run.ts. */
let asked: (payload: Record<string, unknown>) => void = () => undefined;

/** Writes what the content script and the panel read, from the settings. */
async function apply(found: Automation): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: found,
    [NOTING_KEY]: found.settings.noting,
    [READ_CHATS_KEY]: found.settings.readChats,
    [MARK_POSTS_KEY]: found.settings.markPosts,
  });
}

/** When Social Outreach was last installed in each business, as last loaded: { "<businessId>": ISO }. */
export const STARTED_KEY = 'hfos.started';

/**
 * What the extension keeps on the computer about a business's outreach: chats read, steps not yet sent, the day's
 * runner, asks, what waits, and the setup opened. Forgotten when the business starts Social Outreach fresh.
 */
export const KEPT_FOR_BUSINESS = [
  'hfos.chatsRead',
  'hfos.waiting',
  'hfos.groups',
  'hfos.auto',
  'hfos.auto.linkedin',
  'hfos.replies',
  'hfos.facebookFile',
  'hfos.ask',
  'hfos.ask.linkedin',
  'hfos.ask.ends',
  'hfos.waitingFor',
  'hfos.waitingFor.told',
  'hfos.setupOpened',
  'hfos.setupReported',
] as const;

/**
 * Forgets what's kept from before when the business started Social Outreach fresh since it was last loaded (its
 * `startedAt` moved): nothing from before is sent again.
 */
export async function forgetOnFreshStart(businessId: string, startedAt: string | null) {
  if (!startedAt) return;
  const stored: unknown = (await chrome.storage.local.get(STARTED_KEY))[STARTED_KEY];
  const known =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, string>) : {};
  if (known[businessId] === startedAt) return;
  if (known[businessId] !== undefined) await chrome.storage.local.remove([...KEPT_FOR_BUSINESS]);
  await chrome.storage.local.set({ [STARTED_KEY]: { ...known, [businessId]: startedAt } });
}

/** The person's settings from HandsFreeOS, kept for the panel and the pages; null when nobody is signed in. */
export async function loadSettings(businessId?: string): Promise<Automation | null> {
  const id = businessId ?? (await savingTo())?.businessId;
  if (!id) return null;
  const found = await call(
    api().POST('/v1/queries/outreach.automation', { body: { workspaceId: id } }),
    id,
  );
  await forgetOnFreshStart(id, found.startedAt);
  await apply(found);
  return found;
}

function close(): void {
  if (channel && live) void live.removeChannel(channel).catch(() => undefined);
  channel = null;
  listening = null;
}

/**
 * Listens for changes to the person's settings in the business they save to, and keeps the channel's sign-in fresh.
 * Safe to call often: it opens a channel only when there's none for that business.
 */
export async function follow(
  onChange?: () => void,
  onLive?: (payload: Record<string, unknown>) => void,
  onWaiting?: (payload: Record<string, unknown>) => void,
  onAsk?: (payload: Record<string, unknown>) => void,
): Promise<void> {
  if (onChange) changed = onChange;
  if (onAsk) asked = onAsk;
  if (onLive) livened = onLive;
  if (onWaiting) waited = onWaiting;
  if (!config.supabaseUrl || !config.supabasePublishableKey) return;
  const to = await savingTo().catch(() => null);
  const jwt = to ? await token().catch(() => null) : null;
  if (!to || !jwt) return close();
  live ??= new RealtimeClient(`${config.supabaseUrl}/realtime/v1`, {
    params: { apikey: config.supabasePublishableKey },
  });
  await live.setAuth(jwt);
  if (listening === to.businessId && channel) return;
  close();
  listening = to.businessId;
  const mine = live.channel(`workspace:${to.businessId}`, { config: { private: true } });
  channel = mine;
  mine.on('broadcast', { event: 'change' }, (message: { payload?: Record<string, unknown> }) => {
    const type = message.payload?.type;
    // One change can be in two sets: the pushes choice saved also reloads the settings below.
    if (typeof type === 'string' && WAITING_EVENTS.has(type)) waited(message.payload!);
    if (typeof type === 'string' && ASK_EVENTS.has(type)) return asked(message.payload!);
    if (typeof type === 'string' && LIVE_EVENTS.has(type)) return livened(message.payload!);
    if (typeof type !== 'string' || !SETTINGS_EVENTS.has(type)) return;
    void loadSettings(to.businessId)
      .then(() => changed())
      .catch(() => undefined);
  });
  mine.subscribe((status) => {
    // Closed or refused: the next call opens it again.
    if (channel === mine && status !== 'SUBSCRIBED' && status !== 'TIMED_OUT') close();
  });
}
