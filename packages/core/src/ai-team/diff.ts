/**
 * What changed between two teammate settings documents, as short lines for revision history and the save
 * dialog: "Name: Ava → Max", "Books appointments: off → on", "Added the question “Do you own the home?”".
 */
import { formatDuration, formatHours } from '../calendar/format';
import type { NotifyWho } from '../workflows/actions';
import type { TeammateCatalogs } from './catalogs';
import type { DisclosureMode, HoursMode, TeammateConfig, UnsureAction } from './config';

export const DISCLOSURE_NAMES: Readonly<Record<DisclosureMode, string>> = {
  first_message: 'in its first message',
  when_asked: 'when asked',
};

export const HOURS_MODE_NAMES: Readonly<Record<HoursMode, string>> = {
  always: 'all the time',
  after_hours: 'when you’re closed',
  custom: 'set hours',
};

const UNSURE_NAMES: Readonly<Record<UnsureAction, string>> = {
  hand_off: 'hands to a person',
  take_message: 'takes a message',
};

export type TeammateNames = Partial<
  Pick<TeammateCatalogs, 'emailAddresses' | 'chatWidgets' | 'calendars' | 'members' | 'pipelines'>
>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const onOff = (v: boolean) => (v ? 'on' : 'off');
const percent = (v: number) => `${v}%`;
const joinAnd = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** "owners and admins", "Dale and Priya", "the lead’s assignee", or "no one". */
export function notifyText(who: NotifyWho | null, names: TeammateNames = {}): string {
  if (!who) return 'no one';
  switch (who.kind) {
    case 'admins':
      return 'owners and admins';
    case 'users':
      return joinAnd(
        who.userIds.map(
          (u) =>
            (typeof u === 'string' && names.members?.find((m) => m.userId === u)?.name) ||
            'someone',
        ),
      );
    case 'lead_assignee':
      return 'the lead’s assignee';
    case 'person_owner':
      return 'the customer’s owner';
  }
}

export function diffTeammateConfigs(
  a: TeammateConfig,
  b: TeammateConfig,
  names: TeammateNames = {},
): string[] {
  const lines: string[] = [];
  const change = <T>(label: string, x: T, y: T, fmt: (v: T) => string = String) => {
    if (!same(x, y)) lines.push(`${label}: ${fmt(x)} → ${fmt(y)}`);
  };
  const address = (id: string | null) =>
    id ? (names.emailAddresses?.find((x) => x.id === id)?.address ?? 'an address') : 'none';
  const widget = (id: string | null) =>
    id ? (names.chatWidgets?.find((x) => x.id === id)?.name ?? 'a chat widget') : 'none';
  const calendarLine = (verb: 'Added' | 'Removed', id: string) => {
    const name = names.calendars?.find((x) => x.id === id)?.name;
    return name ? `${verb} the calendar ${name}` : `${verb} a calendar`;
  };
  const stage = (id: string | null) => {
    if (!id) return 'stay where they are';
    for (const p of names.pipelines ?? []) {
      const s = p.stages.find((x) => x.id === id);
      if (s) return s.name;
    }
    return 'a stage';
  };

  // Identity
  change('Name', a.identity.name, b.identity.name);
  change('Says it’s AI', a.identity.disclosure, b.identity.disclosure, (v) => DISCLOSURE_NAMES[v]);
  if (a.identity.signature !== b.identity.signature) lines.push('Signature changed');
  if (a.identity.toneNote !== b.identity.toneNote) lines.push('Tone note changed');

  // Channels
  change('Texting', a.channels.sms, b.channels.sms, onOff);
  change('Email', a.channels.email, b.channels.email, onOff);
  change('Website chat', a.channels.chat, b.channels.chat, onOff);
  change('Emails from', a.channels.emailAddressId, b.channels.emailAddressId, address);
  change('Chat widget', a.channels.widgetId, b.channels.widgetId, widget);

  // Respond and answer
  change('Replies to leads', a.respond.enabled, b.respond.enabled, onOff);
  change('Messages new leads', a.respond.newLeads.enabled, b.respond.newLeads.enabled, onOff);
  change('First message by', a.respond.newLeads.channel, b.respond.newLeads.channel, (v) =>
    v === 'sms' ? 'text' : 'email',
  );
  change(
    'Waits before the first message',
    a.respond.newLeads.delayMinutes,
    b.respond.newLeads.delayMinutes,
    (v) => (v === 0 ? 'no wait' : formatDuration(v)),
  );
  change('Answers questions', a.answer.enabled, b.answer.enabled, onOff);
  change('When unsure', a.answer.whenUnsure, b.answer.whenUnsure, (v) => UNSURE_NAMES[v]);

  // Qualify
  change('Qualifies leads', a.qualify.enabled, b.qualify.enabled, onOff);
  const qBefore = new Map(a.qualify.questions.map((q) => [q.id, q]));
  const qAfter = new Map(b.qualify.questions.map((q) => [q.id, q]));
  for (const q of b.qualify.questions) {
    const old = qBefore.get(q.id);
    if (!old) lines.push(`Added the question “${q.question}”`);
    else if (!same(old, q)) lines.push(`Changed the question “${q.question}”`);
  }
  for (const q of a.qualify.questions)
    if (!qAfter.has(q.id)) lines.push(`Removed the question “${q.question}”`);
  const order = (c: TeammateConfig) =>
    c.qualify.questions.map((q) => q.id).filter((id) => qBefore.has(id) && qAfter.has(id));
  if (!same(order(a), order(b))) lines.push('Question order changed');
  change(
    'Qualified leads move to',
    a.qualify.whenQualified.stageId,
    b.qualify.whenQualified.stageId,
    stage,
  );
  change(
    'Who hears about qualified leads',
    a.qualify.whenQualified.notify,
    b.qualify.whenQualified.notify,
    (v) => notifyText(v, names),
  );
  change(
    'Offers qualified leads times to book',
    a.qualify.whenQualified.offerTimes,
    b.qualify.whenQualified.offerTimes,
    onOff,
  );
  change(
    'Tells the team when a lead isn’t a fit',
    a.qualify.whenNotAFit.tellTeam,
    b.qualify.whenNotAFit.tellTeam,
    onOff,
  );

  // Book
  change('Books appointments', a.book.enabled, b.book.enabled, onOff);
  for (const id of b.book.calendarIds)
    if (!a.book.calendarIds.includes(id)) lines.push(calendarLine('Added', id));
  for (const id of a.book.calendarIds)
    if (!b.book.calendarIds.includes(id)) lines.push(calendarLine('Removed', id));
  change('Reschedules', a.book.reschedule, b.book.reschedule, onOff);
  change('Cancellations', a.book.cancel, b.book.cancel, onOff);

  // Follow up and hours
  change('Follows up', a.followUp.enabled, b.followUp.enabled, onOff);
  change('Most nudges', a.followUp.maxNudges, b.followUp.maxNudges);
  change('Works', a.hours.mode, b.hours.mode, (v) => HOURS_MODE_NAMES[v]);
  if (b.hours.mode === 'custom')
    change('Hours', a.hours.custom, b.hours.custom, (v) => formatHours(v));

  // Autonomy and limits
  change('Approvals before automatic', a.autonomy.approvalsNeeded, b.autonomy.approvalsNeeded);
  change(
    'Drafts expire after',
    a.autonomy.draftExpiresMinutes,
    b.autonomy.draftExpiresMinutes,
    formatDuration,
  );
  change(
    'Replies per conversation a day',
    a.limits.repliesPerConversationPerDay,
    b.limits.repliesPerConversationPerDay,
  );
  change('Tool steps per reply', a.limits.toolRounds, b.limits.toolRounds);
  change(
    'Share of the daily AI limit',
    a.limits.dailySharePercent,
    b.limits.dailySharePercent,
    percent,
  );

  // Money
  change('Discounts', a.money.discounts, b.money.discounts, (v) =>
    v === 'never' ? 'never' : 'with approval',
  );
  change('Largest discount', a.money.maxPercent, b.money.maxPercent, percent);

  // Hand-off
  change('Hands off when frustrated', a.handOff.onFrustration, b.handOff.onFrustration, onOff);
  const topics = (c: TeammateConfig) => c.handOff.sensitiveTopics.map((t) => t.toLowerCase());
  for (const t of b.handOff.sensitiveTopics)
    if (!topics(a).includes(t.toLowerCase())) lines.push(`Added the topic “${t}”`);
  for (const t of a.handOff.sensitiveTopics)
    if (!topics(b).includes(t.toLowerCase())) lines.push(`Removed the topic “${t}”`);
  change('Who hears about hand-offs', a.handOff.notify, b.handOff.notify, (v) =>
    notifyText(v, names),
  );
  if (a.handOff.tellCustomer !== b.handOff.tellCustomer) lines.push('Hand-off message changed');
  return lines;
}
