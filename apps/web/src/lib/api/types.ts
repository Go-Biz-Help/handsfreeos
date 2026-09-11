import type { paths } from '@hfos/api-client';

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type Me = Ok<'/v1/queries/account.me'>;
export type WorkspaceSummary = Me['workspaces'][number];
export type WorkspaceGet = Ok<'/v1/queries/workspace.get'>;
export type Members = Ok<'/v1/queries/workspace.members'>;
export type Member = Members['members'][number];
export type Invitations = Ok<'/v1/queries/workspace.invitations'>;
export type PendingInvitation = Invitations['invitations'][number];
export type AuditList = Ok<'/v1/queries/audit.list'>;
export type AuditEntry = AuditList['entries'][number];
export type InvitationPreview = Ok<'/v1/queries/invitation.preview'>;
export type Role = 'owner' | 'admin' | 'member';
