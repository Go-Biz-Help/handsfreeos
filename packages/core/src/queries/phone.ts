import { eq } from 'drizzle-orm';
import { telephonyAccounts } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { defineQuery } from '../kernel/define';
import { quietHoursState } from '../messaging/quiet-hours';
import {
  currentNumber,
  numbersOf,
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
    const all = await numbersOf(ctx.tx, input.workspaceId);
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
    const out = (n: NonNullable<typeof number>) => ({
      id: n.id,
      e164: n.e164,
      display: formatPhone(n.e164),
      numberType: n.numberType,
      status: n.status,
      label: n.label,
      isDefault: n.isDefault,
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
      canManage: hasWorkspacePermission(ctx.scope.workspaceRole, 'channels.manage'),
    };
  },
});
