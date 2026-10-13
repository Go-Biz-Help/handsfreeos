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
 *
 * **HandsFreeOS's own support people** hear about a new support ticket (`queueStaffPush`). That push belongs to no
 * business: its job has no workspace, and its people are every active support person with the kind's switch and a
 * phone on (`private.staff_push_devices`), which the worker can't see from any business's scope.
 *
 * **A person's own moments** (`queuePersonalPush`): a sign-in to the extension with their email. About no business
 * either, and to that one person's phones alone (`private.own_push_devices`), with no switch: only they asked for it.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  clipLine,
  commandButtonsOf,
  isPersonalPush,
  isStaffPush,
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
  /** /app/w/<business>/…, as the moment's email links (a push to support people: /admin/…). */
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
  if (isStaffPush(moment.category))
    throw new Error(`a ${moment.category} push is for support people: queueStaffPush sends it`);
  if (isPersonalPush(moment.category))
    throw new Error(`a ${moment.category} push is the person's own: queuePersonalPush sends it`);
  const userIds = await pushAudience(tx, moment.category, moment.userIds, moment.exceptUserId);
  if (userIds.length === 0) return 0;
  const [ws] = await rows<{ name: string }>(
    tx,
    sql`select name from app.workspaces where id = ${scope.workspaceId}`,
  );
  await schedulePush(tx, moment, userIds, { ...scope, business: ws?.name ?? '' });
  return userIds.length;
}

/** A moment for HandsFreeOS's own support people: about no business, so it names nobody to tell. */
export type StaffPushMoment = Omit<PushMoment, 'userIds' | 'whileWaiting'>;

/**
 * HandsFreeOS's support people with this kind's switch and at least one phone on, but never `except` (a support
 * person who wrote in themselves).
 */
export async function staffPushAudience(
  tx: Tx,
  category: PushCategory,
  except?: string | null,
): Promise<string[]> {
  const found = await rows<{ user_id: string }>(
    tx,
    sql`select distinct user_id from private.staff_push_devices(${PUSH_CATEGORIES[category].switch})
        order by user_id`,
  );
  return found.map((r) => r.user_id).filter((id) => id !== except);
}

/**
 * Queues a push to HandsFreeOS's support people (`support_ticket`), with no business: the job has none, and its
 * subtitle is `about` alone. Answers how many people it is for (0: nothing was queued).
 */
export async function queueStaffPush(tx: Tx, moment: StaffPushMoment): Promise<number> {
  if (!isStaffPush(moment.category))
    throw new Error(`a ${moment.category} push is about a business: queuePush sends it`);
  const userIds = await staffPushAudience(tx, moment.category, moment.exceptUserId);
  if (userIds.length === 0) return 0;
  await schedulePush(tx, moment, userIds, {
    workspaceId: null,
    organizationId: null,
    business: '',
  });
  return userIds.length;
}

/** A moment about one person themselves, about no business: whose phones it goes to. */
export type PersonalPushMoment = Omit<PushMoment, 'userIds' | 'whileWaiting' | 'exceptUserId'> & {
  readonly userId: string;
};

/**
 * Queues a push to one person's own phones (`extension_sign_in`), with no business. Answers how many people it is for
 * (0: they have no phone on, and nothing was queued).
 */
export async function queuePersonalPush(tx: Tx, moment: PersonalPushMoment): Promise<number> {
  if (!isPersonalPush(moment.category))
    throw new Error(`a ${moment.category} push is not a personal one`);
  const found = await rows<{ user_id: string }>(
    tx,
    sql`select distinct user_id from private.own_push_devices(array[${moment.userId}::uuid])`,
  );
  if (found.length === 0) return 0;
  await schedulePush(tx, moment, [moment.userId], {
    workspaceId: null,
    organizationId: null,
    business: '',
  });
  return 1;
}

/** The send job for a moment: one notice, one notification id and a command id per button, for everyone on it. */
async function schedulePush(
  tx: Tx,
  moment: Omit<PushMoment, 'userIds'>,
  userIds: readonly string[],
  where: {
    readonly workspaceId: string | null;
    readonly organizationId: string | null;
    readonly business: string;
  },
): Promise<void> {
  const { business } = where;
  const commandIds: Partial<Record<PushButton, string>> = {};
  for (const button of commandButtonsOf(moment.category)) commandIds[button] = randomUUID();
  const payload: PushSendPayload = {
    notificationId: randomUUID(),
    category: moment.category,
    workspaceId: where.workspaceId,
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
    workspaceId: where.workspaceId,
    organizationId: where.organizationId,
  });
}
