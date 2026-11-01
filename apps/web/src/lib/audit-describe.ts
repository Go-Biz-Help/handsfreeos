import {
  ATTENTION_KIND_LABELS,
  industryLabel,
  LABEL_NAMES,
  type CalendarLabel,
  type RequestChannel,
} from '@hfos/core';
import type { AuditEntry } from './api/types';
import { reminderNoun, reminderWhy } from '@/lib/calendar/reminders';
import { clock } from '@/lib/calls/format';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
/** "Messenger", "Instagram": a message's channel when it's one of Meta's (20261025000200), else null. */
const metaWord = (channel: unknown): string | null =>
  channel === 'messenger' ? 'Messenger' : channel === 'instagram' ? 'Instagram' : null;
const who = (e: AuditEntry) =>
  e.entityName || s(e.after?.email) || s(e.before?.email) || 'a person';
/** "admins", "members": a role's column on the Permissions page, as the log names it. */
const rolePlural = (role: unknown): string => (s(role) ? `${s(role).toLowerCase()}s` : 'a role');
/** The one permission a setting changed, and what it says now ("on", "off", "as the default"…). */
const permissionChange = (e: AuditEntry): [string, string] => {
  const change = Object.entries(e.after ?? {}).find(([k]) => k !== 'role' && k !== 'person');
  return change ? [change[0], s(change[1])] : ['a permission', ''];
};

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
  ai_employee: 'via AI teammate',
  chat_widget: 'via website chat',
  // Someone working in the phone app is working in the app.
  mobile: null,
  // Saved from Facebook with the browser extension (Social Outreach).
  extension: 'via browser extension',
  // The AI keeping customers' tags and details up to date (0107): its name leads the row, its reason is below.
  contact_ai: null,
  // A client in their own portal (Real Estate round two, core).
  portal: 'via client portal',
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
      if (keys.length === 1 && keys[0] !== 'settings') {
        const key = keys[0]!;
        const shown = (v: unknown) => (key === 'industry' ? industryLabel(s(v)) : s(v));
        return `changed ${label[key] ?? key} from ${shown(e.before?.[key])} to ${shown(e.after?.[key])}`;
      }
      return `updated ${keys.map((k) => label[k] ?? k).join(', ')}`;
    }
    // The one line a deleted business leaves, in its organization's log (the worker writes it once it's gone).
    case 'workspace.delete':
      return `deleted the workspace ${s(e.before?.name)} and everything in it`;
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
    // Viewing the app as a teammate (20261018000100): someone in the business, and HandsFreeOS support inside a look.
    case 'teammate_view.start':
      return `viewed the app as ${s(e.after?.person) || 'a teammate'}, read-only`;
    case 'platform.teammate_view.started':
      return `let ${s(e.after?.who) || 'HandsFreeOS support'} view the app as ${s(e.after?.person) || 'one of your team'}, read-only`;
    case 'platform.view_as.started':
      return `let ${s(e.after?.who) || 'HandsFreeOS support'} look at the business read-only${s(e.after?.reason) ? `: “${s(e.after?.reason)}”` : ''}`;
    case 'membership.change_role':
      return `changed ${who(e)}'s role from ${ROLE[s(e.before?.role)] ?? s(e.before?.role)} to ${ROLE[s(e.after?.role)] ?? s(e.after?.role)}`;
    // Milestone 10: a person's own account, handing a business over, and their cell
    case 'organization.add_owner':
      return `made ${who(e)} an owner of ${s(e.after?.organization) || 'the organization'}`;
    case 'account.delete':
      return e.entityId && e.entityId !== e.actor.userId
        ? `made ${who(e)} an owner of ${s(e.after?.organization) || 'the business'} before deleting their account`
        : 'asked to delete their account';
    case 'account.note_deleted':
      return 'finished deleting a teammate’s account: what they worked on stays, shown as from a former teammate';
    case 'assistant.consent':
      return 'said OK to the Assistant sending what they ask about to an AI service';
    case 'user_phone.start_verification':
      return 'asked HandsFreeOS to call their cell phone to confirm it';
    case 'user_phone.verify':
      return 'confirmed a teammate’s cell phone: they pressed 1 on the call';
    case 'push_device.register':
      return 'turned on notifications on a phone';
    case 'push_device.remove':
      return 'turned off notifications on a phone';
    case 'call.connect_me':
      return `called ${s(e.after?.to) || 'a customer'} through their cell`;
    case 'call.cancel_connect':
      return s(e.after?.direction)
        ? `filed the cancelled call to ${withWho(e)}: their phone had started to ring`
        : `cancelled a call to ${withWho(e)} through their cell`;
    case 'phone_number.set_caller_id':
      return s(e.after?.forwardedCallerId) === 'business'
        ? 'set forwarded calls to show the business number'
        : 'set forwarded calls to show the customer’s number';
    case 'phone_number.set_recording_notice':
      return e.after?.announceRecording === false
        ? 'stopped telling customers their calls are recorded'
        : 'set calls to tell customers they are recorded';
    case 'message.cancel_scheduled':
      return 'cancelled a text that was waiting for quiet hours to end';
    case 'message.release_scheduled':
      return s(e.after?.status) === 'failed'
        ? `didn’t send a text held for quiet hours${s(e.after?.errorMessage) ? `: ${s(e.after?.errorMessage)}` : ''}`
        : `sent a text to ${s(e.after?.to)} when quiet hours ended`;
    case 'membership.remove':
      return e.actor.userId === e.entityId
        ? 'left the workspace'
        : `removed ${who(e)} from the workspace`;
    // 0106: what a business lets its people do
    case 'permission.set_role':
    case 'permission.set_member': {
      const [label, said] = permissionChange(e);
      const whom =
        e.action === 'permission.set_role'
          ? rolePlural(e.after?.role)
          : s(e.after?.person) || who(e);
      if (said === 'on' || said === 'off') return `turned “${label}” ${said} for ${whom}`;
      return e.action === 'permission.set_role'
        ? `put “${label}” back to the default for ${whom}`
        : `put “${label}” back to what ${whom}’s role says`;
    }
    case 'permission.reset':
      return s(e.after?.role)
        ? `put every permission back to the default for ${rolePlural(e.after?.role)}`
        : `put every permission back to what ${s(e.after?.person) || who(e)}’s role says`;
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
    case 'person.merge':
      return `merged ${s(e.before?.mergedName) || 'a duplicate'} into ${name(e)}`;
    // Deleting for good, through the Deleted bin (20261027000400, 20261027000800): these lines keep the name once
    // it's emptied.
    case 'person.delete':
    case 'conversation.delete':
    case 'appointment.delete':
    case 'lead.delete':
    case 'company.delete':
    case 'custom_record.delete':
      return binDeleteSentence(e);
    case 'bin.restore':
      return `brought ${binThing(e)} back from the Deleted bin`;
    case 'bin.empty':
      return `deleted ${binThing(e)} for good, from the Deleted bin`;
    case 'tag.create':
      return `created the tag ${name(e)}`;
    case 'tag.update':
      return `updated the tag ${name(e)}`;
    case 'tag.delete':
      return `deleted the tag ${s(e.before?.name)}`;
    case 'record.set_tags': {
      // Putting some on or taking some off (a workflow, the AI, many customers at once) says which.
      const added = tagsBetween(e.after?.tags, e.before?.tags);
      const removed = tagsBetween(e.before?.tags, e.after?.tags);
      if (added.length && !removed.length)
        return `added the tag${added.length > 1 ? 's' : ''} ${added.join(', ')}${onWhom(e)}`;
      if (removed.length && !added.length)
        return `removed the tag${removed.length > 1 ? 's' : ''} ${removed.join(', ')}${onWhom(e)}`;
      return `set tags to ${list(e.after?.tags) || 'none'}`;
    }
    // The AI's pass over the whole customer list (0107).
    case 'contact_ai.start_sweep':
      return `started the AI going through ${num(e.after?.total)} customer${num(e.after?.total) === '1' ? '' : 's'}${
        list(e.after?.tags) ? ` with the tags ${list(e.after?.tags)}` : ''
      }${e.after?.fixDetails ? ', fixing contact details too' : ''}`;
    case 'contact_ai.cancel_sweep':
      return `stopped the AI going through customers (${num(e.after?.reviewed)} of ${num(e.after?.total)} looked at)`;
    case 'contact_ai.sweep_finished':
      return s(e.after?.status) === 'failed'
        ? `stopped going through customers: ${s(e.after?.note)}`
        : `finished going through ${num(e.after?.reviewed)} customers: ${num(e.after?.changed)} changed (${num(e.after?.tagsAdded)} tags on, ${num(e.after?.tagsRemoved)} off, ${num(e.after?.detailsChanged)} details)`;
    case 'record.add_tag':
      return `added the tag ${list(tagsBetween(e.after?.tags, e.before?.tags)) || 'a tag'}${onWhom(e)}`;
    case 'record.remove_tag':
      return `removed the tag ${list(tagsBetween(e.before?.tags, e.after?.tags)) || 'a tag'}${onWhom(e)}`;
    // A business's own fields, its own kinds of records, and how records relate (0101).
    case 'custom_field.create':
      return `added the field ${s(e.after?.label)}`;
    case 'custom_field.update':
      return `updated the field ${name(e)}`;
    case 'custom_field.archive':
      return `retired the field ${s(e.before?.label) || name(e)}`;
    case 'record.set_fields':
      return `filled in ${customKeys(e)} on ${name(e)}`;
    case 'custom_record_type.create':
      return `added ${name(e)} as a kind of record`;
    case 'custom_record_type.update':
      return `updated the kind of record ${name(e)}`;
    case 'custom_record_type.archive':
      return `archived ${name(e)}`;
    case 'custom_record_type.restore':
      return `restored ${name(e)}`;
    case 'custom_record.create':
      return s(e.after?.kind)
        ? `added the ${s(e.after?.kind).toLowerCase()} ${name(e)}`
        : `added ${name(e)}`;
    case 'custom_record.update':
      return `updated ${name(e)} (${fields(e)})`;
    case 'custom_record.archive':
      return `archived ${name(e)}`;
    case 'custom_record.restore':
      return `restored ${name(e)}`;
    case 'relationship_type.create':
      return `set up the relationship ${name(e)}`;
    case 'relationship_type.update':
      return `updated the relationship ${name(e)}`;
    case 'relationship_type.archive':
      return `archived the relationship ${name(e)}`;
    case 'relationship_type.restore':
      return `restored the relationship ${name(e)}`;
    case 'relationship.create':
      return `connected ${s(e.after?.a)} (${s(e.after?.aLabel)}) and ${s(e.after?.b)} (${s(e.after?.bLabel)})`;
    case 'relationship.update':
      return 'changed the note on a relationship';
    case 'relationship.delete':
      return `removed the relationship between ${s(e.before?.a)} and ${s(e.before?.b)}`;
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
    case 'lead.catch_up':
      return `put ${title(e)} on the stage that matches what happened`;
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
    case 'file.lock':
      return `locked ${name(e)} as signed and kept`;
    // Search 5: the worker reading a file's words for search. The row has the file's name, never its words.
    case 'file.save_text':
      return Number(e.after?.chars) > 0
        ? `read the words in ${s(e.after?.name) || 'a file'} for search`
        : `found no words to read in ${s(e.after?.name) || 'a file'}, so search finds it by its name`;
    // An add-on's alerts (Real Estate step 5): raised and cleared by its worker, acknowledged by a person.
    case 'addon_alert.raised':
      return `raised the alert “${s(e.after?.title)}”`;
    case 'addon_alert.updated':
      return `updated the alert “${s(e.after?.title)}”`;
    case 'addon_alert.cleared':
      return 'cleared an alert';
    case 'addon_alert.acknowledge':
      return 'acknowledged an alert';
    case 'file.remove':
      return `deleted the stored file ${name(e)}`;
    case 'import.start':
      return `started importing ${s(e.after?.fileName)}${e.after?.callConsent ? ', with who agreed to calls' : ''}`;
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
    // Milestone 17: bringing a number the business already owns. Every sentence here deliberately says what
    // was done and never what was typed — the account number and the PIN are the old carrier's credentials,
    // and the audit log is read by people who have no business seeing them.
    case 'number_port.start':
      return `started bringing ${s(e.after?.number)} here from another carrier`;
    case 'number_port.save':
      return 'filled in what the old carrier needs';
    case 'number_port.attach_document':
      return `attached ${s(e.after?.document) || 'a document'} for the number move`;
    case 'number_port.submit':
      return `sent the move of ${s(e.after?.number)} to the old carrier`;
    case 'number_port.cancel':
      return 'called off a number move';
    case 'number_port.record_state':
      return portStateSentence(e);
    case 'number_port.complete':
      return `${s(e.after?.number)} finished moving here`;
    // 20261010000900: a number already in Twilio (the business's own account, or GoHighLevel's), sent account
    // to account. Never what was typed to connect an account — only which account.
    case 'number_import.start':
      return `started bringing ${s(e.after?.number)} over from ${s(e.after?.from) || 'Twilio'}`;
    case 'number_import.cancel':
      return `stopped watching for ${s(e.after?.number)}`;
    case 'number_import.record_check':
      return e.after?.problem
        ? `could not finish a look for a number on its way here: ${s(e.after.problem)}`
        : e.after?.carrier
          ? `found out who hosts a number on its way here (${s(e.after.carrier)})`
          : 'got the Twilio account ready to receive a number';
    case 'number_import.complete':
      return `${s(e.after?.number)} arrived and is set up for calls and texts`;
    case 'number_import.fail':
      return `could not set up ${s(e.after?.number)}: ${s(e.after?.why)}`;
    case 'twilio_connection.save':
      return `connected the Twilio account ${s(e.after?.account)}${e.after?.name ? ` (${s(e.after.name)})` : ''}`;
    case 'twilio_connection.disconnect':
      return `disconnected the Twilio account ${s(e.after?.account)}`;
    // Phone & texting on or off: the business's own Twilio account, made or closed on request.
    case 'telephony.enable':
      return 'turned phone & texting on';
    case 'telephony.disable':
      return 'turned phone & texting off';
    case 'telephony.account_changed':
      return e.after?.problem
        ? `left phone & texting on: ${s(e.after.problem)}`
        : s(e.after?.status) === 'closed'
          ? `closed the business’s Twilio account${e.after?.account ? ` ${s(e.after.account)}` : ''}`
          : `opened the business’s Twilio account${e.after?.account ? ` ${s(e.after.account)}` : ''}`;
    case 'twilio_connection.fail':
      return `found Twilio no longer accepts the account ${s(e.after?.account)}`;
    // 0103: RCS. The sender is made in the business's Twilio account; these connect it, pause it and let it go.
    case 'rcs_sender.connect':
      return e.before
        ? `tried connecting the RCS sender ${s(e.after?.senderId)} again`
        : `connected the RCS sender ${s(e.after?.senderId)}`;
    case 'rcs_sender.update':
      return s(e.after?.rcs) === 'off'
        ? 'paused RCS: every text goes as SMS or MMS'
        : s(e.after?.rcs) === 'on'
          ? 'switched RCS back on'
          : 'chose the number new RCS conversations start on';
    case 'rcs_sender.refresh':
      return `asked Twilio where the RCS sender ${s(e.after?.senderId)} stands`;
    case 'rcs_sender.disconnect':
      return 'disconnected RCS: texts go as SMS and MMS again';
    case 'rcs_sender.record_state':
      return rcsStateSentence(e);
    // 0104: asking HandsFreeOS for an RCS sender, and paying for it. Paying, stopping and a refused renewal each
    // open a support ticket too, which is a line of its own.
    case 'rcs_request.cancel':
    case 'rcs_request.record_paid':
    case 'rcs_request.record_renewal':
      if (e.entityType === 'support_ticket')
        return `opened support ticket ${s(e.after?.ticket)} with HandsFreeOS`;
      return rcsRequestSentence(e);
    case 'rcs_request.submit':
      return `asked for an RCS sender showing ${s(e.after?.name)}: ${s(e.after?.firstYear)} for the first year, then ${s(e.after?.yearly)} a year`;
    // 0105: what registering for texting costs, passed on.
    case 'texting_fee.pay':
      return `asked to pay ${s(e.after?.paying)} for texting with another card`;
    case 'texting_fee.record_outcome':
      return e.after?.paid
        ? `paid ${s(e.after.paid)} for texting`
        : e.after?.waived
          ? `let ${s(e.after.waived)} of texting fees through uncharged: paying online is off`
          : `couldn’t take ${s(e.after?.unpaid)} for texting: ${s(e.after?.reason)}`;
    case 'texting_fee.charge_month':
      return `owes ${s(e.after?.owed)} for this month’s texting campaign`;
    case 'rcs_request.pay_renewal':
      return `asked to pay RCS’s ${s(e.after?.renewal)} renewal with another card`;
    case 'rcs_request.record_closed':
      return s(e.after?.status) === 'expired'
        ? 'found the RCS payment page ran out unpaid'
        : 'found the RCS payment didn’t go through';
    case 'registration.submit':
      // 0105: sending a local registration also writes what the carriers charge for it.
      if (e.entityType === 'texting_fee')
        return `owes ${s(e.after?.owed)} for ${s(e.after?.for)}, passed on from the carriers`;
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
      return unansweredSentence(e);
    case 'message.send':
      return e.entityType === 'conversation'
        ? `started a conversation with ${withWho(e)}`
        : metaWord(e.after?.channel)
          ? `sent a ${metaWord(e.after?.channel)} message to ${s(e.after?.to)}`
          : s(e.after?.sendAt)
            ? `held a text to ${s(e.after?.to)} until quiet hours end, ${when(e.after?.sendAt)}`
            : s(e.after?.to) === 'Website chat'
              ? 'replied in a website chat'
              : s(e.after?.subject)
                ? `sent an email to ${s(e.after?.to)} · ${s(e.after?.subject)}`
                : `sent a text to ${s(e.after?.to)}`;
    case 'message.retry':
      if (metaWord(e.after?.channel))
        return `tried the ${metaWord(e.after?.channel)} message to ${s(e.after?.to)} again`;
      return s(e.after?.sendAt)
        ? `tried the text to ${s(e.after?.to)} again, held until quiet hours end, ${when(e.after?.sendAt)}`
        : `tried the ${s(e.after?.to).includes('@') ? 'email' : 'text'} to ${s(e.after?.to)} again`;
    case 'message.receive':
      return receiveSentence(e);
    // Facebook Messenger and Instagram (20261025000200)
    case 'meta_connection.connect':
      return 'started connecting Facebook';
    case 'meta_connection.activate':
      return 'connected Facebook';
    case 'meta_connection.disconnect':
      if (e.entityType === 'meta_account') return metaAccountGone(e);
      return s(e.after?.reason) === 'revoked'
        ? 'recorded that HandsFreeOS was removed on Facebook'
        : s(e.after?.reason) === 'failed'
          ? 'recorded that the Facebook sign-in stopped working'
          : `disconnected Facebook${s(e.after?.facebookUserName) ? ` (signed in as ${s(e.after?.facebookUserName)})` : ''}`;
    case 'meta_account.connect':
      return `connected ${s(e.after?.account)} ${s(e.after?.platform) === 'instagram' ? 'on Instagram' : 'on Messenger'}`;
    case 'meta_account.disconnect':
      return metaAccountGone(e);
    case 'meta_account.fail':
      return s(e.after?.problem) === 'revoked'
        ? `recorded that ${s(e.after?.account)} was removed from HandsFreeOS on Facebook`
        : s(e.after?.problem) === 'failed'
          ? `recorded that Meta stopped sending ${s(e.after?.account)}’s messages`
          : `recorded that ${s(e.after?.account)} needs to be connected again`;
    case 'meta_account.recover':
      return `recorded that ${s(e.after?.account)} is answering again`;
    case 'meta_message.receive':
      if (e.entityType === 'attribution_touch')
        return `recorded that a conversation came from ${s(e.after?.from) || 'a link'}${s(e.after?.account) ? ` on ${s(e.after?.account)}` : ''}`;
      if (s(e.after?.person)) return `matched ${s(e.after?.with)} to ${s(e.after?.person)}`;
      if (s(e.after?.to))
        return `recorded a reply sent from ${metaWord(e.after?.channel) === 'Instagram' ? 'Instagram' : 'Facebook'} to ${s(e.after?.to)}`;
      return `received a ${metaWord(e.after?.channel) ?? 'Messenger'} message${s(e.after?.from) ? ` from ${s(e.after?.from)}` : ''}`;
    case 'meta_message.receipt':
      return `confirmed a ${metaWord(e.after?.channel) ?? 'Messenger'} message was ${s(e.after?.status) === 'read' ? 'seen' : 'delivered'}`;
    // Facebook lead ads (funnels)
    case 'meta_lead.receive':
      if (e.entityType === 'attribution_touch')
        return `recorded that a customer came from ${s(e.after?.from) || 'a lead form'}${s(e.after?.account) ? ` on ${s(e.after?.account)}` : ''}`;
      if (e.entityType === 'person') return 'added a customer from a Facebook lead ad';
      return 'opened a lead from a Facebook lead ad';
    case 'meta_message.edit':
      return 'recorded that a customer changed or took back a message';
    case 'ad.resolve':
      return s(e.after?.ad) || s(e.after?.campaign)
        ? `looked up the ad${s(e.after?.ad) ? ` “${s(e.after?.ad)}”` : ''}${s(e.after?.campaign) ? ` in the campaign “${s(e.after?.campaign)}”` : ''}`
        : s(e.after?.status) === 'no_access'
          ? 'couldn’t look up an ad: no Facebook sign-in here may read it'
          : s(e.after?.status) === 'not_found'
            ? 'couldn’t look up an ad: Meta no longer has it'
            : 'couldn’t look up an ad at Meta yet';
    case 'message.update_status':
      return statusSentence(e);
    case 'message.attach_media': {
      const n = Number(e.after?.photos ?? 0);
      if (metaWord(e.after?.channel))
        return `saved ${n === 1 ? 'a file' : `${n} files`} from a ${metaWord(e.after?.channel)} message`;
      return `saved ${n === 1 ? 'a photo' : `${n} photos`} from a text`;
    }
    case 'call.start':
      return `called ${s(e.after?.to) || 'a customer'} from the browser`;
    case 'call.record':
      return `took a call from ${s(e.after?.from) || 'a caller'}`;
    case 'call.update_status':
      // A call through a teammate's cell that nobody pressed 1 on (M10): it never reached the customer.
      if (s(e.after?.status) && !s(e.after?.direction))
        return `ended a call through a teammate’s cell to ${withWho(e)}: nobody pressed 1, so it never rang`;
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
    case 'person.set_call_consent':
      return e.after?.callConsent === 'opted_out'
        ? `recorded that ${s(e.after?.name)} doesn’t want calls`
        : `recorded that ${s(e.after?.name)} agreed in writing to calls${s(e.after?.source) ? ` (${s(e.after?.source)})` : ''}`;
    case 'attendee.confirm_by_call':
      return `recorded that the customer confirmed ${apptTitle(e)} on a call from the AI`;
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
    // Video meetings: people's own Zoom accounts
    case 'meeting_connection.connect':
      return 'started connecting a Zoom account';
    case 'meeting_connection.activate':
      return `connected the Zoom account ${s(e.after?.account)}`;
    case 'meeting_connection.disconnect':
      return s(e.after?.person)
        ? `disconnected ${s(e.after?.person)}'s Zoom account`
        : `disconnected the Zoom account ${s(e.after?.account)}`;
    case 'meeting_connection.fail':
      return s(e.after?.status) === 'reauth_required'
        ? `recorded that the Zoom account ${s(e.after?.account)} needs reconnecting`
        : `recorded that the Zoom account ${s(e.after?.account)} stopped working${s(e.after?.error) ? `: ${s(e.after?.error)}` : ''}`;
    case 'meeting_connection.revoke':
      return 'disconnected a Zoom account after the HandsFreeOS app was removed in Zoom';
    case 'meeting_connection.check_settings':
      return `asked for the Zoom account ${s(e.after?.account)}’s settings to be checked again`;
    case 'meeting_connection.record_settings':
      return `checked the Zoom account ${s(e.after?.account)}’s recording settings`;
    case 'appointment.set_meeting_link':
      return 'updated an appointment’s video link';
    case 'appointment.attach_transcript':
      return `kept the transcript of the call for ${s(e.after?.title)}`;
    case 'call_suggestion.record':
      return `summed up the call for ${s(e.after?.title)}`;
    case 'call_suggestion.decide':
      return s(e.after?.decision) === 'approve'
        ? `approved the AI’s suggested ${s(e.after?.kind) === 'task' ? 'task' : 'follow-up email'} after a call`
        : `dismissed the AI’s suggested ${s(e.after?.kind) === 'task' ? 'task' : 'follow-up email'} after a call`;
    case 'appointment.make_meeting_link':
      return 'asked for an appointment’s Zoom link to be made again';
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
      return s(e.after?.kind) === 'radius'
        ? `added the territory ${name(e)}: ${String(e.after?.miles ?? '')} miles from ${s(e.after?.from) || 'a point on the map'}`
        : s(e.after?.kind) === 'polygon'
          ? `added the territory ${name(e)}, drawn on the map`
          : `added the territory ${name(e)} with ${count(e.after?.zipCodes, 'ZIP code', 'ZIP codes')}`;
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
    case 'appointment.still_going':
      return `said ${apptTitle(e)} was still going`;
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
    // Milestone 7: website chat
    case 'chat_widget.create':
      return `added a website chat for ${name(e)}`;
    case 'chat_widget.update':
      return `updated the website chat on ${name(e)} (${chatWidgetFields(e)})`;
    case 'chat_widget.pause':
      return `paused the website chat on ${name(e)}`;
    case 'chat_widget.resume':
      return `turned the website chat on ${name(e)} back on`;
    case 'chat_widget.rotate_key':
      return `gave the website chat on ${name(e)} a new key, so snippets pasted before stop working`;
    case 'chat.receive':
      return `received a website chat from ${s(e.after?.from) || 'a website visitor'}`;
    case 'chat.identify':
      return chatIdentifySentence(e);
    case 'chat.block_visitor':
      return e.after?.network
        ? `blocked ${s(e.after?.name) || 'a website visitor'} and their network from the website chat for 7 days`
        : `blocked ${s(e.after?.name) || 'a website visitor'} from the website chat`;
    case 'chat.unblock_visitor':
      return `let ${s(e.after?.name) || 'a website visitor'} use the website chat again`;
    // Milestone 7: the AI teammate
    case 'ai_teammate.create':
      return `set up the AI teammate ${s(e.after?.name)}${s(e.after?.preset) ? ` as ${s(e.after?.preset)}` : ''}`;
    case 'ai_teammate.save_config':
      return teammateSaveSentence(e);
    case 'ai_teammate.restore':
      return `brought back an earlier version of ${s(e.after?.name) || 'the AI teammate'}’s settings`;
    case 'ai_teammate.set_status':
      return teammateStatusSentence(e);
    case 'ai_teammate.decide_draft':
      return teammateDecisionSentence(e);
    case 'ai_teammate.send_draft':
      return `sent ${teammateOf(e)}’s approved draft${Number(e.after?.actions ?? 0) ? ', with its booking change' : ''}`;
    case 'ai_teammate.retry':
      return `asked ${teammateOf(e)} for a new draft${s(e.after?.reason) ? ` (“${s(e.after?.reason)}”)` : ''}`;
    case 'chat.mark_sent':
      return 'delivered a reply to a website chat';
    case 'chat.mark_read':
      return `saw ${Number(e.after?.replies ?? 1) === 1 ? 'a reply' : `${Number(e.after?.replies)} replies`} in the website chat`;
    case 'ai_teammate.reply':
      return `saved a draft from ${teammateOf(e)} for someone’s OK`;
    case 'ai_teammate.expire_draft':
      return 'let an AI teammate draft expire, so the conversation went to a person';
    case 'ai_teammate.budget_notice':
      return `told ${list(e.after?.emailed) || 'the owners'} that ${teammateOf(e)} used its share of today’s AI limit`;
    // Quick setup for the AI teammate: starting it, asking for the website to be read, and Save.
    case 'ai_setup.save':
      return s(e.after?.url)
        ? `asked the AI teammate to read ${kbSite(e.after?.url)} for quick setup`
        : `started quick setup for the AI teammate${Number(e.after?.run ?? 1) > 1 ? ' again' : ''}`;
    case 'ai_setup.finish':
      return aiSetupFinishSentence(e);
    case 'ai_setup.note_found': {
      const found = [
        count(e.after?.services, 'service', 'services'),
        ...(Number(e.after?.facts ?? 0)
          ? [count(e.after?.facts, 'answer to the quick facts', 'answers to the quick facts')]
          : []),
        count(e.after?.questions, 'question for leads', 'questions for leads'),
        ...(e.after?.hours ? ['the open hours'] : []),
      ];
      return `read ${kbSite(e.after?.url)} for quick setup and found ${andJoin(found)}`;
    }
    // An agency's saved answers for the setup (the agency area's Saved setups)
    case 'ai_setup_template.save':
      return `saved ${s(e.after?.from) ? `${s(e.after?.from)}’s ` : ''}quick setup answers as the AI setup “${name(e)}”`;
    case 'ai_setup_template.rename':
      return `renamed the AI setup “${s(e.before?.name)}” to “${s(e.after?.name)}”`;
    case 'ai_setup_template.delete':
      return `removed the AI setup “${name(e)}”`;
    case 'conversation.hand_off':
      return `handed the conversation with ${withWho(e)} to a person${handoffReasonWords(e)}`;
    case 'conversation.pick_up':
      return `picked up the conversation with ${withWho(e)}`;
    case 'conversation.take_over':
      return `took over the conversation with ${withWho(e)} from the AI teammate${e.after?.draftCancelled ? ', dropping its draft' : ''}`;
    case 'conversation.hand_to_ai':
      return `handed the conversation with ${withWho(e)} to ${teammateOf(e)}`;
    case 'lead.record_answers':
      return s(e.after?.status) === 'qualified' && e.after?.answers === undefined
        ? `marked ${title(e)} qualified`
        : `recorded ${Number(e.after?.answers ?? 0) === 1 ? 'a qualifying answer' : `${Number(e.after?.answers ?? 0)} qualifying answers`} on ${title(e)}${QUALIFY_STATUS[s(e.after?.status)] ?? ''}`;
    case 'appointment.book_for_customer':
      return `booked ${name(e) === 'a record' ? 'a visit' : name(e)} for the customer`;
    case 'attendee.reschedule_for_customer':
      return 'moved a visit for the customer';
    case 'attendee.cancel_for_customer':
      return 'cancelled a visit for the customer';
    case 'series.book_for_customer':
      return `booked ${count(e.after?.occurrences, 'visit', 'visits')} of ${apptTitle(e)} for the customer, starting ${when(e.after?.startsAt)}`;
    case 'invoice.create_for_customer':
      return `sent the customer a bill${s(e.after?.invoice) ? ` (${s(e.after?.invoice)})` : ''}, with an owner’s OK`;
    case 'estimate.create_for_customer':
      return `sent the customer a quote${s(e.after?.estimate) ? ` (${s(e.after?.estimate)})` : ''}, with an owner’s OK`;
    case 'estimate.answer_for_customer':
      return `recorded the customer’s answer to ${s(e.after?.estimate) || 'a quote'}, with an owner’s OK`;
    case 'subscription.start_for_customer':
      return `signed the customer up for ${s(e.after?.plan) || 'a plan'}, with an owner’s OK`;
    case 'chat.send_code_for_customer':
      return `sent a code to ${s(e.after?.sentTo) || 'the customer'} to check who is in the chat`;
    case 'chat.check_code_for_customer':
      return 'checked the chat visitor’s code: they’re the customer';
    case 'offer.create':
      return `added the promotion “${s(e.after?.name) || 'a promotion'}”`;
    case 'offer.update':
      return 'changed a promotion';
    case 'offer.archive':
      return `removed the promotion “${s(e.after?.name) || 'a promotion'}”`;
    case 'job.set_status':
      return e.after?.note !== undefined && s(e.before?.status) === s(e.after?.status)
        ? `changed the customer’s note on the job ${s(e.after?.title) || ''}`.trim()
        : `marked the job ${s(e.after?.title) || ''} ${s(e.after?.status).toLowerCase() || 'changed'}`.replace(
            '  ',
            ' ',
          );
    case 'job.add_visit':
      return `added the visit ${s(e.after?.visit) || ''} to the job ${s(e.after?.job) || ''}`
        .replace(/\s+/g, ' ')
        .trim();
    case 'appointment.add_for_customer':
      return `added to ${apptTitle(e)}${s(e.after?.service) ? `: ${s(e.after?.service)}` : ''}${e.after?.seats !== undefined ? `, now for ${String(e.after?.seats)}` : ''}${s(e.after?.note) ? ', with a note' : ''}`;
    case 'waitlist.join_for_customer':
      return `added ${s(e.after?.customer) || 'the customer'} to the waitlist for ${s(e.after?.calendar) || 'a calendar'}`;
    case 'message.record_opt_out':
      return `recorded that ${s(e.after?.number) || 'a customer'} asked to stop getting texts${s(e.after?.words) ? ` (“${s(e.after?.words)}”)` : ''}`;
    // Milestone 8: confirming a booking (by text in message.receive, above)
    // Funnels: one person on a session.
    case 'attendee.set_attendance':
      return s(e.after?.status) === 'attended'
        ? `marked someone attended at ${apptTitle(e)}`
        : s(e.after?.status) === 'no_show'
          ? `marked someone a no-show at ${apptTitle(e)}`
          : `recorded that someone joined ${apptTitle(e)}`;
    case 'attendee.confirm':
      return s(e.after?.confirmedVia) === 'staff'
        ? `marked ${apptTitle(e)}${forWhom(e)} on ${when(e.after?.startsAt)} confirmed`
        : `took back the confirmation on ${apptTitle(e)}${forWhom(e)}`;
    case 'attendee.confirm_online':
      return `recorded that ${customerOf(e)} confirmed ${apptTitle(e)} on ${when(e.after?.startsAt)}`;
    // Milestone 8: the Action Center (what the worker noticed is in the default branch, hidden by default)
    case 'attention.snooze':
      return `snoozed ${itemOf(e)} until ${when(e.after?.snoozedUntil)}`;
    case 'attention.unsnooze':
      return e.actor.type === 'system'
        ? `brought back ${itemOf(e)}: its snooze ended`
        : `brought back ${itemOf(e)} early`;
    case 'attention.dismiss':
      return `dismissed ${itemOf(e)}${s(e.after?.reason) ? ` (“${s(e.after?.reason)}”)` : ''}`;
    case 'attention.restore':
      return s(e.before?.state) === 'dismissed'
        ? `undid dismissing ${itemOf(e)}`
        : `undid snoozing ${itemOf(e)}`;
    case 'attention.assign':
      return s(e.after?.assignee)
        ? `gave ${itemOf(e)} to ${s(e.after?.assignee)}`
        : `left ${itemOf(e)} for anyone`;
    case 'attention.let_handle':
      return letHandleSentence(e);
    case 'attention.cancel_auto':
      return `cancelled the ${autoNoun(e)} waiting to go out for ${itemOf(e)}`;
    case 'attention.save_settings':
      return attentionSettingsSentence(e);
    case 'automations.save_settings':
      return automationsSettingsSentence(e);
    case 'maintenance.set_schedule':
      return `set ${s(e.after?.customer) || 'a customer'}’s ${s(e.after?.service) || 'service'} to ${s(e.after?.every) || 'the default'}`;
    case 'referral.create_lead':
      return s(e.after?.lead)
        ? `made a lead from a referral: “${s(e.after?.lead)}” (${s(e.after?.source) || 'Referral'})`
        : 'made a lead from a referral';
    case 'teammate_lesson.apply':
      return s(e.after?.line)
        ? `added to what the AI knows: “${s(e.after?.line)}”`
        : 'added a line to what the AI knows';
    case 'attention.record_auto':
      return recordAutoSentence(e);
    case 'campaign.create':
      return `started the campaign ${campaignOf(e)} for ${countOf(e.after?.recipients)} ${countOf(e.after?.recipients) === 1 ? 'person' : 'people'}${e.after?.keepAdding === true ? ', adding more as they fit' : ''}`;
    case 'campaign.update_draft':
      return `changed a text in a campaign`;
    case 'campaign.update_email':
      return `changed the email in the campaign ${campaignOf(e)}`;
    case 'campaign.update_call':
      return `changed how the calls open in the campaign ${campaignOf(e)}`;
    case 'email_unsubscribe.record':
      return `recorded that ${s(e.after?.address) || 'a customer'} unsubscribed from campaign email`;
    case 'campaign.remove_recipient':
      return `took someone out of a campaign`;
    case 'campaign.approve':
      return `approved the campaign ${campaignOf(e)}: ${countOf(e.after?.approved)} ${campaignNoun(e)}, ${countOf(e.after?.perHour)} an hour`;
    case 'campaign.pause':
      return `paused the campaign ${campaignOf(e)}`;
    case 'campaign.resume':
      return `resumed the campaign ${campaignOf(e)}`;
    case 'campaign.cancel':
      return `stopped the campaign ${campaignOf(e)}`;
    case 'campaign.set_pace':
      return `set the campaign ${campaignOf(e)} to ${countOf(e.after?.perHour)} ${campaignNoun(e)} an hour`;
    case 'campaign.set_keep_adding':
      return e.after?.keepAdding === true
        ? `had the campaign ${campaignOf(e)} keep adding people`
        : `stopped adding people to the campaign ${campaignOf(e)}`;
    default:
      return detectionSentence(e) ?? e.action;
  }
}

/** “Fall tune-up”: a campaign's name, as its entries carry it. */
const campaignOf = (e: AuditEntry) => {
  const t = s(e.after?.name) || e.entityName;
  return t ? `“${t}”` : '';
};
/** What a campaign sends, as its audit line counts them. */
const campaignNoun = (e: AuditEntry) =>
  s(e.after?.channel) === 'email' ? 'emails' : s(e.after?.channel) === 'call' ? 'calls' : 'texts';
const countOf = (v: unknown): number => (typeof v === 'number' ? v : 0);

// ---- Milestone 8: the Action Center helpers ----

/** “Maria Lopez · New AC install”: the item's title, copied into each of its entries. */
const itemOf = (e: AuditEntry) => {
  const t = s(e.after?.item) || s(e.before?.item) || e.entityName;
  return t ? `“${t}”` : 'an Action Center item';
};
const customerOf = (e: AuditEntry) => strings(e.after?.customers)[0] || 'the customer';
/** An automatic action's noun, from the item's kind (copied in as its label). */
const autoNoun = (e: AuditEntry) =>
  s(e.after?.kind) === ATTENTION_KIND_LABELS.unconfirmed_appointment
    ? 'confirmation request'
    : 'follow-up';

function letHandleSentence(e: AuditEntry): string {
  switch (s(e.after?.action)) {
    case 'hand_to_ai':
      return `handed ${itemOf(e)} to the AI teammate from the Action Center`;
    case 'reply':
      return `replied to ${itemOf(e)} from the Action Center`;
    case 'set_next_action':
      return `set a next action for ${itemOf(e)} from the Action Center`;
    default:
      return `asked HandsFreeOS to send the ${autoNoun(e)} for ${itemOf(e)}`;
  }
}

/** Why an automatic message didn't go, in plain words (the worker's reason codes). */
const AUTO_SKIP: Record<string, string> = {
  // Who it would have gone to
  opted_out: 'they opted out',
  someone_talking: 'someone is talking with them',
  customer_waiting: 'they’re waiting on a reply',
  draft_pending: 'a draft is waiting for approval',
  workflow_running: 'they’re in a workflow',
  recent_person_contact: 'a person messaged them recently',
  cooldown: 'they got an automatic message recently',
  // What it was about
  lead_closed: 'the lead is closed',
  subject_gone: 'what it was about is gone',
  not_open: 'the item wasn’t open any more',
  resolved: 'it had already been taken care of',
  already_sent: 'one had already gone',
  too_late: 'it was too late to send',
  // The business's own settings
  turned_off: 'it’s switched off',
  nudge_not_reviewed: 'nobody has read the follow-up wording yet',
  nudge_incomplete: 'the follow-up wording couldn’t be filled in',
  quiet_hours: 'it was quiet hours',
  no_booking_link: 'there’s no booking link to send',
  // No way to send it
  no_way_to_reach: 'there’s no way to reach them',
  messaging_not_ready: 'texting isn’t set up yet',
  no_number: 'there’s no number to text from',
  no_email_address: 'there’s no email address for them',
  recipient_suppressed: 'email to them is stopped',
  email_domain_unverified: 'the business’s email domain isn’t verified',
  invalid_contact: 'their number or address isn’t usable',
};

function recordAutoSentence(e: AuditEntry): string {
  const noun = autoNoun(e);
  if (s(e.after?.autoState) === 'scheduled')
    return `scheduled a ${noun} for ${itemOf(e)}, to go ${when(e.after?.scheduledFor)}`;
  if (s(e.after?.autoState) === 'skipped') {
    const why = AUTO_SKIP[s(e.after?.reason)] ?? s(e.after?.reason).replace(/_/g, ' ');
    return `didn’t send the ${noun} for ${itemOf(e)}${why ? `: ${why}` : ''}`;
  }
  if (s(e.after?.state) === 'handled')
    return `sent a ${noun} for ${itemOf(e)} by ${s(e.after?.channel) === 'email' ? 'email' : 'text'}`;
  return `recorded the ${noun} for ${itemOf(e)}`;
}

const SETTING_WORDS: Record<string, string> = {
  kinds: 'what to look for',
  hot: 'hot leads',
  unanswered: 'unanswered leads',
  stale: 'gone-quiet days',
  appointments: 'the confirmation window',
  typicalJobValueCents: 'the typical job value',
  auto: 'what it does on its own',
  nudge: 'the follow-up wording',
  replyToConfirm: '“Reply C to confirm”',
};

function attentionSettingsSentence(e: AuditEntry): string {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const before = obj(e.before?.attention);
  const after = obj(e.after?.attention);
  const was = obj(before.auto);
  const now = obj(after.auto);
  if (!was.nudgeReviewedAt && now.nudgeReviewedAt)
    return 'read the follow-up wording and turned automatic follow-ups on';
  if (typeof now.nudges === 'boolean' && now.nudges !== was.nudges)
    return `turned automatic follow-ups ${now.nudges ? 'on' : 'off'}`;
  if (typeof now.confirmRequests === 'boolean' && now.confirmRequests !== was.confirmRequests)
    return `turned confirmation requests ${now.confirmRequests ? 'on' : 'off'}`;
  const changed = Object.keys(SETTING_WORDS).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return changed.length
    ? `changed the Action Center settings: ${andJoin(changed.map((k) => SETTING_WORDS[k]!))}`
    : 'saved the Action Center settings';
}

/** Automations' own switches, in the words the page gives them. */
const SWITCH_WORDS: Readonly<Record<string, string>> = {
  dayBefore: 'the day-before confirmation',
  dayOf: 'the day-of reminder',
  waitlist: 'waitlist offers',
  morningBrief: 'the morning brief',
  reengage: 're-engaging dead leads',
  intake: 'intake questions',
  thankYou: 'thank-yous after the job',
  maintenance: 'maintenance reminders',
  callConfirmVisits: 'AI calls to confirm tomorrow’s visits',
  callBackMissed: 'AI calls back for missed calls',
};

function automationsSettingsSentence(e: AuditEntry): string {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const was = obj(obj(e.before?.automations).switches);
  const now = obj(obj(e.after?.automations).switches);
  if (
    !obj(obj(e.before?.automations).reengage).reviewedAt &&
    obj(obj(e.after?.automations).reengage).reviewedAt
  )
    return 'read the re-engage message and turned re-engaging dead leads on';
  const words = (on: boolean) =>
    Object.keys(SWITCH_WORDS)
      .filter((k) => now[k] === on && was[k] !== on)
      .map((k) => SWITCH_WORDS[k]!);
  const on = words(true);
  const off = words(false);
  const parts = [
    ...(on.length ? [`turned ${andJoin(on)} on`] : []),
    ...(off.length ? [`turned ${andJoin(off)} off`] : []),
  ];
  return parts.length ? parts.join(' and ') : 'saved the automation settings';
}

/** What the worker notices as facts change: an item opened, came back, became urgent or cleared. */
const NOTICED = new Set(['opened', 'reopened', 'snooze_ended', 'resolved', 'became_urgent']);
const noticedTail = (e: AuditEntry): string | null => {
  const [head, tail = ''] = e.action.split('.', 2);
  return head === 'attention_item' || (head === 'attention' && NOTICED.has(tail)) ? tail : null;
};

/**
 * The worker's notes on what it noticed, which the audit log hides until asked ("Show what HandsFreeOS noticed"):
 * the transitions only, never a sweep that found nothing new.
 */
export function isAuditDetection(e: AuditEntry): boolean {
  return e.actor.type === 'system' && noticedTail(e) !== null;
}

function detectionSentence(e: AuditEntry): string | null {
  const tail = noticedTail(e);
  if (tail === null) return null;
  switch (tail) {
    case 'opened':
      return `noticed ${itemOf(e)}`;
    case 'reopened':
      return `brought back ${itemOf(e)}: something changed`;
    case 'resolved':
      return `cleared ${itemOf(e)}: it doesn’t need anyone now`;
    case 'became_urgent':
      return `marked ${itemOf(e)} urgent`;
    default:
      return `brought back ${itemOf(e)}: its snooze ended`;
  }
}

// ---- Milestone 7: the AI teammate helpers ----

/** "Ava (AI)", from the entry's own words (its name is copied into most of them). */
const teammateOf = (e: AuditEntry) => {
  const n = s(e.after?.teammate) || s(e.after?.name);
  return n ? `${n} (AI)` : 'the AI teammate';
};

const QUALIFY_STATUS: Record<string, string> = {
  qualified: ', and the lead qualified',
  not_a_fit: ', and an answer rules them out',
  incomplete: '',
};

const HANDOFF_REASON_WORDS: Record<string, string> = {
  asked_for_person: 'they asked for a person',
  frustrated: 'they sounded frustrated',
  cant_answer: 'it couldn’t answer from Knowledge',
  sensitive: 'a sensitive topic',
  emergency: 'an emergency',
  legal: 'a legal threat',
  complaint: 'a complaint',
  refund: 'a refund',
  cancellation: 'cancelling service',
  limit: 'the daily reply limit',
  budget: 'the day’s AI limit',
  wallet: 'the balance ran out',
  error: 'something went wrong',
  draft_expired: 'nobody approved its draft in time',
  loop: 'an automatic reply loop',
  other: 'a person should take it',
};
const handoffReasonWords = (e: AuditEntry) => {
  const r = HANDOFF_REASON_WORDS[s(e.after?.reason)];
  return r ? ` (${r})` : '';
};

function teammateSaveSentence(e: AuditEntry): string {
  const changes = Array.isArray(e.after?.changes) ? e.after.changes.map(String) : [];
  const who = s(e.after?.name) || 'the AI teammate';
  if (!changes.length) return `saved ${who}’s settings`;
  const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
  return `changed ${who}’s settings: ${changes[0]}${more}`;
}

function aiSetupFinishSentence(e: AuditEntry): string {
  const changes = strings(e.after?.changes);
  const who = s(e.after?.name) || 'the AI teammate';
  if (!changes.length) return `saved quick setup for ${who}, which changed nothing`;
  const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
  return `saved quick setup for ${who}: ${changes[0]}${more}`;
}

function teammateStatusSentence(e: AuditEntry): string {
  const who = s(e.after?.name) || 'the AI teammate';
  switch (s(e.after?.status)) {
    case 'off':
      return `turned ${who} off`;
    case 'training':
      return s(e.before?.status) === 'automatic'
        ? `put ${who} back on training wheels`
        : `turned ${who} on, with training wheels`;
    case 'automatic':
      return s(e.after?.via) === 'threshold'
        ? `gave ${who} its last approval, so it replies on its own now`
        : `switched ${who} to automatic`;
    default:
      return `changed ${who}’s status`;
  }
}

function teammateDecisionSentence(e: AuditEntry): string {
  // The approval that reached the threshold also records the switch to automatic.
  if (s(e.after?.status) === 'automatic') return teammateStatusSentence(e);
  const who = teammateOf(e);
  if (s(e.after?.decision) === 'Rejected')
    return `rejected ${who}’s draft${s(e.after?.reason) ? `: “${s(e.after?.reason)}”` : ''}`;
  return `approved ${who}’s draft${e.after?.edited ? ' with an edit' : ''}`;
}

// ---- Milestone 7: website chat helpers ----

const CHAT_WIDGET_FIELD: Record<string, string> = {
  allowedOrigins: 'sites',
  teammateId: 'who answers',
  greeting: 'greeting',
  launcherLabel: 'button label',
  accentColor: 'colour',
  textColor: 'words’ colour',
  headerColor: 'top bar colour',
  showLogo: 'logo',
  position: 'position',
  mobilePosition: 'corner on phones',
  desktopLift: 'height on computers',
  mobileLift: 'height on phones',
  desktopButton: 'button on computers',
  mobileButton: 'button on phones',
  awayMessage: 'away message',
  whenAway: 'what happens while nobody answers',
  askFor: 'what it asks for',
  smsConsent: 'texts consent box',
  dailyCap: 'daily limit',
  name: 'name',
};
// `before` holds exactly the fields that changed; `after` always carries the chat's name to show, so without a
// `before` the name is left out.
const chatWidgetFields = (e: AuditEntry) =>
  andJoin(
    (e.before ? Object.keys(e.before) : Object.keys(e.after ?? {}).filter((k) => k !== 'name')).map(
      (k) => CHAT_WIDGET_FIELD[k] ?? k,
    ),
  ) || 'details';

/** chat.identify writes the visitor's details, and can add a customer and link the chat to them. */
function chatIdentifySentence(e: AuditEntry): string {
  if (e.entityType === 'person') return `added ${name(e)} from the website chat`;
  if (e.entityType === 'conversation')
    return `linked a website chat to ${s(e.after?.person) || 'a customer'}`;
  const said = s(e.after?.name);
  return said
    ? `noted that a website visitor said their name is ${said}`
    : 'noted the details a website visitor gave';
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

/**
 * waitlist.offer_expired: the time went back to the waitlist, or they wait again (someone else took it).
 * waitlist.window_passed: the window of time they waited for is over.
 * waitlist.session_passed: the session they waited for started, or was cancelled.
 */
function offerExpiredSentence(e: AuditEntry): string {
  const who = s(e.after?.customer) || 'a customer';
  const cal = s(e.after?.calendar) ? ` for ${s(e.after?.calendar)}` : '';
  if (s(e.after?.reason) === 'window_passed')
    return `took ${who} off the waitlist${cal}: the times they wanted have passed`;
  if (s(e.after?.reason) === 'session_started')
    return `took ${who} off the waitlist for ${apptTitle(e)}: it has started`;
  if (s(e.after?.reason) === 'session_cancelled')
    return `took ${who} off the waitlist for ${apptTitle(e)}: it was cancelled`;
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

/**
 * What the old carrier said, in a sentence. The one that matters is `scheduled`: a business plans its week
 * around moving day, and a row in the log that names the date is often the only place it is written down.
 */
function portStateSentence(e: AuditEntry): string {
  const status = s(e.after?.status);
  const moves = s(e.after?.moves);
  switch (status) {
    case 'carrier_review':
      return 'the old carrier is looking at the number move';
    case 'scheduled':
      return moves
        ? `the old carrier set ${moves} as the day the number moves`
        : 'the old carrier agreed to move the number';
    case 'rejected':
      return 'the old carrier turned the number move down';
    case 'failed':
      return 'the number move did not go through';
    default:
      return `recorded the number move as ${status || 'changed'}`;
  }
}

/** Paying for RCS, stopping it renewing, and its yearly renewal (0104). */
function rcsRequestSentence(e: AuditEntry): string {
  switch (e.action) {
    case 'rcs_request.cancel':
      return s(e.after?.renews) === 'no'
        ? `stopped RCS renewing; it stays on until ${s(e.after?.until)}`
        : 'gave up on the RCS request before paying';
    case 'rcs_request.record_paid':
      return `paid ${s(e.after?.paid)} for RCS; HandsFreeOS is making the sender (ticket ${s(e.after?.ticket)})`;
    default:
      return s(e.after?.renewal) === 'refused'
        ? `couldn’t renew RCS: ${s(e.after?.reason)}`
        : `renewed RCS for ${s(e.after?.paid)}, paid through ${s(e.after?.until)}`;
  }
}

function rcsStateSentence(e: AuditEntry): string {
  // The same sender put on texting or taken off it (switched on or off in Settings), with no news from the carriers.
  if (typeof e.after?.inService === 'boolean' && !s(e.after?.status))
    return e.after.inService
      ? 'put the RCS sender on texting: texts go as RCS where phones can show it'
      : 'took the RCS sender off texting for now: texts go as SMS and MMS';
  const reason = s(e.after?.reason) ? `: ${s(e.after?.reason)}` : '';
  switch (s(e.after?.status)) {
    case 'in_review':
      return 'noted the carriers are reviewing the RCS sender';
    case 'active':
      return 'recorded that the RCS sender is approved: texts go as RCS where phones can show it';
    case 'offline':
      return `recorded that the RCS sender went offline${reason}`;
    case 'failed':
      return `could not connect the RCS sender${reason}`;
    case 'disconnected':
      return 'took the RCS sender off texting';
    default:
      return `recorded the RCS sender as ${s(e.after?.status) || 'changed'}`;
  }
}

const withWho = (e: AuditEntry) =>
  s(e.after?.with) || s(e.before?.with) || e.entityName || 'a customer';

/**
 * A customer waiting for a reply, told: by email to the people named, and (M10) on the phones of `pushed` people,
 * so the line never says "emailed nobody" when phones were told.
 */
function unansweredSentence(e: AuditEntry): string {
  const emailed = list(e.after?.emailed);
  const pushed = Number(e.after?.pushed ?? 0);
  const phones =
    pushed > 0 ? `told ${pushed === 1 ? '1 person' : `${pushed} people`} on their phones` : '';
  const how =
    emailed && phones
      ? `emailed ${emailed} and ${phones}`
      : emailed
        ? `emailed ${emailed}`
        : phones;
  return `${how || 'emailed nobody'} that ${s(e.after?.with)} is waiting for a reply`;
}

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

/** A Page or Instagram account that stopped answering here, and why. */
function metaAccountGone(e: AuditEntry): string {
  const account = s(e.after?.account);
  switch (s(e.after?.reason)) {
    case 'moved':
      return `stopped answering ${account}: another business connected it`;
    case 'revoked':
      return `recorded that ${account} was removed from HandsFreeOS on Facebook`;
    case 'failed':
      return `stopped answering ${account}: its sign-in stopped working`;
    default:
      return `disconnected ${account}`;
  }
}

function receiveSentence(e: AuditEntry): string {
  if (e.entityType === 'message') return `received a text from ${s(e.after?.from)}`;
  // A reply of C (or YES while asked) confirmed a booking (M8).
  if (e.entityType === 'appointment' && s(e.after?.confirmedVia) === 'sms')
    return `recorded that ${customerOf(e)} confirmed ${apptTitle(e)} on ${when(e.after?.startsAt)} by text`;
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
  const what =
    s(e.after?.channel) === 'email'
      ? 'an email'
      : s(e.after?.channel) === 'chat'
        ? 'a chat message'
        : s(e.after?.channel) === 'portal'
          ? 'a portal message'
          : metaWord(e.after?.channel)
            ? `a ${metaWord(e.after?.channel)} message`
            : 'a text';
  if (status === 'delivered') return `confirmed ${what} was delivered`;
  if (status === 'bounced')
    return `recorded that an email bounced${s(e.after?.errorMessage) ? `: ${s(e.after?.errorMessage)}` : ''}`;
  if (status === 'complained') return 'recorded that a customer marked an email as spam';
  if ((status === 'failed' || status === 'undelivered') && metaWord(e.after?.channel))
    return `recorded that ${what} didn’t reach them${s(e.after?.errorMessage) ? `: ${s(e.after?.errorMessage)}` : ''}`;
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
    return `held an email from ${s(e.after?.from)}, who isn’t in Contacts yet`;
  if (e.entityType === 'conversation')
    return s(e.after?.person)
      ? `matched ${s(e.after?.with)} to ${s(e.after?.person)}`
      : `started an email conversation with ${withWho(e)}`;
  const from = s(e.after?.from);
  return `received an email${from ? ` from ${from}` : ''}`;
}

const name = (e: AuditEntry) => s(e.after?.name) || s(e.before?.name) || e.entityName || 'a record';
/**
 * A customer or a company by name, "the conversation with …", "the booking …", "the lead …" or a record with its
 * kind ("the pet Rex"), as the Deleted bin lists them.
 */
function binThing(e: AuditEntry): string {
  if (e.entityType === 'conversation') return `the conversation with ${name(e)}`;
  if (e.entityType === 'appointment') return `the booking ${name(e)}`;
  if (e.entityType === 'lead') return `the lead ${name(e)}`;
  const contents = e.after?.contents;
  const kind =
    e.entityType === 'custom_record' && contents && typeof contents === 'object'
      ? s((contents as Record<string, unknown>).type)
      : '';
  return kind ? `the ${kind.toLowerCase()} ${name(e)}` : name(e);
}
/** What a delete put in the bin, or a booking still to come it cancelled first (or a class seat it gave up). */
function binDeleteSentence(e: AuditEntry): string {
  if (e.after?.deleted) return `deleted ${binThing(e)}`;
  const on = s(e.after?.startsAt) ? ` on ${when(e.after?.startsAt)}` : '';
  if (e.entityType === 'appointment' && s(e.before?.status))
    return `cancelled ${apptTitle(e)}${forWhom(e)}${on} before deleting ${e.action === 'person.delete' ? 'them' : 'it'}`;
  if (e.entityType === 'appointment')
    return `took a customer off ${apptTitle(e)}${on} before deleting them`;
  return `deleted ${binThing(e)}`;
}
const title = (e: AuditEntry) => s(e.after?.title) || s(e.before?.title) || 'a lead';
const fields = (e: AuditEntry) =>
  Object.keys(e.after ?? {})
    .filter((k) => k !== 'name')
    .join(', ') || 'details';
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : '');
/** The fields a record.set_fields row changed, by their keys ("custom.gate_code" → "gate code"). */
const customKeys = (e: AuditEntry) =>
  Object.keys(e.after ?? {})
    .filter((k) => k.startsWith('custom.'))
    .map((k) => k.slice('custom.'.length).replace(/_/g, ' '))
    .join(', ') || 'fields';
/** The tag names in one list and not the other (what a single add or remove changed). */
const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '0');
/** "on Mike Johnson", when the row names who (a tag put on a customer, 0107). */
const onWhom = (e: AuditEntry): string => (s(e.after?.name) ? ` on ${s(e.after?.name)}` : '');
const tagsBetween = (these: unknown, those: unknown): string[] => {
  const other = new Set(Array.isArray(those) ? those.map(String) : []);
  return Array.isArray(these) ? these.map(String).filter((t) => !other.has(t)) : [];
};

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
  | 'ai_team'
  | 'action_center'
  | 'other';

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  action_center: 'Action Center',
  ai_team: 'AI teammate',
  members: 'Members',
  invitations: 'Invitations',
  workspace: 'Workspace',
  customers: 'Contacts',
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
  'meeting_connection.',
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
 * recorded as itself), "Ava (AI)" for the AI teammate (its name from the page, else from the entry), or
 * HandsFreeOS for system work.
 */
export function auditActor(
  e: AuditEntry,
  teammateName?: string | null,
): {
  readonly name: string;
  readonly kind: 'person' | 'workflow' | 'system' | 'ai';
  readonly workflowId: string | null;
} {
  if (e.actor.type === 'ai_employee') {
    const n = teammateName || s(e.after?.teammate);
    return { name: n ? `${n} (AI)` : 'The AI teammate', kind: 'ai', workflowId: null };
  }
  if (e.actor.type === 'workflow')
    return {
      name: e.actor.workflow ? `Workflow: ${e.actor.workflow.name}` : 'A workflow',
      kind: 'workflow',
      workflowId: e.actor.workflow?.id ?? e.actor.userId,
    };
  // The AI keeping customers' tags and details up to date on its own (0107).
  if (e.actor.type === 'system' && e.channel === 'contact_ai')
    return { name: 'HandsFreeOS AI', kind: 'system', workflowId: null };
  if (e.actor.type === 'system') return { name: 'HandsFreeOS', kind: 'system', workflowId: null };
  return { name: e.actor.fullName ?? 'Someone', kind: 'person', workflowId: null };
}

export function auditCategory(action: string): AuditCategory {
  // attention.* (people's and the worker's actions on items, and the settings) and attention_item.* (what it noticed).
  if (action.startsWith('attention')) return 'action_center';
  if (action.startsWith('workflow')) return 'workflows';
  if (
    action.startsWith('ai_teammate.') ||
    ['conversation.hand_off', 'conversation.pick_up', 'conversation.take_over'].includes(action) ||
    action === 'conversation.hand_to_ai' ||
    action === 'lead.record_answers'
  )
    return 'ai_team';
  if (CALENDAR_PREFIXES.some((p) => action.startsWith(p))) return 'calendar';
  // A person's own account (deleting it hands a business over) and their cell phone: about the team (M10).
  if (
    action.startsWith('membership.') ||
    action.startsWith('teammate_view.') ||
    action.startsWith('platform.teammate_view.') ||
    action.startsWith('account.') ||
    action.startsWith('user_phone.') ||
    action === 'organization.add_owner'
  )
    return 'members';
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
      'number_port.',
      'rcs_sender.',
      'rcs_request.',
      'texting_fee.',
      'email.',
      'email_domain.',
      'email_address.',
      'email_suppression.',
      'mailbox.',
      'chat.',
      'chat_widget.',
      'chat_visitor.',
      // Facebook Messenger and Instagram (20261025000200), and the ads that bring people to them.
      'meta_connection.',
      'meta_account.',
      'meta_message.',
      'meta_lead.',
      'ad.',
    ].some((p) => action.startsWith(p))
  )
    return 'inbox';
  if (
    action.startsWith('person.') ||
    action.startsWith('company.') ||
    action.startsWith('tag.') ||
    action.startsWith('record.') ||
    action.startsWith('contact_ai.') ||
    action.startsWith('custom_field.') ||
    action.startsWith('custom_record') ||
    action.startsWith('relationship')
  )
    return 'customers';
  if (action.startsWith('lead.') || action.startsWith('pipeline.') || action.startsWith('stage.'))
    return 'leads';
  if (action.startsWith('task.') || action.startsWith('activity.')) return 'tasks';
  if (action.startsWith('file.')) return 'files';
  if (action.startsWith('import.')) return 'imports';
  return 'other';
}
