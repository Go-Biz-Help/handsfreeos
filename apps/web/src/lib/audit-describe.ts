import type { AuditEntry } from './api/types';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const who = (e: AuditEntry) =>
  e.entityName || s(e.after?.email) || s(e.before?.email) || 'a person';

/** One plain-English sentence per audit row, in the third person after the actor's name. */
export function describeAudit(e: AuditEntry): string {
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
        : `sent a text to ${s(e.after?.to)}`;
    case 'message.retry':
      return `tried the text to ${s(e.after?.to)} again`;
    case 'message.receive':
      return receiveSentence(e);
    case 'message.update_status':
      return statusSentence(e);
    case 'message.attach_media': {
      const n = Number(e.after?.photos ?? 0);
      return `saved ${n === 1 ? 'a photo' : `${n} photos`} from a text`;
    }
    case 'person.set_sms_consent':
      return e.after?.smsConsent === 'opted_out'
        ? `marked ${s(e.after?.name)} as not wanting texts`
        : `marked ${s(e.after?.name)} as agreeing to texts`;
    default:
      return e.action;
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
  if (status === 'delivered') return 'confirmed a text was delivered';
  if (status === 'failed' || status === 'undelivered')
    return `recorded that a text was not delivered${s(e.after?.errorCode) ? ` (carrier error ${s(e.after?.errorCode)})` : ''}`;
  return `recorded a text as ${status || 'updated'}`;
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
  inbox: 'Inbox & texting',
  leads: 'Leads',
  tasks: 'Tasks',
  files: 'Files',
  imports: 'Imports',
  other: 'Other',
};

export function auditCategory(action: string): AuditCategory {
  if (action.startsWith('membership.')) return 'members';
  if (action.startsWith('invitation.')) return 'invitations';
  if (action.startsWith('workspace.') || action.startsWith('organization.')) return 'workspace';
  if (
    action === 'person.set_sms_consent' ||
    ['conversation.', 'message.', 'phone_number.', 'phone.', 'registration.'].some((p) =>
      action.startsWith(p),
    )
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
