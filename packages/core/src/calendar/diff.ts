/**
 * What changed between two settings documents, as short lines for revision history and the save dialog:
 * "Assignment: fixed person → round robin", "Added Priya", "Seats: 1 → 10".
 */
import { personName, resourceName, serviceName, type CalendarCatalogs } from './catalogs';
import type { AssignmentMode, CalendarConfig, LocationKind, Reminder } from './config';
import { formatClock } from '../messaging/quiet-hours';
import { formatDuration, formatHours, formatNotice } from './format';

export const ASSIGNMENT_NAMES: Readonly<Record<AssignmentMode, string>> = {
  fixed: 'fixed person',
  customer_choice: 'customer’s choice',
  round_robin: 'round robin',
  weighted: 'weighted round robin',
  first_available: 'first available',
  collective: 'everyone together',
};

export const LOCATION_NAMES: Readonly<Record<LocationKind, string>> = {
  customer_address: 'customer’s address',
  business: 'business',
  virtual: 'video call',
  phone: 'phone call',
};

const SERVICE_MODES = { none: 'off', one: 'one service', choice: 'customer picks' } as const;
const OWNERSHIP = {
  assigned_staff: 'assigned staff',
  calendar_owner: 'calendar owner',
  none: 'nobody',
} as const;
const PAYMENTS = { none: 'none', deposit: 'deposit', full: 'full payment' } as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const onOff = (v: boolean) => (v ? 'on' : 'off');
const minutesOrNone = (v: number) => (v === 0 ? 'none' : formatDuration(v));
const lengths = (list: readonly number[]) => list.map(formatDuration).join(', ');
const reminder = (r: Reminder) =>
  r.kind === 'day_before'
    ? `day before at ${formatClock(r.at)}`
    : `${formatDuration(r.minutes)} before`;

type Names = Partial<
  Pick<CalendarCatalogs, 'team' | 'services' | 'resources' | 'territories' | 'pipelines'>
>;

export function diffConfigs(a: CalendarConfig, b: CalendarConfig, catalogs?: Names): string[] {
  const lines: string[] = [];
  const change = <T>(label: string, x: T, y: T, fmt: (v: T) => string = String) => {
    if (!same(x, y)) lines.push(`${label}: ${fmt(x)} → ${fmt(y)}`);
  };
  const who = (id: string) => personName(catalogs as CalendarCatalogs | undefined, id);
  const territory = (id: string) =>
    catalogs?.territories?.find((t) => t.id === id)?.name ?? 'a territory';

  change('Booking page', a.public, b.public, (v) => (v ? 'public' : 'private'));

  // Team
  const before = new Map(a.team.members.map((m) => [m.userId, m]));
  const after = new Map(b.team.members.map((m) => [m.userId, m]));
  for (const m of b.team.members) if (!before.has(m.userId)) lines.push(`Added ${who(m.userId)}`);
  for (const m of a.team.members) if (!after.has(m.userId)) lines.push(`Removed ${who(m.userId)}`);
  for (const m of b.team.members) {
    const old = before.get(m.userId);
    if (!old) continue;
    change(`${who(m.userId)}’s weight`, old.weight, m.weight);
    change(`${who(m.userId)}’s priority`, old.priority, m.priority);
    change(who(m.userId), old.required, m.required, (v) => (v ? 'required' : 'optional'));
  }
  const order = (c: CalendarConfig) =>
    c.team.members.map((m) => m.userId).filter((u) => before.has(u) && after.has(u));
  if (!same(order(a), order(b))) lines.push('Team order changed');
  change('Assignment', a.team.assignment, b.team.assignment, (v) => ASSIGNMENT_NAMES[v]);
  change('Crew size', a.team.crewSize, b.team.crewSize);

  // Services
  change('Services', a.services.mode, b.services.mode, (v) => SERVICE_MODES[v]);
  const sBefore = new Map(a.services.items.map((i) => [i.serviceId, i]));
  const sAfter = new Map(b.services.items.map((i) => [i.serviceId, i]));
  const svc = (id: string) => serviceName(catalogs as CalendarCatalogs | undefined, id);
  for (const i of b.services.items)
    if (!sBefore.has(i.serviceId)) lines.push(`Added ${svc(i.serviceId)}`);
  for (const i of a.services.items)
    if (!sAfter.has(i.serviceId)) lines.push(`Removed ${svc(i.serviceId)}`);
  for (const i of b.services.items) {
    const old = sBefore.get(i.serviceId);
    if (old && !same(old.overrides, i.overrides))
      lines.push(`${svc(i.serviceId)}: settings on this calendar changed`);
  }

  // Lengths, capacity, schedule
  change('Lengths', a.durations.minutes, b.durations.minutes, lengths);
  change(
    'Customer picks the length',
    a.durations.customerChooses,
    b.durations.customerChooses,
    onOff,
  );
  change('Start times every', a.durations.step, b.durations.step, formatDuration);
  change('Seats', a.capacity.seats, b.capacity.seats);
  change('Largest party', a.capacity.maxPartySize, b.capacity.maxPartySize);
  change('Show seats left', a.capacity.showSeatsLeft, b.capacity.showSeatsLeft, onOff);
  change('Booking', a.schedule.mode, b.schedule.mode, (v) =>
    v === 'hours' ? 'open hours' : 'fixed sessions',
  );
  change('Calendar hours', a.schedule.hours, b.schedule.hours, formatHours);

  // Locations and resources
  const kinds = (c: CalendarConfig) => c.locations.options.map((o) => o.kind);
  change('Locations', kinds(a), kinds(b), (v) =>
    v.length ? v.map((k) => LOCATION_NAMES[k]).join(', ') : 'none',
  );
  if (same(kinds(a), kinds(b)) && !same(a.locations.options, b.locations.options))
    lines.push('Location details changed');
  change(
    'Customer picks the location',
    a.locations.customerChooses,
    b.locations.customerChooses,
    onOff,
  );
  const res = (id: string) => resourceName(catalogs as CalendarCatalogs | undefined, id);
  const rBefore = new Map(a.resources.required.map((r) => [r.resourceId, r.quantity]));
  const rAfter = new Map(b.resources.required.map((r) => [r.resourceId, r.quantity]));
  for (const [id, q] of rAfter) {
    const old = rBefore.get(id);
    if (old === undefined) lines.push(`Added ${res(id)}`);
    else change(`${res(id)} needed`, old, q);
  }
  for (const id of rBefore.keys()) if (!rAfter.has(id)) lines.push(`Removed ${res(id)}`);

  // Buffers and territory
  change('Buffer before', a.buffers.before, b.buffers.before, minutesOrNone);
  change('Buffer after', a.buffers.after, b.buffers.after, minutesOrNone);
  change('Travel time', a.buffers.travelMinutes, b.buffers.travelMinutes, minutesOrNone);
  change('ZIP routing', a.territory.routing === 'zip', b.territory.routing === 'zip', onOff);
  change('Territories', a.territory.territoryIds, b.territory.territoryIds, (v) =>
    v.length ? v.map(territory).join(', ') : 'all',
  );

  // Booking window
  change('Minimum notice', a.window.minNoticeMinutes, b.window.minNoticeMinutes, formatNotice);
  change('Books up to', a.window.maxDaysAhead, b.window.maxDaysAhead, (v) => `${v} days ahead`);
  const range = (c: CalendarConfig) => [c.window.dateFrom, c.window.dateTo] as const;
  change('Date range', range(a), range(b), ([from, to]) =>
    from || to ? `${from ?? 'now'} to ${to ?? 'no end'}` : 'none',
  );
  change(
    'Daily limit per person',
    a.window.dailyLimitPerPerson,
    b.window.dailyLimitPerPerson,
    (v) => (v === null ? 'none' : String(v)),
  );

  // Repeats, waitlist, intake
  change('Staff repeats', a.recurring.staffSeries, b.recurring.staffSeries, onOff);
  change('Customer repeats', a.recurring.customerSeries, b.recurring.customerSeries, onOff);
  change('Most repeats', a.recurring.maxOccurrences, b.recurring.maxOccurrences);
  change('Waitlist', a.waitlist.enabled, b.waitlist.enabled, onOff);
  change('Waitlist offers last', a.waitlist.offerMinutes, b.waitlist.offerMinutes, formatDuration);
  const qBefore = new Map(a.intake.questions.map((q) => [q.id, q]));
  const qAfter = new Map(b.intake.questions.map((q) => [q.id, q]));
  for (const q of b.intake.questions) {
    const old = qBefore.get(q.id);
    if (!old) lines.push(`Added question “${q.label}”`);
    else if (!same(old, q)) lines.push(`Changed question “${q.label}”`);
  }
  for (const q of a.intake.questions)
    if (!qAfter.has(q.id)) lines.push(`Removed question “${q.label}”`);

  // Policies
  const allowed = (v: boolean) => (v ? 'allowed' : 'not allowed');
  const hoursBefore = (v: number) => (v === 0 ? 'any time' : `${v} hours before`);
  change('Cancellations', a.policies.cancel.allowed, b.policies.cancel.allowed, allowed);
  change(
    'Cancel cutoff',
    a.policies.cancel.cutoffHours,
    b.policies.cancel.cutoffHours,
    hoursBefore,
  );
  change('Reschedules', a.policies.reschedule.allowed, b.policies.reschedule.allowed, allowed);
  change(
    'Reschedule cutoff',
    a.policies.reschedule.cutoffHours,
    b.policies.reschedule.cutoffHours,
    hoursBefore,
  );
  change('Most reschedules', a.policies.reschedule.maxTimes, b.policies.reschedule.maxTimes);
  if (a.policies.policyText !== b.policies.policyText) lines.push('Policy text changed');

  // Notifications and integrations
  const n = (c: CalendarConfig) => c.notifications;
  change('Confirmation texts', n(a).confirmation.text, n(b).confirmation.text, onOff);
  change('Confirmation emails', n(a).confirmation.email, n(b).confirmation.email, onOff);
  change('Reminders', n(a).reminders, n(b).reminders, (v) =>
    v.length ? v.map(reminder).join(', ') : 'none',
  );
  change('Reminder texts', n(a).reminderChannels.text, n(b).reminderChannels.text, onOff);
  change('Reminder emails', n(a).reminderChannels.email, n(b).reminderChannels.email, onOff);
  change('Staff email on booking', n(a).staffEmail, n(b).staffEmail, onOff);
  change(
    'Check staff calendars',
    a.integrations.checkStaffCalendars,
    b.integrations.checkStaffCalendars,
    onOff,
  );
  change('Add to staff calendars', a.integrations.writeEvents, b.integrations.writeEvents, onOff);

  // CRM, payments, automations
  change('Owner', a.crm.ownership, b.crm.ownership, (v) => OWNERSHIP[v]);
  change('Assign contact owner', a.crm.assignContactOwner, b.crm.assignContactOwner, onOff);
  change('Create a lead', a.crm.createLead, b.crm.createLead, (v) => {
    if (!v) return 'off';
    const p = catalogs?.pipelines?.find((x) => x.id === v.pipelineId);
    const s = p?.stages.find((x) => x.id === v.stageId);
    return p && s ? `${p.name} · ${s.name}` : 'on';
  });
  change('Payment', a.payments.mode, b.payments.mode, (v) => PAYMENTS[v]);
  change('Workflows', a.automations.workflowIds.length, b.automations.workflowIds.length);
  if (
    a.automations.workflowIds.length === b.automations.workflowIds.length &&
    !same(a.automations.workflowIds, b.automations.workflowIds)
  )
    lines.push('Workflows changed');
  return lines;
}
