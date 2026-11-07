/**
 * The person's own settings (M12, step six): their name, light or dark, which emails HandsFreeOS sends them, their
 * working hours and their time off.
 *
 * These belong to one person rather than to the business, so they need no permission beyond using the Assistant —
 * and they are about the person asking. The one exception is hours: owners and admins set a teammate's week, time
 * zone and time off too, as Members → ⋯ → Edit hours does, and the hours commands check that it's theirs to set.
 */

import {
  APPEARANCE_LABELS,
  EMAIL_ONLY_ROWS,
  HfosError,
  NOTIFICATION_ROWS,
  plainSpaces,
  zonePickLabel,
  type AppearanceChoice,
  type EmailSwitch,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { firstName } from './calendar-format';
import type { ToolContext } from './runtime';
import { scheduleWords, type TeamSchedule } from './schedule-words';
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

const DAY = 86_400_000;

/** One time off or extra open time, as get_settings (my_calendar) and read_schedule_team list it. */
interface Listed {
  exceptionId: string;
  when: string;
  note?: string;
}

/**
 * The time off remove_time_off takes out, found among whose hours these are (yesterday to two months out, as
 * Settings → My calendar lists them), so the card says which time comes back and whose it is. Extra open time is
 * marked, since taking that out closes the time instead. Refused, before any card, when it isn't theirs there.
 */
async function timeOffToRemove(
  db: Db,
  ctx: ToolContext,
  args: Args,
  who: string | null,
): Promise<Listed & { extra: boolean }> {
  const exceptionId = str(args['exceptionId']);
  const read = who
    ? `read_schedule_team with ${firstName(who)}’s userId`
    : 'get_settings (area my_calendar)';
  if (!exceptionId)
    throw HfosError.validation(
      [{ path: 'exceptionId', message: 'Say which time off.' }],
      `Say which time off to take out: pass its exceptionId, as ${read} lists it.`,
    );
  const now = Date.now();
  const team = await query<TeamSchedule>(db, ctx, 'schedule.team', {
    from: new Date(now - DAY).toISOString(),
    to: new Date(now + 60 * DAY).toISOString(),
    userIds: [ownerOf(ctx, args)],
  });
  const theirs = scheduleWords(team).people[0];
  const off = theirs?.timeOff.find((t) => t.exceptionId === exceptionId);
  const extra = theirs?.extraOpenTime?.find((t) => t.exceptionId === exceptionId);
  if (!off && !extra)
    throw HfosError.rule(
      'time_off_not_found',
      404,
      `That time off isn’t on ${who ? `${firstName(who)}’s` : 'your'} calendar from yesterday to two months out. Read it again with ${read} and pass the exceptionId listed there${who ? '' : ', or give userId for a teammate’s'}.`,
    );
  return { ...(off ?? extra)!, extra: !off };
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

/** Each input's email switch. */
const EMAIL_KEYS: Record<string, EmailSwitch> = {
  emailWhenCustomerWaiting: 'unansweredEmail',
  morningEmail: 'attentionDigest',
  eveningEmail: 'eveningSummary',
  emailWhenAiHandsOver: 'aiHandoff',
  emailWhenBooked: 'bookingEmail',
  emailWhenPaid: 'paymentEmail',
  emailWhenAddonNeedsYou: 'addonEmail',
};

/** Which email goes with which switch, named as its row on Settings → Account's Notifications ("Urgent items"). */
const EMAIL_SWITCHES: Record<string, { key: EmailSwitch; label: string }> = Object.fromEntries(
  Object.entries(EMAIL_KEYS).map(([arg, key]) => [
    arg,
    {
      key,
      label: [...NOTIFICATION_ROWS, ...EMAIL_ONLY_ROWS].find((r) => r.email === key)?.title ?? key,
    },
  ]),
);

/** Said on the card whenever it changes the look: the phone app keeps its own, which this never touches. */
const WEB_LOOK_ONLY =
  'This changes the web app, for every browser you sign in on. The phone app keeps its own: set it on the phone under More → Settings → Appearance.';

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
      fields.push({
        label: 'Web app’s appearance',
        value: APPEARANCE_LABELS[appearance as AppearanceChoice] ?? appearance,
      });
    for (const [arg, { label }] of Object.entries(EMAIL_SWITCHES)) {
      const value = bool(args[arg]);
      if (value !== undefined)
        fields.push({ label: `Email: ${label}`, value: value ? 'On' : 'Off' });
    }
    return {
      card: settingsCard(toolCallId, 'update_my_account', {
        title: 'Change your account',
        fields,
        confirmLabel: 'Save the change',
        ...(appearance ? { warnings: [{ kind: 'note' as const, text: WEB_LOOK_ONLY }] } : {}),
      }),
      result: {
        waiting: true,
        changes: fields.map((f) => f.label),
        ...(appearance ? { note: WEB_LOOK_ONLY } : {}),
      },
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
      // Notifications' own section when only emails changed: the phone opens its Notifications screen for it.
      href: `/app/w/${ctx.workspaceId}/settings${touchedNotifications && !settings.theme && !str(args['fullName']) ? '#notifications' : ''}`,
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
    if (act === 'remove_time_off') {
      // Which time comes back, and whose: the card names it rather than an id.
      const off = await timeOffToRemove(db, ctx, args, who);
      const them = who ? firstName(who) : 'you';
      const Them = who ? them : 'You';
      return {
        card: settingsCard(toolCallId, 'update_my_hours', {
          title: off.extra ? 'Take out that extra open time' : 'Put that time back',
          fields: [
            ...(who ? [{ label: 'Whose', value: who }] : []),
            { label: 'When', value: off.when },
            ...(off.note ? [{ label: 'What it is', value: off.note }] : []),
            {
              label: 'What changes',
              value: off.extra
                ? `Nobody can book ${them} then, unless it’s in ${who ? 'their' : 'your'} usual hours`
                : `${Them} can be booked then again`,
            },
          ],
          confirmLabel: off.extra ? 'Take it out' : 'Put it back',
        }),
        result: {
          waiting: true,
          when: off.when,
          ...(off.extra ? { extraOpenTime: true } : {}),
          ...(who ? { whose: who } : {}),
        },
      };
    }
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
    // The time the card named, still theirs: nobody else's is taken out on this card's say-so.
    const off =
      action(args) === 'remove_time_off' ? await timeOffToRemove(db, ctx, args, who) : null;
    const done = await saveHours(db, ctx, args);
    const your = who ? `${firstName(who)}’s` : 'your';
    const outcome =
      done === 'schedule.set'
        ? `${who ? your : 'Your'} hours are saved`
        : done === 'time_off.remove'
          ? off?.extra
            ? 'Taken out'
            : 'Put back'
          : `Time off is in ${your} calendar`;
    return { outcome, href, command: done };
  },
};

export const settingsMeConfirmTools: Record<string, SettingsConfirmTool> = {
  update_my_account: updateMyAccount,
  update_my_hours: updateMyHours,
};
