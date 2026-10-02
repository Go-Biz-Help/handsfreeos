import { and, eq, isNotNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { telephonyAccounts, textingFees } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { quietHoursState } from '../messaging/quiet-hours';
import {
  currentNumber,
  currentRcsRequest,
  currentRcsSender,
  numbersOf,
  latestByKind,
  loadRegistrations,
  rcsSending,
  readiness,
  textingFeesPaidFor,
  unsettledTextingFee,
  workspaceMessaging,
} from '../messaging/store';
import { TEXTING_CAMPAIGN_MONTH_CENTS } from '../money/texting-fees';
import { PhoneSetupStatusInput, PhoneSetupStatusOutput } from '../schemas/telephony';
import { scopeCan } from '../kernel/execute';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

type FeeRow = typeof textingFees.$inferSelect;
const feeOut = (f: FeeRow) => ({
  id: f.id,
  purpose: f.purpose,
  status: f.status,
  lines: f.lines.map(({ key, name, cents }) => ({ key, name, cents })),
  amountCents: f.amountCents,
  checkoutUrl: f.status === 'open' ? f.sessionUrl : null,
  problem: f.problem || null,
  periodStart: iso(f.periodStart),
});

/**
 * What registering for texting costs the business right now (0105): a registration's fees waiting to be paid, a
 * month the card didn't pay, whether a card is kept, and the campaign's month once there is one to charge.
 */
async function textingFeesOf(
  tx: Parameters<typeof unsettledTextingFee>[0],
  workspaceId: string,
  regs: readonly { kind: string; status: string }[],
) {
  const due = await unsettledTextingFee(tx, workspaceId, 'registration');
  const month = await unsettledTextingFee(tx, workspaceId, 'month');
  const [kept] = await tx
    .select({ id: textingFees.id })
    .from(textingFees)
    .where(
      and(
        eq(textingFees.workspaceId, workspaceId),
        eq(textingFees.status, 'paid'),
        isNotNull(textingFees.cardRef),
      ),
    )
    .limit(1);
  const campaign = latestByKind(regs).get('a2p_campaign');
  return {
    due: due ? feeOut(due) : null,
    month: month ? feeOut(month) : null,
    card: !!kept,
    monthlyCents: kept && campaign?.status === 'approved' ? TEXTING_CAMPAIGN_MONTH_CENTS : null,
    paidFor: await textingFeesPaidFor(tx, workspaceId),
  };
}

export const phoneSetupStatus = defineQuery({
  name: 'phone.setup_status',
  description:
    'Where texting and calls stand: the business number, the carrier registration, the next step, the texting rules and the RCS sender.',
  input: PhoneSetupStatusInput,
  output: PhoneSetupStatusOutput,
  permission: 'inbox.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const all = await numbersOf(ctx.tx, input.workspaceId);
    // Who each number rings (M17). One query for the workspace rather than one per number, and an absent
    // entry is the ordinary case — it means the number rings everybody with the inbox.
    const memberRows = await rows<{ phone_number_id: string; user_id: string }>(
      ctx.tx,
      sql`select phone_number_id, user_id from app.phone_number_members
          where workspace_id = ${input.workspaceId} order by user_id`,
    );
    const members = new Map<string, string[]>();
    for (const r of memberRows)
      members.set(r.phone_number_id, [...(members.get(r.phone_number_id) ?? []), r.user_id]);
    // `number` stays what it always was — the one the setup wizard is about — so nothing reading it had to
    // change when a business could have several. `currentNumber` includes a `failed` purchase, which the
    // wizard has to show; `numbersOf` is the list, default first.
    const number = await currentNumber(ctx.tx, input.workspaceId);
    const regs = await loadRegistrations(ctx.tx, input.workspaceId);
    // Column-level grants: people read the account's status, never its sealed credentials.
    const [account] = await ctx.tx
      .select({ status: telephonyAccounts.status })
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, input.workspaceId));
    const m = await workspaceMessaging(ctx.tx, input.workspaceId);
    const r = readiness(number, regs);
    const rcs = await currentRcsSender(ctx.tx, input.workspaceId);
    // Row-level security shows a request only to people who manage the channels: null for everybody else.
    const asked = await currentRcsRequest(ctx.tx, input.workspaceId);
    const manages = scopeCan(ctx.scope, 'channels.manage');
    const fees = manages ? await textingFeesOf(ctx.tx, input.workspaceId, regs) : null;
    const out = (n: NonNullable<typeof number>) => ({
      id: n.id,
      e164: n.e164,
      display: formatPhone(n.e164),
      numberType: n.numberType,
      status: n.status,
      label: n.label,
      isDefault: n.isDefault,
      memberUserIds: members.get(n.id) ?? [],
      routing: {
        forwarding: n.routing.forwarding.map((f) => ({ ...f })),
        ringSeconds: n.routing.ringSeconds,
        voicemailEnabled: n.routing.voicemailEnabled,
        voicemailGreeting: n.routing.voicemailGreeting,
        forwardedCallerId: n.routing.forwardedCallerId ?? ('customer' as const),
      },
      purchasedAt: iso(n.purchasedAt),
      lastError: n.lastError,
    });
    return {
      number: number ? out(number) : null,
      numbers: all.map(out),
      accountStatus: account?.status ?? null,
      registrations: [...latestByKind(regs).values()].map((g) => ({
        id: g.id,
        kind: g.kind,
        status: g.status,
        providerStatus: g.providerStatus,
        rejectionReason: g.rejectionReason,
        submittedAt: iso(g.submittedAt),
        approvedAt: iso(g.approvedAt),
        submission: g.submission,
      })),
      voiceReady: r.voiceReady,
      messagingReady: r.messagingReady,
      nextStep: r.nextStep,
      // The 10DLC chain as if a local number were here and working: the same question the import list asks.
      localRegistrationStep: readiness({ status: 'active', numberType: 'local' }, regs).nextStep,
      settings: m.settings,
      timezone: m.timezone,
      quiet: quietHoursState(m.settings.quietHours, m.timezone),
      canManage: scopeCan(ctx.scope, 'channels.manage'),
      rcsSender: rcs
        ? {
            id: rcs.id,
            senderId: rcs.senderId,
            status: rcs.status,
            enabled: rcs.enabled,
            phoneNumberId: rcs.phoneNumberId,
            displayName: rcs.displayName,
            providerStatus: rcs.providerStatus,
            lastError: rcs.lastError,
            checkedAt: iso(rcs.checkedAt),
            connectedAt: iso(rcs.connectedAt),
            sending: rcsSending(rcs),
          }
        : null,
      rcsRequest: asked
        ? {
            id: asked.id,
            status: asked.status,
            brand: asked.brand,
            firstYearCents: asked.firstYearCents,
            yearlyCents: asked.yearlyCents,
            checkoutUrl: asked.status === 'open' ? asked.sessionUrl : null,
            problem: asked.problem || null,
            paidAt: iso(asked.paidAt),
            paidThrough: iso(asked.paidThrough),
            renews: asked.status === 'paid' && !asked.stoppedAt && !asked.renewalFailedAt,
            stoppedAt: iso(asked.stoppedAt),
            renewalProblem: asked.renewalProblem,
            // Only while it is still for the year that is due: a page for a year already renewed is spent.
            renewalCheckoutUrl:
              asked.renewalFailedAt &&
              asked.renewalSessionUrl &&
              asked.renewalSessionFor?.getTime() === asked.paidThrough?.getTime()
                ? asked.renewalSessionUrl
                : null,
            ticketNumber: asked.ticketNumber,
            createdAt: asked.createdAt.toISOString(),
          }
        : null,
      textingFees: fees,
    };
  },
});
