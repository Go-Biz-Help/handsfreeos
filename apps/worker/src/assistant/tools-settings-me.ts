/**
 * The person's own settings (M12, step six): their name, light or dark, which emails HandsFreeOS sends them, their
 * working hours and their time off.
 *
 * These belong to one person rather than to the business, so they need no permission beyond using the Assistant —
 * and they are about the person asking. The one exception is hours: owners and admins set a teammate's week, time
 * zone and time off too, as Members → ⋯ → Edit hours does, and the hours commands check that it's theirs to set.
 */

import { HfosError, plainSpaces, zonePickLabel } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { firstName } from './calendar-format';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
import {
  dryRun,
  hoursLine,
  settingsCard,
  type SettingsConfirmTool,
} from './tools-settings-calendar';

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

/** Whose hours these are: the person asking, or the teammate named (owners and admins). */
const ownerOf = (ctx: ToolContext, args: Args) => str(args['userId']) ?? ctx.actor.userId;

/** The saved week, for a set_hours that changes only the time zone. */
async function savedWeek(db: Db, ctx: ToolContext, userId: string): Promise<Hours> {
  const now = Date.now();
  const team = await query<{ people: { weekly: Hours }[] }>(db, ctx, 'schedule.team', {
    from: new Date(now).toISOString(),
    to: new Date(now + 86_400_000).toISOString(),
    userIds: [userId],
  });
  return team.people[0]?.weekly ?? [];
}

/** A teammate's name, or null when the hours are the person's own. */
async function teammateOf(db: Db, ctx: ToolContext, args: Args): Promise<string | null> {
  const userId = ownerOf(ctx, args);
  if (userId === ctx.actor.userId) return null;
  const team = await query<{
    members: { userId: string; fullName: string; email: string }[];
    organizationAdmins: { userId: string; fullName: string; email: string }[];
  }>(db, ctx, 'workspace.members');
  const m = [...team.members, ...team.organizationAdmins].find((x) => x.userId === userId);
  if (!m)
    throw HfosError.notFound(
      'That person isn’t on this business’s team. Pick a teammate from list_team.',
    );
  return m.fullName || m.email;
}

/** The hours command update_my_hours runs, the same for the card's dry run and for Confirm. */
async function saveHours(db: Db, ctx: ToolContext, args: Args): Promise<string> {
  const act = action(args);
  const userId = ownerOf(ctx, args);
  // Somebody else's go by their id; the kernel lets only owners and admins (calendars.manage) set those.
  const owner = { ownerKind: 'user', ...(userId === ctx.actor.userId ? {} : { ownerId: userId }) };
  if (act === 'set_hours') {
    // Only the zone: the week stays as it's saved.
    const weekly =
      args['weekly'] ??
      (zoneArg(args).timezone !== undefined ? await savedWeek(db, ctx, userId) : []);
    await command(db, ctx, 'schedule.set', { ...owner, weekly, ...zoneArg(args) });
    return 'schedule.set';
  }
  if (act === 'remove_time_off') {
    await command(db, ctx, 'time_off.remove', { exceptionId: args['exceptionId'] });
    return 'time_off.remove';
  }
  await command(db, ctx, 'time_off.add', {
    ...owner,
    kind: 'unavailable',
    ...(str(args['startsAt'])
      ? { startsAt: args['startsAt'], endsAt: args['endsAt'] }
      : {
          startDate: args['startDate'],
          ...(str(args['endDate']) ? { endDate: args['endDate'] } : {}),
        }),
    ...(str(args['note']) ? { note: str(args['note']) } : {}),
  });
  return 'time_off.add';
}

/** set_hours' zone as schedule.set takes it: a zone, null to follow the business's, or left as it is. */
const zoneArg = (args: Args): { timezone?: string | null } => {
  const zone = str(args['timeZone']);
  return zone === undefined ? {} : { timezone: zone === 'business' ? null : zone };
};

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
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const who = await teammateOf(db, ctx, args);
    // A teammate's: the command runs once and is rolled back, so a refusal (not an owner or admin, a time off
    // that isn't theirs) is said before the card rather than after Confirm.
    if (who) await dryRun(db, (tx) => saveHours(tx, ctx, args));
    const your = who ? `${firstName(who)}’s` : 'your';
    const Your = who ? your : 'Your';
    if (act === 'set_hours') {
      const zone = zoneArg(args).timezone;
      return {
        card: settingsCard(toolCallId, 'update_my_hours', {
          title: args['weekly'] ? `Change ${your} working hours` : `Change ${your} time zone`,
          fields: [
            ...(who ? [{ label: 'Whose', value: who }] : []),
            ...(args['weekly']
              ? [{ label: `${Your} week`, value: hoursLine(args['weekly'] as Hours) }]
              : []),
            ...(zone !== undefined
              ? [
                  {
                    label: `${Your} hours are in`,
                    value: zone ? zonePickLabel(zone) : 'The business’s time zone',
                  },
                ]
              : []),
          ],
          confirmLabel: who ? 'Save the hours' : 'Save my hours',
          warnings: [{ kind: 'note', text: 'Visits already booked stay; this is about new ones.' }],
        }),
        result: { waiting: true, ...(who ? { whose: who } : {}) },
      };
    }
    if (act === 'remove_time_off')
      return {
        card: settingsCard(toolCallId, 'update_my_hours', {
          title: 'Put that time back',
          fields: [
            ...(who ? [{ label: 'Whose', value: who }] : []),
            {
              label: 'What changes',
              value: who
                ? `${firstName(who)} can be booked then again`
                : 'You can be booked then again',
            },
          ],
          confirmLabel: 'Put it back',
        }),
        result: { waiting: true, ...(who ? { whose: who } : {}) },
      };
    const start = str(args['startDate']);
    const end = str(args['endDate']);
    const partial = str(args['startsAt']);
    return {
      card: settingsCard(toolCallId, 'update_my_hours', {
        title: `Put time off in ${your} calendar`,
        fields: [
          ...(who ? [{ label: 'Whose', value: who }] : []),
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
        warnings: [
          {
            kind: 'note',
            text: `Nobody can book ${who ? firstName(who) : 'you'} then. Visits already booked stay.`,
          },
        ],
      }),
      result: { waiting: true, ...(who ? { whose: who } : {}) },
    };
  },

  async commit(db, ctx, args) {
    const who = await teammateOf(db, ctx, args);
    const userId = ownerOf(ctx, args);
    const href = `/app/w/${ctx.workspaceId}/settings/my-calendar${who ? `?user=${userId}` : ''}`;
    const done = await saveHours(db, ctx, args);
    const your = who ? `${firstName(who)}’s` : 'your';
    const outcome =
      done === 'schedule.set'
        ? `${who ? your : 'Your'} hours are saved`
        : done === 'time_off.remove'
          ? 'Put back'
          : `Time off is in ${your} calendar`;
    return { outcome, href, command: done };
  },
};

export const settingsMeConfirmTools: Record<string, SettingsConfirmTool> = {
  update_my_account: updateMyAccount,
  update_my_hours: updateMyHours,
};
