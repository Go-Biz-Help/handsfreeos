/** Server-side messaging helpers shared by the commands and queries (numbers, readiness, conversations, jobs). */
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { sql, type Tx } from '@hfos/db/client';
import {
  conversations,
  optOuts,
  people,
  phoneNumbers,
  telephonyRegistrations,
  workspaces,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import type { CommandContext } from '../kernel/types';
import {
  DEFAULT_TELEPHONY_SETTINGS,
  TelephonySettings,
  type PhoneNextStep,
  type RegistrationFamily,
} from '../schemas/telephony';
import type { RegistrationKind } from '@hfos/db/schema';

/**
 * The two meanings `LIVE_NUMBER_STATUSES` used to carry at once, separated (M17).
 *
 * They looked like one idea while a number could only ever be bought. `porting` broke that: a number on its
 * way to us from another carrier **is claimed** — no other business may take it, it shows in Settings, it can
 * be named and assigned — and **cannot send a thing** until the carrier actually moves it. One list could not
 * be both, and whichever meaning it kept would have been wrong somewhere: claimed-only would let a default be
 * set on a number that sends nothing, sendable-only would let two businesses port the same number in.
 */
export const CLAIMED_STATUSES = ['provisioning', 'porting', 'active', 'releasing'] as const;

/** What a number has to be for anything to actually go out from it. */
export const SENDABLE_STATUSES = ['provisioning', 'active', 'releasing'] as const;

/** @deprecated Say which you mean: `SENDABLE_STATUSES` or `CLAIMED_STATUSES`. */
export const LIVE_NUMBER_STATUSES = SENDABLE_STATUSES;

export const FAMILY_KINDS: Record<RegistrationFamily, readonly RegistrationKind[]> = {
  toll_free_verification: ['toll_free_verification'],
  a2p_10dlc: ['a2p_customer_profile', 'a2p_trust_product', 'a2p_brand', 'a2p_campaign'],
};
export const familyFor = (numberType: string): RegistrationFamily =>
  numberType === 'toll_free' ? 'toll_free_verification' : 'a2p_10dlc';

/**
 * The number a business sends from when nothing more specific applies (M17).
 *
 * This is what `liveNumber` used to be, with one clause added, and the clause is the whole compatibility
 * story: ordering by
 * `is_default` first and then by the same `created_at desc` it always used means a business with one number
 * gets exactly the row it got before. A business with several gets the one it picked.
 *
 * It is the fallback, not the answer. A conversation that already knows its own number uses that
 * (`conversationNumber`); this is for a thread that has not started yet.
 */
export async function defaultNumber(tx: Tx, workspaceId: string) {
  const [n] = await tx
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.workspaceId, workspaceId),
        inArray(phoneNumbers.status, [...SENDABLE_STATUSES]),
      ),
    )
    .orderBy(desc(phoneNumbers.isDefault), desc(phoneNumbers.createdAt))
    .limit(1);
  return n ?? null;
}

/**
 * The number a conversation belongs to, which is the one the customer has been writing to.
 *
 * **This is the fix for the split-thread problem.** A customer who texted the dispatch line and gets a reply
 * from the front-desk line sees two threads on their phone and no longer knows which one to use — and the
 * business sees one thread while the customer sees two. So a conversation is glued to the number it arrived
 * on, whoever types the reply.
 *
 * Falls back to the workspace default when the conversation has no number (threads created before this
 * shipped) or when the number it had has since been released. Never throws: failing a text because somebody
 * released a number a month ago would be worse than sending it from the number that replaced it.
 */
export async function conversationNumber(
  tx: Tx,
  workspaceId: string,
  phoneNumberId: string | null,
) {
  if (phoneNumberId) {
    const [n] = await tx
      .select()
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.id, phoneNumberId),
          eq(phoneNumbers.workspaceId, workspaceId),
          inArray(phoneNumbers.status, [...SENDABLE_STATUSES]),
        ),
      )
      .limit(1);
    if (n) return n;
  }
  return defaultNumber(tx, workspaceId);
}

/**
 * A business's own number, found by the e164 a call or message is actually on.
 *
 * The workspace check is the point: it says "this number is ours and it is live", which is what a caller
 * comparing `number.e164` to a call's `from` was really asking. Comparing against the *default* was only ever
 * right while a business could have one number.
 */
export async function numberByE164(tx: Tx, workspaceId: string, e164: string) {
  const [n] = await tx
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.workspaceId, workspaceId),
        eq(phoneNumbers.e164, e164),
        inArray(phoneNumbers.status, [...SENDABLE_STATUSES]),
      ),
    )
    .limit(1);
  return n ?? null;
}

/** Every number a business has that is not released, its default first. For Settings, and for pickers. */
export async function numbersOf(tx: Tx, workspaceId: string) {
  return tx
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), ne(phoneNumbers.status, 'released')))
    .orderBy(desc(phoneNumbers.isDefault), desc(phoneNumbers.createdAt));
}

/**
 * How many numbers a business is holding. Used by the purchase cap: dropping the one-per-workspace index
 * removed the only thing standing between a stuck retry and forty numbers on somebody's card.
 *
 * **Claimed, not sendable.** A number on its way to us from another carrier is one this business has said it
 * wants and nobody else can take — counting only what can send today would let a business with ten ports in
 * flight buy ten more numbers, and end the month with twenty.
 */
export async function liveNumberCount(tx: Tx, workspaceId: string): Promise<number> {
  const found = await tx
    .select({ id: phoneNumbers.id })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.workspaceId, workspaceId),
        inArray(phoneNumbers.status, [...CLAIMED_STATUSES]),
      ),
    );
  return found.length;
}

/** No business needs more than this, and a runaway purchase loop needs a ceiling. */
export const MAX_NUMBERS_PER_WORKSPACE = 10;

/** The newest number that is not released (a failed purchase shows its error until someone retries). */
export async function currentNumber(tx: Tx, workspaceId: string) {
  const [n] = await tx
    .select()
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), ne(phoneNumbers.status, 'released')))
    .orderBy(desc(phoneNumbers.createdAt))
    .limit(1);
  return n ?? null;
}

export async function loadRegistrations(tx: Tx, workspaceId: string) {
  return tx
    .select()
    .from(telephonyRegistrations)
    .where(eq(telephonyRegistrations.workspaceId, workspaceId))
    .orderBy(asc(telephonyRegistrations.createdAt));
}

/** The newest row per registration kind. */
export function latestByKind<T extends { kind: string }>(regs: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of regs) map.set(r.kind, r);
  return map;
}

/**
 * Whether the carrier has this registration's current details: sent, and not sent again by people since. A row
 * waiting in `submitted` without them is still the worker's to send, and people may still change it.
 */
/**
 * Whether the carrier has *this* version of a port: sent, and not sent again by people since.
 *
 * The twin of `carrierHasDetails`, and needed for the same reason. A person cannot clear `provider_sid` — the
 * port guard forbids it on every transition, Send included — so a port the carrier turned down still carries
 * the dead request's reference. Without this the worker sees a sid, believes the carrier already has it, and
 * the corrected account number never leaves the building.
 */
export function carrierHasPort(port: {
  providerSid: string | null;
  submittedAt: Date | null;
  carrierSubmittedAt: Date | null;
}): boolean {
  return (
    !!port.providerSid &&
    (port.carrierSubmittedAt?.getTime() ?? null) === (port.submittedAt?.getTime() ?? null)
  );
}

export function carrierHasDetails(reg: {
  providerSid: string | null;
  submittedAt: Date | null;
  carrierSubmittedAt: Date | null;
}): boolean {
  return (
    !!reg.providerSid &&
    (reg.carrierSubmittedAt?.getTime() ?? null) === (reg.submittedAt?.getTime() ?? null)
  );
}

export interface Readiness {
  readonly voiceReady: boolean;
  readonly messagingReady: boolean;
  readonly nextStep: PhoneNextStep;
}

/** Voice works once the number is active; texting also needs the carrier registration approved. */
export function readiness(
  number: { status: string; numberType: string } | null,
  regs: readonly { kind: string; status: string }[],
): Readiness {
  if (!number || number.status === 'failed' || number.status === 'released')
    return { voiceReady: false, messagingReady: false, nextStep: 'buy_number' };
  if (number.status === 'provisioning')
    return { voiceReady: false, messagingReady: false, nextStep: 'provisioning' };
  // The same shape as provisioning — claimed, nothing working yet — but the wait is the losing carrier's and
  // is measured in weeks, so the screen says something different while it happens.
  if (number.status === 'porting')
    return { voiceReady: false, messagingReady: false, nextStep: 'porting' };
  if (number.status === 'releasing')
    return { voiceReady: false, messagingReady: false, nextStep: 'releasing' };
  const kinds = FAMILY_KINDS[familyFor(number.numberType)];
  const latest = latestByKind(regs.filter((r) => (kinds as readonly string[]).includes(r.kind)));
  const chain = kinds.map((k) => latest.get(k)).filter((r) => r !== undefined);
  if (chain.length === 0 || chain.every((r) => r.status === 'draft'))
    return { voiceReady: true, messagingReady: false, nextStep: 'submit_registration' };
  if (chain.some((r) => r.status === 'rejected' || r.status === 'failed'))
    return { voiceReady: true, messagingReady: false, nextStep: 'rejected' };
  if (chain.length === kinds.length && chain.every((r) => r.status === 'approved'))
    return { voiceReady: true, messagingReady: true, nextStep: 'ready' };
  return { voiceReady: true, messagingReady: false, nextStep: 'awaiting_approval' };
}

export interface WorkspaceMessaging {
  readonly name: string;
  readonly timezone: string;
  readonly organizationId: string;
  readonly settings: TelephonySettings;
  readonly rawSettings: Record<string, unknown>;
}

/** Time zone, name and texting settings (defaults filled in) for one workspace. */
export async function workspaceMessaging(tx: Tx, workspaceId: string): Promise<WorkspaceMessaging> {
  const [ws] = await tx
    .select({
      name: workspaces.name,
      timezone: workspaces.timezone,
      organizationId: workspaces.organizationId,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw HfosError.notFound('Workspace not found.');
  const raw = (ws.settings ?? {}) as Record<string, unknown>;
  const parsed = TelephonySettings.partial().safeParse(raw['telephony'] ?? {});
  const stored = parsed.success ? parsed.data : {};
  return {
    name: ws.name,
    timezone: ws.timezone,
    organizationId: ws.organizationId,
    rawSettings: raw,
    settings: {
      quietHours: stored.quietHours ?? DEFAULT_TELEPHONY_SETTINGS.quietHours,
      unansweredReminderMinutes:
        stored.unansweredReminderMinutes ?? DEFAULT_TELEPHONY_SETTINGS.unansweredReminderMinutes,
    },
  };
}

export async function isOptedOut(tx: Tx, workspaceId: string, e164: string): Promise<boolean> {
  const [row] = await tx
    .select({ optedOut: optOuts.optedOut })
    .from(optOuts)
    .where(and(eq(optOuts.workspaceId, workspaceId), eq(optOuts.counterpartE164, e164)));
  return row?.optedOut ?? false;
}

/** The customer with this number (the most recently touched one when several share it). */
export async function matchPersonByPhone(
  tx: Tx,
  workspaceId: string,
  e164: string,
): Promise<string | null> {
  const [p] = await tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        eq(people.phoneE164, e164),
        isNull(people.archivedAt),
      ),
    )
    .orderBy(desc(people.updatedAt))
    .limit(1);
  return p?.id ?? null;
}

export async function loadConversation(ctx: CommandContext, conversationId: string) {
  const [c] = await ctx.tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  if (!c) throw HfosError.notFound('Conversation not found.');
  return c;
}

/**
 * The customer's most recent thread on a channel, whichever of the business's lines it is on (0089).
 *
 * One ordering rule in one place, because several things now turn on "which lane?" — where a workflow's text
 * goes, which thread the call bridge dials into, which email thread a text thread offers to switch to — and
 * they must all pick the same one or the customer gets answered in two places at once.
 *
 * Null when this customer has never written on this channel.
 */
export async function latestConversation(
  tx: Tx,
  workspaceId: string,
  channel: 'sms' | 'email',
  counterpart: string,
) {
  const [c] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.channel, channel),
        eq(conversations.counterpart, counterpart),
      ),
    )
    // Nulls last: a thread that has never carried a message is the weakest answer, not the strongest.
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.createdAt))
    .limit(1);
  return c ?? null;
}

/**
 * The line a message should start on when the caller has not named one (0089).
 *
 * A customer who already has a thread is answered on the line of whichever of their threads spoke most
 * recently, so a workflow, a booking confirmation or the AI teammate writes where the customer has actually
 * been talking rather than on whatever the business happens to call its default. Only a customer nobody has
 * ever written to falls through to the default line, which is what every outbound path did before threads had
 * lines at all — so a business with one number gets the row it got yesterday, every time.
 *
 * Returns null when this customer has no thread on this channel; the caller then picks the default itself,
 * because what "default" means differs by channel (`defaultNumber` vs `pickFromAddress`).
 */
export async function preferredLane(
  tx: Tx,
  workspaceId: string,
  channel: 'sms' | 'email',
  counterpart: string,
): Promise<{ phoneNumberId: string | null; emailAddressId: string | null } | null> {
  const c = await latestConversation(tx, workspaceId, channel, counterpart);
  return c ? { phoneNumberId: c.phoneNumberId, emailAddressId: c.emailAddressId } : null;
}

/**
 * One conversation per customer per line of the business (0089): returns the existing one or starts it.
 *
 * The line is the business's own end of the thread — the number a text came in on, the address a mail was
 * sent to — and it is half of the key, because a customer who texts the dispatch line after texting the front
 * desk is starting a second conversation, not adding to the first. Before this they shared one thread and the
 * reply went out from whichever line came first, which is the split-thread problem seen from the business's
 * side instead of the customer's.
 *
 * **A thread with no line takes the first one offered rather than sitting beside a new one.** Threads made
 * before lines existed, and threads belonging to a business that had nothing to send from when they started,
 * have no line to be keyed on. Left alone they would each fork the first time anybody wrote to them, and
 * every business would find its inbox doubled on the morning this shipped. Adoption is what makes 0089
 * invisible to a business with one number, and it is the property to defend in review.
 */
export async function findOrCreateConversation(
  ctx: CommandContext,
  input: {
    channel: 'sms' | 'email';
    counterpart: string;
    personId: string | null;
    phoneNumberId: string | null;
    emailAddressId?: string | null;
  },
) {
  const workspaceId = ctx.scope.workspaceId!;
  const mail = input.channel === 'email';
  const column = mail ? conversations.emailAddressId : conversations.phoneNumberId;
  const lineId = (mail ? input.emailAddressId : input.phoneNumberId) ?? null;
  const lineValue = (id: string) => (mail ? { emailAddressId: id } : { phoneNumberId: id });
  const sameCustomer = and(
    eq(conversations.workspaceId, workspaceId),
    eq(conversations.channel, input.channel),
    eq(conversations.counterpart, input.counterpart),
  );
  const find = () =>
    ctx.tx
      .select()
      .from(conversations)
      .where(and(sameCustomer, lineId ? eq(column, lineId) : isNull(column)));
  const [existing] = await find();
  if (existing) return { conversation: existing, created: false };
  if (lineId) {
    const [lineless] = await ctx.tx
      .select()
      .from(conversations)
      .where(and(sameCustomer, isNull(column)))
      .limit(1);
    if (lineless) {
      const [adopted] = await ctx.tx
        .update(conversations)
        .set(lineValue(lineId))
        .where(eq(conversations.id, lineless.id))
        .returning();
      if (adopted) return { conversation: adopted, created: false };
    }
  }
  const inserted = await ctx.tx
    .insert(conversations)
    .values({
      workspaceId,
      channel: input.channel,
      counterpart: input.counterpart,
      personId: input.personId,
      phoneNumberId: mail ? null : lineId,
      emailAddressId: mail ? lineId : null,
      createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { conversation: inserted[0], created: true };
  const [raced] = await find();
  if (!raced) throw HfosError.forbidden();
  return { conversation: raced, created: false };
}

/**
 * Queues delayed work. A pending job with the same kind and key wins (the first reminder time stands), unless
 * `pullEarlier` is set: then the pending job keeps whichever time is sooner, so a reminder re-armed for an
 * earlier start moves up. Jobs re-read their state when they run, so running early only makes them wait again.
 *
 * A job that is running right now (locked, and already due) can't move earlier, and its runner would write the
 * handler's own next time over it when it finishes. So a pull-earlier then is remembered as `_wakeAt` in the
 * payload, and the runner (apps/worker/src/jobs.ts) never leaves the job later than that.
 */
export async function scheduleJob(
  tx: Tx,
  job: {
    kind: string;
    dedupeKey: string | null;
    runAt: Date;
    payload: Record<string, unknown>;
    workspaceId: string | null;
    organizationId: string | null;
  },
  opts: { readonly pullEarlier?: boolean } = {},
): Promise<void> {
  const onConflict = opts.pullEarlier
    ? sql`do update set run_at = least(app.scheduled_jobs.run_at, excluded.run_at),
          payload = case when app.scheduled_jobs.locked_at is not null and app.scheduled_jobs.run_at <= now()
            then app.scheduled_jobs.payload || jsonb_build_object('_wakeAt', least(
              coalesce((app.scheduled_jobs.payload ->> '_wakeAt')::timestamptz, excluded.run_at), excluded.run_at))
            else app.scheduled_jobs.payload end`
    : sql`do nothing`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${job.organizationId}, ${job.workspaceId}, ${job.kind}, ${job.dedupeKey}, ${job.runAt.toISOString()}::timestamptz, ${JSON.stringify(job.payload)}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null ${onConflict}`,
  );
}

/** Whether a user can work this workspace (a direct member, or an owner or admin of its organization). */
export async function isWorkspaceUser(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const found = await tx.execute(
    sql`select 1 from app.workspace_memberships wm where wm.workspace_id = ${workspaceId} and wm.user_id = ${userId}
        union all
        select 1 from app.organization_memberships om join app.workspaces w on w.organization_id = om.organization_id
        where w.id = ${workspaceId} and om.user_id = ${userId}
        limit 1`,
  );
  return Array.from(found as unknown as Iterable<unknown>).length > 0;
}
