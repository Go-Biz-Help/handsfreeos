import { LABEL_NAMES, type CalendarLabel, type RequestChannel } from '@hfos/core';
import type { AuditEntry } from './api/types';
import { clock } from '@/lib/calls/format';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const who = (e: AuditEntry) =>
  e.entityName || s(e.after?.email) || s(e.before?.email) || 'a person';

/** How a change arrived, when that isn't someone working in the app themselves. Every channel is listed. */
const VIA: Record<RequestChannel, string | null> = {
  web: null,
  api: null,
  worker: null,
  cli: null,
  sms: null,
  test: null,
  assistant: 'via Assistant',
  booking_page: 'via booking page',
};

/**
 * One plain-English sentence per audit row, in the third person after the actor's name. What the Assistant
 * did for someone ends "via Assistant" (their name still leads the row); what a customer did on a public
 * booking page ends "via booking page".
 */
export function describeAudit(e: AuditEntry): string {
  const sentence = describeAction(e);
  const via = VIA[e.channel as RequestChannel];
  return via ? `${sentence} ${via}` : sentence;
}

function describeAction(e: AuditEntry): string {
  switch (e.action) {
    case 'organization.create':
      return e.entityType === 'organization'
        ? `created the organization ${s(e.after?.name)}`
        : `created the workspace ${s(e.after?.name)}`;
    case 'workspace.create':
      return `created the workspace ${s(e.after?.name)}`;
    case 'workspace.update': {
      const keys = Object.keys(e.after ?? {});
      const label: Record<string, string> = {
        name: 'the name',
        timezone: 'the time zone',
        industry: 'the industry',
        settings: 'workspace settings',
      };
      if (keys.length === 1 && keys[0] !== 'settings')
        return `changed ${label[keys[0]!] ?? keys[0]} from ${s(e.before?.[keys[0]!])} to ${s(e.after?.[keys[0]!])}`;
      return `updated ${keys.map((k) => label[k] ?? k).join(', ')}`;
    }
    case 'membership.invite':
      return `invited ${s(e.after?.email)} as ${ROLE[s(e.after?.role)] ?? s(e.after?.role)}`;
    case 'invitation.resend':
      return `re-sent the invitation to ${s(e.after?.email)}`;
    case 'invitation.revoke':
      return `revoked the invitation for ${s(e.after?.email)}`;
    case 'invitation.send':
      return `emailed the invitation link to ${s(e.after?.email)}`;
    case 'invitation.accept':
      return e.entityType === 'invitation'
        ? `accepted an invitation and joined as ${ROLE[s(e.after?.role)] ?? s(e.after?.role)}`
        : 'joined the workspace';
    case 'membership.change_role':
      return `changed ${who(e)}'s role from ${ROLE[s(e.before?.role)] ?? s(e.before?.role)} to ${ROLE[s(e.after?.role)] ?? s(e.after?.role)}`;
    case 'membership.remove':
      return e.actor.userId === e.entityId
        ? 'left the workspace'
        : `removed ${who(e)} from the workspace`;
    // Milestone 2: CRM
    case 'pipeline.create':
      return `created the pipeline ${name(e)}`;
    case 'pipeline.update':
      return `updated the pipeline ${name(e)}`;
    case 'pipeline.archive':
      return `archived the pipeline ${name(e)}`;
    case 'stage.create':
      return `added the stage ${name(e)} to ${s(e.after?.pipeline)}`;
    case 'stage.update':
      return `updated the stage ${name(e)}`;
    case 'stage.reorder':
      return `reordered the stages of ${name(e)}`;
    case 'stage.delete':
      return `deleted the stage ${s(e.before?.name)}`;
    case 'company.create':
      return `added the company ${name(e)}`;
    case 'company.update':
      return `updated ${name(e)} (${fields(e)})`;
    case 'company.archive':
      return `archived the company ${name(e)}`;
    case 'company.restore':
      return `restored the company ${name(e)}`;
    case 'person.create':
      return `added ${name(e)}`;
    case 'person.update':
      return `updated ${name(e)} (${fields(e)})`;
    case 'person.archive':
      return `archived ${name(e)}`;
    case 'person.restore':
      return `restored ${name(e)}`;
    case 'tag.create':
      return `created the tag ${name(e)}`;
    case 'tag.update':
      return `updated the tag ${name(e)}`;
    case 'tag.delete':
      return `deleted the tag ${s(e.before?.name)}`;
    case 'record.set_tags':
      return `set tags to ${list(e.after?.tags) || 'none'}`;
    case 'lead.create':
      return `created the lead ${title(e)} in ${s(e.after?.stage)}`;
    case 'lead.update': {
      const keys = Object.keys(e.after ?? {}).filter((k) => k !== 'title');
      return keys.includes('assigneeUserId') && keys.length === 1
        ? `assigned ${title(e)}`
        : `updated the lead ${title(e)} (${keys.join(', ') || 'details'})`;
    }
    case 'lead.move_stage': {
      if (e.after?.status === 'won' && e.before?.status !== 'won')
        return `won the lead ${title(e)}`;
      if (e.after?.status === 'lost' && e.before?.status !== 'lost')
        return `marked the lead ${title(e)} lost${e.after?.reason ? ` (${s(e.after.reason)})` : ''}`;
      if (e.after?.stage)
        return `moved ${title(e)} from ${s(e.before?.stage)} to ${s(e.after?.stage)}`;
      return `reopened the lead ${title(e)}`;
    }
    case 'lead.set_next_action':
      return e.after?.nextAction
        ? `set the next action on ${title(e)}: ${s(e.after.nextAction)}`
        : `cleared the next action on ${title(e)}`;
    case 'lead.archive':
      return `archived the lead ${title(e)}`;
    case 'lead.restore':
      return `restored the lead ${title(e)}`;
    case 'task.create':
      return `created the task ${title(e)}`;
    case 'task.update':
      return `updated the task ${title(e)}`;
    case 'task.complete':
      return `completed the task ${title(e)}`;
    case 'task.reopen':
      return `reopened the task ${title(e)}`;
    case 'task.delete':
      return `deleted the task ${s(e.before?.title)}`;
    case 'activity.log':
      return `logged a ${s(e.after?.kind) || 'note'}`;
    case 'activity.update':
      return 'edited a timeline entry';
    case 'activity.delete':
      return `deleted a ${s(e.before?.kind) || 'note'}`;
    case 'file.confirm':
      return `uploaded ${name(e)}`;
    case 'file.delete':
      return `removed the file ${s(e.before?.name)}`;
    case 'file.remove':
      return `deleted the stored file ${name(e)}`;
    case 'import.start':
      return `started importing ${s(e.after?.fileName)}`;
    case 'import.cancel':
      return 'cancelled an import';
    case 'import.progress':
      return `imported ${s(e.after?.processedRows) || '?'} rows so far`;
    case 'import.finish':
      return `finished importing ${s(e.after?.fileName)}: ${s(e.after?.created)} added, ${s(e.after?.updated)} updated, ${s(e.after?.skipped)} skipped, ${s(e.after?.errors)} errors`;
    // Milestone 3: numbers, carrier registration, texting and the inbox
    case 'phone_number.buy':
      return `started buying the ${s(e.after?.numberType) === 'local' ? 'local' : 'toll-free'} number ${s(e.after?.number)}`;
    case 'phone_number.activate':
      return `turned on the number ${s(e.after?.number)}`;
    case 'phone_number.fail':
      return `could not buy ${s(e.after?.number)}${s(e.after?.error) ? `: ${s(e.after?.error)}` : ''}`;
    case 'phone_number.release':
      return `released the number ${s(e.after?.number) || s(e.before?.number)}`;
    case 'phone_number.mark_released':
      return `gave ${s(e.after?.number)} back to the carrier`;
    case 'phone_number.set_routing':
      return 'changed how calls ring';
    case 'phone.update_settings':
      return 'updated the texting settings';
    case 'registration.submit':
      return `sent ${s(e.after?.legalName)}'s ${s(e.after?.kind) === 'a2p_10dlc' ? 'local-number registration' : 'toll-free verification'} to the carriers`;
    case 'registration.update_status':
      return registrationSentence(e);
    case 'conversation.open':
      return `started a conversation with ${withWho(e)}`;
    case 'conversation.mark_read':
      return `read the conversation with ${withWho(e)}`;
    case 'conversation.mark_unread':
      return `marked the conversation with ${withWho(e)} unread`;
    case 'conversation.assign':
      return s(e.after?.assignee)
        ? `assigned the conversation with ${withWho(e)} to ${s(e.after?.assignee)}`
        : `unassigned the conversation with ${withWho(e)}`;
    case 'conversation.snooze':
      return `snoozed the conversation with ${withWho(e)} until ${when(e.after?.until)}`;
    case 'conversation.close':
      return `closed the conversation with ${withWho(e)}`;
    case 'conversation.reopen':
      return e.actor.userId
        ? `reopened the conversation with ${withWho(e)}`
        : `brought back the conversation with ${withWho(e)} (snooze ended)`;
    case 'conversation.link_person':
      return `linked the conversation with ${withWho(e)} to ${s(e.after?.person)}`;
    case 'conversation.unanswered_check':
      return `emailed ${list(e.after?.emailed) || 'nobody'} that ${s(e.after?.with)} is waiting for a reply`;
    case 'message.send':
      return e.entityType === 'conversation'
        ? `started a conversation with ${withWho(e)}`
        : s(e.after?.subject)
          ? `sent an email to ${s(e.after?.to)} · ${s(e.after?.subject)}`
          : `sent a text to ${s(e.after?.to)}`;
    case 'message.retry':
      return `tried the ${s(e.after?.to).includes('@') ? 'email' : 'text'} to ${s(e.after?.to)} again`;
    case 'message.receive':
      return receiveSentence(e);
    case 'message.update_status':
      return statusSentence(e);
    case 'message.attach_media': {
      const n = Number(e.after?.photos ?? 0);
      return `saved ${n === 1 ? 'a photo' : `${n} photos`} from a text`;
    }
    case 'call.start':
      return `called ${s(e.after?.to) || 'a customer'} from the browser`;
    case 'call.record':
      return `took a call from ${s(e.after?.from) || 'a caller'}`;
    case 'call.update_status':
      return s(e.after?.duration)
        ? `logged a ${s(e.after?.duration)} call ${s(e.after?.direction) === 'outbound' ? 'to' : 'from'} ${s(e.after?.with)}`
        : `logged a missed call ${s(e.after?.direction) === 'outbound' ? 'to' : 'from'} ${s(e.after?.with)}`;
    case 'call.attach_recording':
      return `saved a ${clock(Number(e.after?.seconds ?? 0))} voicemail from ${s(e.after?.with)}`;
    case 'call.attach_transcript':
      return s(e.after?.status) === 'completed'
        ? `wrote out the voicemail from ${s(e.after?.with)}`
        : `could not write out the voicemail from ${s(e.after?.with)}`;
    // Email: addresses, the workspace's own domain, connected mailboxes, blocked and unmatched mail
    case 'email.receive':
      return emailReceiveSentence(e);
    case 'email_domain.add':
      return `added ${s(e.after?.domain)} for sending email`;
    case 'email_domain.verify':
      return `asked to check the DNS records for ${s(e.after?.domain)}`;
    case 'email_domain.remove':
      return `removed the domain ${s(e.before?.domain)}`;
    case 'email_domain.record':
      return s(e.after?.status) === 'verified'
        ? `recorded that ${s(e.after?.domain)} is verified for sending`
        : s(e.after?.status) === 'failed' && s(e.before?.status) === 'verified'
          ? `found that ${s(e.after?.domain)} stopped verifying, so email goes out from the shared address again`
          : s(e.after?.status) === 'failed'
            ? `recorded that ${s(e.after?.domain)} did not verify${s(e.after?.error) ? `: ${s(e.after?.error)}` : ''}`
            : `saved the DNS records for ${s(e.after?.domain)}`;
    case 'email_address.create':
      return `added the email address ${s(e.after?.address)}${e.after?.isDefault ? ' as the default' : ''}`;
    case 'email_address.update':
      return e.after?.isDefault
        ? `made ${s(e.after?.address)} the default email address`
        : s(e.after?.displayName)
          ? `changed the name on ${s(e.after?.address)} to ${s(e.after?.displayName)}`
          : `updated the email address ${s(e.after?.address)}`;
    case 'mailbox.connect':
      return `started connecting ${s(e.after?.provider) === 'google' ? 'a Gmail' : 'an Outlook'} mailbox`;
    case 'mailbox.activate':
      return s(e.after?.status) === 'disconnected'
        ? `replaced the earlier connection to ${s(e.after?.account)}`
        : `connected the ${mailboxName(e)} mailbox ${s(e.after?.account)}`;
    case 'mailbox.disconnect':
      return `disconnected the ${mailboxName(e)} mailbox ${s(e.after?.account)}`;
    case 'mailbox.resync':
      return `asked ${s(e.after?.account)} to sync again`;
    case 'mailbox.fail':
      return s(e.after?.status) === 'reauth_required'
        ? `recorded that ${s(e.after?.account)} needs reconnecting`
        : `recorded that ${s(e.after?.account)} stopped syncing${s(e.after?.error) ? `: ${s(e.after?.error)}` : ''}`;
    case 'email.claim_unmatched':
      return `filed the email from ${s(e.after?.from)} under ${s(e.after?.person)}`;
    case 'email.dismiss_unmatched':
      return `dismissed the email from ${s(e.after?.from)}`;
    case 'email_suppression.record':
      return `stopped emailing ${s(e.after?.address)} (${s(e.after?.reason) === 'spam_complaint' ? 'marked as spam' : 'the address bounced'})`;
    case 'email_suppression.add':
      return `stopped emailing ${s(e.after?.address)}`;
    case 'email_suppression.release':
      return `unblocked ${s(e.after?.address)}`;
    case 'person.set_sms_consent':
      return e.after?.smsConsent === 'opted_out'
        ? `marked ${s(e.after?.name)} as not wanting texts`
        : `marked ${s(e.after?.name)} as agreeing to texts`;
    // Milestone 5: people's own Google and Outlook calendars
    case 'calendar_connection.connect':
      return `started connecting ${s(e.after?.provider) === 'google' ? 'a Google Calendar' : 'an Outlook calendar'}`;
    case 'calendar_connection.activate':
      return s(e.after?.status) === 'disconnected'
        ? `replaced the earlier calendar connection to ${s(e.after?.account)}`
        : `connected the ${calendarName(e)} ${s(e.after?.account)}`;
    case 'calendar_connection.disconnect':
      return s(e.after?.person)
        ? `disconnected ${s(e.after?.person)}'s ${calendarName(e)}`
        : `disconnected the ${calendarName(e)} ${s(e.after?.account)}`;
    case 'calendar_connection.sync_now':
      return `asked the ${calendarName(e)} ${s(e.after?.account)} to sync again`;
    case 'calendar_connection.fail':
      return s(e.after?.status) === 'reauth_required'
        ? `recorded that the ${calendarName(e)} ${s(e.after?.account)} needs reconnecting`
        : `recorded that the ${calendarName(e)} ${s(e.after?.account)} stopped syncing${s(e.after?.error) ? `: ${s(e.after?.error)}` : ''}`;
    // Milestone 5: calendars, their catalogs, people's hours and appointments
    case 'calendar.create':
      return `created the calendar ${name(e)}${s(e.after?.preset) ? ` from the ${s(e.after?.preset)} preset` : ''}`;
    case 'calendar.save':
    case 'calendar.restore_revision':
      return calendarSaveSentence(e);
    case 'calendar.set_status':
      return calendarStatusSentence(e);
    case 'calendar.set_slug':
      return `changed the link for ${name(e)} from ${s(e.before?.slug)} to ${s(e.after?.slug)}`;
    case 'service.create':
      return `added the service ${name(e)}`;
    case 'service.update':
      return `updated the service ${name(e)} (${catalogFields(e)})`;
    case 'service.archive':
      return `archived the service ${name(e)}`;
    case 'resource.create':
      return `added the resource ${name(e)}${Number(e.after?.quantity ?? 1) > 1 ? ` (${Number(e.after?.quantity)} of them)` : ''}`;
    case 'resource.update':
      return `updated the resource ${name(e)} (${catalogFields(e)})`;
    case 'resource.archive':
      return `archived the resource ${name(e)}`;
    case 'territory.create':
      return `added the territory ${name(e)} with ${count(e.after?.zipCodes, 'ZIP code', 'ZIP codes')}`;
    case 'territory.update':
      return `updated the territory ${name(e)}`;
    case 'territory.delete':
      return `deleted the territory ${s(e.before?.name)}`;
    case 'booking_site.update':
      return !e.before
        ? `set up the booking site /book/${s(e.after?.slug)}`
        : e.after?.enabled === false && e.before.enabled !== false
          ? 'turned off online booking'
          : e.after?.enabled === true && e.before.enabled === false
            ? 'turned online booking back on'
            : `updated the booking site /book/${s(e.after?.slug)}`;
    case 'schedule.set':
      return `set ${possessive(e)} hours to ${s(e.after?.hours) || 'closed'}`;
    case 'time_off.add':
      return `added ${s(e.after?.kind) === 'available' ? 'extra open time' : 'time off'} for ${owner(e)}: ${offSpan(e.after)}`;
    case 'time_off.remove':
      return `removed ${s(e.before?.kind) === 'available' ? 'extra open time' : 'time off'} for ${owner(e)} (${offSpan(e.before)})`;
    case 'appointment.create':
    case 'appointment.book_online':
      return `booked ${apptTitle(e)}${forWhom(e)}${withStaff(e)} for ${when(e.after?.startsAt)}`;
    case 'appointment.update':
      return `updated ${apptTitle(e)} (${apptFields(e)})`;
    case 'appointment.reschedule':
    case 'attendee.reschedule_online':
      return `moved ${apptTitle(e)}${forWhom(e)} from ${when(e.before?.startsAt)} to ${when(e.after?.startsAt)}`;
    case 'appointment.reassign':
      return `gave ${apptTitle(e)}${forWhom(e)} to ${names(e.after?.staff) || 'nobody'}${names(e.before?.staff) ? ` (was ${names(e.before?.staff)})` : ''}`;
    case 'appointment.cancel':
      return `cancelled ${apptTitle(e)}${forWhom(e)} on ${when(e.after?.startsAt)}${s(e.after?.reason) ? ` (${s(e.after?.reason)})` : ''}`;
    case 'attendee.cancel_online':
      return `cancelled a place on ${apptTitle(e)} on ${when(e.after?.startsAt)}`;
    case 'appointment.set_status':
      return s(e.after?.status) === 'no_show'
        ? `marked ${apptTitle(e)}${forWhom(e)} a no-show`
        : `marked ${apptTitle(e)}${forWhom(e)} done`;
    case 'appointment.add_attendee':
      return `added a customer to ${apptTitle(e)} on ${when(e.after?.startsAt)}${s(e.after?.seats) ? ` (${s(e.after?.seats)} seats taken)` : ''}`;
    case 'appointment.remove_attendee':
      return `took a customer off ${apptTitle(e)} on ${when(e.after?.startsAt)}`;
    case 'session.publish':
      return `published ${apptTitle(e)} for ${when(e.after?.startsAt)}`;
    case 'series.create':
      return `booked ${count(e.after?.occurrences, 'visit', 'visits')} of ${apptTitle(e)}${forWhom(e)}, starting ${when(e.after?.startsAt)}`;
    case 'series.cancel':
      return `cancelled ${count(e.after?.cancelled, 'visit', 'visits')} of ${apptTitle(e)}`;
    case 'waitlist.add':
      return `added ${s(e.after?.customer) || 'a customer'} to the waitlist for ${s(e.after?.calendar) || 'a calendar'}`;
    case 'waitlist.remove':
      return 'took someone off a waitlist';
    case 'waitlist.offer':
      return 'offered an opening to the next person on the waitlist';
    case 'waitlist.expire':
      return 'passed an unclaimed waitlist offer to the next person';
    case 'appointment.record_reminder':
      return `sent a reminder about ${apptTitle(e)}`;
    default:
      return e.action;
  }
}

// ---- Milestone 5 helpers ----

const count = (v: unknown, one: string, many: string) => {
  const n = Number(v ?? 0);
  return `${n} ${n === 1 ? one : many}`;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const andJoin = (list: string[]) =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
const names = (v: unknown) => andJoin(strings(v));
const apptTitle = (e: AuditEntry) =>
  s(e.after?.title) || s(e.before?.title) || e.entityName || 'an appointment';
const forWhom = (e: AuditEntry) => {
  const who = strings(e.after?.customers);
  return who.length ? ` for ${andJoin(who)}` : '';
};
const withStaff = (e: AuditEntry) => {
  const who = strings(e.after?.staff);
  return who.length ? ` with ${andJoin(who)}` : '';
};
const FIELD_WORDS: Record<string, string> = {
  durations: 'lengths',
  defaultDuration: 'default length',
  bufferBefore: 'setup time',
  bufferAfter: 'cleanup time',
  priceCents: 'price',
  locationKinds: 'places',
  hours: 'hours',
  quantity: 'how many',
  kind: 'kind',
  location: 'location',
  description: 'description',
  color: 'color',
  notes: 'notes',
  leadId: 'lead',
  title: 'title',
};
const catalogFields = (e: AuditEntry) =>
  Object.keys(e.after ?? {})
    .filter((k) => k !== 'name')
    .map((k) => FIELD_WORDS[k] ?? k)
    .join(', ') || 'details';
const apptFields = (e: AuditEntry) =>
  Object.keys(e.after ?? {})
    .filter((k) => k !== 'title' || s(e.before?.title) !== s(e.after?.title))
    .map((k) => FIELD_WORDS[k] ?? k)
    .join(', ') || 'details';
const owner = (e: AuditEntry) => s(e.after?.owner) || s(e.before?.owner) || 'someone';
const possessive = (e: AuditEntry) => {
  const o = owner(e);
  return o === e.actor.fullName ? 'their own' : `${o}’s`;
};
const shortDay = (v: unknown) => {
  const d = typeof v === 'string' ? new Date(v) : v instanceof Date ? v : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
};
function offSpan(v: Record<string, unknown> | null | undefined): string {
  if (!v) return '';
  if (v.allDay) {
    const a = shortDay(v.startsAt);
    const b = shortDay(new Date(Date.parse(s(v.endsAt)) - 1));
    return a === b ? `${a}, all day` : `${a} to ${b}, all day`;
  }
  return `${when(v.startsAt)} to ${when(v.endsAt)}`;
}
const labelText = (raw: string) =>
  raw
    .split(/,\s*|\s·\s/)
    .filter(Boolean)
    .map((k) => LABEL_NAMES[k as CalendarLabel] ?? k)
    .join(' · ');

function calendarSaveSentence(e: AuditEntry): string {
  const changes = strings(e.after?.changes);
  const revision = Number(e.after?.revision ?? 0);
  const was = labelText(s(e.before?.labels));
  const now = labelText(s(e.after?.labels));
  const labels = was && now && was !== now ? ` (${was} → ${now})` : '';
  const restored = changes.find((c) => c.startsWith('Restored revision'));
  if (restored)
    return `restored ${name(e)} to ${restored.slice('Restored '.length)}, saved as revision ${revision}${labels}`;
  const [first, ...rest] = changes.filter((c) => !c.startsWith('Restored'));
  return `saved ${name(e)} as revision ${revision}${labels}${first ? `: ${first}${rest.length ? ` and ${rest.length} more ${rest.length === 1 ? 'change' : 'changes'}` : ''}` : ''}`;
}

function calendarStatusSentence(e: AuditEntry): string {
  switch (s(e.after?.status)) {
    case 'active':
      return s(e.before?.status) === 'paused' ? `resumed ${name(e)}` : `turned on ${name(e)}`;
    case 'paused':
      return `paused ${name(e)}`;
    case 'archived':
      return `archived the calendar ${name(e)}`;
    default:
      return `set ${name(e)} back to a draft`;
  }
}

const withWho = (e: AuditEntry) =>
  s(e.after?.with) || s(e.before?.with) || e.entityName || 'a customer';
const when = (v: unknown) => {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'later';
};

const REGISTRATION_KIND: Record<string, string> = {
  toll_free_verification: 'toll-free verification',
  a2p_customer_profile: 'business profile',
  a2p_trust_product: 'messaging profile',
  a2p_brand: 'brand registration',
  a2p_campaign: 'texting campaign',
};

function registrationSentence(e: AuditEntry): string {
  const kind = REGISTRATION_KIND[s(e.after?.kind)] ?? 'registration';
  const reason = s(e.after?.rejectionReason) ? `: ${s(e.after?.rejectionReason)}` : '';
  switch (s(e.after?.status)) {
    case 'submitted':
      return `sent the ${kind} to the carriers`;
    case 'in_review':
      return `noted the carriers are reviewing the ${kind}`;
    case 'approved':
      return `recorded that the carriers approved the ${kind}`;
    case 'rejected':
      return `recorded that the carriers turned down the ${kind}${reason}`;
    default:
      return `recorded that the ${kind} could not be sent${reason}`;
  }
}

function receiveSentence(e: AuditEntry): string {
  if (e.entityType === 'message') return `received a text from ${s(e.after?.from)}`;
  if (s(e.after?.smsConsent) === 'opted_out')
    return `recorded that ${s(e.after?.number)} opted out of texts`;
  if (s(e.after?.smsConsent) === 'opted_in')
    return `recorded that ${s(e.after?.number)} opted back in to texts`;
  if (s(e.after?.person)) return `matched ${s(e.after?.with)} to ${s(e.after?.person)}`;
  return 'received a text';
}

function statusSentence(e: AuditEntry): string {
  if (s(e.after?.smsConsent) === 'opted_out')
    return `recorded that ${s(e.after?.number)} no longer takes texts (the carrier said so)`;
  const status = s(e.after?.status);
  const what = s(e.after?.channel) === 'email' ? 'an email' : 'a text';
  if (status === 'delivered') return `confirmed ${what} was delivered`;
  if (status === 'bounced')
    return `recorded that an email bounced${s(e.after?.errorMessage) ? `: ${s(e.after?.errorMessage)}` : ''}`;
  if (status === 'complained') return 'recorded that a customer marked an email as spam';
  if (status === 'failed' || status === 'undelivered')
    return s(e.after?.channel) === 'email'
      ? `recorded that an email was not sent${s(e.after?.errorMessage) ? `: ${s(e.after?.errorMessage)}` : ''}`
      : `recorded that a text was not delivered${s(e.after?.errorCode) ? ` (carrier error ${s(e.after?.errorCode)})` : ''}`;
  return `recorded ${what} as ${status || 'updated'}`;
}

const mailboxName = (e: AuditEntry) => (s(e.after?.provider) === 'google' ? 'Gmail' : 'Outlook');
const calendarName = (e: AuditEntry) =>
  s(e.after?.provider) === 'google' ? 'Google Calendar' : 'Outlook calendar';

function emailReceiveSentence(e: AuditEntry): string {
  if (e.entityType === 'email_unmatched')
    return `held an email from ${s(e.after?.from)}, who isn’t in Customers yet`;
  if (e.entityType === 'conversation')
    return s(e.after?.person)
      ? `matched ${s(e.after?.with)} to ${s(e.after?.person)}`
      : `started an email conversation with ${withWho(e)}`;
  const from = s(e.after?.from);
  return `received an email${from ? ` from ${from}` : ''}`;
}

const name = (e: AuditEntry) => s(e.after?.name) || s(e.before?.name) || e.entityName || 'a record';
const title = (e: AuditEntry) => s(e.after?.title) || s(e.before?.title) || 'a lead';
const fields = (e: AuditEntry) =>
  Object.keys(e.after ?? {})
    .filter((k) => k !== 'name')
    .join(', ') || 'details';
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : '');

export type AuditCategory =
  | 'members'
  | 'invitations'
  | 'workspace'
  | 'customers'
  | 'inbox'
  | 'calendar'
  | 'leads'
  | 'tasks'
  | 'files'
  | 'imports'
  | 'other';

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  members: 'Members',
  invitations: 'Invitations',
  workspace: 'Workspace',
  customers: 'Customers',
  inbox: 'Texts, calls & email',
  calendar: 'Calendar',
  leads: 'Leads',
  tasks: 'Tasks',
  files: 'Files',
  imports: 'Imports',
  other: 'Other',
};

const CALENDAR_PREFIXES = [
  'calendar.',
  'calendar_connection.',
  'service.',
  'resource.',
  'territory.',
  'booking_site.',
  'schedule.',
  'time_off.',
  'appointment.',
  'attendee.',
  'session.',
  'series.',
  'waitlist.',
];

export function auditCategory(action: string): AuditCategory {
  if (CALENDAR_PREFIXES.some((p) => action.startsWith(p))) return 'calendar';
  if (action.startsWith('membership.')) return 'members';
  if (action.startsWith('invitation.')) return 'invitations';
  if (action.startsWith('workspace.') || action.startsWith('organization.')) return 'workspace';
  if (
    action === 'person.set_sms_consent' ||
    [
      'conversation.',
      'message.',
      'call.',
      'phone_number.',
      'phone.',
      'registration.',
      'email.',
      'email_domain.',
      'email_address.',
      'email_suppression.',
      'mailbox.',
    ].some((p) => action.startsWith(p))
  )
    return 'inbox';
  if (
    action.startsWith('person.') ||
    action.startsWith('company.') ||
    action.startsWith('tag.') ||
    action.startsWith('record.')
  )
    return 'customers';
  if (action.startsWith('lead.') || action.startsWith('pipeline.') || action.startsWith('stage.'))
    return 'leads';
  if (action.startsWith('task.') || action.startsWith('activity.')) return 'tasks';
  if (action.startsWith('file.')) return 'files';
  if (action.startsWith('import.')) return 'imports';
  return 'other';
}
