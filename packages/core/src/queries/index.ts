import type { QueryDef } from '../kernel/types';
import { auditList } from './audit.list';
import { companyGet, companyList } from './company';
import { crmFindMatches, crmSummary, fileList, importGet, importList, tagList } from './crm-misc';
import { invitationPreview } from './invitation.preview';
import { leadBoard, leadGet, leadList } from './lead';
import { me } from './me';
import { personGet, personList } from './person';
import { pipelineList } from './pipeline.list';
import { taskList } from './task.list';
import { timelineList } from './timeline.list';
import { workspaceGet } from './workspace.get';
import { workspaceInvitations } from './workspace.invitations';
import { workspaceMembers } from './workspace.members';

export {
  auditList,
  companyGet,
  companyList,
  crmFindMatches,
  crmSummary,
  fileList,
  importGet,
  importList,
  invitationPreview,
  leadBoard,
  leadGet,
  leadList,
  me,
  personGet,
  personList,
  pipelineList,
  tagList,
  taskList,
  timelineList,
  workspaceGet,
  workspaceInvitations,
  workspaceMembers,
};

export const queries: readonly QueryDef[] = [
  me,
  workspaceGet,
  workspaceMembers,
  workspaceInvitations,
  invitationPreview,
  auditList,
  pipelineList,
  companyList,
  companyGet,
  personList,
  personGet,
  tagList,
  leadBoard,
  leadList,
  leadGet,
  taskList,
  timelineList,
  fileList,
  importGet,
  importList,
  crmFindMatches,
  crmSummary,
] as unknown as readonly QueryDef[];
