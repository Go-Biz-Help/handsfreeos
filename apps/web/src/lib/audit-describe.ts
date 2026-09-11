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
    default:
      return e.action;
  }
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
