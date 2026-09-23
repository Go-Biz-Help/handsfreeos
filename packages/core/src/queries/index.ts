import type { QueryDef } from '../kernel/types';
import { formQueries } from './form';
import { maintenanceForPerson } from './maintenance';
import { reviewQueries } from './review';
import { relationshipQueries } from './relationship';
import { templateQueries } from './template';
import { platformQueries } from './platform';
import { foundingQueries } from './founding';
import { supportQueries } from './support';
import { accountDeletionCheck, pushDeviceList, userPhoneGet } from './account';
import { aiTeammateActivity, aiTeammateDraftList, aiTeammateGet } from './ai-team';
import {
  attentionForRecord,
  attentionList,
  attentionPreviewHandle,
  attentionSettingsGet,
  attentionSummary,
} from './attention';
import { assistantThreadGet, assistantThreadList } from './assistant';
import { chatWidgetGet, chatWidgetList } from './chat';
import { auditList } from './audit.list';
import {
  appointmentGet,
  appointmentList,
  bookingSiteGet,
  calendarAvailability,
  calendarConnectionList,
  calendarGet,
  calendarList,
  resourceList,
  scheduleTeam,
  serviceList,
  territoryList,
} from './calendar';
import { companyGet, companyList } from './company';
import {
  crmFindMatches,
  crmMetrics,
  crmSummary,
  fileList,
  importGet,
  importList,
  tagList,
} from './crm-misc';
import {
  callLog,
  conversationGet,
  conversationThread,
  inboxList,
  inboxSummary,
  messageGet,
} from './inbox';
import { emailSetupStatus, emailSuppressionList, emailUnmatchedList } from './email';
import { emailComposeOptions } from './email-compose';
import { invitationPreview } from './invitation.preview';
import { intakeList } from './intake';
import { phoneSetupStatus } from './phone';
import { brandedDomainGet } from './branded-domain';
import { numberPortList } from './port';
import { leadBoard, leadGet, leadList } from './lead';
import { me } from './me';
import { personGet, personList } from './person';
import { pipelineList } from './pipeline.list';
import { taskList } from './task.list';
import { timelineList } from './timeline.list';
import { workspaceGet } from './workspace.get';
import { workspaceInvitations } from './workspace.invitations';
import { workspaceMembers } from './workspace.members';
import { migrationQueries } from './migration';
import { walletQueries } from './wallet';
import { offerList } from './offer';
import {
  workflowApprovalList,
  workflowCatalogs,
  workflowGet,
  workflowList,
  workflowProposalGet,
  workflowRunGet,
  workflowRunList,
  workflowStats,
  workflowTemplateGet,
  workflowTemplateList,
  workflowVersionGet,
} from './workflow';
import {
  estimateGet,
  estimateList,
  invoiceGet,
  invoiceList,
  moneyForRecord,
  moneySettingsGet,
  moneySummary,
  paymentConnectionList,
  paymentList,
  planList,
  productList,
  subscriptionGet,
  subscriptionList,
} from './money';
import {
  knowledgeItemGet,
  knowledgeItemList,
  knowledgePackList,
  knowledgeProfileGet,
  knowledgeScanGet,
  knowledgeSearch,
  knowledgeSuggestionList,
} from './knowledge';

export {
  accountDeletionCheck,
  pushDeviceList,
  userPhoneGet,
  conversationGet,
  conversationThread,
  callLog,
  inboxList,
  inboxSummary,
  messageGet,
  emailSetupStatus,
  emailSuppressionList,
  emailUnmatchedList,
  intakeList,
  phoneSetupStatus,
  numberPortList,
  brandedDomainGet,
  assistantThreadGet,
  assistantThreadList,
  auditList,
  companyGet,
  companyList,
  crmFindMatches,
  crmMetrics,
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
  calendarList,
  calendarGet,
  calendarAvailability,
  appointmentList,
  appointmentGet,
  scheduleTeam,
  serviceList,
  resourceList,
  territoryList,
  bookingSiteGet,
  calendarConnectionList,
};

export { emailComposeOptions };

export const queries: readonly QueryDef[] = [
  ...migrationQueries,
  ...supportQueries,
  ...platformQueries,
  ...foundingQueries,
  me,
  accountDeletionCheck,
  pushDeviceList,
  userPhoneGet,
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
  crmMetrics,
  intakeList,
  phoneSetupStatus,
  numberPortList,
  brandedDomainGet,
  callLog,
  inboxList,
  inboxSummary,
  conversationGet,
  conversationThread,
  messageGet,
  emailSetupStatus,
  emailSuppressionList,
  emailUnmatchedList,
  emailComposeOptions,
  assistantThreadList,
  assistantThreadGet,
  calendarList,
  calendarGet,
  calendarAvailability,
  appointmentList,
  appointmentGet,
  scheduleTeam,
  serviceList,
  resourceList,
  territoryList,
  bookingSiteGet,
  calendarConnectionList,
  workflowList,
  workflowGet,
  workflowVersionGet,
  workflowCatalogs,
  workflowRunList,
  workflowRunGet,
  workflowStats,
  workflowApprovalList,
  workflowProposalGet,
  workflowTemplateList,
  workflowTemplateGet,
  knowledgeProfileGet,
  knowledgeItemList,
  offerList,
  knowledgeItemGet,
  knowledgeSearch,
  knowledgeScanGet,
  knowledgeSuggestionList,
  knowledgePackList,
  aiTeammateGet,
  aiTeammateDraftList,
  aiTeammateActivity,
  chatWidgetList,
  chatWidgetGet,
  attentionList,
  attentionSummary,
  attentionForRecord,
  attentionPreviewHandle,
  attentionSettingsGet,
  maintenanceForPerson,
  productList,
  planList,
  paymentConnectionList,
  estimateList,
  estimateGet,
  invoiceList,
  invoiceGet,
  paymentList,
  subscriptionList,
  subscriptionGet,
  moneySummary,
  moneyForRecord,
  moneySettingsGet,
  ...walletQueries,
  ...formQueries,
  ...templateQueries,
  ...reviewQueries,
  ...relationshipQueries,
] as unknown as readonly QueryDef[];

export {
  productList,
  planList,
  paymentConnectionList,
  estimateList,
  estimateGet,
  invoiceList,
  invoiceGet,
  paymentList,
  subscriptionList,
  subscriptionGet,
  moneySummary,
  moneyForRecord,
  moneySettingsGet,
  attentionList,
  attentionSummary,
  attentionForRecord,
  attentionPreviewHandle,
  attentionSettingsGet,
  chatWidgetList,
  chatWidgetGet,
  workflowList,
  workflowGet,
  workflowVersionGet,
  workflowCatalogs,
  workflowRunList,
  workflowRunGet,
  workflowStats,
  workflowApprovalList,
  workflowProposalGet,
  workflowTemplateList,
  workflowTemplateGet,
  knowledgeProfileGet,
  knowledgeItemList,
  knowledgeItemGet,
  knowledgeSearch,
  knowledgeScanGet,
  knowledgeSuggestionList,
  knowledgePackList,
  aiTeammateGet,
  aiTeammateDraftList,
  aiTeammateActivity,
};

export * from './form';
export * from './maintenance';
export * from './template';
export * from './review';
export * from './migration';
export * from './support';
export * from './platform';
export * from './wallet';
export * from './port';
export * from './branded-domain';
export * from './founding';
export * from './offer';
export * from './relationship';
