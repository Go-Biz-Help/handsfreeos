import { eq } from 'drizzle-orm';
import { telephonyAccounts } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { quietHoursState } from '../messaging/quiet-hours';
import {
  currentNumber,
  latestByKind,
  loadRegistrations,
  readiness,
  workspaceMessaging,
} from '../messaging/store';
import { hasWorkspacePermission } from '../permissions';
import { PhoneSetupStatusInput, PhoneSetupStatusOutput } from '../schemas/telephony';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const phoneSetupStatus = defineQuery({
  name: 'phone.setup_status',
  description:
    'Where texting and calls stand: the business number, the carrier registration, the next step, and the texting rules.',
  input: PhoneSetupStatusInput,
  output: PhoneSetupStatusOutput,
  permission: 'inbox.use',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const number = await currentNumber(ctx.tx, input.workspaceId);
    const regs = await loadRegistrations(ctx.tx, input.workspaceId);
    // Column-level grants: people read the account's status, never its sealed credentials.
    const [account] = await ctx.tx
      .select({ status: telephonyAccounts.status })
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, input.workspaceId));
    const m = await workspaceMessaging(ctx.tx, input.workspaceId);
    const r = readiness(number, regs);
    return {
      number: number
        ? {
            id: number.id,
            e164: number.e164,
            display: formatPhone(number.e164),
            numberType: number.numberType,
            status: number.status,
            label: number.label,
            routing: {
              forwarding: number.routing.forwarding.map((f) => ({ ...f })),
              ringSeconds: number.routing.ringSeconds,
              voicemailEnabled: number.routing.voicemailEnabled,
              voicemailGreeting: number.routing.voicemailGreeting,
              forwardedCallerId: number.routing.forwardedCallerId ?? 'customer',
            },
            purchasedAt: iso(number.purchasedAt),
            lastError: number.lastError,
          }
        : null,
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
      canManage: hasWorkspacePermission(ctx.scope.workspaceRole, 'channels.manage'),
    };
  },
});
