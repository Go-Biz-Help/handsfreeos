/**
 * Replies the person's tabs saw on each network (docs/outreach.md, decision 22), sent to HandsFreeOS from the
 * background as that network's (`outreach.replies.note`), which keeps each one that answers a message of the person's
 * and tells their phone. Only
 * chats from the last two days go, so an old chat never buzzes anyone; and a chat sent lately isn't sent again until a
 * few minutes have passed, while the tab keeps seeing it. Nothing is kept waiting: a reply HandsFreeOS couldn't hear
 * of now is seen again the next time the chat is on screen. Nothing goes while the switch in the panel is off.
 */
import { REPLIES_MOST } from '@hfos/core/addons/outreach/alerts';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { facebook } from '../networks/facebook/kit';
import type { ReplySighting } from '../networks/facebook/replies';
import type { TabNote } from '../messages';
import type { RepliesNoteInput } from './messages';
import { api, savingTo } from './session';
import { instantOf } from './when';

/** Older than this, a chat in the list isn't news. */
export const REPLY_FRESH_MS = 2 * 24 * 3_600_000;
/** A chat sent lately waits this long before it's sent again. */
export const REPLY_AGAIN_MS = 3 * 60_000;
/** The chats sent lately, while the browser is open. */
const SENT_KEY = 'hfos.replies';

/**
 * Who a sighting is about, to send each chat once in a while: Facebook's as they always were, another network's
 * saying which.
 */
export const sightingKey = (s: ReplySighting, platform: Platform = facebook.platform) => {
  const key =
    s.threadKey ?? `${s.profile?.id ?? ''}|${s.profile?.username ?? ''}|${s.name.toLowerCase()}`;
  return platform === facebook.platform ? key : `${platform}:${key}`;
};

/** The sightings worth sending now: lately written, not sent in the last few minutes, each once, at most a note's. */
export function toSend(
  seen: readonly ReplySighting[],
  sent: Readonly<Record<string, number>>,
  now: Date,
  platform: Platform = facebook.platform,
): ReplySighting[] {
  const out = new Map<string, ReplySighting>();
  for (const s of seen) {
    const at = s.when ? instantOf(s.when, now) : null;
    if (at && now.getTime() - at.getTime() > REPLY_FRESH_MS) continue;
    const key = sightingKey(s, platform);
    if (now.getTime() - (sent[key] ?? 0) < REPLY_AGAIN_MS) continue;
    if (!out.has(key)) out.set(key, s);
  }
  return [...out.values()].slice(0, REPLIES_MOST);
}

/** What HandsFreeOS is sent: who, by their chat's id or profile, and the network when it's said; never when or what. */
export function repliesInput(
  workspaceId: string,
  seen: readonly ReplySighting[],
  looking: boolean,
  platform?: Platform,
): RepliesNoteInput {
  return {
    workspaceId,
    ...(platform ? { platform } : {}),
    looking,
    seen: seen.map((s) => ({
      name: s.name.trim().slice(0, 200),
      threadKey: s.threadKey,
      profile:
        s.profile && (s.profile.id || s.profile.username)
          ? { id: s.profile.id, username: s.profile.username, url: s.profile.url }
          : null,
    })),
  };
}

/** Whether a tab's note of replies has the shape of one. */
export function isRepliesNote(note: Record<string, unknown>): boolean {
  return (
    note.type === 'hfos-replies' &&
    typeof note.looking === 'boolean' &&
    Array.isArray(note.seen) &&
    note.seen.every(
      (s: unknown) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as ReplySighting).name === 'string' &&
        ((s as ReplySighting).threadKey === null ||
          typeof (s as ReplySighting).threadKey === 'string'),
    )
  );
}

async function sentNow(): Promise<Record<string, number>> {
  try {
    const value: unknown = (await chrome.storage.session.get(SENT_KEY))[SENT_KEY];
    return typeof value === 'object' && value !== null ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Sends what a tab saw on its network, when it's news, while noting is on (./noting.ts). A failure is let go: the
 * chat is seen again.
 */
export async function noteReplies(
  note: Extract<TabNote, { type: 'hfos-replies' }>,
  platform: Platform = facebook.platform,
): Promise<void> {
  const now = new Date();
  const sent = await sentNow();
  const fresh = toSend(note.seen, sent, now, platform);
  if (!fresh.length) return;
  const to = await savingTo().catch(() => null);
  if (!to) return;
  // Kept as sent before it goes, so a second tab seeing the same chat now doesn't send it too.
  const kept = Object.fromEntries(
    Object.entries(sent).filter(([, at]) => now.getTime() - at < REPLY_AGAIN_MS),
  );
  for (const s of fresh) kept[sightingKey(s, platform)] = now.getTime();
  await chrome.storage.session.set({ [SENT_KEY]: kept });
  try {
    await api().POST('/v1/commands/outreach.replies.note', {
      body: repliesInput(to.businessId, fresh, note.looking, platform),
    });
  } catch {
    // No connection: seen again later.
  }
}
