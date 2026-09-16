/**
 * Queuing a push for a moment (M10). The code that notices a moment (the urgent alert, an event's handler) calls
 * `queuePush` in its own transaction, with the same people its email picks. That makes the push part of the moment:
 * - **Once per moment.** The job commits with whatever marks the moment as told (the urgent alert's fingerprint and
 *   its unanswered event, the outbox row being done), so a retried job or handler finds it told and queues nothing,
 *   and one that rolls back takes its push with it. The job's key keeps two queues of one moment to one job.
 * - **Only people who want it.** Each person's switch for the kind (`private.push_on`) and at least one phone that
 *   is on; the person who did the thing hears nothing about it. Nobody left: nothing is queued.
 * - **One notice for everyone.** One notification id and one command id per button, the same on every phone, so a
 *   button pressed on two phones, or twice, does its thing once (the command receipts are each person's).
 *
 * The send job (send.ts) looks the phones up again when it runs and checks the switches once more.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  clipLine,
  commandButtonsOf,
  PUSH_CATEGORIES,
  scheduleJob,
  type PushButton,
  type PushCategory,
  type PushRefs,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { TenantScope } from '../services';
import { PUSH_WORDS, type PushNotice } from './payload';

export const PUSH_JOBS = {
  /** One per moment: the notice to every phone of the people who should hear it. */
  send: 'push.send',
  /** One per send, 15 minutes on: what Apple and Google said, and phones the app is gone from turned off. */
  receipts: 'push.receipts',
  /**
   * One per conversation while a burst of its messages lasts (arrival.ts): pending, it is the burst, and later
   * messages update the notification quietly. It runs out, doing nothing, when the burst does.
   */
  burst: 'push.burst',
} as const;

/** Dedupe keys hold 200 characters: a longer moment key is hashed. */
export function pushJobKey(momentKey: string): string {
  const key = `push:${momentKey}`;
  return key.length <= 200 ? key : `push:${createHash('sha256').update(momentKey).digest('hex')}`;
}

export interface PushMoment {
  /** What makes the moment this one ("urgent:<item>:<fingerprint>", "booking:<event>"). */
  readonly key: string;
  readonly category: PushCategory;
  /** The people who should hear it: the same people as its email. Repeats and nulls are fine. */
  readonly userIds: readonly (string | null | undefined)[];
  /** Whoever did it (a person), who needs no push about it. */
  readonly exceptUserId?: string | null;
  readonly title: string;
  /** Before the business's name in the subtitle ("Text" makes "Text · Lone Star HVAC & Roofing"). */
  readonly about?: string | null;
  readonly body: string;
  /** /app/w/<business>/…, as the moment's email links. */
  readonly path: string;
  readonly refs: PushRefs;
  /** The notification it replaces, where one about the same thing may be showing (`conversation-<id>`). */
  readonly collapseId?: string | null;
  /** An update to a notification already showing: it replaces it without a sound. */
  readonly quiet?: boolean;
  /** Sent only while this conversation still waits on the same reply: nobody answered it before the push went. */
  readonly whileWaiting?: WhileWaiting | null;
}

export interface WhileWaiting {
  readonly conversationId: string;
  /** The conversation's `awaiting_reply_since` when the push was queued (ISO). */
  readonly awaitingSince: string;
}

/** The job's payload: the notice, who it is for, and what it is sent only while. */
export interface PushSendPayload extends PushNotice {
  readonly userIds: readonly string[];
  readonly whileWaiting?: WhileWaiting | null;
}

/** Of these people, the ones with this kind's switch on and at least one phone on, but never `except`. */
export async function pushAudience(
  tx: Tx,
  category: PushCategory,
  userIds: readonly (string | null | undefined)[],
  except?: string | null,
): Promise<string[]> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== except))];
  if (ids.length === 0) return [];
  const found = await rows<{ id: string }>(
    tx,
    sql`select u.id from app.users u
        where u.id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          and u.deleted_at is null
          and private.push_on(u.settings, ${PUSH_CATEGORIES[category].switch})
          and exists (select 1 from app.push_devices d where d.user_id = u.id and d.disabled_at is null)
        order by u.id`,
  );
  return found.map((r) => r.id);
}

/** Queues the push for a moment; answers how many people it is for (0: nothing was queued). */
export async function queuePush(tx: Tx, scope: TenantScope, moment: PushMoment): Promise<number> {
  const userIds = await pushAudience(tx, moment.category, moment.userIds, moment.exceptUserId);
  if (userIds.length === 0) return 0;
  const [ws] = await rows<{ name: string }>(
    tx,
    sql`select name from app.workspaces where id = ${scope.workspaceId}`,
  );
  const business = ws?.name ?? '';
  const commandIds: Partial<Record<PushButton, string>> = {};
  for (const button of commandButtonsOf(moment.category)) commandIds[button] = randomUUID();
  const payload: PushSendPayload = {
    notificationId: randomUUID(),
    category: moment.category,
    workspaceId: scope.workspaceId,
    business,
    title: clipLine(moment.title, PUSH_WORDS.title),
    subtitle:
      clipLine(
        [moment.about, business].filter((p): p is string => !!p?.trim()).join(' · '),
        PUSH_WORDS.subtitle,
      ) || null,
    body: clipLine(moment.body, PUSH_WORDS.body),
    path: moment.path,
    refs: moment.refs,
    commandIds,
    sentAt: new Date().toISOString(),
    collapseId: moment.collapseId ?? null,
    quiet: moment.quiet === true,
    userIds,
    ...(moment.whileWaiting ? { whileWaiting: moment.whileWaiting } : {}),
  };
  await scheduleJob(tx, {
    kind: PUSH_JOBS.send,
    dedupeKey: pushJobKey(moment.key),
    runAt: new Date(),
    payload: payload as unknown as Record<string, unknown>,
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
  return userIds.length;
}
