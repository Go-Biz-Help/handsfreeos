import type { FriendAnswer } from '@hfos/core/addons/outreach/limits';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { NeedClear } from '@hfos/core/addons/outreach/waiting-words';
import { SENDS_SOURCE } from '@hfos/core/addons/outreach/views/waiting';

import { change } from '@/changes';

/**
 * Social Outreach's changes on the phone (decision 44), each a command through the phone's queue. OK, change and skip
 * a message work with no signal: each writes the message's new state into the phone's copy in the same transaction
 * (the row's id is `sends:<its id>`), so it leaves Waiting for you at once, and the server's rows take its place once
 * it's handled. An OK waits on the phone for 30 minutes before the phone asks "Still send?"; a skip goes whenever.
 *
 * The SQL is SQLite's, checked by `src/sync/__tests__/phone-sql.test.ts`.
 */

export const rowIdOf = (sendId: string) => `${SENDS_SOURCE}:${sendId}`;

/** A message OK'd or skipped: only its state changes on the phone. */
export const SEND_STATE_SQL = `UPDATE addon_phone_rows SET data = json_set(data, '$.state', ?) WHERE id = ?`;
/** A message changed, then OK'd: its words too. */
export const SEND_CHANGED_SQL = `UPDATE addon_phone_rows SET data = json_set(data, '$.state', ?, '$.text', ?) WHERE id = ?`;

/** OKs one message, as it is or changed. */
export function okSend(workspaceId: string, sendId: string, text?: string) {
  return change(
    'outreach.send.approve',
    { workspaceId, sends: [{ sendId, ...(text !== undefined ? { text } : {}) }] },
    {
      optimistic: (tx) =>
        text !== undefined
          ? tx.execute(SEND_CHANGED_SQL, ['approved', text, rowIdOf(sendId)])
          : tx.execute(SEND_STATE_SQL, ['approved', rowIdOf(sendId)]),
    },
  );
}

/**
 * Approve all, from what the phone showed: those named that still wait are OK'd, and any OK'd or skipped elsewhere
 * meanwhile passed over (`partial`), rather than the whole refused.
 */
export function okAll(workspaceId: string, sends: readonly { sendId: string }[]) {
  return change(
    'outreach.send.approve',
    { workspaceId, sends: sends.map((s) => ({ sendId: s.sendId })), partial: true },
    {
      optimistic: async (tx) => {
        for (const s of sends) await tx.execute(SEND_STATE_SQL, ['approved', rowIdOf(s.sendId)]);
      },
    },
  );
}

/** Skips a message: it isn't sent, and they're off the person's list for today. */
export function skipSend(workspaceId: string, sendId: string) {
  return change(
    'outreach.send.skip',
    { workspaceId, sendId },
    { optimistic: (tx) => tx.execute(SEND_STATE_SQL, ['skipped', rowIdOf(sendId)]) },
  );
}

/** I did it, or Let it go, on a step handed to the person. */
export const clearNeed = (workspaceId: string, needId: string, how: NeedClear) =>
  change('outreach.need.clear', { workspaceId, needId, how });

/**
 * Retry, or Retry all (`needIds` null), on steps handed over (decisions 132 and 143): with signal, as it reaches them
 * again. A message goes a few minutes after the one before; any other step goes back on Today's list.
 */
export const retrySteps = (workspaceId: string, needIds: string[] | null) =>
  change('outreach.need.retry', { workspaceId, needIds });

/** Leave it, on a friend request that's the person's to decide. */
export const setAside = (workspaceId: string, profileId: string) =>
  change('outreach.request.set_aside', { workspaceId, profileId });

/** Confirm or Delete, on a friend request that's the person's to decide (decision 136): the extension does it. */
export const answerRequest = (workspaceId: string, profileId: string, answer: FriendAnswer) =>
  change('outreach.request.answer', { workspaceId, profileId, answer });

/**
 * Start my day, and Stop for today, on one network (each network's day is its own): they wait on the phone with no
 * signal, and go when it's back.
 */
export const startDay = (workspaceId: string, platform: Platform = 'facebook') =>
  change('outreach.day.start', { workspaceId, platform });
export const stopDay = (workspaceId: string, platform: Platform = 'facebook') =>
  change('outreach.day.stop', { workspaceId, platform });

/** Not for me, on a post on Today's list. */
export const skipPost = (workspaceId: string, postId: string) =>
  change('outreach.post.skip', { workspaceId, postId });
