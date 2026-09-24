import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { telephonyAccounts } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { quietHoursState } from '../messaging/quiet-hours';
import {
  currentNumber,
  currentRcsSender,
  numbersOf,
  latestByKind,
  loadRegistrations,
  rcsSending,
  readiness,
  workspaceMessaging,
} from '../messaging/store';
import { PhoneSetupStatusInput, PhoneSetupStatusOutput } from '../schemas/telephony';
import { scopeCan } from '../kernel/execute';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

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
    };
  },
});
