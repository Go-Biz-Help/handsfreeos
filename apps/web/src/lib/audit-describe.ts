import { LABEL_NAMES, type CalendarLabel, type RequestChannel } from '@hfos/core';
import type { AuditEntry } from './api/types';
import { reminderNoun, reminderWhy } from '@/lib/calendar/reminders';
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
  workflow: 'via workflow',
};

/**
 * One plain-English sentence per audit row, in the third person after the actor's name. What the Assistant
 * did for someone ends "via Assistant" (their name still leads the row); what a customer did on a public
 * booking page ends "via booking page"; what a workflow step did ends "via workflow".
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
    case 'waitlist.promote':
      return `gave a waitlisted customer a place on ${apptTitle(e)} on ${when(e.after?.startsAt)}`;
    case 'waitlist.offer':
      return s(e.after?.customer)
        ? `offered ${s(e.after?.customer)} the ${s(e.after?.calendar) || 'open'} time on ${when(e.after?.startsAt)}, held until ${when(e.after?.expiresAt)}`
        : 'offered an opening to the next person on the waitlist';
    case 'waitlist.expire':
      return offerExpiredSentence(e);
    case 'waitlist.claim_online':
      return claimSentence(e);
    case 'attendee.record_reminder':
      return reminderSentence(e);
    case 'appointment.team_email':
      return `emailed ${names(e.after?.emailed) || 'the team'} that ${s(e.after?.customer) || 'a customer'} ${s(e.after?.about) === 'cancelled' ? 'cancelled' : 'booked'} ${apptTitle(e)}`;
    // Milestone 6: the knowledge base
    case 'knowledge.profile_update':
      return profileSentence(e);
    case 'knowledge_item.create':
      return `added the ${kbKind(e.after?.kind)} ${kbTitle(e)}${s(e.after?.status) === 'published' ? ' and published it' : ' as a draft'}`;
    case 'knowledge_item.update':
      return kbUpdateSentence(e);
    case 'knowledge_item.publish':
      return `published ${kbTitle(e)} for the AI to use`;
    case 'knowledge_item.archive':
      return `archived ${kbTitle(e)}, so the AI no longer uses it`;
    case 'knowledge_item.import_faqs': {
      const skipped = Number(e.after?.skipped ?? 0);
      return `imported ${count(e.after?.imported, 'FAQ', 'FAQs')}${s(e.after?.status) === 'published' ? ' and published them' : ' as drafts'}${skipped ? `, skipping ${skipped} already in the knowledge base` : ''}`;
    }
    case 'knowledge_item.record_use':
      return `used ${count(e.after?.items, 'knowledge item', 'knowledge items')}${s(e.after?.titles) ? `: ${s(e.after?.titles)}` : ''}`;
    case 'knowledge_document.add':
      return `added the file ${s(e.after?.file) || 'a file'} to the knowledge base`;
    case 'knowledge_document.save_text':
      return s(e.after?.note)
        ? `saved ${kbTitle(e)} as a draft document without its text. ${s(e.after?.note)}`
        : `read the text of ${kbTitle(e)} into a draft document`;
    case 'knowledge_source.set':
      return s(e.before?.url)
        ? `changed the website from ${kbSite(e.before?.url)} to ${kbSite(e.after?.url)}`
        : `set the website to ${kbSite(e.after?.url)}`;
    case 'knowledge_scan.start':
      return `started a scan of ${kbSite(e.after?.url)}`;
    case 'knowledge_scan.progress':
      return `read ${count(e.after?.pages, 'page', 'pages')} of ${kbSite(e.after?.url)} so far`;
    case 'knowledge_scan.finish':
      return s(e.after?.status) === 'failed'
        ? `stopped scanning ${kbSite(e.after?.url)}${s(e.after?.note) ? `: ${s(e.after?.note)}` : ''}`
        : `finished scanning ${kbSite(e.after?.url)}: ${count(e.after?.pages, 'page', 'pages')} read, ${count(e.after?.suggestions, 'suggestion', 'suggestions')}`;
    case 'knowledge_suggestion.propose': {
      const made = Number(e.after?.suggestions ?? 0);
      const grouped = Number(e.after?.grouped ?? 0);
      if (!made && grouped)
        return `added ${count(grouped, 'question', 'questions')} to similar ones waiting in Suggestions`;
      return `suggested ${count(made, 'item', 'items')} for the knowledge base${grouped ? ` (${grouped} joined similar questions)` : ''}`;
    }
    case 'knowledge_suggestion.accept':
      if (e.entityType === 'knowledge_suggestion')
        return `accepted the ${KB_FROM[s(e.after?.from)] ?? ''}suggestion ${kbTitle(e)}`;
      return s(e.before?.title)
        ? `updated ${kbTitle(e)} from a suggestion`
        : `added ${kbTitle(e)} from a suggestion`;
    case 'knowledge_suggestion.reject':
      return `rejected the ${KB_FROM[s(e.after?.from)] ?? ''}suggestion ${kbTitle(e)}${s(e.after?.note) ? ` (${s(e.after?.note)})` : ''}`;
    case 'knowledge_pack.create':
      return `created the knowledge pack ${name(e)} with ${count(e.after?.items, 'item', 'items')}`;
    case 'knowledge_pack.update':
      return `updated the knowledge pack ${name(e)}${e.after?.version ? ` to version ${String(e.after.version)}` : ''}`;
    case 'knowledge_pack.push':
      return `sent the knowledge pack ${name(e)} to ${s(e.after?.businesses) || 'client businesses'}`;
    // The agency's workflow templates (and the engine installing and updating them in a business)
    case 'workflow_template.create_from_workflow':
      return `saved ${s(e.after?.from) ? `the workflow “${s(e.after?.from)}”` : 'a workflow'} as the template ${name(e)}`;
    case 'workflow_template.save_draft':
      return `edited the template ${name(e)}`;
    case 'workflow_template.publish':
      return `published the template ${name(e)}${e.after?.version ? ` version ${String(e.after.version)}` : ''}`;
    case 'workflow_template.push':
      return `pushed the template ${name(e)}${e.after?.version ? ` version ${String(e.after.version)}` : ''} to ${s(e.after?.businesses) || 'client businesses'}`;
    case 'workflow_template.install':
      if (s(e.after?.error))
        return `couldn’t install the template ${name(e)}: ${s(e.after?.error)}`;
      return e.entityType === 'workflow'
        ? `added ${wfName(e)} from an agency template`
        : `installed the template ${name(e)}${e.after?.version ? ` version ${String(e.after.version)}` : ''}`;
    case 'workflow_template.apply_update':
      return e.after?.version
        ? `updated ${wfName(e)} to its template’s version ${String(e.after.version)}`
        : wfDraftSentence(e);
    case 'workflow_template.create':
      return `created the template ${name(e)} from scratch`;
    case 'workflow_template.rename':
      return s(e.before?.name) && s(e.before?.name) !== s(e.after?.name)
        ? `renamed the template “${s(e.before?.name)}” to “${s(e.after?.name)}”`
        : `changed the description of the template ${name(e)}`;
    // Milestone 6: workflows (a workflow's own steps read "Workflow: Speed to lead sent a text … via workflow")
    case 'workflow.create':
      return `created the workflow ${wfName(e)}${s(e.after?.source) ? ` (${s(e.after?.source)})` : ''}`;
    case 'workflow.save_draft':
    case 'workflow.restore_version':
    case 'workflow_proposal.apply':
      return wfDraftSentence(e);
    case 'workflow_proposal.create':
      return s(e.after?.name)
        ? `asked the AI builder for a change to ${wfName(e)}`
        : 'asked the AI builder to draft a new workflow';
    case 'workflow_proposal.mark_applied':
      return `applied an AI change to ${wfName(e)}${s(e.after?.summary) ? `: ${s(e.after?.summary)}` : ''}`;
    case 'workflow.rename':
      return `renamed the workflow “${s(e.before?.name)}” to “${s(e.after?.name)}”`;
    case 'workflow.publish':
      return `published ${wfName(e)}${e.after?.version ? ` version ${String(e.after.version)}` : ''}`;
    case 'workflow.pause':
      return `paused ${wfName(e)}`;
    case 'workflow.resume':
      return `resumed ${wfName(e)}`;
    case 'workflow.archive':
      return `archived ${wfName(e)}${Number(e.after?.stoppedRuns ?? 0) ? ` and stopped ${count(e.after?.stoppedRuns, 'run', 'runs')}` : ''}`;
    case 'workflow.test':
      return `ran a ${s(e.after?.mode) || 'Simulate'} test of ${wfName(e)}${s(e.after?.customer) ? ` with ${s(e.after?.customer)}` : ''}`;
    case 'workflow.enrol':
      return `added ${s(e.after?.customer) || 'a customer'} to ${wfName(e)}`;
    case 'workflow.remove_contact':
      return `took ${s(e.after?.customer) || 'a customer'} out of ${wfName(e)}`;
    case 'workflow.stop_run':
      return `stopped a run of ${wfName(e)}${s(e.after?.customer) ? ` for ${s(e.after?.customer)}` : ''}`;
    case 'workflow.decide_approval':
      return `${s(e.after?.decision) === 'Rejected' ? 'rejected' : 'approved'} a step of ${wfName(e)}${s(e.after?.customer) ? ` for ${s(e.after?.customer)}` : ''}${e.after?.edited ? ', with an edit' : ''}`;
    case 'workflow.retry_step':
      return `retried a failed step of ${wfName(e)}`;
    case 'workflow.skip_step':
      return `skipped a failed step of ${wfName(e)}`;
    case 'workflow.request_approval':
      return 'asked for an approval';
    case 'workflow.expire_approval':
      return 'let an approval expire';
    case 'workflow_run.start':
      return 'started a run';
    case 'workflow_run.end':
      return wfRunEndSentence(e);
    default:
      return e.action;
  }
}

// ---- Milestone 6: workflow helpers ----

function wfName(e: AuditEntry): string {
  const n = s(e.after?.name) || s(e.after?.workflow) || s(e.before?.name);
  return n ? `“${n}”` : 'a workflow';
}

function wfDraftSentence(e: AuditEntry): string {
  const changes = Array.isArray(e.after?.changes) ? e.after.changes.map(String) : [];
  const first = changes[0];
  if (e.action === 'workflow.restore_version')
    return `${first ? first[0]!.toLowerCase() + first.slice(1) : 'restored an old version'} into the draft of ${wfName(e)}`;
  const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
  const how = e.action === 'workflow_proposal.apply' ? 'applied an AI change to' : 'edited';
  return `${how} the draft of ${wfName(e)}${first ? `: ${first}${more}` : ''}`;
}

const WF_RUN_END: Record<string, string> = {
  end_step: 'it reached an End step',
  rejected: 'the approval was rejected',
  approval_expired: 'the approval expired',
  approval_cancelled: 'the approval was cancelled',
  'stop_on:reply': 'they replied',
  'stop_on:booking': 'they booked',
  'stop_on:lead_won': 'the lead was won',
  'stop_on:lead_lost': 'the lead was lost',
  max_days: 'it ran for the most days a run can last',
  step_limit: 'it reached the step limit',
  workflow_archived: 'the workflow was archived',
  removed_from_workflow: 'they were taken out',
  removed_by_workflow: 'another workflow took them out',
  stopped_by_person: 'someone stopped it',
  outdated: 'the draft changed during the test',
};

function wfRunEndSentence(e: AuditEntry): string {
  const reason = s(e.after?.reason);
  const status = s(e.after?.status);
  const why =
    reason && reason !== 'finished' ? (WF_RUN_END[reason] ?? reason.replace(/_/g, ' ')) : '';
  if (status === 'completed') return why ? `finished a run (${why})` : 'finished a run';
  if (status === 'failed') return `stopped a run when a step failed${why ? ` (${why})` : ''}`;
  return `stopped a run${why ? `: ${why}` : ''}`;
}

// ---- Milestone 6: knowledge base helpers ----

const KB_KIND: Record<string, string> = {
  faq: 'FAQ',
  article: 'article',
  fact: 'fact',
  document: 'document',
};
const KB_KIND_A: Record<string, string> = { faq: 'an FAQ', article: 'an article', fact: 'a fact' };
const KB_FROM: Record<string, string> = { scan: 'website ', gap: '', pack: 'Go Biz Help ' };
const KB_PROFILE_FIELD: Record<string, string> = {
  description: 'what you do',
  services: 'services',
  serviceArea: 'service area',
  hours: 'hours',
  policies: 'policies',
  tone: 'tone of voice',
  wordsToUse: 'words to use',
  wordsToAvoid: 'words to avoid',
  signature: 'signature',
  allowPrices: '“AI may quote prices”',
};
const kbKind = (v: unknown) => KB_KIND[s(v)] ?? 'item';
const kbTitle = (e: AuditEntry) => {
  const t = s(e.after?.title) || s(e.before?.title) || e.entityName;
  return t ? `“${t}”` : 'an item';
};
const kbSite = (v: unknown) =>
  s(v)
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '') || 'the website';

function profileSentence(e: AuditEntry): string {
  const changed = s(e.after?.changed)
    .split(', ')
    .filter((f) => f && f !== 'created');
  const prices = e.after?.allowPrices;
  if (typeof prices === 'boolean' && typeof e.before?.allowPrices === 'boolean') {
    const others = changed.filter((f) => f !== 'allowPrices');
    return `turned ${prices ? 'on' : 'off'} “AI may quote prices”${others.length ? ` and updated ${andJoin(others.map((f) => KB_PROFILE_FIELD[f] ?? f))}` : ''}`;
  }
  if (!changed.length) return 'created the business profile';
  return `updated the business profile: ${andJoin(changed.map((f) => KB_PROFILE_FIELD[f] ?? f))}`;
}

function kbUpdateSentence(e: AuditEntry): string {
  const was = s(e.before?.title);
  const now = s(e.after?.title);
  const parts: string[] = [];
  if (was && now && was !== now) parts.push(`renamed it to “${now}”`);
  if (s(e.after?.kind)) parts.push(`made it ${KB_KIND_A[s(e.after?.kind)] ?? 'another kind'}`);
  if (e.after?.tags !== undefined) parts.push('changed its tags');
  if (s(e.after?.text)) parts.push('changed its text');
  const subject = was ? `“${was}”` : kbTitle(e);
  return parts.length ? `edited ${subject}: ${andJoin(parts)}` : `edited ${subject}`;
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

/** attendee.reminder_recorded: "sent Mike Johnson the day-before reminder for AC tune-up by text". */
function reminderSentence(e: AuditEntry): string {
  const customer = s(e.after?.customer) || 'a customer';
  const noun = reminderNoun(s(e.after?.reminder));
  const about = s(e.after?.title) ? ` for ${s(e.after?.title)}` : '';
  const first = s(e.after?.customer).trim().split(/\s+/)[0] ?? '';
  const why = reminderWhy(s(e.after?.reason) || null, first);
  if (s(e.after?.status) === 'skipped')
    return `skipped ${customer}’s ${noun}${about}${why ? `: ${why}` : ''}`;
  const email = s(e.after?.channel) === 'email';
  return `sent ${customer} the ${noun}${about} by ${email ? 'email' : 'text'}${email && why ? ` (${why})` : ''}`;
}

/** waitlist.offer_expired: the time went back to the waitlist, or they wait again (someone else took it). */
function offerExpiredSentence(e: AuditEntry): string {
  const who = s(e.after?.customer) || 'a customer';
  const cal = s(e.after?.calendar) ? ` for ${s(e.after?.calendar)}` : '';
  return s(e.after?.status) === 'waiting'
    ? `put ${who} back on the waitlist${cal}: someone else took the time before their offer ran out`
    : `ended ${who}’s waitlist offer${cal}: it wasn’t claimed in time`;
}

/** waitlist.claim_online writes the booking, the new customer and lead, and waitlist.claimed. */
function claimSentence(e: AuditEntry): string {
  if (e.entityType === 'person') return `added ${name(e)}`;
  if (e.entityType === 'lead')
    return `created the lead ${title(e)}${s(e.after?.stage) ? ` in ${s(e.after?.stage)}` : ''}`;
  if (s(e.after?.title))
    return `booked ${apptTitle(e)}${forWhom(e)}${withStaff(e)} for ${when(e.after?.startsAt)} from a waitlist offer`;
  return `recorded that ${s(e.after?.customer) || 'a customer'} claimed their waitlist offer for ${when(e.after?.startsAt)}`;
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
  | 'workflows'
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
  workflows: 'Workflows',
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

/**
 * Who did it, for a log row: a person, "Workflow: Speed to lead" (audit.list names the workflow, which is
 * recorded as itself), or HandsFreeOS for system work.
 */
export function auditActor(e: AuditEntry): {
  readonly name: string;
  readonly kind: 'person' | 'workflow' | 'system';
  readonly workflowId: string | null;
} {
  if (e.actor.type === 'workflow')
    return {
      name: e.actor.workflow ? `Workflow: ${e.actor.workflow.name}` : 'A workflow',
      kind: 'workflow',
      workflowId: e.actor.workflow?.id ?? e.actor.userId,
    };
  if (e.actor.type === 'system') return { name: 'HandsFreeOS', kind: 'system', workflowId: null };
  return { name: e.actor.fullName ?? 'Someone', kind: 'person', workflowId: null };
}

export function auditCategory(action: string): AuditCategory {
  if (action.startsWith('workflow')) return 'workflows';
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
