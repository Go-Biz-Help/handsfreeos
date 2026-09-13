import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  carrierHasDetails,
  executeCommand,
  FAMILY_KINDS,
  familyFor,
  formatPhone,
  latestByKind,
  liveNumber,
  messagePreview,
  messageUpdateStatus,
  phoneNumberActivate,
  phoneNumberFail,
  phoneNumberMarkReleased,
  registrationUpdateStatus,
  scheduleJob,
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
  if (account && n.providerSid) {
    try {
      await ctx.telephony.releaseNumber(account, n.providerSid);
    } catch (e) {
      // Already gone at the provider is what we wanted.
      if (!isPermanentProviderError(e)) throw e;
      ctx.log.warn({ err: e.message }, 'provider refused the release; marking released anyway');
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
  const [regs, number, account] = await run(
    async (tx) =>
      [
        await tx
          .select()
          .from(telephonyRegistrations)
          .where(eq(telephonyRegistrations.workspaceId, scope.workspaceId))
          .orderBy(asc(telephonyRegistrations.createdAt)),
        await liveNumber(tx, scope.workspaceId),
        await loadAccount(tx, scope.workspaceId, services.sealer),
      ] as const,
  );
  if (!number || number.status !== 'active') return;
  if (!account) throw new Error('no telephony account for this workspace');
  const latest = latestByKind(regs);
  const meta = workerMeta(causation.correlationId, causation.causationId);
  const update = (input: Record<string, unknown>) =>
    executeCommand(
      services.db,
      registrationUpdateStatus,
      { workspaceId: scope.workspaceId, ...input },
      systemActor(scope),
      meta,
    );
  // Provider ids of the steps later ones may build on.
  const usable: Partial<Record<RegistrationKind, string>> = {};
  let approvedSoFar = true;
  for (const kind of FAMILY_KINDS[familyFor(number.numberType)] as readonly RegistrationKind[]) {
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
        phoneNumberSid: number.providerSid,
        phoneNumberE164: number.e164,
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
  if (p.to === 'approved') {
    const number = await liveNumber(ctx.tx, scope.workspaceId);
    mail = textingApprovedEmail({
      business,
      number: number ? formatPhone(number.e164) : 'your business number',
      link: `${ctx.webUrl}/app/w/${scope.workspaceId}/inbox`,
    });
  } else {
    const [reg] = await ctx.tx
      .select({ reason: telephonyRegistrations.rejectionReason })
      .from(telephonyRegistrations)
      .where(eq(telephonyRegistrations.id, ctx.event.entityId!));
    mail = textingRejectedEmail({
      business,
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

/** Hands a queued text to the carrier; the status callbacks take it from there. */
export const onMessageQueued: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const [m] = await ctx.tx.select().from(messages).where(eq(messages.id, ctx.event.entityId!));
  if (!m || m.direction !== 'outbound' || m.providerMessageId) return;
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
  const number = await liveNumber(ctx.tx, scope.workspaceId);
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (!conv || !number || number.status !== 'active' || !account) {
    await fail('no_number', 'The business number is not active.');
    return;
  }
  const mediaUrls = await Promise.all(
    m.media.map((x) => ctx.store.signedUrl(x.bucket, x.objectPath, 3600)),
  );
  try {
    const sent = await ctx.telephony.sendMessage(account, {
      from: number.e164,
      messagingServiceSid: account.messagingServiceSid,
      to: conv.counterpart,
      body: m.bodyText ?? '',
      mediaUrls,
      statusCallbackUrl: webhookUrls(ctx.publicUrl).smsStatusUrl,
    });
    await executeCommand(
      ctx.db,
      messageUpdateStatus,
      {
        workspaceId: scope.workspaceId,
        messageId: m.id,
        providerMessageId: sent.sid,
        status: TEXT_STATUS[sent.status] ?? 'sending',
      },
      systemActor(scope),
      metaOf(ctx),
    );
  } catch (e) {
    if (!isPermanentProviderError(e)) throw e;
    await fail(e.code, e.message);
  }
};

/** A conversation found its customer: earlier texts join their timeline. */
export const onConversationLinked: EventHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const personId = (ctx.event.payload as { personId?: string }).personId;
  if (!personId || !ctx.event.entityId) return;
  const earlier = await ctx.tx
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, ctx.event.entityId), isNull(messages.activityId)))
    .orderBy(asc(messages.occurredAt));
  for (const m of earlier) {
    const [a] = await ctx.tx
      .insert(activities)
      .values({
        workspaceId: scope.workspaceId,
        kind: m.channel === 'email' ? 'email' : 'sms',
        subtype: m.direction,
        personId,
        body: m.bodyText || messagePreview(null, m.media.length) || null,
        occurredAt: m.occurredAt,
        authorUserId: null,
        actorType: 'system',
        meta: {
          direction: m.direction,
          messageId: m.id,
          conversationId: m.conversationId,
          status: m.status,
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
