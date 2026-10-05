/**
 * The person's own settings (M12, step six): their name, light or dark, which emails HandsFreeOS sends them, their
 * working hours and their time off.
 *
 * These belong to one person rather than to the business, so they need no permission beyond using the Assistant —
 * and they are always about the person asking. Nothing here takes a teammate's id: changing somebody else's hours
 * is the business's business, and goes through the screens.
 */

import { plainSpaces } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
import { hoursLine, settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Hours = { day: number; start: string; end: string }[];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const action = (args: Args) => String(args['action'] ?? '');

interface Me {
  user: { fullName: string; settings: Record<string, unknown> };
}

const meOf = (db: Db, ctx: ToolContext) => query<Me>(db, ctx, 'account.me');

/** Which email goes with which switch, in the words the settings screen uses. */
const EMAIL_SWITCHES: Record<string, { key: string; label: string }> = {
  emailWhenCustomerWaiting: { key: 'unansweredEmail', label: 'A customer is waiting' },
  morningEmail: { key: 'attentionDigest', label: 'The morning list' },
  eveningEmail: { key: 'eveningSummary', label: 'The end-of-day email' },
  emailWhenAiHandsOver: { key: 'aiHandoff', label: 'Your AI hands a customer over' },
  emailWhenBooked: { key: 'bookingEmail', label: 'Someone books' },
  emailWhenPaid: { key: 'paymentEmail', label: 'Someone pays' },
  emailWhenAddonNeedsYou: { key: 'addonEmail', label: 'An add-on needs you' },
};

const APPEARANCE_WORDS: Record<string, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Whatever this device is set to',
};

const updateMyAccount: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { user } = await meOf(db, ctx);
    const fields: Field[] = [];
    const name = str(args['fullName']);
    if (name) {
      fields.push({ label: 'Your name', value: name });
      if (name !== user.fullName) fields.push({ label: 'Was', value: user.fullName });
    }
    const appearance = str(args['appearance']);
    if (appearance)
      fields.push({ label: 'Appearance', value: APPEARANCE_WORDS[appearance] ?? appearance });
    for (const [arg, { label }] of Object.entries(EMAIL_SWITCHES)) {
      const value = bool(args[arg]);
      if (value !== undefined)
        fields.push({ label: `Email when: ${label}`, value: value ? 'Yes' : 'No' });
    }
    return {
      card: settingsCard(toolCallId, 'update_my_account', {
        title: 'Change your account',
        fields,
        confirmLabel: 'Save the change',
      }),
      result: { waiting: true, changes: fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const { user } = await meOf(db, ctx);
    const notifications = {
      ...((user.settings['notifications'] as Record<string, boolean> | undefined) ?? {}),
    };
    let touchedNotifications = false;
    for (const [arg, { key }] of Object.entries(EMAIL_SWITCHES)) {
      const value = bool(args[arg]);
      if (value !== undefined) {
        notifications[key] = value;
        touchedNotifications = true;
      }
    }
    const settings = {
      ...(str(args['appearance']) ? { theme: str(args['appearance']) } : {}),
      ...(touchedNotifications ? { notifications } : {}),
    };
    await command(db, ctx, 'user.update_profile', {
      ...(str(args['fullName']) ? { fullName: str(args['fullName']) } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
    });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings`,
      command: 'user.update_profile',
    };
  },
};

/** "Sep 24" and "Sep 24 to Sep 26", from local dates the model wrote. */
const dayWords = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return plainSpaces(
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      Date.UTC(y!, (m ?? 1) - 1, d ?? 1),
    ),
  );
};

const updateMyHours: SettingsConfirmTool = {
  async prepare(_db, _ctx, args, toolCallId) {
    const act = action(args);
    if (act === 'set_hours')
      return {
        card: settingsCard(toolCallId, 'update_my_hours', {
          title: 'Change your working hours',
          fields: [{ label: 'Your week', value: hoursLine((args['weekly'] as Hours) ?? []) }],
          confirmLabel: 'Save my hours',
          warnings: [{ kind: 'note', text: 'Visits already booked stay; this is about new ones.' }],
        }),
        result: { waiting: true },
      };
    if (act === 'remove_time_off')
      return {
        card: settingsCard(toolCallId, 'update_my_hours', {
          title: 'Put that time back',
          fields: [{ label: 'What changes', value: 'You can be booked then again' }],
          confirmLabel: 'Put it back',
        }),
        result: { waiting: true },
      };
    const start = str(args['startDate']);
    const end = str(args['endDate']);
    const partial = str(args['startsAt']);
    return {
      card: settingsCard(toolCallId, 'update_my_hours', {
        title: 'Put time off in your calendar',
        fields: [
          {
            label: 'When',
            value: partial
              ? 'Part of a day'
              : end && end !== start
                ? `${dayWords(start ?? '')} to ${dayWords(end)}`
                : dayWords(start ?? ''),
          },
          ...(str(args['note']) ? [{ label: 'What it is', value: str(args['note'])! }] : []),
        ],
        confirmLabel: 'Book the time off',
        warnings: [{ kind: 'note', text: 'Nobody can book you then. Visits already booked stay.' }],
      }),
      result: { waiting: true },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/settings/my-calendar`;
    if (act === 'set_hours') {
      await command(db, ctx, 'schedule.set', { ownerKind: 'user', weekly: args['weekly'] ?? [] });
      return { outcome: 'Your hours are saved', href, command: 'schedule.set' };
    }
    if (act === 'remove_time_off') {
      await command(db, ctx, 'time_off.remove', { exceptionId: args['exceptionId'] });
      return { outcome: 'Put back', href, command: 'time_off.remove' };
    }
    await command(db, ctx, 'time_off.add', {
      ownerKind: 'user',
      kind: 'unavailable',
      ...(str(args['startsAt'])
        ? { startsAt: args['startsAt'], endsAt: args['endsAt'] }
        : {
            startDate: args['startDate'],
            ...(str(args['endDate']) ? { endDate: args['endDate'] } : {}),
          }),
      ...(str(args['note']) ? { note: str(args['note']) } : {}),
    });
    return { outcome: 'Time off is in your calendar', href, command: 'time_off.add' };
  },
};

export const settingsMeConfirmTools: Record<string, SettingsConfirmTool> = {
  update_my_account: updateMyAccount,
  update_my_hours: updateMyHours,
};
