/**
 * Phone & texting on or off for a business: its own Twilio subaccount.
 *
 * A person presses the switch; the worker makes or closes the subaccount, because the API never holds a
 * carrier key. **On** makes it now rather than with the first number, so a business moving a number here has
 * the Account SID to hand HighLevel or Twilio before it has any number. **Off** closes it for good — Twilio
 * cannot reopen a closed account, and closing releases every number in it — so it is refused while anything is
 * in the account (`phoneAccountBlockers`), and the worker asks again the moment before it closes.
 */
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { phoneAccountBlockers } from '../messaging/phone-account';
import {
  TelephonyAccountChangedInput,
  TelephonyDisableInput,
  TelephonyEnableInput,
  TelephonySwitchOutput,
} from '../schemas/telephony';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export const telephonyEnable = defineCommand({
  name: 'telephony.enable',
  description:
    'Turn on phone & texting: HandsFreeOS makes this business its own Twilio account now, and shows its Account SID — what HighLevel or Twilio asks for to move a number here.',
  risk: 1,
  input: TelephonyEnableInput,
  output: TelephonySwitchOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['telephony.enable_requested'],
  async handler(ctx, input) {
    await ctx.emit({
      type: 'telephony.enable_requested',
      entityType: 'telephony_account',
      entityId: input.workspaceId,
      after: { phoneAndTexting: 'on' },
    });
    return { requested: 'on' as const };
  },
});

export const telephonyDisable = defineCommand({
  name: 'telephony.disable',
  description:
    'Turn off phone & texting: closes this business’s Twilio account for good. Only when no number, transfer, port, RCS sender or texting registration is in it; turning it on again gives a new Account SID.',
  risk: 3,
  input: TelephonyDisableInput,
  output: TelephonySwitchOutput,
  permission: 'channels.manage',
  scope: inWorkspace,
  emits: ['telephony.disable_requested'],
  async handler(ctx, input) {
    const blockers = await phoneAccountBlockers(ctx.tx, input.workspaceId);
    if (blockers.length)
      throw HfosError.rule(
        'telephony_in_use',
        409,
        `Phone & texting can’t be turned off yet. ${blockers.join(' ')}`,
      );
    await ctx.emit({
      type: 'telephony.disable_requested',
      entityType: 'telephony_account',
      entityId: input.workspaceId,
      after: { phoneAndTexting: 'off' },
    });
    return { requested: 'off' as const };
  },
});

/** Worker: what came of the switch. Writes nothing itself — the worker already has — and says so to the page. */
export const telephonyAccountChanged = defineCommand({
  name: 'telephony.account_changed',
  description: 'Worker: this business’s Twilio account was made, closed, or left on.',
  risk: 1,
  input: TelephonyAccountChangedInput,
  output: TelephonySwitchOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['telephony.account_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    await ctx.emit({
      type: 'telephony.account_changed',
      entityType: 'telephony_account',
      entityId: input.workspaceId,
      payload: { status: input.status, accountSid: input.accountSid },
      after: {
        status: input.status,
        ...(input.accountSid ? { account: input.accountSid } : {}),
        ...(input.problem ? { problem: input.problem } : {}),
      },
    });
    return { requested: input.status === 'active' ? ('on' as const) : ('off' as const) };
  },
});

export const telephonyAccountCommands = [
  telephonyEnable,
  telephonyDisable,
  telephonyAccountChanged,
];
