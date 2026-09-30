import type { QueryDef } from '../kernel/types';
import { formQueries } from './form';
import { campaignQueries } from './campaign';
import { contactAiQueries } from './contact-ai';
import { maintenanceForPerson } from './maintenance';
import { reviewQueries } from './review';
import { relationshipQueries } from './relationship';
import { templateQueries } from './template';
import { platformQueries } from './platform';
import { foundingQueries } from './founding';
import { supportQueries } from './support';
import { ideaQueries } from './ideas';
import { onboardingClients, onboardingStatus, platformOnboardingCounts } from './onboarding';
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
  waitlistList,
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
import {
  emailSenderRuleList,
  emailSetupStatus,
  emailSuppressionList,
  emailUnmatchedList,
} from './email';
import { emailComposeOptions } from './email-compose';
import { invitationPreview } from './invitation.preview';
import { intakeList } from './intake';
import { phoneSetupStatus } from './phone';
import { brandedDomainGet } from './branded-domain';
import { numberPortList } from './port';
import { numberImportList, twilioConnectionList } from './number-import';
import { leadBoard, leadGet, leadList } from './lead';
import { me } from './me';
import { personGet, personList } from './person';
import { pipelineList } from './pipeline.list';
import { taskList } from './task.list';
import { timelineList } from './timeline.list';
import { workspaceGet } from './workspace.get';
import { workspaceInvitations } from './workspace.invitations';
import { workspaceMembers } from './workspace.members';
import { permissionSettings } from './permission';
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
  emailSenderRuleList,
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
  permissionSettings,
  calendarList,
  calendarGet,
  calendarAvailability,
  appointmentList,
  appointmentGet,
  waitlistList,
  scheduleTeam,
  serviceList,
  resourceList,
  territoryList,
  bookingSiteGet,
  calendarConnectionList,
};

export { emailComposeOptions };

import { addonQueries } from './addon';
import { ADDON_CATALOG } from '../addons/catalog';

/** What a business has and could have, what a change would touch, and settings, over the real catalogue (0108). */
const addonQueryDefs = addonQueries(ADDON_CATALOG);
export const {
  list: addonList,
  impact: addonImpact,
  settings: addonSettings,
  suggestion: addonSuggestion,
} = addonQueryDefs;
export { addonQueries } from './addon';

import { addonRoadmapQueries } from './addon-roadmap';

/** Voting on what's next: the planned list, Home's note, and the team's view (0109). */
export const {
  roadmap: addonRoadmap,
  news: addonNews,
  overview: addonPickOverview,
} = addonRoadmapQueries(ADDON_CATALOG);
export { addonRoadmapQueries, ADDON_NEWS_DAYS } from './addon-roadmap';

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
  permissionSettings,
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
  numberImportList,
  twilioConnectionList,
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
  emailSenderRuleList,
  emailComposeOptions,
  assistantThreadList,
  assistantThreadGet,
  calendarList,
  calendarGet,
  calendarAvailability,
  appointmentList,
  appointmentGet,
  waitlistList,
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
  ...campaignQueries,
  ...contactAiQueries,
  ...templateQueries,
  ...reviewQueries,
  ...relationshipQueries,
  // Ideas, the roadmap and What's new (0102).
  ...ideaQueries,
  // Add-ons (0108).
  addonList,
  addonImpact,
  addonSettings,
  addonSuggestion,
  // Voting on what's next (0109).
  addonRoadmap,
  addonNews,
  addonPickOverview,
  // Getting started.
  onboardingStatus,
  onboardingClients,
  platformOnboardingCounts,
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
export * from './campaign';
export * from './contact-ai';
export * from './maintenance';
export * from './template';
export * from './review';
export * from './migration';
export * from './number-import';
export * from './support';
export * from './platform';
export * from './wallet';
export * from './port';
export * from './branded-domain';
export * from './founding';
export * from './offer';
export * from './relationship';
export * from './onboarding';
export * from './ideas';
