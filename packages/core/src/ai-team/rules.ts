/**
 * The teammate's conflict rules, shaped like the calendar's. Settings never lock each other out: when they
 * clash with each other or with the business's setup, an issue says so in a short sentence and offers
 * fixes, either a settings patch or a link to the page that sorts it out. Errors block turning the
 * teammate on (off → training or automatic); nothing blocks saving. Warnings never block.
 *
 * Link fixes carry a path inside the workspace ('settings/texting'); the web puts `/app/w/<id>/` in front.
 */
import type { WeeklyHours } from '../calendar/config';
import { intersect, normalize, subtract, type Interval } from '../calendar/engine/intervals';
import { parseClock } from '../calendar/engine/zoned';
import { formatClock, type QuietHoursWindow } from '../messaging/quiet-hours';
import type { NotifyWho } from '../workflows/actions';
import type { TeammateCatalogs, TeammateMember } from './catalogs';
import type { TeammateConfig, TeammatePatch } from './config';
import { suggestedQuestions } from './presets';

export const TEAMMATE_ISSUE_CODES = [
  'no_channel',
  'texting_not_ready',
  'no_email_address',
  'no_chat_widget',
  'booking_needs_calendar',
  'calendar_not_bookable',
  'no_qualifying_questions',
  'nobody_to_notify',
  'thin_knowledge',
  'after_hours_without_hours',
  'quiet_hours_overlap',
  'double_texting',
] as const;
export type TeammateIssueCode = (typeof TEAMMATE_ISSUE_CODES)[number];

export interface TeammatePatchFix {
  readonly id: string;
  readonly label: string;
  readonly patch: TeammatePatch;
}
export interface TeammateLinkFix {
  readonly id: string;
  readonly label: string;
  /** A path inside the workspace, e.g. 'settings/texting'. */
  readonly href: string;
}
export type TeammateIssueFix = TeammatePatchFix | TeammateLinkFix;

export const isPatchFix = (fix: TeammateIssueFix): fix is TeammatePatchFix => 'patch' in fix;

export interface TeammateIssue {
  readonly code: TeammateIssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Dotted settings paths the builder highlights, e.g. 'channels.emailAddressId'. */
  readonly fields: readonly string[];
  readonly fixes: readonly TeammateIssueFix[];
}

/** Whether the issues stop the teammate being turned on. Saving is never blocked. */
export function hasBlockingTeammateIssues(issues: readonly TeammateIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Fewer published answers than this is a thin knowledge base. */
export const THIN_KNOWLEDGE_ITEMS = 5;

/** Where link fixes go, inside the workspace. */
export const TEAMMATE_LINKS = {
  texting: 'settings/texting',
  email: 'settings/email',
  websiteChat: 'settings/website-chat',
  newCalendar: 'settings/calendars/new',
  calendar: (id: string) => `settings/calendars/${id}`,
  /** The calendar with its name and description open, to say what it's for. */
  calendarDetails: (id: string) => `settings/calendars/${id}?details=1`,
  newKnowledge: 'knowledge/items/new',
  profile: 'knowledge/profile',
  businessHours: 'settings/workspace',
  workflow: (id: string) => `workflows/${id}`,
} as const;

// ---- Week arithmetic (minutes of the week, Sunday 00:00 is 0, the workspace's zone) ----

const DAY = 1440;

function weekIntervals(hours: WeeklyHours): Interval[] {
  return normalize(
    hours.map((h) => ({
      start: h.day * DAY + parseClock(h.start),
      end: h.day * DAY + parseClock(h.end),
    })),
  );
}

function quietIntervals(q: QuietHoursWindow): Interval[] {
  const s = parseClock(q.start);
  const e = parseClock(q.end);
  if (!q.enabled || s === e) return [];
  const out: Interval[] = [];
  for (let d = 0; d < 7; d++) {
    const base = d * DAY;
    if (s < e) out.push({ start: base + s, end: base + e });
    else out.push({ start: base + s, end: base + DAY }, { start: base, end: base + e });
  }
  return normalize(out);
}

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Intervals back to weekly hours, split at midnight ('24:00' ends a day). */
function toWeeklyHours(list: readonly Interval[]): WeeklyHours {
  const out: { day: number; start: string; end: string }[] = [];
  for (const i of list) {
    let start = i.start;
    while (start < i.end) {
      const day = Math.floor(start / DAY);
      const end = Math.min(i.end, (day + 1) * DAY);
      out.push({ day, start: hhmm(start - day * DAY), end: hhmm(end - day * DAY) });
      start = end;
    }
  }
  return out;
}

// ---- Rules ----

interface Ctx {
  readonly config: TeammateConfig;
  readonly catalogs: TeammateCatalogs;
  readonly now: number;
  readonly push: (issue: TeammateIssue) => void;
}

function channelRules({ config, catalogs, push }: Ctx): void {
  const c = config.channels;
  const address = catalogs.emailAddresses[0];
  const widget = catalogs.chatWidgets[0];

  if (!c.sms && !c.email && !c.chat)
    push({
      code: 'no_channel',
      severity: 'error',
      message: 'Turn on at least one channel',
      fields: ['channels'],
      fixes: [
        ...(address
          ? [
              {
                id: 'email_on',
                label: `Turn on email (${address.address})`,
                patch: { channels: { email: true, emailAddressId: address.id } },
              },
            ]
          : []),
        ...(widget
          ? [
              {
                id: 'chat_on',
                label: `Turn on website chat (${widget.name})`,
                patch: { channels: { chat: true, widgetId: widget.id } },
              },
            ]
          : []),
        { id: 'sms_on', label: 'Turn on texting', patch: { channels: { sms: true } } },
      ],
    });

  if (c.sms && !catalogs.textingReady)
    push({
      code: 'texting_not_ready',
      severity: 'warning',
      message: 'Texting isn’t set up yet, so it can’t text customers',
      fields: ['channels.sms'],
      fixes: [
        { id: 'set_up_texting', label: 'Set up texting', href: TEAMMATE_LINKS.texting },
        { id: 'sms_off', label: 'Turn off texting', patch: { channels: { sms: false } } },
      ],
    });

  if (c.email && !catalogs.emailAddresses.some((a) => a.id === c.emailAddressId))
    push({
      code: 'no_email_address',
      severity: 'error',
      message: c.emailAddressId
        ? 'The address it emailed from was removed'
        : 'Pick the address it emails from',
      fields: ['channels.emailAddressId'],
      fixes: [
        address
          ? {
              id: 'use_address',
              label: `Use ${address.address}`,
              patch: { channels: { emailAddressId: address.id } },
            }
          : { id: 'add_address', label: 'Add an email address', href: TEAMMATE_LINKS.email },
        { id: 'email_off', label: 'Turn off email', patch: { channels: { email: false } } },
      ],
    });

  if (c.chat && !catalogs.chatWidgets.some((w) => w.id === c.widgetId))
    push({
      code: 'no_chat_widget',
      severity: 'error',
      message: c.widgetId
        ? 'The website chat it answered was removed'
        : 'Pick the website chat it answers',
      fields: ['channels.widgetId'],
      fixes: [
        widget
          ? {
              id: 'use_widget',
              label: `Use ${widget.name}`,
              patch: { channels: { widgetId: widget.id } },
            }
          : {
              id: 'set_up_chat',
              label: 'Set up website chat',
              href: TEAMMATE_LINKS.websiteChat,
            },
        { id: 'chat_off', label: 'Turn off website chat', patch: { channels: { chat: false } } },
      ],
    });
}

function bookingRules({ config, catalogs, push }: Ctx): void {
  if (!config.book.enabled) return;
  const ids = config.book.calendarIds;
  const open = catalogs.calendars.filter((c) => !c.archived && c.bookableOnline);

  if (!ids.length) {
    const first = open[0];
    push({
      code: 'booking_needs_calendar',
      severity: 'error',
      message: 'Booking needs a calendar',
      fields: ['book.calendarIds'],
      fixes: [
        first
          ? {
              id: 'add_calendar',
              label: `Add ${first.name}`,
              patch: { book: { calendarIds: [first.id] } },
            }
          : { id: 'new_calendar', label: 'Create a calendar', href: TEAMMATE_LINKS.newCalendar },
        { id: 'booking_off', label: 'Turn off booking', patch: { book: { enabled: false } } },
      ],
    });
  }

  for (const id of ids) {
    const cal = catalogs.calendars.find((c) => c.id === id);
    if (cal && !cal.archived && cal.bookableOnline) continue;
    push({
      code: 'calendar_not_bookable',
      severity: 'error',
      message: !cal
        ? 'A calendar it books on was deleted'
        : cal.archived
          ? `${cal.name} was archived`
          : `${cal.name} isn’t open for online booking`,
      fields: ['book.calendarIds'],
      fixes: [
        {
          id: 'remove_calendar',
          label: `Remove ${cal ? cal.name : 'it'}`,
          patch: { book: { calendarIds: ids.filter((x) => x !== id) } },
        },
        ...(cal && !cal.archived
          ? [{ id: 'open_calendar', label: `Open ${cal.name}`, href: TEAMMATE_LINKS.calendar(id) }]
          : []),
      ],
    });
  }
}

function qualifyRules({ config, catalogs, push }: Ctx): void {
  if (config.qualify.enabled && !config.qualify.questions.length)
    push({
      code: 'no_qualifying_questions',
      severity: 'error',
      message: 'Qualifying needs questions',
      fields: ['qualify.questions'],
      fixes: [
        {
          id: 'add_suggested',
          label: 'Add suggested questions',
          patch: { qualify: { questions: suggestedQuestions(catalogs.industry) } },
        },
        { id: 'qualify_off', label: 'Turn off qualifying', patch: { qualify: { enabled: false } } },
      ],
    });
}

/** Whether a notify setting reaches anyone. The lead's assignee or the customer's owner is known only at the time. */
function reaches(who: NotifyWho, members: readonly TeammateMember[]): boolean {
  switch (who.kind) {
    case 'admins':
      return members.some((m) => m.active && m.role !== 'member');
    case 'users':
      return who.userIds.some(
        (u) => typeof u === 'string' && members.some((m) => m.userId === u && m.active),
      );
    default:
      return true;
  }
}

function notifyRules({ config, catalogs, push }: Ctx): void {
  const admins = catalogs.members.some((m) => m.active && m.role !== 'member');
  const someone = catalogs.members.find((m) => m.active);

  if (!reaches(config.handOff.notify, catalogs.members))
    push({
      code: 'nobody_to_notify',
      severity: 'error',
      message: 'Nobody hears about hand-offs',
      fields: ['handOff.notify'],
      fixes: [
        ...(admins && config.handOff.notify.kind !== 'admins'
          ? [
              {
                id: 'notify_admins',
                label: 'Tell owners and admins',
                patch: { handOff: { notify: { kind: 'admins' as const } } },
              },
            ]
          : []),
        ...(someone
          ? [
              {
                id: 'notify_person',
                label: `Tell ${someone.name}`,
                patch: {
                  handOff: { notify: { kind: 'users' as const, userIds: [someone.userId] } },
                },
              },
            ]
          : []),
      ],
    });

  const qualified = config.qualify.whenQualified.notify;
  if (config.qualify.enabled && qualified && !reaches(qualified, catalogs.members))
    push({
      code: 'nobody_to_notify',
      severity: 'warning',
      message: 'Nobody hears about qualified leads',
      fields: ['qualify.whenQualified.notify'],
      fixes: [
        ...(admins && qualified.kind !== 'admins'
          ? [
              {
                id: 'notify_admins',
                label: 'Tell owners and admins',
                patch: { qualify: { whenQualified: { notify: { kind: 'admins' as const } } } },
              },
            ]
          : []),
        {
          id: 'notify_nobody',
          label: 'Don’t tell anyone',
          patch: { qualify: { whenQualified: { notify: null } } },
        },
      ],
    });
}

function knowledgeRules({ config, catalogs, push }: Ctx): void {
  if (!config.answer.enabled) return;
  const items = catalogs.knowledge.published;
  const { filled, total } = catalogs.profile;
  const thinItems = items < THIN_KNOWLEDGE_ITEMS;
  const thinProfile = filled < Math.ceil(total / 2);
  if (!thinItems && !thinProfile) return;
  push({
    code: 'thin_knowledge',
    severity: 'warning',
    message: thinItems
      ? items === 0
        ? 'The knowledge base is empty, so it can’t answer questions'
        : `The knowledge base has only ${items} ${items === 1 ? 'answer' : 'answers'}`
      : 'The business profile is mostly empty',
    fields: ['answer.enabled'],
    fixes: [
      ...(thinItems
        ? [{ id: 'add_answers', label: 'Add answers', href: TEAMMATE_LINKS.newKnowledge }]
        : []),
      ...(thinProfile
        ? [
            {
              id: 'fill_profile',
              label: 'Fill in the business profile',
              href: TEAMMATE_LINKS.profile,
            },
          ]
        : []),
    ],
  });
}

function hoursRules({ config, catalogs, push }: Ctx): void {
  const h = config.hours;
  if (h.mode === 'after_hours' && !catalogs.businessHours?.length)
    push({
      code: 'after_hours_without_hours',
      severity: 'error',
      message: 'After-hours mode needs your business hours',
      fields: ['hours.mode'],
      fixes: [
        { id: 'work_always', label: 'Work all the time', patch: { hours: { mode: 'always' } } },
        {
          id: 'set_business_hours',
          label: 'Set business hours',
          href: TEAMMATE_LINKS.businessHours,
        },
      ],
    });

  // Texts it starts itself wait for the morning, and at night it only answers texts that just came in.
  const q = catalogs.quietHours;
  if (h.mode !== 'custom' || !config.channels.sms || !q.enabled) return;
  const quiet = quietIntervals(q);
  const work = weekIntervals(h.custom);
  if (!intersect(work, quiet).length) return;
  const trimmed = toWeeklyHours(subtract(work, quiet));
  push({
    code: 'quiet_hours_overlap',
    severity: 'warning',
    message: `Its hours overlap quiet hours (${formatClock(q.start)}–${formatClock(q.end)}), when it only answers new texts`,
    fields: ['hours.custom'],
    fixes: [
      ...(trimmed.length
        ? [
            {
              id: 'trim_hours',
              label: 'Keep its hours out of quiet hours',
              patch: { hours: { custom: trimmed } },
            },
          ]
        : []),
      { id: 'change_quiet_hours', label: 'Change quiet hours', href: TEAMMATE_LINKS.texting },
    ],
  });
}

function doubleTextingRules({ config, catalogs, push }: Ctx): void {
  const r = config.respond;
  const [first] = catalogs.newLeadTextWorkflows;
  if (
    !first ||
    !r.enabled ||
    !r.newLeads.enabled ||
    r.newLeads.channel !== 'sms' ||
    !config.channels.sms
  )
    return;
  const count = catalogs.newLeadTextWorkflows.length;
  push({
    code: 'double_texting',
    severity: 'warning',
    message:
      count === 1
        ? `“${first.name}” also texts new leads`
        : `${count} workflows also text new leads`,
    fields: ['respond.newLeads'],
    fixes: [
      {
        id: 'new_leads_off',
        label: 'Don’t message new leads',
        patch: { respond: { newLeads: { enabled: false } } },
      },
      {
        id: 'open_workflow',
        label: `Open “${first.name}”`,
        href: TEAMMATE_LINKS.workflow(first.id),
      },
    ],
  });
}

/** Every conflict in a teammate's settings, in a stable order. */
export function validateTeammate(
  config: TeammateConfig,
  catalogs: TeammateCatalogs,
  now: Date | number = Date.now(),
): TeammateIssue[] {
  const issues: TeammateIssue[] = [];
  const ctx: Ctx = {
    config,
    catalogs,
    now: typeof now === 'number' ? now : now.getTime(),
    push: (issue) => issues.push(issue),
  };
  channelRules(ctx);
  bookingRules(ctx);
  qualifyRules(ctx);
  notifyRules(ctx);
  knowledgeRules(ctx);
  hoursRules(ctx);
  doubleTextingRules(ctx);
  const order = new Map(TEAMMATE_ISSUE_CODES.map((c, i) => [c, i]));
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => order.get(a.issue.code)! - order.get(b.issue.code)! || a.i - b.i)
    .map((x) => x.issue);
}
