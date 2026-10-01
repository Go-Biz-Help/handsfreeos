import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  carrierHasDetails,
  executeCommand,
  FAMILY_KINDS,
  familyFor,
  formatPhone,
  latestByKind,
  conversationNumber,
  currentRcsSender,
  defaultNumber,
  numbersOf,
  messagePreview,
  messageUpdateStatus,
  phoneNumberActivate,
  phoneNumberFail,
  phoneNumberMarkReleased,
  rcsSending,
  registrationUpdateStatus,
  scheduleJob,
  WALLET_REFUSALS,
  walletRoom,
  type RegistrationFamily,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  activities,
  conversations,
  messages,
  phoneNumbers,
  telephonyRegistrations,
  workspaces,
} from '@hfos/db/schema';
import { textingApprovedEmail, textingRejectedEmail } from '../emails/templates';
import { sendQueuedEmail } from './email';
import { TEXT_STATUS } from '../processors/twilio-messaging';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { ensureAccount, loadAccount, webhookUrls } from '../telephony/accounts';
import { contentTemplateFor } from '../telephony/rcs-content';
import { errorMessage } from '../outbox';
import {
  isPermanentProviderError,
  ProviderError,
  type OwnedNumber,
  type RegistrationKind,
  type RegistrationState,
} from '../telephony/provider';
import type { EventHandler, HandlerContext } from './types';

const metaOf = (ctx: HandlerContext) => workerMeta(ctx.event.correlationId, ctx.event.id);

/** Why buying kept failing, in words that fit "We couldn’t buy {number}: {reason} Pick another number." */
function purchaseTrouble(e: unknown): string {
  if (e instanceof ProviderError) {
    if (e.httpStatus === 401 || e.httpStatus === 403)
      return 'The phone carrier refused HandsFreeOS’s account.';
    if (e.httpStatus === 429) return 'The phone carrier is too busy right now.';
    return 'The phone carrier did not answer.';
  }
  return 'Setting up the number kept failing.';
}

/**
 * Buys the number people picked: subaccount and messaging service first (each committed), then the number.
 * A refusal is recorded at once; trouble worth retrying is retried, and on the last try the number is marked
 * failed too, so the page asks for another number instead of "Setting up" for good.
 */
export const onPurchaseRequested: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [n] = await ctx.tx
    .select()
    .from(phoneNumbers)
    .where(eq(phoneNumbers.id, ctx.event.entityId!));
  if (!n || n.status !== 'provisioning') return;
  const fail = (error: string) =>
    executeCommand(
      ctx.db,
      phoneNumberFail,
      { workspaceId: scope.workspaceId, phoneNumberId: n.id, error },
      systemActor(scope),
      metaOf(ctx),
    );
  let bought: OwnedNumber | null = null;
  try {
    const account = await ensureAccount(ctx, scope);
    bought =
      (await ctx.telephony.findOwnedNumber(account, n.e164)) ??
      (await ctx.telephony.buyNumber(account, { e164: n.e164, urls: webhookUrls(ctx.publicUrl) }));
    if (account.messagingServiceSid)
      await ctx.telephony.addNumberToService(account, account.messagingServiceSid, bought.sid);
    await executeCommand(
      ctx.db,
      phoneNumberActivate,
      {
        workspaceId: scope.workspaceId,
        phoneNumberId: n.id,
        providerSid: bought.sid,
        accountId: account.id,
        capabilities: { ...bought.capabilities },
      },
      systemActor(scope),
      metaOf(ctx),
    );
  } catch (e) {
    if (isPermanentProviderError(e)) {
      await fail(e.message);
      return;
    }
    // A number already bought stays "Setting up" for an operator: telling the owner it wasn't bought is wrong.
    if (ctx.attempt < ctx.maxAttempts || bought) throw e;
    ctx.log.warn({ err: errorMessage(e) }, 'number purchase gave up after the last try');
    await fail(purchaseTrouble(e));
  }
};

export const onReleaseRequested: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [n] = await ctx.tx
    .select()
    .from(phoneNumbers)
    .where(eq(phoneNumbers.id, ctx.event.entityId!));
  if (!n || n.status !== 'releasing') return;
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (account) {
    // A number released while it was still being set up has no sid here yet, but may well have been bought before
    // the purchase stopped. Asking the carrier what it holds for this number is what stops us walking away from one
    // we are paying for.
    const sid =
      n.providerSid ?? (await ctx.telephony.findOwnedNumber(account, n.e164))?.sid ?? null;
    if (sid) {
      try {
        await ctx.telephony.releaseNumber(account, sid);
      } catch (e) {
        // Already gone at the provider is what we wanted.
        if (!isPermanentProviderError(e)) throw e;
        ctx.log.warn({ err: e.message }, 'provider refused the release; marking released anyway');
      }
    }
  }
  await executeCommand(
    ctx.db,
    phoneNumberMarkReleased,
    { workspaceId: scope.workspaceId, phoneNumberId: n.id },
    systemActor(scope),
    metaOf(ctx),
  );
};

const REVIEWING = new Set(['submitted', 'in_review']);
/** Twilio reviews the 10DLC customer profile and trust product while the brand goes ahead. */
const PROCEED_WHILE_REVIEWING = new Set<RegistrationKind>([
  'a2p_customer_profile',
  'a2p_trust_product',
]);

/**
 * Walks the workspace's registration chain in order: sends each step whose details the carrier doesn't have yet
 * (new, or sent again by people after a rejection) once the steps before it are usable, and keeps a poll going
 * for every step under review. A step sent again waits for the steps before it to be approved, since the
 * carriers check it against them. Safe to call again at any time.
 */
export async function advanceRegistrations(
  services: WorkerServices,
  scope: TenantScope,
  causation: { correlationId?: string | null; causationId?: string | null } = {},
): Promise<void> {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => asWorker(services.db, scope, fn);
  const [regs, numbers, loaded] = await run(
    async (tx) =>
      [
        await tx
          .select()
          .from(telephonyRegistrations)
          .where(eq(telephonyRegistrations.workspaceId, scope.workspaceId))
          .orderBy(asc(telephonyRegistrations.createdAt)),
        await numbersOf(tx, scope.workspaceId),
        await loadAccount(tx, scope.workspaceId, services.sealer),
      ] as const,
  );
  const latest = latestByKind(regs);
  /**
   * **A local (10DLC) registration goes ahead with no number at all.** Its four steps register the business and
   * how it texts, and the campaign sits on the messaging service rather than on a number, so a business moving
   * its own number here registers while it travels; the number joins the service when it lands and texts that
   * day. That needs the subaccount and messaging service first, which a number would otherwise have made, so a
   * 10DLC chain makes them here. Toll-free verification is for one number, and still waits for it.
   */
  const tenDlc = FAMILY_KINDS.a2p_10dlc.some((k) => latest.has(k));
  if (!tenDlc && !numbers.some((n) => n.status === 'active')) return;
  const account = loaded ?? (tenDlc ? await ensureAccount(services, scope) : null);
  if (!account) throw new Error('no telephony account for this workspace');
  const meta = workerMeta(causation.correlationId, causation.causationId);
  const update = (input: Record<string, unknown>) =>
    executeCommand(
      services.db,
      registrationUpdateStatus,
      { workspaceId: scope.workspaceId, ...input },
      systemActor(scope),
      meta,
    );

  /** One family's chain, walked in order against the number that family is for. */
  const advanceFamily = async (
    family: RegistrationFamily,
    number: (typeof numbers)[number] | null,
  ): Promise<void> => {
    // Provider ids of the steps later ones may build on.
    const usable: Partial<Record<RegistrationKind, string>> = {};
    let approvedSoFar = true;
    for (const kind of FAMILY_KINDS[family] as readonly RegistrationKind[]) {
      const reg = latest.get(kind);
      if (!reg) return;
      if (reg.status === 'approved') {
        if (reg.providerSid) usable[kind] = reg.providerSid;
        continue;
      }
      if (!REVIEWING.has(reg.status)) return; // rejected, failed or draft: people act next
      if (carrierHasDetails(reg)) {
        await ensurePoll(services, scope, reg.id);
        if (!PROCEED_WHILE_REVIEWING.has(kind)) return;
        usable[kind] = reg.providerSid!;
        approvedSoFar = false;
        continue;
      }
      // Sent again after the carriers turned it down: it goes once the steps before it are approved.
      if (reg.providerSid && !approvedSoFar) return;
      const submission = reg.submission as Record<string, unknown>;
      const contact = (submission['contact'] ?? {}) as { email?: string };
      let state: RegistrationState;
      try {
        state = await services.telephony.submitRegistration(account, {
          kind,
          submission,
          phoneNumberSid: number?.providerSid ?? null,
          phoneNumberE164: number?.e164 ?? null,
          previous: { ...usable },
          messagingServiceSid: account.messagingServiceSid,
          notifyEmail: contact.email ?? '',
          replaces: reg.providerSid,
        });
      } catch (e) {
        if (!isPermanentProviderError(e)) throw e;
        await update({ registrationId: reg.id, status: 'failed', rejectionReason: e.message });
        return;
      }
      const reviewing = REVIEWING.has(state.status);
      await update({
        registrationId: reg.id,
        status: state.status,
        providerSid: state.providerSid,
        providerStatus: state.providerStatus,
        rejectionReason: state.rejectionReason,
        nextPollAt: reviewing
          ? new Date(Date.now() + services.registrationPollMs).toISOString()
          : null,
        // The version the carrier now has: people sending again later makes this differ.
        carrierSubmittedAt: reg.submittedAt?.toISOString() ?? null,
      });
      if (state.status === 'approved') {
        usable[kind] = state.providerSid;
        continue;
      }
      if (!reviewing) return;
      await ensurePoll(services, scope, reg.id);
      if (!PROCEED_WHILE_REVIEWING.has(kind)) return;
      usable[kind] = state.providerSid;
      approvedSoFar = false;
    }
  };

  /**
   * **Every family the business has actually submitted, not one guessed from a number.**
   *
   * This used to take the oldest registration that named a number, look that number up and walk whichever
   * family it belonged to. A business that gave up its toll-free number and bought a local one therefore kept
   * working the dead number's paperwork forever: the loop found the approved toll-free verification, had
   * nothing left to do, and returned — while the 10DLC chain the business had actually submitted sat
   * untouched and texting never turned on. A business holding both kinds at once had the same fault, with
   * whichever chain was submitted second never moving.
   *
   * So the families come from the registrations themselves, and each is walked against its own number. This
   * cannot start anything: a family with no registration is not in the set, and `advanceFamily` returns at the
   * first step nobody has submitted. Registrations stay per family rather than per number — a workspace with
   * two local numbers registers once and both are covered, which is how 10DLC works — so one number per
   * family is the right thing to submit against.
   */
  for (const [family, kinds] of Object.entries(FAMILY_KINDS) as [
    RegistrationFamily,
    readonly RegistrationKind[],
  ][]) {
    if (!kinds.some((k) => latest.has(k))) continue;
    // `numbersOf` is ordered `is_default desc, created_at desc`, so this is the business's own preference,
    // and it never returns a released one. `active` because a number still provisioning has no carrier sid
    // to register against yet — a number arriving (bought, ported or transferred) calls this again.
    const number =
      numbers.find((n) => n.status === 'active' && familyFor(n.numberType) === family) ?? null;
    if (!number && family !== 'a2p_10dlc') continue;
    await advanceFamily(family, number);
  }
}

async function ensurePoll(services: WorkerServices, scope: TenantScope, registrationId: string) {
  await asWorker(services.db, scope, (tx) =>
    scheduleJob(tx, {
      kind: 'registration.poll',
      dedupeKey: `registration:${registrationId}`,
      runAt: new Date(Date.now() + services.registrationPollMs),
      payload: { registrationId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    }),
  );
}

export const onRegistrationSubmitted: EventHandler = async (ctx) => {
  await advanceRegistrations(ctx, tenantOf(ctx.scope), {
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
};

/**
 * A number started working here: bought, ported in or transferred from another Twilio account. A registration
 * sent while it was on its way (toll-free verification waits for its number) goes now, rather than sitting
 * until somebody sends it again. Nothing to do for a business with no registration, which `advanceRegistrations`
 * finds for itself.
 */
export const onNumberArrived: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [any] = await ctx.tx
    .select({ id: telephonyRegistrations.id })
    .from(telephonyRegistrations)
    .where(eq(telephonyRegistrations.workspaceId, scope.workspaceId))
    .limit(1);
  if (!any) return;
  await advanceRegistrations(ctx, scope, {
    correlationId: ctx.event.correlationId,
    causationId: ctx.event.id,
  });
};

/** Owners and admins hear when texting turns on, or when the carriers want a change. */
export const onRegistrationStatusChanged: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.event.payload as { kind?: string; to?: string };
  const final = p.kind === 'toll_free_verification' || p.kind === 'a2p_campaign';
  if (!(p.to === 'rejected' || (p.to === 'approved' && final))) return;
  const [ws] = await ctx.tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const business = ws?.name ?? 'your business';
  const recipients = await managers(ctx.tx, scope.workspaceId);
  if (recipients.length === 0) return;
  let mail;
  const number = await defaultNumber(ctx.tx, scope.workspaceId);
  if (p.to === 'approved') {
    // Approved ahead of the number (it is still being moved here): the email says so, and points at Settings.
    mail = textingApprovedEmail({
      business,
      number: number ? formatPhone(number.e164) : null,
      link: number
        ? `${ctx.webUrl}/app/w/${scope.workspaceId}/inbox`
        : `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting`,
    });
  } else {
    const [reg] = await ctx.tx
      .select({ reason: telephonyRegistrations.rejectionReason })
      .from(telephonyRegistrations)
      .where(eq(telephonyRegistrations.id, ctx.event.entityId!));
    mail = textingRejectedEmail({
      business,
      calls: !!number,
      reason: reg?.reason ?? null,
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting`,
    });
  }
  for (const r of recipients) await ctx.mailer.send({ to: r.email, ...mail });
};

/** Owners and admins of a workspace (directly, or through its organization). */
export async function managers(
  tx: Tx,
  workspaceId: string,
): Promise<{ id: string; email: string; full_name: string; settings: Record<string, unknown> }[]> {
  return rows(
    tx,
    sql`select distinct u.id, u.email::text as email, u.full_name, u.settings from app.users u
        where u.id in (
          select wm.user_id from app.workspace_memberships wm
          where wm.workspace_id = ${workspaceId} and wm.role in ('owner', 'admin')
          union
          select om.user_id from app.organization_memberships om
          join app.workspaces w on w.organization_id = om.organization_id
          where w.id = ${workspaceId} and om.role in ('owner', 'admin'))`,
  );
}

/**
 * Who hears about a workflow straight away (a dead step, an approval nobody is named for, "Notify the team →
 * owners and admins"): the business's own owners and admins, members of the workspace itself. Its
 * organization's owners and admins only when it has none, so someone always hears; otherwise the agency
 * sees its clients in the daily digest (agency-digest.ts) instead of every email.
 */
export async function workspaceManagers(
  tx: Tx,
  workspaceId: string,
): Promise<{ id: string; email: string; full_name: string; settings: Record<string, unknown> }[]> {
  return rows(
    tx,
    sql`with own as (
          select wm.user_id from app.workspace_memberships wm
          where wm.workspace_id = ${workspaceId} and wm.role in ('owner', 'admin'))
        select u.id, u.email::text as email, u.full_name, u.settings from app.users u
        where u.id in (select user_id from own)
           or (not exists (select 1 from own) and u.id in (
                select om.user_id from app.organization_memberships om
                join app.workspaces w on w.organization_id = om.organization_id
                where w.id = ${workspaceId} and om.role in ('owner', 'admin')))
        order by u.email`,
  );
}

/**
 * The provider id a queued message may carry without having gone: a retry (message.retry) names the attempt
 * that failed. Any other provider id means this send already happened, and a repeated event must not send it
 * twice.
 */
export function retryReplaces(ctx: HandlerContext): string | null {
  const p = ctx.event.payload as { replacesProviderMessageId?: string | null };
  return p.replacesProviderMessageId ?? null;
}

/** Hands a queued text to the carrier; the status callbacks take it from there. */
export const onMessageQueued: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [m] = await ctx.tx.select().from(messages).where(eq(messages.id, ctx.event.entityId!));
  if (!m || m.direction !== 'outbound') return;
  if (m.providerMessageId && m.providerMessageId !== retryReplaces(ctx)) return;
  if (m.status !== 'queued' && m.status !== 'sending') return;
  if (m.channel === 'email') {
    await sendQueuedEmail(ctx, m);
    return;
  }
  const fail = (errorCode: string, errorMessage: string) =>
    executeCommand(
      ctx.db,
      messageUpdateStatus,
      {
        workspaceId: scope.workspaceId,
        messageId: m.id,
        status: 'failed',
        errorCode,
        errorMessage,
      },
      systemActor(scope),
      metaOf(ctx),
    );
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, m.conversationId));
  /**
   * The number this thread is on — what the customer sees the reply come from (M17). `conversationNumber`
   * falls back to the business's default when the thread has no number (it predates this) or when the number
   * it had has since been released: a queued text is not worth failing because somebody released a number
   * last week, and sending from the number that replaced it is what a person would do.
   */
  const number = conv
    ? await conversationNumber(ctx.tx, scope.workspaceId, conv.phoneNumberId)
    : null;
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (!conv || !number || number.status !== 'active' || !account) {
    await fail('no_number', 'The business number is not active.');
    return;
  }
  // It fell back, so the timeline has to say what the wire will. Both the thread and the message itself are
  // re-stamped, so the thread is stable again from here and its history does not claim a number it never used.
  if (conv.phoneNumberId !== number.id) {
    await ctx.tx
      .update(conversations)
      .set({ phoneNumberId: number.id })
      .where(eq(conversations.id, conv.id));
    await ctx.tx.update(messages).set({ fromAddress: number.e164 }).where(eq(messages.id, m.id));
  }
  // The second wallet gate (M16 step 9). The first is on message.send, but a text can sit queued for minutes —
  // scheduled, held, retried — and the balance can run out in between. Failing here means the message lands
  // `failed` with a code the inbox explains, rather than disappearing into a carrier call nobody paid for.
  const room = await walletRoom(ctx.tx, scope.workspaceId, 'text', (msg, e) =>
    ctx.log.error({ err: e }, msg),
  );
  if (!room.allowed) {
    await fail('wallet_empty', WALLET_REFUSALS.text);
    return;
  }
  /*
   * RCS first (0103), when the business's sender is approved, switched on and in its messaging service's pool.
   * Nobody chooses: Twilio checks whether the customer's phone can show RCS and, when it can't, sends the same
   * message as an SMS or MMS from this thread's own number. Which way it went comes back on the status
   * callbacks. Without an RCS sender every text goes exactly as it always did.
   */
  const rcsFirst =
    !!account.messagingServiceSid && rcsSending(await currentRcsSender(ctx.tx, scope.workspaceId));
  const rich = m.rich;
  // A picture on an RCS message can wait a while for its phone to come back before Twilio falls back to MMS, so
  // its link lives longer than an ordinary picture message's.
  const ttl = rcsFirst ? RCS_MEDIA_SECONDS : 3600;
  const mediaUrls = await Promise.all(
    m.media.map((x) => ctx.store.signedUrl(x.bucket, x.objectPath, ttl)),
  );
  // A rich text over RCS is its content template; without RCS it is its plain face, sent as an SMS or MMS.
  let contentSid: string | null = null;
  if (rcsFirst && rich) {
    const cardUrls = await Promise.all(
      rich.cards.map((c) => ctx.store.signedUrl(c.media.bucket, c.media.objectPath, ttl)),
    );
    try {
      ({ sid: contentSid } = await ctx.telephony.createContent(
        account,
        contentTemplateFor({
          messageId: m.id,
          body: m.bodyText ?? '',
          rich,
          photoUrl: mediaUrls[0] ?? null,
          cardUrls,
        }),
      ));
    } catch (e) {
      if (!isPermanentProviderError(e)) throw e;
      await fail(e.code, e.message);
      return;
    }
  }
  // A carousel's pictures ride on its cards; a phone without RCS gets its words.
  const pictures = rich?.kind === 'carousel' ? [] : mediaUrls;
  let sent: { sid: string; status: string };
  try {
    sent = await ctx.telephony.sendMessage(account, {
      from: number.e164,
      messagingServiceSid: account.messagingServiceSid,
      to: conv.counterpart,
      body: rich ? rich.smsText : (m.bodyText ?? ''),
      mediaUrls: pictures,
      statusCallbackUrl: webhookUrls(ctx.publicUrl).smsStatusUrl,
      rcsFirst,
      contentSid,
    });
  } catch (e) {
    // The template belongs to this attempt and nothing went out with it: a retry makes its own.
    if (contentSid)
      await ctx.telephony
        .deleteContent(account, contentSid)
        .catch((err: unknown) => ctx.log.warn({ err }, 'could not delete an unsent rcs template'));
    if (!isPermanentProviderError(e)) throw e;
    await fail(e.code, e.message);
    return;
  }
  await executeCommand(
    ctx.db,
    messageUpdateStatus,
    {
      workspaceId: scope.workspaceId,
      messageId: m.id,
      providerMessageId: sent.sid,
      ...(m.providerMessageId ? { replacesProviderMessageId: m.providerMessageId } : {}),
      status: TEXT_STATUS[sent.status] ?? 'sending',
      // Without RCS the way is known now; RCS first learns it from the callbacks.
      ...(rcsFirst ? {} : { transport: pictures.length > 0 ? 'mms' : 'sms' }),
      ...(contentSid ? { contentSid } : {}),
    },
    systemActor(scope),
    metaOf(ctx),
  );
};

/** How long an RCS message's pictures stay fetchable: long enough for a slow phone and the fallback after it. */
const RCS_MEDIA_SECONDS = 6 * 3600;

/** A conversation found its customer: earlier texts join their timeline. */
export const onConversationLinked: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const personId = (ctx.event.payload as { personId?: string }).personId;
  if (!personId || !ctx.event.entityId) return;
  const earlier = await ctx.tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, ctx.event.entityId),
        isNull(messages.activityId),
        // Only what happened. A text that never went (still held from the start, cancelled, or refused when quiet
        // hours ended) joins the timeline, and becomes the conversation's latest, when it first goes.
        eq(messages.went, true),
      ),
    )
    .orderBy(asc(messages.occurredAt));
  for (const m of earlier) {
    // A failed text tried again in quiet hours, still waiting, is on the timeline as the attempt that was made.
    const was = m.failedAttempt;
    const [a] = await ctx.tx
      .insert(activities)
      .values({
        workspaceId: scope.workspaceId,
        kind: m.channel === 'email' ? 'email' : m.channel === 'chat' ? 'chat' : 'sms',
        subtype: m.direction,
        personId,
        body: m.bodyText || messagePreview(null, m.media.length) || null,
        occurredAt: was ? new Date(was.occurredAt) : m.occurredAt,
        authorUserId: null,
        actorType: 'system',
        meta: {
          direction: m.direction,
          messageId: m.id,
          conversationId: m.conversationId,
          status: was?.status ?? m.status,
          sentBy: m.sentBy,
          backfilled: true,
        },
      })
      .returning({ id: activities.id });
    if (a) await ctx.tx.update(messages).set({ activityId: a.id }).where(eq(messages.id, m.id));
  }
};

/** Snoozed conversations come back on time: the worker holds the alarm. */
export const onConversationSnoozed: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const until = (ctx.event.payload as { until?: string }).until;
  if (!until || !ctx.event.entityId) return;
  await scheduleJob(ctx.tx, {
    kind: 'conversation.unsnooze',
    dedupeKey: `unsnooze:${ctx.event.entityId}`,
    runAt: new Date(until),
    payload: { conversationId: ctx.event.entityId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};
