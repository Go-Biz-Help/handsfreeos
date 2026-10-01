/**
 * Sending a push, and hearing back (M10).
 *
 * `push.send`, one per moment (queue.ts). The people it is for are looked at again: the phones they have on get the
 * notice, while their switch for the kind is still on, 100 phones to a request. **A phone never gets the same push
 * twice.** Before each request its phones are written down as in flight, and after it as handed over, so a try that
 * stops partway (the worker restarting, the database dropping out) never sends to them again. Only a request Expo
 * answered with an error, which took none of it, goes again on the job's next try. A ticket that already says the
 * app is gone turns that phone off at once. A push about a customer's new message goes only while nobody has answered
 * it and the AI teammate hasn't taken the conversation (`whileWaiting`): a reply that came first ends it.
 *
 * `push.receipts`, 15 minutes after each request: what Apple and Google said. A phone the app is gone from
 * (DeviceNotRegistered) is turned off, unless it registered again after the push went; receipts not ready yet are
 * asked for again, twice at most (Expo keeps them a day). Neither job logs a token or anything a push said.
 *
 * A push to HandsFreeOS's own support people (`support_ticket`) runs the same way with no business in scope: its
 * phones, and turning off the ones the app is gone from, go through the two database functions made for it
 * (`private.staff_push_devices`, `private.turn_off_staff_push_devices`), since no business's scope can see them.
 */
import {
  isStaffPush,
  PUSH_BUTTON_IDS,
  PUSH_CATEGORIES,
  PUSH_CATEGORY_IDS,
  PushRefs,
  scheduleJob,
  type PushCategory,
} from '@hfos/core/server';
import { asWorker, rows, sql, type SystemScope, type Tx } from '@hfos/db/client';
import { z } from 'zod';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { tenantOf } from '../services';
import { messageFor, type PushNotice } from './payload';
import {
  DEVICE_GONE,
  PUSH_CHUNK,
  PushSendError,
  RECEIPT_CHUNK,
  type PushPlatform,
  type PushReceipt,
  type PushTicket,
} from './provider';
import { PUSH_JOBS } from './queue';

const MINUTE = 60_000;
/** Expo asks for receipts to be read about 15 minutes after sending. */
export const RECEIPT_DELAY_MS = 15 * MINUTE;
/** Receipts not ready yet are asked for again this much later, this many times. */
export const RECEIPT_RETRY_MS = 30 * MINUTE;
export const RECEIPT_ROUNDS = 2;

/** Which phones a try has handed the push to, and which it was handing it to when it stopped. */
const Delivery = z.object({
  handedOver: z.array(z.string()).default([]),
  inFlight: z.array(z.string()).default([]),
});
type Delivery = z.infer<typeof Delivery>;

const SendPayload = z.object({
  notificationId: z.uuid(),
  category: z.enum(PUSH_CATEGORY_IDS),
  /** Null for a push to support people. */
  workspaceId: z.uuid().nullable(),
  business: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  body: z.string(),
  path: z.string(),
  refs: PushRefs,
  commandIds: z.partialRecord(z.enum(PUSH_BUTTON_IDS), z.uuid()),
  sentAt: z.string(),
  collapseId: z.string().max(64).nullable().optional(),
  quiet: z.boolean().optional(),
  userIds: z.array(z.uuid()).max(5_000),
  whileWaiting: z
    .object({ conversationId: z.uuid(), awaitingSince: z.iso.datetime() })
    .nullable()
    .optional(),
  _delivery: Delivery.optional(),
});

const ReceiptsPayload = z.object({
  notificationId: z.uuid(),
  /** When the request went: a phone seen since then registered again, and stays on. */
  sentAt: z.iso.datetime(),
  tickets: z.array(z.object({ id: z.string().min(1).max(200), deviceId: z.uuid() })).max(5_000),
  round: z.number().int().min(0).default(0),
  /** The phones are support people's (a push about no business): turned off through their own function. */
  staff: z.boolean().optional(),
});

interface Device {
  readonly id: string;
  readonly platform: PushPlatform;
  readonly token: string;
}

/** The phones on for these people whose switch for the kind is on. */
async function liveDevices(
  tx: Tx,
  category: PushCategory,
  userIds: readonly string[],
): Promise<Device[]> {
  if (userIds.length === 0) return [];
  return rows<Device & Record<string, unknown>>(
    tx,
    sql`select d.id, d.platform::text as platform, d.expo_push_token as token
        from app.push_devices d join app.users u on u.id = d.user_id
        where d.user_id in (${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          and d.disabled_at is null and u.deleted_at is null
          and private.push_on(u.settings, ${PUSH_CATEGORIES[category].switch})
        order by d.user_id, d.created_at, d.id`,
  );
}

/** The conversation still waits on the same reply: open, not the AI teammate's, and nobody has answered it. */
async function stillWaiting(
  tx: Tx,
  w: { readonly conversationId: string; readonly awaitingSince: string },
): Promise<boolean> {
  const [c] = await rows<{ waiting: boolean }>(
    tx,
    sql`select status = 'open' and handled_by <> 'ai'
          and date_trunc('milliseconds', awaiting_reply_since) = ${w.awaitingSince}::timestamptz as waiting
        from app.conversations where id = ${w.conversationId}`,
  );
  return c?.waiting ?? false;
}

/** Phones the app is gone from: off, unless they registered again after `sentAt`. */
async function turnOffGone(tx: Tx, deviceIds: readonly string[], sentAt: Date): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const off = await rows<{ id: string }>(
    tx,
    sql`update app.push_devices set disabled_at = now(), disabled_reason = 'not_registered'
        where id in (${sql.join(
          deviceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          and disabled_at is null and last_seen_at <= ${sentAt.toISOString()}::timestamptz
        returning id`,
  );
  return off.length;
}

/** A support person's phones on, whose switch for the kind is on, while they are still an active support person. */
async function staffDevices(
  tx: Tx,
  category: PushCategory,
  userIds: readonly string[],
): Promise<Device[]> {
  if (userIds.length === 0) return [];
  return rows<Device & Record<string, unknown>>(
    tx,
    sql`select device_id as id, platform, token
        from private.staff_push_devices(${PUSH_CATEGORIES[category].switch}, array[${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])`,
  );
}

/** A support person's phones the app is gone from: off, unless they registered again after `sentAt`. */
async function turnOffStaffGone(
  tx: Tx,
  deviceIds: readonly string[],
  sentAt: Date,
): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const [r] = await rows<{ off: number }>(
    tx,
    sql`select private.turn_off_staff_push_devices(array[${sql.join(
      deviceIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}], ${sentAt.toISOString()}::timestamptz) as off`,
  );
  return Number(r?.off ?? 0);
}

/**
 * Whose phones a push goes to, and how the job reaches them: a business's people from its own scope, or HandsFreeOS's
 * support people, from none, through the functions that may look.
 */
interface Phones {
  readonly scope: SystemScope;
  readonly find: (tx: Tx, category: PushCategory, userIds: readonly string[]) => Promise<Device[]>;
  readonly turnOff: (tx: Tx, deviceIds: readonly string[], sentAt: Date) => Promise<number>;
}

function phonesFor(staff: boolean, jobScope: SystemScope): Phones {
  return staff
    ? { scope: {}, find: staffDevices, turnOff: turnOffStaffGone }
    : { scope: tenantOf(jobScope), find: liveDevices, turnOff: turnOffGone };
}

const writeDelivery = (tx: Tx, jobId: string, delivery: Delivery) =>
  tx.execute(
    sql`update app.scheduled_jobs
        set payload = jsonb_set(payload, '{_delivery}', ${JSON.stringify(delivery)}::jsonb)
        where id = ${jobId}`,
  );

/** Counts of each error word, for a log line that says what went wrong without saying to whom. */
const tally = (errors: readonly string[]) =>
  errors.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e]: (acc[e] ?? 0) + 1 }), {});

export const pushSendJob: JobHandler = async (ctx) => {
  const parsed = SendPayload.safeParse(ctx.job.payload);
  if (!parsed.success) {
    ctx.log.warn({ issues: parsed.error.issues.length }, 'a push job could not be read; not sent');
    return;
  }
  const p = parsed.data;
  const provider = ctx.push.provider;
  if (!provider) {
    ctx.log.info(
      { notificationId: p.notificationId },
      'push is off (no Expo access token); not sent',
    );
    return;
  }
  const staff = isStaffPush(p.category);
  if (staff !== (p.workspaceId === null)) {
    ctx.log.warn(
      { notificationId: p.notificationId, category: p.category },
      'a push job’s business doesn’t fit its kind; not sent',
    );
    return;
  }
  const phones = phonesFor(staff, ctx.scope);
  const { scope } = phones;
  const waiting = p.whileWaiting;
  if (waiting && !(await asWorker(ctx.db, scope, (tx) => stillWaiting(tx, waiting)))) {
    ctx.log.debug({ notificationId: p.notificationId }, 'answered before its push went; not sent');
    return;
  }
  // A try that stopped partway: whatever was in flight may have gone, so it counts as handed over.
  const handedOver = [...(p._delivery?.handedOver ?? []), ...(p._delivery?.inFlight ?? [])];
  const done = new Set(handedOver);
  const devices = (
    await asWorker(ctx.db, scope, (tx) => phones.find(tx, p.category, p.userIds))
  ).filter((d) => !done.has(d.id));
  const notice: PushNotice = p;
  for (let i = 0; i < devices.length; i += PUSH_CHUNK) {
    const chunk = devices.slice(i, i + PUSH_CHUNK);
    const ids = chunk.map((d) => d.id);
    // The database's clock, as a phone's last_seen_at is: registering again after this keeps a phone on.
    const startedAt = await asWorker(ctx.db, {}, async (tx) => {
      await writeDelivery(tx, ctx.job.id, { handedOver, inFlight: ids });
      const [clock] = await rows<{ now: Date | string }>(tx, sql`select now() as now`);
      return new Date(clock!.now);
    });
    let tickets: PushTicket[];
    try {
      tickets = await provider.send(chunk.map((d) => messageFor(d, notice)));
    } catch (e) {
      if (e instanceof PushSendError && e.refused) {
        // Expo took none of it: these phones get it on the job's next try.
        await asWorker(ctx.db, {}, (tx) =>
          writeDelivery(tx, ctx.job.id, { handedOver, inFlight: [] }),
        );
        throw e;
      }
      // It may have gone: never twice, so these phones are done with.
      handedOver.push(...ids);
      await asWorker(ctx.db, {}, (tx) =>
        writeDelivery(tx, ctx.job.id, { handedOver, inFlight: [] }),
      );
      ctx.log.warn(
        { err: errorMessage(e), notificationId: p.notificationId, phones: ids.length },
        'a push may not have reached Expo; it is not sent again',
      );
      continue;
    }
    handedOver.push(...ids);
    const accepted: { id: string; deviceId: string }[] = [];
    const gone: string[] = [];
    const refused: string[] = [];
    tickets.forEach((t, k) => {
      const device = chunk[k];
      if (!device) return;
      if (t.status === 'ok') accepted.push({ id: t.id, deviceId: device.id });
      else if (t.error === DEVICE_GONE) gone.push(device.id);
      else refused.push(t.error ?? 'unknown');
    });
    const turnedOff = await asWorker(ctx.db, scope, async (tx) => {
      await writeDelivery(tx, ctx.job.id, { handedOver, inFlight: [] });
      if (accepted.length > 0)
        await scheduleJob(tx, {
          kind: PUSH_JOBS.receipts,
          dedupeKey: `push-receipts:${accepted[0]!.id}`,
          runAt: new Date(Date.now() + RECEIPT_DELAY_MS),
          payload: {
            notificationId: p.notificationId,
            sentAt: startedAt.toISOString(),
            tickets: accepted,
            round: 0,
            ...(staff ? { staff: true } : {}),
          },
          workspaceId: scope.workspaceId ?? null,
          organizationId: scope.organizationId ?? null,
        });
      return phones.turnOff(tx, gone, startedAt);
    });
    if (turnedOff > 0)
      ctx.log.info(
        { notificationId: p.notificationId, turnedOff },
        'phones the app is gone from turned off',
      );
    if (refused.length > 0)
      ctx.log[refused.includes('InvalidCredentials') ? 'error' : 'warn'](
        { notificationId: p.notificationId, errors: tally(refused) },
        'Expo refused some pushes',
      );
  }
  if (devices.length > 0)
    ctx.log.info(
      { notificationId: p.notificationId, category: p.category, phones: devices.length },
      'push sent',
    );
};

export const pushReceiptsJob: JobHandler = async (ctx) => {
  const parsed = ReceiptsPayload.safeParse(ctx.job.payload);
  if (!parsed.success) {
    ctx.log.warn({ issues: parsed.error.issues.length }, 'a push receipt job could not be read');
    return;
  }
  const provider = ctx.push.provider;
  if (!provider) return;
  const p = parsed.data;
  const phones = phonesFor(p.staff === true, ctx.scope);
  const receipts: Record<string, PushReceipt> = {};
  for (let i = 0; i < p.tickets.length; i += RECEIPT_CHUNK)
    Object.assign(
      receipts,
      await provider.receipts(p.tickets.slice(i, i + RECEIPT_CHUNK).map((t) => t.id)),
    );
  const gone: string[] = [];
  const refused: string[] = [];
  const waiting: { id: string; deviceId: string }[] = [];
  for (const t of p.tickets) {
    const r = receipts[t.id];
    if (!r) waiting.push(t);
    else if (r.status === 'error') {
      if (r.error === DEVICE_GONE) gone.push(t.deviceId);
      else refused.push(r.error ?? 'unknown');
    }
  }
  const turnedOff = await asWorker(ctx.db, phones.scope, (tx) =>
    phones.turnOff(tx, gone, new Date(p.sentAt)),
  );
  if (turnedOff > 0)
    ctx.log.info(
      { notificationId: p.notificationId, turnedOff },
      'phones the app is gone from turned off',
    );
  if (refused.length > 0)
    ctx.log[refused.includes('InvalidCredentials') ? 'error' : 'warn'](
      { notificationId: p.notificationId, errors: tally(refused) },
      'Apple or Google refused some pushes',
    );
  if (waiting.length > 0 && p.round < RECEIPT_ROUNDS) {
    await asWorker(ctx.db, {}, (tx) =>
      tx.execute(
        sql`update app.scheduled_jobs
            set payload = ${JSON.stringify({ ...p, tickets: waiting, round: p.round + 1 })}::jsonb
            where id = ${ctx.job.id}`,
      ),
    );
    return { rescheduleAt: new Date(Date.now() + RECEIPT_RETRY_MS) };
  }
};

/** Job kind → handler, for scheduled.ts's jobs map. A burst's job has nothing to do when it runs out. */
export const pushJobs: JobMap = {
  [PUSH_JOBS.send]: pushSendJob,
  [PUSH_JOBS.receipts]: pushReceiptsJob,
  [PUSH_JOBS.burst]: async () => {},
};
