/**
 * My cell phone (M10): the number HandsFreeOS rings when a person presses Call in the app, then connects the
 * customer from the business number. A cell is confirmed by the same kind of call: HandsFreeOS calls it from one
 * of the person's business numbers ("This is HandsFreeOS confirming this is your phone. Press 1."), and pressing 1
 * marks it verified. People set their own number (app.user_phones); only the worker verifies. Each request is
 * limited (VERIFY_CALLS_PER_HOUR, VERIFY_CALLS_PER_DAY), counted from the requests the person made (their own
 * events), so removing and adding the number again doesn't reset it.
 */
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { phoneNumbers, userPhones } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { waitInWords } from '../kernel/app-request';
import { defineCommand } from '../kernel/define';
import { defaultNumber } from '../messaging/store';
import {
  UserPhoneRecordCallInput,
  UserPhoneRefOutput,
  UserPhoneStartVerificationInput,
  UserPhoneStartVerificationOutput,
  UserPhoneVerifyInput,
} from '../schemas/user-phone';

/** Verification calls a person may ask for in an hour, and in a day. */
export const VERIFY_CALLS_PER_HOUR = 3;
export const VERIFY_CALLS_PER_DAY = 6;
/** Pressing Verify again this soon after, for the same number, is the call already on its way. */
const REPEAT_MS = 45_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const userPhoneStartVerification = defineCommand({
  name: 'user_phone.start_verification',
  description:
    'Set your own cell phone. HandsFreeOS calls it from the business number, and pressing 1 on that call confirms it’s yours. A different number takes the place of the one before, which is no longer verified.',
  risk: 1,
  input: UserPhoneStartVerificationInput,
  output: UserPhoneStartVerificationOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['user_phone.verification_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const workspaceId = ctx.scope.workspaceId!;
    const number = await defaultNumber(ctx.tx, workspaceId);
    if (!number || number.status !== 'active')
      throw HfosError.rule(
        'no_number',
        409,
        'This business needs a number before HandsFreeOS can call your cell.',
      );
    const [business] = await ctx.tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, input.phone)))
      .limit(1);
    if (business)
      throw HfosError.validation([
        { path: 'phone', message: 'That’s a business number. Enter your own cell.' },
      ]);

    const mine = await ctx.tx.select().from(userPhones).where(eq(userPhones.userId, me));
    const same = mine.find((p) => p.e164 === input.phone);
    if (same?.verifiedAt)
      return {
        userPhoneId: same.id,
        e164: same.e164,
        status: 'verified' as const,
        callerId: number.e164,
      };

    const [asked] = await rows<{
      hour: number;
      day: number;
      latest_at: Date | null;
      latest_phone: string | null;
      oldest_hour: Date | null;
      oldest_day: Date | null;
    }>(
      ctx.tx,
      sql`select count(*) filter (where created_at > now() - interval '1 hour')::int as hour,
            count(*)::int as day,
            max(created_at) as latest_at,
            (array_agg(entity_id order by created_at desc))[1] as latest_phone,
            min(created_at) filter (where created_at > now() - interval '1 hour') as oldest_hour,
            min(created_at) as oldest_day
          from app.events
          where actor_id = ${me} and event_type = 'user_phone.verification_requested'
            and created_at > now() - interval '1 day'`,
    );
    if (
      same &&
      asked?.latest_at &&
      asked.latest_phone === same.id &&
      Date.now() - new Date(asked.latest_at).getTime() < REPEAT_MS
    )
      return {
        userPhoneId: same.id,
        e164: same.e164,
        status: 'calling' as const,
        callerId: number.e164,
      };
    const refuse = (count: number, oldest: Date | null, spanMs: number, span: string) => {
      const retryAt = new Date(new Date(oldest ?? Date.now()).getTime() + spanMs);
      return new HfosError(
        'rule_violation',
        409,
        `You’ve asked for ${count} verification calls in the last ${span}. Try again in ${waitInWords(retryAt.getTime() - Date.now())}.`,
        { retryAfter: retryAt.toISOString() },
        'verification_limit',
      );
    };
    if ((asked?.hour ?? 0) >= VERIFY_CALLS_PER_HOUR)
      throw refuse(asked!.hour, asked!.oldest_hour, HOUR, 'hour');
    if ((asked?.day ?? 0) >= VERIFY_CALLS_PER_DAY)
      throw refuse(asked!.day, asked!.oldest_day, DAY, '24 hours');

    // A different number takes the place of the one before, verified or not.
    const others = mine.filter((p) => p.e164 !== input.phone).map((p) => p.id);
    if (others.length)
      await ctx.tx
        .delete(userPhones)
        .where(and(eq(userPhones.userId, me), inArray(userPhones.id, others)));
    let row = same;
    if (!row) {
      [row] = await ctx.tx
        .insert(userPhones)
        .values({ userId: me, e164: input.phone })
        .onConflictDoNothing()
        .returning();
      row ??= (
        await ctx.tx
          .select()
          .from(userPhones)
          .where(and(eq(userPhones.userId, me), eq(userPhones.e164, input.phone)))
      )[0];
    }
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'user_phone.verification_requested',
      entityType: 'user_phone',
      entityId: row.id,
      payload: { userPhoneId: row.id, userId: me },
    });
    return {
      userPhoneId: row.id,
      e164: row.e164,
      status: 'calling' as const,
      callerId: number.e164,
    };
  },
});

export const userPhoneRecordCall = defineCommand({
  name: 'user_phone.record_call',
  description:
    'Worker: HandsFreeOS placed a verification call to someone’s cell. Its count and time are kept with the number.',
  risk: 0,
  input: UserPhoneRecordCallInput,
  output: UserPhoneRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(userPhones)
      .set({
        verificationCount: sql`least(${userPhones.verificationCount} + 1, 1000)`,
        // The database's clock, like the request event's time the worker compares it with (the worker's own clock
        // can be a little behind the database's, and a retried event would then call again).
        lastVerificationAt: sql`now()`,
      })
      .where(eq(userPhones.id, input.userPhoneId))
      .returning({ id: userPhones.id });
    if (!row) throw HfosError.notFound('That cell isn’t set any more.');
    return { userPhoneId: row.id, changed: true };
  },
});

export const userPhoneVerify = defineCommand({
  name: 'user_phone.verify',
  description:
    'Worker: someone pressed 1 on the call to their cell. It is their verified cell from now on, in place of any other.',
  risk: 1,
  input: UserPhoneVerifyInput,
  output: UserPhoneRefOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['user_phone.verified'],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select()
      .from(userPhones)
      .where(eq(userPhones.id, input.userPhoneId))
      .for('update');
    if (!row) throw HfosError.notFound('That cell isn’t set any more.');
    if (row.verifiedAt) return { userPhoneId: row.id, changed: false };
    // One verified cell per person: this one takes the place of any other.
    await ctx.tx
      .update(userPhones)
      .set({ verifiedAt: null })
      .where(
        and(
          eq(userPhones.userId, row.userId),
          ne(userPhones.id, row.id),
          isNotNull(userPhones.verifiedAt),
        ),
      );
    await ctx.tx
      .update(userPhones)
      .set({ verifiedAt: new Date() })
      .where(eq(userPhones.id, row.id));
    await ctx.emit({
      type: 'user_phone.verified',
      entityType: 'user_phone',
      entityId: row.id,
      payload: { userPhoneId: row.id, userId: row.userId },
    });
    return { userPhoneId: row.id, changed: true };
  },
});
