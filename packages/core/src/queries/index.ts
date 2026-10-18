import type { QueryDef } from '../kernel/types';
import { portalAccessGet } from '../commands/portal-access';
import { portalQueries } from './portal';
import { portalFileQueries } from '../commands/portal-files';
import { portalMessageQueries } from '../commands/portal-messages';
import { formQueries } from './form';
import { campaignQueries } from './campaign';
import { contactAiQueries } from './contact-ai';
import { maintenanceForPerson } from './maintenance';
import { reviewQueries } from './review';
import { relationshipQueries } from './relationship';
import { supportAccessList } from './support-access';
import { recordHoldQueries } from './record-hold';
import { binQueries } from './bin';
export { binList, binPreview } from './bin';
import { safetyQueries } from './safety';
import { templateQueries } from './template';
import { platformQueries } from './platform';
import { problemReportQueries } from './problem-reports';
import { teammateViewQueries } from './teammate-view';
import { foundingQueries } from './founding';
import { supportQueries } from './support';
import { ideaQueries } from './ideas';
import { onboardingClients, onboardingStatus, platformOnboardingCounts } from './onboarding';
import { accountDeletionCheck, pushDeviceList, userPhoneGet } from './account';
import { aiTeammateActivity, aiTeammateDraftList, aiTeammateGet } from './ai-team';
import {
  aiTeammateFeedbackList,
  aiTeammateReview,
  teammateInstructionList,
} from './teammate-feedback';
import { aiSetupGet, aiSetupTemplateList } from './ai-setup';
import { onboardingSetupGet } from './onboarding-setup';
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
import { appointmentTranscriptList, meetingConnectionList } from '../commands/meeting-connection';
import { liveMeetingAccountMine } from '../commands/live-meeting';
import { callSuggestionList } from '../commands/call-suggestion';
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
  fileFingerprints,
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
import { registrationGetDraft } from './registration';
import { numberImportList, twilioConnectionList } from './number-import';
import { attributionList, metaAccountList } from './social';
import { leadBoard, leadGet, leadList } from './lead';
import { me } from './me';
import { extensionSignInPending } from './extension-sign-in';
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
import { mainOfferGet, mainOfferTryList, mainOfferVersionList } from './main-offer';
import {
  partnerGet,
  partnerList,
  partnerOfPerson,
  partnersSettings,
  portalPartner,
} from './partners';
import { partnerPayoutGet, partnerPayouts, platformPartnerPayoutsGet } from './partner-payouts';
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
  registrationGetDraft,
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
  fileFingerprints,
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
  meetingConnectionList,
  liveMeetingAccountMine,
  appointmentTranscriptList,
  callSuggestionList,
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

import { addonConnectionQueries } from './addon-connection';

/** What an add-on connects to, and the business's accounts there (round five). */
export const { list: addonConnectionList } = addonConnectionQueries(ADDON_CATALOG);
export { addonConnectionQueries } from './addon-connection';

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
  portalAccessGet,
  // A customer's own, in their portal (Real Estate round two).
  ...portalQueries,
  ...portalFileQueries,
  ...portalMessageQueries,
  ...supportQueries,
  ...platformQueries,
  // What our own tools saw when something didn't go (20261027008100).
  ...problemReportQueries,
  // Viewing the app as a teammate (20261018000100).
  ...teammateViewQueries,
  ...foundingQueries,
  me,
  accountDeletionCheck,
  pushDeviceList,
  // Approving an extension sign-in from the phone or the web (20261027002910).
  extensionSignInPending,
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
  fileFingerprints,
  importGet,
  importList,
  crmFindMatches,
  crmSummary,
  crmMetrics,
  intakeList,
  phoneSetupStatus,
  numberPortList,
  registrationGetDraft,
  numberImportList,
  twilioConnectionList,
  brandedDomainGet,
  callLog,
  inboxList,
  inboxSummary,
  conversationGet,
  conversationThread,
  messageGet,
  // Facebook Messenger and Instagram: the Pages and accounts, and where customers came from (20261025000200).
  metaAccountList,
  attributionList,
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
  meetingConnectionList,
  liveMeetingAccountMine,
  appointmentTranscriptList,
  callSuggestionList,
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
  mainOfferGet,
  mainOfferVersionList,
  mainOfferTryList,
  partnersSettings,
  partnerList,
  partnerGet,
  partnerOfPerson,
  portalPartner,
  partnerPayouts,
  partnerPayoutGet,
  platformPartnerPayoutsGet,
  knowledgeItemGet,
  knowledgeSearch,
  knowledgeScanGet,
  knowledgeSuggestionList,
  knowledgePackList,
  aiTeammateGet,
  aiTeammateDraftList,
  aiTeammateActivity,
  aiTeammateFeedbackList,
  aiTeammateReview,
  teammateInstructionList,
  aiSetupGet,
  aiSetupTemplateList,
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
  // HandsFreeOS support let into private records (Real Estate step 4).
  supportAccessList,
  ...recordHoldQueries,
  // The Deleted bin (20261027000400).
  ...binQueries,
  ...safetyQueries,
  // Ideas, the roadmap and What's new (0102).
  ...ideaQueries,
  // Add-ons (0108).
  addonList,
  addonImpact,
  addonSettings,
  addonConnectionList,
  addonSuggestion,
  // Voting on what's next (0109).
  addonRoadmap,
  addonNews,
  addonPickOverview,
  // Getting started.
  onboardingStatus,
  onboardingClients,
  platformOnboardingCounts,
  // The onboarding setup.
  onboardingSetupGet,
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
  aiTeammateFeedbackList,
  aiTeammateReview,
  teammateInstructionList,
  aiSetupGet,
  aiSetupTemplateList,
  onboardingSetupGet,
};

export * from './form';
export * from './portal';
export * from './campaign';
export * from './contact-ai';
export * from './maintenance';
export * from './extension-sign-in';
export * from './template';
export * from './review';
export * from './migration';
export * from './number-import';
export * from './social';
export * from './support';
export * from './platform';
export * from './problem-reports';
export * from './teammate-view';
export * from './wallet';
export * from './port';
export * from './branded-domain';
export * from './founding';
export * from './offer';
export * from './main-offer';
export * from './partners';
export * from './partner-payouts';
export * from './relationship';
export * from './support-access';
export * from './record-hold';
export * from './safety';
export * from './onboarding';
export * from './ideas';
