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
    default:
      return e.action;
  }
}

export function auditCategory(action: string): 'members' | 'invitations' | 'workspace' | 'other' {
  if (action.startsWith('membership.')) return 'members';
  if (action.startsWith('invitation.')) return 'invitations';
  if (action.startsWith('workspace.') || action.startsWith('organization.')) return 'workspace';
  return 'other';
}
