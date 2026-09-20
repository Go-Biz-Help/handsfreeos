import { and, eq } from 'drizzle-orm';
import { phoneNumbers, workspaces } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  defaultNumber,
  LIVE_NUMBER_STATUSES,
  liveNumberCount,
  MAX_NUMBERS_PER_WORKSPACE,
  workspaceMessaging,
} from '../messaging/store';
import { assertWalletHasRoom } from '../money/wallet-gate';
import {
  PhoneNumberActivateInput,
  PhoneNumberBuyInput,
  PhoneNumberBuyOutput,
  PhoneNumberFailInput,
  PhoneNumberMarkReleasedInput,
  PhoneNumberReleaseInput,
  PhoneNumberReleaseOutput,
  PhoneNumberSetCallerIdInput,
  PhoneNumberSetCallerIdOutput,
  PhoneNumberSetDefaultInput,
  PhoneNumberSetDefaultOutput,
  PhoneNumberSetLabelInput,
  PhoneNumberSetLabelOutput,
  PhoneNumberSetRoutingInput,
  PhoneNumberSetRoutingOutput,
  PhoneNumberSystemOutput,
  PhoneUpdateSettingsInput,
  PhoneUpdateSettingsOutput,
  type TelephonySettings,
} from '../schemas/telephony';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

async function loadNumber(ctx: CommandContext, phoneNumberId: string) {
  const [n] = await ctx.tx
    .select()
    .from(phoneNumbers)
    .where(
      and(eq(phoneNumbers.id, phoneNumberId), eq(phoneNumbers.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!n) throw HfosError.notFound('Number not found.');
  return n;
}

export const phoneNumberBuy = defineCommand({
  name: 'phone_number.buy',
  description:
    'Buy the workspace’s business number from the search results. HandsFreeOS provisions it with the carrier; calls ring as soon as it is active.',
  risk: 3,
  input: PhoneNumberBuyInput,
  output: PhoneNumberBuyOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.purchase_requested'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    /**
     * A business may have several numbers now (M17) — a second location, a dispatch line, a toll-free
     * beside a local one. But a ceiling is not optional: dropping the one-per-workspace unique index
     * removed the only thing that stood between a purchase that kept retrying and forty numbers on
     * somebody's card, each of them billed monthly.
     */
    if ((await liveNumberCount(ctx.tx, workspaceId)) >= MAX_NUMBERS_PER_WORKSPACE)
      throw HfosError.rule(
        'number_limit',
        409,
        `That is ${MAX_NUMBERS_PER_WORKSPACE} numbers, which is as many as one business can have. Release one you are not using first.`,
      );
    // A number is charged a month up front, so it needs the whole month there. Nobody should be able to buy
    // one at zero and be billed for it later.
    await assertWalletHasRoom(ctx.tx, workspaceId, 'number');
    const [row] = await ctx.tx
      .insert(phoneNumbers)
      .values({
        workspaceId,
        e164: input.e164,
        numberType: input.numberType,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: phoneNumbers.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'phone_number.purchase_requested',
      entityType: 'phone_number',
      entityId: row.id,
      payload: { e164: input.e164, numberType: input.numberType },
      after: {
        number: formatPhone(input.e164),
        numberType: input.numberType,
        status: 'provisioning',
      },
    });
    return { phoneNumberId: row.id };
  },
});

export const phoneNumberRelease = defineCommand({
  name: 'phone_number.release',
  description:
    'Give the business number back to the carrier. Calls and texts to it stop, and it cannot be recovered.',
  risk: 4,
  input: PhoneNumberReleaseInput,
  output: PhoneNumberReleaseOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.release_requested'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    // `provisioning` too: a purchase the worker never finished would otherwise hold the workspace's one live slot
    // for good, with no way out of Settings. The worker looks the number up at the carrier before it gives up on
    // it, so a number that was in fact bought is still handed back.
    if (n.status !== 'active' && n.status !== 'provisioning')
      throw HfosError.rule(
        'number_not_active',
        409,
        n.status === 'releasing'
          ? 'This number is already being given back.'
          : 'This number is no longer in use.',
      );
    if (n.e164 !== input.confirmE164)
      throw HfosError.validation([
        { path: 'confirmE164', message: 'Type the number exactly as shown to release it.' },
      ]);
    await ctx.tx.update(phoneNumbers).set({ status: 'releasing' }).where(eq(phoneNumbers.id, n.id));
    const number = formatPhone(n.e164);
    await ctx.emit({
      type: 'phone_number.release_requested',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { e164: n.e164 },
      before: { number, status: n.status },
      after: { number, status: 'releasing' },
    });
    return { phoneNumberId: n.id };
  },
});

export const phoneNumberSetRouting = defineCommand({
  name: 'phone_number.set_routing',
  description:
    'Choose which phones ring with the browsers when a customer calls, how long they ring, and the voicemail greeting.',
  risk: 2,
  input: PhoneNumberSetRoutingInput,
  output: PhoneNumberSetRoutingOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.routing_updated'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if (n.status === 'released' || n.status === 'failed')
      throw HfosError.rule('number_not_active', 409, 'This number is no longer in use.');
    const seen = new Set<string>();
    const issues: { path: string; message: string }[] = [];
    input.routing.forwarding.forEach((f, i) => {
      if (f.e164 === n.e164)
        issues.push({
          path: `routing.forwarding.${i}.e164`,
          message: 'Forward to a phone other than the business number.',
        });
      else if (seen.has(f.e164))
        issues.push({
          path: `routing.forwarding.${i}.e164`,
          message: 'This phone is already on the list.',
        });
      seen.add(f.e164);
    });
    if (issues.length > 0) throw HfosError.validation(issues);
    // What forwarding phones show stays as it is unless this save names it.
    const callerId = input.routing.forwardedCallerId ?? n.routing.forwardedCallerId;
    const routing = {
      forwarding: input.routing.forwarding.map((f) => ({
        e164: f.e164,
        label: f.label,
        enabled: f.enabled,
      })),
      ringSeconds: input.routing.ringSeconds,
      voicemailEnabled: input.routing.voicemailEnabled,
      voicemailGreeting: input.routing.voicemailGreeting || null,
      ...(callerId ? { forwardedCallerId: callerId } : {}),
    };
    await ctx.tx.update(phoneNumbers).set({ routing }).where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.routing_updated',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { ringing: routing.forwarding.filter((f) => f.enabled).length },
      before: { routing: n.routing },
      after: { routing },
    });
    return { phoneNumberId: n.id };
  },
});

export const phoneNumberSetCallerId = defineCommand({
  name: 'phone_number.set_caller_id',
  description:
    'Choose what forwarding phones show when a customer calls: the customer’s number, or the business number (so a phone that silences unknown callers still rings once the business number is a contact). Either way the phone hears who is calling before pressing 1.',
  risk: 1,
  input: PhoneNumberSetCallerIdInput,
  output: PhoneNumberSetCallerIdOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.routing_updated'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if (n.status === 'released' || n.status === 'failed')
      throw HfosError.rule('number_not_active', 409, 'This number is no longer in use.');
    const was = n.routing.forwardedCallerId ?? 'customer';
    if (was === input.forwardedCallerId)
      return { phoneNumberId: n.id, forwardedCallerId: input.forwardedCallerId };
    const routing = { ...n.routing, forwardedCallerId: input.forwardedCallerId };
    await ctx.tx.update(phoneNumbers).set({ routing }).where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.routing_updated',
      entityType: 'phone_number',
      entityId: n.id,
      payload: {
        ringing: n.routing.forwarding.filter((f) => f.enabled).length,
        forwardedCallerId: input.forwardedCallerId,
      },
      before: { forwardedCallerId: was },
      after: { forwardedCallerId: input.forwardedCallerId },
    });
    return { phoneNumberId: n.id, forwardedCallerId: input.forwardedCallerId };
  },
});

/**
 * Which number a new conversation goes out from (M17).
 *
 * The write is one boolean; the rule that exactly one number holds it, and that a released number hands it
 * on, lives in `private.phone_numbers_keep_default()`. That is deliberate — a business can have several
 * numbers and several people changing them, and "exactly one" is the kind of promise the database should keep
 * rather than whichever command ran last.
 *
 * Existing threads are not moved. A conversation belongs to the number the customer wrote to, and changing
 * the default is about where the *next* one starts.
 */
export const phoneNumberSetDefault = defineCommand({
  name: 'phone_number.set_default',
  description: 'Choose which of a business’s numbers new conversations go out from.',
  risk: 2,
  input: PhoneNumberSetDefaultInput,
  output: PhoneNumberSetDefaultOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.default_changed'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if (!LIVE_NUMBER_STATUSES.includes(n.status as (typeof LIVE_NUMBER_STATUSES)[number]))
      throw HfosError.rule(
        'number_not_live',
        409,
        'That number is not in use, so nothing can be sent from it.',
      );
    if (n.isDefault) return { phoneNumberId: n.id };
    const was = await defaultNumber(ctx.tx, ctx.scope.workspaceId!);
    await ctx.tx.update(phoneNumbers).set({ isDefault: true }).where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.default_changed',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { e164: n.e164, wasPhoneNumberId: was?.id ?? null },
      before: { number: was ? formatPhone(was.e164) : null },
      after: { number: formatPhone(n.e164) },
    });
    return { phoneNumberId: n.id };
  },
});

/** What the team calls a number. With one number nobody needs this; with three it is what makes a list usable. */
export const phoneNumberSetLabel = defineCommand({
  name: 'phone_number.set_label',
  description: 'Name one of a business’s numbers, so a list of them can be told apart.',
  risk: 1,
  input: PhoneNumberSetLabelInput,
  output: PhoneNumberSetLabelOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.label_changed'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if ((n.label ?? null) === input.label) return { phoneNumberId: n.id };
    await ctx.tx.update(phoneNumbers).set({ label: input.label }).where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.label_changed',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { e164: n.e164, label: input.label },
      before: { label: n.label },
      after: { label: input.label },
    });
    return { phoneNumberId: n.id };
  },
});

export const phoneUpdateSettings = defineCommand({
  name: 'phone.update_settings',
  description: 'Quiet hours for texts and the reminder email when a customer waits for a reply.',
  risk: 2,
  input: PhoneUpdateSettingsInput,
  output: PhoneUpdateSettingsOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone.settings_updated'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const current = await workspaceMessaging(ctx.tx, workspaceId);
    const next: TelephonySettings = {
      quietHours: input.quietHours ?? current.settings.quietHours,
      unansweredReminderMinutes:
        input.unansweredReminderMinutes ?? current.settings.unansweredReminderMinutes,
    };
    const [row] = await ctx.tx
      .update(workspaces)
      .set({ settings: { ...current.rawSettings, telephony: next } })
      .where(eq(workspaces.id, workspaceId))
      .returning({ id: workspaces.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'phone.settings_updated',
      entityType: 'workspace',
      entityId: workspaceId,
      payload: { fields: Object.keys(input).filter((k) => k !== 'workspaceId') },
      before: { telephony: current.settings },
      after: { telephony: next },
    });
    return { settings: next };
  },
});

// ---------- worker-only: the carrier's answers ----------

export const phoneNumberActivate = defineCommand({
  name: 'phone_number.activate',
  description: 'Worker: the carrier confirmed the purchase and the number is live.',
  risk: 1,
  input: PhoneNumberActivateInput,
  output: PhoneNumberSystemOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.purchased'],
  actors: ['system'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if (n.status === 'active' && n.providerSid === input.providerSid)
      return { phoneNumberId: n.id, status: 'active' as const };
    if (n.status !== 'provisioning')
      throw HfosError.rule(
        'number_not_provisioning',
        409,
        'This number is not waiting for a purchase.',
      );
    await ctx.tx
      .update(phoneNumbers)
      .set({
        status: 'active',
        providerSid: input.providerSid,
        accountId: input.accountId,
        capabilities: input.capabilities,
        purchasedAt: new Date(),
        lastError: null,
      })
      .where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.purchased',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { e164: n.e164, numberType: n.numberType },
      before: { status: n.status },
      after: { number: formatPhone(n.e164), numberType: n.numberType, status: 'active' },
    });
    return { phoneNumberId: n.id, status: 'active' as const };
  },
});

export const phoneNumberFail = defineCommand({
  name: 'phone_number.fail',
  description:
    'Worker: the purchase did not go through; the owner sees why and can pick another number.',
  risk: 1,
  input: PhoneNumberFailInput,
  output: PhoneNumberSystemOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.purchase_failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if (n.status === 'failed') return { phoneNumberId: n.id, status: 'failed' as const };
    if (n.status !== 'provisioning')
      throw HfosError.rule(
        'number_not_provisioning',
        409,
        'This number is not waiting for a purchase.',
      );
    await ctx.tx
      .update(phoneNumbers)
      .set({ status: 'failed', lastError: input.error })
      .where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.purchase_failed',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { e164: n.e164, error: input.error },
      before: { status: n.status },
      after: { number: formatPhone(n.e164), status: 'failed', error: input.error },
    });
    return { phoneNumberId: n.id, status: 'failed' as const };
  },
});

export const phoneNumberMarkReleased = defineCommand({
  name: 'phone_number.mark_released',
  description: 'Worker: the carrier took the number back.',
  risk: 1,
  input: PhoneNumberMarkReleasedInput,
  output: PhoneNumberSystemOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['phone_number.released'],
  actors: ['system'],
  async handler(ctx, input) {
    const n = await loadNumber(ctx, input.phoneNumberId);
    if (n.status === 'released') return { phoneNumberId: n.id, status: 'released' as const };
    if (n.status !== 'releasing')
      throw HfosError.rule('number_not_releasing', 409, 'This number is not being released.');
    await ctx.tx
      .update(phoneNumbers)
      .set({ status: 'released', releasedAt: new Date() })
      .where(eq(phoneNumbers.id, n.id));
    await ctx.emit({
      type: 'phone_number.released',
      entityType: 'phone_number',
      entityId: n.id,
      payload: { e164: n.e164 },
      before: { status: n.status },
      after: { number: formatPhone(n.e164), status: 'released' },
    });
    return { phoneNumberId: n.id, status: 'released' as const };
  },
});
