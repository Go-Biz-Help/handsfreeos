import type { TimelineEntry } from '@/lib/api/types';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Texts and emails mirror a conversation: what the customer sent, or what the business sent them. */
export function isChannelEntry(e: TimelineEntry): boolean {
  return e.kind === 'sms' || e.kind === 'email' || !!e.meta.direction;
}
const inbound = (e: TimelineEntry) => isChannelEntry(e) && e.meta.direction === 'inbound';
const undelivered = (e: TimelineEntry) =>
  e.meta.status === 'failed' || e.meta.status === 'undelivered' || e.meta.status === 'bounced';

/**
 * Who did it, for the timeline row: the customer for what they sent us, a teammate, "Import" for system
 * work on someone's behalf, or the app.
 */
export function timelineActor(e: TimelineEntry, subjectName?: string): string {
  if (inbound(e)) return subjectName || 'The customer';
  if (e.actorType === 'system') return e.meta.onBehalfOf ? 'Import' : 'HandsFreeOS';
  return e.actor?.fullName ?? 'Former member';
}

/** The sentence after the actor's name. */
export function describeTimeline(
  e: TimelineEntry,
  recordType: 'person' | 'company' | 'lead',
): string {
  if (e.kind === 'note') return 'added a note';
  if (e.kind === 'call') return 'logged a call';
  if (e.kind === 'visit') return 'logged a visit';
  if (e.kind === 'sms') {
    const keyword = str(e.meta.keyword);
    if (keyword === 'stop') return 'opted out of texts (STOP)';
    if (keyword === 'start') return 'opted back in to texts';
    if (inbound(e)) return 'texted';
    return undelivered(e) ? 'sent a text · not delivered' : 'sent a text';
  }
  if (e.kind === 'email') {
    const subject = str(e.meta.subject) ? ` · ${str(e.meta.subject)}` : '';
    if (inbound(e)) return `emailed${subject}`;
    return undelivered(e) ? `sent an email that bounced${subject}` : `sent an email${subject}`;
  }
  const title = str(e.meta.title);
  const noun =
    recordType === 'person'
      ? 'this person'
      : recordType === 'company'
        ? 'this company'
        : 'this lead';
  switch (e.subtype) {
    case 'created':
      return `added ${noun}`;
    case 'archived':
      return `archived ${noun}`;
    case 'restored':
      return `restored ${noun}`;
    case 'lead_created':
      return `created the lead ${e.body ?? ''}${str(e.meta.stage) ? ` in ${str(e.meta.stage)}` : ''}`;
    case 'stage_changed':
      return `moved ${title || 'the lead'} from ${str(e.meta.from)} to ${str(e.meta.to)}`;
    case 'won':
      return `won ${title || 'the lead'}`;
    case 'lost':
      return `marked ${title || 'the lead'} lost`;
    case 'reopened':
      return `reopened ${title || 'the lead'}`;
    case 'assigned':
      return e.body?.startsWith('Assigned to ')
        ? `assigned ${title || 'the lead'} to ${e.body.slice('Assigned to '.length)}`
        : `unassigned ${title || 'the lead'}`;
    case 'next_action':
      return e.body
        ? `set the next action on ${title || 'the lead'}`
        : `cleared the next action on ${title || 'the lead'}`;
    case 'task_done':
      return 'completed a task';
    case 'file_added':
      return 'uploaded a file';
    default:
      return e.subtype?.replace(/_/g, ' ') ?? 'made a change';
  }
}

/** Whether the row shows the body in a quiet well (notes, calls, texts, task titles, file names). */
export function timelineBody(e: TimelineEntry): string | null {
  if (e.kind !== 'system') return e.body;
  switch (e.subtype) {
    case 'task_done':
    case 'file_added':
    case 'next_action':
      return e.body;
    case 'lost':
      return e.body?.replace(/^Lost:\s*/, '') || null;
    default:
      return null;
  }
}

export function timelineDotClass(e: TimelineEntry): string {
  if (e.kind === 'sms' && str(e.meta.keyword) === 'stop') return 'bg-card-3';
  if (e.kind === 'sms' || e.kind === 'email') return undelivered(e) ? 'bg-danger' : 'bg-accent';
  if (e.kind === 'note') return 'bg-accent';
  if (e.kind === 'call' || e.kind === 'visit') return 'bg-success';
  if (e.subtype === 'file_added') return 'bg-warning';
  if (e.subtype === 'won') return 'bg-success';
  if (e.subtype === 'lost') return 'bg-danger';
  return 'bg-card-3';
}
