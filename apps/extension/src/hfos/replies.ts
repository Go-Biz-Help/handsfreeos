/**
 * Replies the person's tabs saw on each network (docs/outreach.md, decision 22), sent to HandsFreeOS from the
 * background as that network's (`outreach.replies.note`), which keeps each one that answers a step of the person's
 * and tells their phone. Only
 * chats from the last two days go, so an old chat never buzzes anyone; and a chat sent lately isn't sent again until a
 * few minutes have passed, while the tab keeps seeing it. Nothing is kept waiting: a reply HandsFreeOS couldn't hear
 * of now is seen again the next time the chat is on screen. Nothing goes while the switch in the panel is off. A reply
 * HandsFreeOS keeps as new has that network's runner draft the answer next (decision 125, `onReplied`).
 *
 * A newer message of theirs is news too (decision 150): each chat's last line is kept on the computer as a short
 * fingerprint, never its words, and one that changed goes at once, marked `newer`, even when nothing of the person's
 * was noted since their last one (they answered from their phone, or skipped the draft).
 */
import { REPLIES_MOST, REPLY_FRESH_MS } from '@hfos/core/addons/outreach/alerts';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { facebook } from '../networks/facebook/kit';
import type { ReplySighting } from '../networks/facebook/replies';
import type { TabNote } from '../messages';
import type { RepliesNoteInput } from './messages';
import { heardReplies } from './replied';
import { api, savingTo } from './session';
import { instantOf } from './when';

export { onReplied } from './replied';

/** A chat sent lately waits this long before it's sent again. */
export const REPLY_AGAIN_MS = 3 * 60_000;
/** The chats sent lately, while the browser is open. */
const SENT_KEY = 'hfos.replies';
/** Each chat's last line as last seen, as a fingerprint: kept across restarts, so a message while closed is news. */
export const LINES_KEY = 'hfos.replyLines';
/** A chat's line is forgotten after this long unseen. */
const LINES_KEPT_MS = 7 * 24 * 3_600_000;
/** The most lines kept: far more than the lists show. */
const LINES_MOST = 1_000;

/** Each chat's last line as last seen, by chat and where it showed: a fingerprint and when. */
export type SeenLines = Readonly<Record<string, { readonly h: string; readonly at: number }>>;

/** A short fingerprint of a line (FNV-1a), so the words themselves are never kept. */
export function lineHash(line: string): string {
  let h = 0x811c9dc5;
  for (const ch of line.replace(/\s+/g, ' ').trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The sightings marked `newer` where the chat's last line changed since the computer last saw it, and the lines as
 * they are now. The first sight of a chat only notes where it stands. A line from the list and one from the chat
 * open are compared each with its own, as they're written differently.
 */
export function withNewer(
  seen: readonly ReplySighting[],
  lines: SeenLines,
  now: number,
  platform: Platform = facebook.platform,
): { readonly seen: ReplySighting[]; readonly lines: SeenLines } {
  const next: Record<string, { h: string; at: number }> = {};
  for (const [key, kept] of Object.entries(lines))
    if (now - kept.at < LINES_KEPT_MS) next[key] = kept;
  // Only the computer says what's newer: never a tab.
  const out = seen.map(({ newer: _said, ...s }): ReplySighting => {
    if (!s.last) return s;
    const key = `${sightingKey(s, platform)}|${s.last.where}`;
    const h = lineHash(s.last.line);
    const had = next[key];
    next[key] = { h, at: now };
    return had && had.h !== h ? { ...s, newer: true } : s;
  });
  const keys = Object.keys(next);
  if (keys.length > LINES_MOST)
    for (const key of keys
      .sort((a, b) => next[a]!.at - next[b]!.at)
      .slice(0, keys.length - LINES_MOST))
      delete next[key];
  return { seen: out, lines: next };
}

/**
 * Who a sighting is about, to send each chat once in a while: Facebook's as they always were, another network's
 * saying which.
 */
export const sightingKey = (s: ReplySighting, platform: Platform = facebook.platform) => {
  const key =
    s.threadKey ?? `${s.profile?.id ?? ''}|${s.profile?.username ?? ''}|${s.name.toLowerCase()}`;
  return platform === facebook.platform ? key : `${platform}:${key}`;
};

/**
 * The sightings worth sending now: lately written, not sent in the last few minutes (but for a newer message, which
 * goes at once), each once, newer ones first, at most a note's.
 */
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
    if (!s.newer && now.getTime() - (sent[key] ?? 0) < REPLY_AGAIN_MS) continue;
    const had = out.get(key);
    if (!had || (s.newer && !had.newer)) out.set(key, s);
  }
  return [...out.values()]
    .sort((a, b) => Number(!!b.newer) - Number(!!a.newer))
    .slice(0, REPLIES_MOST);
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
      // That it changed, never its words (decision 150).
      ...(s.newer ? { newer: true } : {}),
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

async function linesNow(): Promise<SeenLines> {
  try {
    const value: unknown = (await chrome.storage.local.get(LINES_KEY))[LINES_KEY];
    return typeof value === 'object' && value !== null ? (value as SeenLines) : {};
  } catch {
    return {};
  }
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
  const lined = withNewer(note.seen, await linesNow(), now.getTime(), platform);
  await chrome.storage.local.set({ [LINES_KEY]: lined.lines }).catch(() => undefined);
  const fresh = toSend(lined.seen, sent, now, platform);
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
    const { data } = await api().POST('/v1/commands/outreach.replies.note', {
      body: repliesInput(to.businessId, fresh, note.looking, platform),
    });
    heardReplies(
      platform,
      (data?.replies ?? []).map((r) => r.profileId),
    );
  } catch {
    // No connection: seen again later.
  }
}
