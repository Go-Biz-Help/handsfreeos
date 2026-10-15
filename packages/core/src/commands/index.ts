import type { CommandDef } from '../kernel/types';
import { formCommands } from './form';
import { reviewCommands } from './review';
import { templateCommands } from './template';
import { formResponseCommands } from './form-response';
import { supportStaffCommands } from './support-staff';
import { teammateViewCommands } from './teammate-view';
import { supportTicketCommands } from './support';
import { ideaCommands } from './ideas';
import { activityDelete, activityLog, activityUpdate } from './activity';
import { assistantThreadArchive, assistantThreadRename } from './assistant';
import {
  appointmentAddAttendee,
  appointmentCancel,
  appointmentCreate,
  appointmentReassign,
  appointmentRemoveAttendee,
  appointmentReschedule,
  appointmentSetStatus,
  appointmentStillGoing,
  appointmentUpdate,
  appointmentSetMeetingLink,
  appointmentMakeMeetingLink,
  appointmentAttachTranscript,
  seriesCancel,
  seriesCreate,
  sessionPublish,
  waitlistAdd,
  waitlistRemove,
} from './appointment';
import {
  appointmentBookOnline,
  attendeeCancelOnline,
  attendeeRescheduleOnline,
} from './appointment-online';
import { bookingConfirmDeposit, bookingReleaseHold } from './booking-deposit';
import { waitlistJoinOnline } from './waitlist-online';
import { attendeeRecordReminder } from './reminder';
import {
  waitlistClaimOnline,
  waitlistExpire,
  waitlistOffer,
  waitlistPromote,
} from './waitlist-offer';
import {
  calendarCreate,
  calendarRestoreRevision,
  calendarSave,
  calendarSetSlug,
  calendarSetStatus,
} from './calendar';
import {
  bookingSiteSetPage,
  bookingSiteUpdate,
  resourceArchive,
  resourceCreate,
  resourceUpdate,
  serviceArchive,
  serviceCreate,
  serviceUpdate,
  territoryCreate,
  territoryDelete,
  territoryUpdate,
} from './calendar-catalog';
import { scheduleSet, timeOffAdd, timeOffRemove } from './calendar-hours';
import { calendarConnectionCommands } from './calendar-connection';
import { meetingConnectionCommands } from './meeting-connection';
import { liveMeetingCommands } from './live-meeting';
import { callSuggestionCommands } from './call-suggestion';
import { companyArchive } from './company.archive';
import {
  conversationAssign,
  conversationArchive,
  conversationClose,
  conversationCloseAll,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationReopen,
  conversationRestore,
  conversationSnooze,
} from './conversation';
import {
  messageAttachMedia,
  messageCancelScheduled,
  messageReceive,
  messageReleaseScheduled,
  messageRetry,
  messageSend,
  messageRecordOptOut,
  messageUpdateStatus,
  personSetSmsConsent,
} from './message';
import { videoLinkCreate, videoLinkReceiveUpload, videoLinkStartUpload } from './video-link';
import { fileFinishCopy, fileLinkCreate, leadSaveFileAnswer } from './file-answer';
import {
  phoneNumberActivate,
  phoneNumberBuy,
  phoneNumberFail,
  phoneNumberMarkReleased,
  phoneNumberRelease,
  phoneNumberSetCallerId,
  phoneNumberSetRecordingNotice,
  phoneNumberSetDefault,
  phoneNumberSetLabel,
  phoneNumberSetMembers,
  phoneNumberSetRouting,
  phoneUpdateSettings,
} from './phone';
import {
  registrationSaveDraft,
  registrationSubmit,
  registrationUpdateStatus,
} from './registration';
import { brandedDomainCommands } from './branded-domain';
import { customFieldCommands } from './custom-field';
import { customRecordCommands } from './custom-record';
import { customRecordTeamCommands } from './custom-record-team';
import { recordHoldCommands } from './record-hold';
import { binCommands } from './bin';
import { safetyCommands } from './safety';
import { supportAccessCommands } from './support-access';
import { addonAlertCommands } from './addon-alert';
export { addonAlertAcknowledge } from './addon-alert';
export {
  supportAccessDecline,
  supportAccessEnd,
  supportAccessGrant,
  supportAccessRequest,
} from './support-access';
export { customRecordAssign, customRecordUnassign } from './custom-record-team';
export { recordHoldLift, recordHoldPlace } from './record-hold';
export {
  appointmentDelete,
  binEmpty,
  binRestore,
  companyDelete,
  conversationDelete,
  customRecordDelete,
  leadDelete,
  personDelete,
} from './bin';
export {
  safetyCheckIn,
  safetyCheckOut,
  safetyContactRecord,
  safetyContactSave,
  safetyEscalate,
  safetyExtend,
  safetyHelp,
  safetyResolveByLink,
  safetyWhere,
} from './safety';
import { relationshipCommands } from './relationship';
import { inboxVisibilityCommands } from './inbox-visibility';
import { portCommands } from './port';
import { numberImportCommands } from './number-import';
import { twilioConnectionCommands } from './twilio-connection';
import { telephonyAccountCommands } from './telephony-account';
import { rcsCommands } from './rcs';
import { rcsRequestCommands } from './rcs-request';
import { textingFeeCommands } from './texting-fee';
import {
  emailAddressCreate,
  emailAddressReassign,
  emailAddressUpdate,
  emailClaimUnmatched,
  emailDismissUnmatched,
  emailDomainAdd,
  emailDomainReceive,
  emailDomainRecord,
  emailDomainRecordInbound,
  emailDomainRecordReceiving,
  emailDomainRemove,
  emailDomainStopReceiving,
  emailDomainVerify,
  emailSuppressionAdd,
  emailSuppressionRelease,
  mailboxActivate,
  mailboxConnect,
  mailboxDisconnect,
  mailboxFail,
  mailboxResync,
} from './email';
import { emailReceive, emailSuppressionRecord } from './email-inbound';
import {
  callAttachRecording,
  callAttachTranscript,
  callCancelConnect,
  callConnectMe,
  callRecord,
  callStart,
  callUpdateStatus,
} from './call';
import { userPhoneRecordCall, userPhoneStartVerification, userPhoneVerify } from './user-phone';
import { accountDelete, accountNoteDeleted, assistantConsent } from './account';
import { companyCreate } from './company.create';
import { companyRestore } from './company.restore';
import { companyUpdate } from './company.update';
import { fileBeginUpload, fileConfirm, fileDelete, fileLock, fileStore } from './file';
import { importCancel, importCreate, importStart } from './import';
import { invitationAccept } from './invitation.accept';
import { invitationResend } from './invitation.resend';
import { invitationRevoke } from './invitation.revoke';
import { leadArchive, leadRestore } from './lead.archive';
import { leadCreate } from './lead.create';
import { leadCatchUp } from './lead.catch_up';
import { leadMoveStage } from './lead.move_stage';
import { leadSetNextAction } from './lead.set_next_action';
import { leadUpdate } from './lead.update';
import { membershipChangeRole } from './membership.change_role';
import { permissionReset, permissionSetMember, permissionSetRole } from './permission';
import { membershipInvite } from './membership.invite';
import { membershipRemove } from './membership.remove';
import { organizationAddOwner } from './organization.add_owner';
import { organizationCreate } from './organization.create';
import { personArchive } from './person.archive';
import { personCreate } from './person.create';
import { personMerge } from './person.merge';
import { personRestore } from './person.restore';
import { personUpdate } from './person.update';
import { pipelineArchive } from './pipeline.archive';
import { pipelineCreate } from './pipeline.create';
import { pipelineUpdate } from './pipeline.update';
import { recordAssign, recordUnassign } from './record.assign';
import { recordAddTag, recordRemoveTag, recordSetTags } from './record.set_tags';
import { stageCreate } from './stage.create';
import { stageDelete } from './stage.delete';
import { stageReorder } from './stage.reorder';
import { stageUpdate } from './stage.update';
import { tagCreate } from './tag.create';
import { tagDelete } from './tag.delete';
import { tagUpdate } from './tag.update';
import { taskComplete, taskCreate, taskDelete, taskReopen, taskUpdate } from './task';
import { userUpdateProfile } from './user.update_profile';
import { workspaceCreate } from './workspace.create';
import { workspaceDelete } from './workspace.delete';
import { workspaceJoin } from './workspace.join';
import { workspaceUpdate } from './workspace.update';
import {
  workflowArchive,
  workflowCreate,
  workflowPause,
  workflowProposalApply,
  workflowProposalCreate,
  workflowProposalMarkApplied,
  workflowPublish,
  workflowRename,
  workflowRestoreVersion,
  workflowResume,
  workflowSaveDraft,
  workflowTest,
} from './workflow';
import {
  workflowDecideApproval,
  workflowEnrol,
  workflowRemoveContact,
  workflowRetryStep,
  workflowSkipStep,
  workflowStopRun,
} from './workflow-run';
import {
  knowledgePackCreate,
  knowledgePackPush,
  knowledgePackUpdate,
  workflowTemplateApplyUpdate,
  workflowTemplateCreate,
  workflowTemplateCreateFromWorkflow,
  workflowTemplateInstall,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTemplateRename,
  workflowTemplateSaveDraft,
} from './workflow-template';
import {
  knowledgeDocumentAdd,
  knowledgeDocumentBeginUpload,
  knowledgeDocumentSaveText,
  knowledgeItemArchive,
  knowledgeItemCreate,
  knowledgeItemImportFaqs,
  knowledgeItemPublish,
  knowledgeItemRecordUse,
  knowledgeItemUpdate,
  knowledgeProfileUpdate,
  knowledgeScanStart,
  knowledgeSourceSet,
  knowledgeSuggestionAccept,
  knowledgeSuggestionPropose,
  knowledgeSuggestionReject,
} from './knowledge';
import { offerArchive, offerCreate, offerUpdate } from './offer';
import {
  mainOfferDiscardDraft,
  mainOfferPublish,
  mainOfferSaveDraft,
  mainOfferScoreSave,
} from './main-offer';
import { chatCheckCodeForCustomer, chatSendCodeForCustomer } from './chat-verify';
import {
  portalAccessGive,
  portalAccessRevoke,
  portalCheckCode,
  portalSendCode,
  portalSessionEnd,
  portalSessionSeen,
} from './portal-access';
import { portalFileCommands } from './portal-files';
import { portalMessageCommands } from './portal-messages';
import { jobAddVisit, jobSetStatus } from './job';
import {
  aiTeammateCreate,
  aiTeammateDecideDraft,
  aiTeammateRestore,
  aiTeammateRetry,
  aiTeammateSaveConfig,
  aiTeammateSendDraft,
  aiTeammateSetStatus,
} from './ai-team';
import { aiSetupFinish, aiSetupNoteFound, aiSetupSave } from './ai-setup';
import { onboardingSetupFinish, onboardingSetupSave } from './onboarding-setup';
import {
  lookBeginUpload,
  lookFind,
  lookNoteUpload,
  lookNoteWebsite,
  lookSet,
  lookUseUpload,
} from './look';
import {
  aiSetupTemplateDelete,
  aiSetupTemplateRename,
  aiSetupTemplateSave,
} from './ai-setup-template';
import {
  appointmentBookForCustomer,
  attendeeCancelForCustomer,
  attendeeRescheduleForCustomer,
  seriesBookForCustomer,
  waitlistJoinForCustomer,
  appointmentAddForCustomer,
} from './appointment-ai';
import {
  estimateAnswerForCustomer,
  estimateCreateForCustomer,
  invoiceCreateForCustomer,
  subscriptionStartForCustomer,
} from './money-ai';
import {
  conversationHandOff,
  conversationHandToAi,
  conversationPickUp,
  conversationTakeOver,
} from './conversation-handling';
import { intakeSubmit } from './intake';
import {
  intakeSourceArchive,
  intakeSourceCreate,
  intakeSourceRotateKey,
  intakeSourceUpdate,
} from './intake-source';
import { leadRecordAnswers } from './lead.record_answers';
import {
  chatWidgetCreate,
  chatWidgetPause,
  chatWidgetRecordSeen,
  chatWidgetResume,
  chatWidgetRotateKey,
  chatWidgetUpdate,
} from './chat-widget';
import {
  chatBlockVisitor,
  chatIdentify,
  chatMarkRead,
  chatMarkSent,
  chatReceive,
  chatUnblockVisitor,
  chatVisitorRecordSeen,
  chatVisitorResume,
  chatVisitorRotateToken,
  chatVisitorStart,
} from './chat';
import {
  attentionAssign,
  attentionCancelAuto,
  attentionDismiss,
  attentionLetHandle,
  attentionRecordAuto,
  attentionRestore,
  attentionSaveSettings,
  attentionSnooze,
  attentionUnsnooze,
} from './attention';
import { automationsSaveSettings } from './automations';
import { referralCreateLead } from './referral';
import { teammateLessonApply } from './teammate-lesson';
import { maintenanceSetSchedule } from './maintenance';
import { attendeeConfirm, attendeeConfirmByCall, attendeeConfirmOnline } from './attendee-confirm';
import { aiCallCommands } from './ai-call';
import { socialCommands } from './social';
import { paymentConnectionCommands } from './payment-connection';
import { campaignCommands } from './campaign';
import { contactAiCommands } from './contact-ai';
import {
  moneySaveSettings,
  planArchive,
  planCreate,
  planUpdate,
  productArchive,
  productCreate,
  productUpdate,
} from './money-catalog';
import { estimateCommands } from './estimate';
import { invoiceCommands } from './invoice';
import { paymentCommands } from './payment';
import { subscriptionCommands } from './subscription';
import { foundingCommands } from './founding';
import { walletCommands } from './wallet';
import { phoneModelCommands } from './phone-model';
import { ownBusinessCommands } from './own-business';
import { mailFolderCommands } from './mail-folder';
import { aiProviderCommands } from './ai-provider';
import { pushDeviceRegister, pushDeviceRemove } from './push-device';
import { extensionSignInAnswer } from './extension-sign-in';
import {
  onboardingAsYouGo,
  onboardingFinish,
  onboardingRemind,
  onboardingSaveAnswers,
  onboardingSendLink,
  onboardingSetEnabled,
  onboardingSetView,
  onboardingSkip,
} from './onboarding';
import { migrationCommands } from './migration';

import { addonLifecycleCommands } from './addon';
import { ADDON_CATALOG } from '../addons/catalog';

/** Installing, turning on and off, uninstalling and deleting add-ons' data, over the real catalogue (0108). */
const addonCommands = addonLifecycleCommands(ADDON_CATALOG);
export const {
  install: addonInstall,
  enable: addonEnable,
  disable: addonDisable,
  uninstall: addonUninstall,
  purge: addonPurge,
  startFresh: addonStartFresh,
  saveSettings: addonSaveSettings,
  saveMySettings: addonSaveMySettings,
  dismissSuggestion: addonDismissSuggestion,
} = addonCommands;
export { addonLifecycleCommands, ADDON_MOVE_EVENTS } from './addon';

import { addonRoadmapCommands } from './addon-roadmap';

/** Voting on what's next: a business's vote, Home's note set aside, and the team's pick (0109). */
export const {
  vote: addonVote,
  unvote: addonUnvote,
  markNewsSeen: addonMarkNewsSeen,
  choosePick: addonPickChoose,
} = addonRoadmapCommands(ADDON_CATALOG);
export { addonRoadmapCommands } from './addon-roadmap';

import { addonGrantCommands } from './addon-grant';

/** Staff handing one business an add-on still being built, to try it (Real Estate, step 2). */
export const { give: addonGrantGive, takeBack: addonGrantTakeBack } =
  addonGrantCommands(ADDON_CATALOG);
export { addonGrantCommands } from './addon-grant';

import { addonConnectionCommands } from './addon-connection';

/** An add-on's accounts at other services: kept by the worker, let go by a person, HandsFreeOS's own by staff. */
export const {
  save: addonConnectionSave,
  disconnect: addonConnectionDisconnect,
  health: addonConnectionHealth,
  webhook: addonConnectionWebhook,
  beginSignIn: addonConnectionBeginSignIn,
  endSignIn: addonConnectionEndSignIn,
  tokens: addonConnectionTokens,
  platform: addonConnectionPlatform,
} = addonConnectionCommands(ADDON_CATALOG);
export {
  addonConnectionCommands,
  connectorOf,
  CONNECTION_FAILURES_BEFORE_ERROR,
} from './addon-connection';

import { addonSealedCommands } from './addon-sealed';

/** Values an add-on keeps sealed (round seven): each time one is shown again, kept in the history. */
export const { viewed: addonSealedViewed } = addonSealedCommands(ADDON_CATALOG);
export { addonSealedCommands } from './addon-sealed';

export {
  conversationAssign,
  conversationArchive,
  conversationClose,
  conversationCloseAll,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationReopen,
  conversationRestore,
  conversationSnooze,
  messageAttachMedia,
  messageCancelScheduled,
  messageReceive,
  messageReleaseScheduled,
  messageRetry,
  messageSend,
  messageRecordOptOut,
  messageUpdateStatus,
  personSetSmsConsent,
  phoneNumberActivate,
  phoneNumberBuy,
  phoneNumberFail,
  phoneNumberMarkReleased,
  phoneNumberRelease,
  phoneNumberSetCallerId,
  phoneNumberSetRecordingNotice,
  phoneNumberSetDefault,
  phoneNumberSetLabel,
  phoneNumberSetMembers,
  phoneNumberSetRouting,
  phoneUpdateSettings,
  registrationSubmit,
  registrationSaveDraft,
  registrationUpdateStatus,
  callAttachRecording,
  callAttachTranscript,
  callCancelConnect,
  callConnectMe,
  callRecord,
  callStart,
  callUpdateStatus,
  userPhoneRecordCall,
  userPhoneStartVerification,
  userPhoneVerify,
  accountDelete,
  accountNoteDeleted,
  assistantConsent,
  emailAddressCreate,
  emailAddressReassign,
  emailAddressUpdate,
  emailClaimUnmatched,
  emailDismissUnmatched,
  emailDomainAdd,
  emailDomainReceive,
  emailDomainRecord,
  emailDomainRecordInbound,
  emailDomainRecordReceiving,
  emailDomainRemove,
  emailDomainStopReceiving,
  emailDomainVerify,
  emailSuppressionAdd,
  emailSuppressionRelease,
  mailboxActivate,
  mailboxConnect,
  mailboxDisconnect,
  mailboxFail,
  mailboxResync,
  activityDelete,
  activityLog,
  activityUpdate,
  companyArchive,
  companyCreate,
  companyRestore,
  companyUpdate,
  fileBeginUpload,
  fileConfirm,
  fileDelete,
  fileLock,
  fileStore,
  importCancel,
  importCreate,
  importStart,
  invitationAccept,
  invitationResend,
  invitationRevoke,
  leadArchive,
  leadCatchUp,
  leadCreate,
  leadMoveStage,
  leadRestore,
  leadSetNextAction,
  leadUpdate,
  membershipChangeRole,
  membershipInvite,
  membershipRemove,
  organizationAddOwner,
  organizationCreate,
  permissionReset,
  permissionSetMember,
  permissionSetRole,
  personArchive,
  personCreate,
  personMerge,
  personRestore,
  personUpdate,
  pipelineArchive,
  pipelineCreate,
  pipelineUpdate,
  recordAddTag,
  recordAssign,
  recordRemoveTag,
  recordSetTags,
  recordUnassign,
  stageCreate,
  stageDelete,
  stageReorder,
  stageUpdate,
  tagCreate,
  tagDelete,
  tagUpdate,
  taskComplete,
  taskCreate,
  taskDelete,
  taskReopen,
  taskUpdate,
  userUpdateProfile,
  workspaceCreate,
  workspaceJoin,
  workspaceUpdate,
  workspaceDelete,
  assistantThreadArchive,
  assistantThreadRename,
  calendarCreate,
  calendarSave,
  calendarRestoreRevision,
  calendarSetStatus,
  calendarSetSlug,
  serviceCreate,
  serviceUpdate,
  serviceArchive,
  resourceCreate,
  resourceUpdate,
  resourceArchive,
  territoryCreate,
  territoryUpdate,
  territoryDelete,
  bookingSiteUpdate,
  bookingSiteSetPage,
  scheduleSet,
  timeOffAdd,
  timeOffRemove,
  appointmentCreate,
  appointmentUpdate,
  appointmentSetMeetingLink,
  appointmentMakeMeetingLink,
  appointmentAttachTranscript,
  appointmentReschedule,
  appointmentReassign,
  appointmentCancel,
  appointmentSetStatus,
  appointmentStillGoing,
  appointmentAddAttendee,
  appointmentRemoveAttendee,
  sessionPublish,
  seriesCreate,
  seriesCancel,
  waitlistAdd,
  waitlistRemove,
  appointmentBookOnline,
  attendeeRescheduleOnline,
  attendeeCancelOnline,
  bookingConfirmDeposit,
  bookingReleaseHold,
  waitlistJoinOnline,
};
export { hashInvitationToken } from './invitation.accept';
export { teammateViewEnd, teammateViewStart } from './teammate-view';
export { INVITATION_TTL_MS } from './membership.invite';
export { DEFAULT_STAGES } from './pipeline.create';

/** Explicit list on purpose: greppable, bundler-safe, and the order the docs list them in. */
export { emailReceive, emailSuppressionRecord };
export { videoLinkCreate, videoLinkStartUpload, videoLinkReceiveUpload };
export { videoLinkTokenHash, videoUploadPath, fileUploadPath } from './video-link';
export { fileLinkCreate, leadSaveFileAnswer, fileFinishCopy };
export { storedFilePath } from './file';

export const commands: readonly CommandDef[] = [
  organizationCreate,
  workspaceCreate,
  workspaceJoin,
  workspaceUpdate,
  workspaceDelete,
  membershipInvite,
  invitationResend,
  invitationRevoke,
  invitationAccept,
  membershipChangeRole,
  membershipRemove,
  permissionSetRole,
  permissionSetMember,
  permissionReset,
  organizationAddOwner,
  userUpdateProfile,
  accountDelete,
  assistantConsent,
  accountNoteDeleted,
  pipelineCreate,
  pipelineUpdate,
  pipelineArchive,
  stageCreate,
  stageUpdate,
  stageReorder,
  stageDelete,
  companyCreate,
  companyUpdate,
  companyArchive,
  companyRestore,
  personCreate,
  personUpdate,
  personArchive,
  personRestore,
  personMerge,
  tagCreate,
  tagUpdate,
  tagDelete,
  recordSetTags,
  recordAddTag,
  recordRemoveTag,
  recordAssign,
  recordUnassign,
  leadCreate,
  leadUpdate,
  leadMoveStage,
  leadSetNextAction,
  leadArchive,
  leadRestore,
  taskCreate,
  taskUpdate,
  taskComplete,
  taskReopen,
  taskDelete,
  activityLog,
  activityUpdate,
  activityDelete,
  fileBeginUpload,
  fileConfirm,
  fileDelete,
  fileLock,
  fileStore,
  importCreate,
  importStart,
  importCancel,
  phoneNumberBuy,
  phoneNumberRelease,
  phoneNumberSetRouting,
  phoneNumberSetCallerId,
  phoneNumberSetRecordingNotice,
  phoneNumberSetDefault,
  phoneNumberSetLabel,
  phoneNumberSetMembers,
  phoneUpdateSettings,
  phoneNumberActivate,
  phoneNumberFail,
  phoneNumberMarkReleased,
  registrationSubmit,
  registrationSaveDraft,
  registrationUpdateStatus,
  conversationOpen,
  conversationMarkRead,
  conversationMarkUnread,
  conversationAssign,
  conversationSnooze,
  conversationArchive,
  conversationClose,
  conversationCloseAll,
  conversationReopen,
  conversationRestore,
  conversationLinkPerson,
  messageSend,
  messageRetry,
  messageCancelScheduled,
  messageReleaseScheduled,
  messageReceive,
  messageUpdateStatus,
  messageAttachMedia,
  videoLinkCreate,
  videoLinkStartUpload,
  videoLinkReceiveUpload,
  fileLinkCreate,
  leadSaveFileAnswer,
  fileFinishCopy,
  personSetSmsConsent,
  messageRecordOptOut,
  callStart,
  callRecord,
  callUpdateStatus,
  callAttachRecording,
  callAttachTranscript,
  callConnectMe,
  callCancelConnect,
  userPhoneStartVerification,
  userPhoneRecordCall,
  userPhoneVerify,
  emailDomainAdd,
  emailDomainVerify,
  emailDomainRemove,
  emailDomainRecord,
  emailDomainReceive,
  emailDomainStopReceiving,
  emailDomainRecordReceiving,
  emailDomainRecordInbound,
  emailAddressCreate,
  emailAddressReassign,
  emailAddressUpdate,
  mailboxConnect,
  mailboxDisconnect,
  mailboxResync,
  mailboxActivate,
  mailboxFail,
  emailClaimUnmatched,
  emailDismissUnmatched,
  emailSuppressionAdd,
  emailSuppressionRelease,
  // Moving email threads between the Inbox, Other mail and Spam (M19).
  ...mailFolderCommands,
  emailReceive,
  emailSuppressionRecord,
  assistantThreadRename,
  assistantThreadArchive,
  calendarCreate,
  calendarSave,
  calendarRestoreRevision,
  calendarSetStatus,
  calendarSetSlug,
  serviceCreate,
  serviceUpdate,
  serviceArchive,
  resourceCreate,
  resourceUpdate,
  resourceArchive,
  territoryCreate,
  territoryUpdate,
  territoryDelete,
  bookingSiteUpdate,
  bookingSiteSetPage,
  scheduleSet,
  timeOffAdd,
  timeOffRemove,
  appointmentCreate,
  appointmentUpdate,
  appointmentSetMeetingLink,
  appointmentMakeMeetingLink,
  appointmentAttachTranscript,
  appointmentReschedule,
  appointmentReassign,
  appointmentCancel,
  appointmentSetStatus,
  appointmentStillGoing,
  appointmentAddAttendee,
  appointmentRemoveAttendee,
  sessionPublish,
  seriesCreate,
  seriesCancel,
  waitlistAdd,
  waitlistRemove,
  appointmentBookOnline,
  attendeeRescheduleOnline,
  attendeeCancelOnline,
  bookingConfirmDeposit,
  bookingReleaseHold,
  waitlistJoinOnline,
  ...calendarConnectionCommands,
  ...meetingConnectionCommands,
  ...liveMeetingCommands,
  ...callSuggestionCommands,
  attendeeRecordReminder,
  waitlistPromote,
  waitlistOffer,
  waitlistExpire,
  waitlistClaimOnline,
  workflowCreate,
  workflowSaveDraft,
  workflowRename,
  workflowPublish,
  workflowPause,
  workflowResume,
  workflowArchive,
  workflowRestoreVersion,
  workflowTest,
  workflowEnrol,
  workflowRemoveContact,
  workflowStopRun,
  workflowDecideApproval,
  workflowRetryStep,
  workflowSkipStep,
  workflowProposalApply,
  workflowProposalCreate,
  workflowProposalMarkApplied,
  workflowTemplateCreateFromWorkflow,
  workflowTemplatePublish,
  workflowTemplatePush,
  workflowTemplateSaveDraft,
  workflowTemplateInstall,
  workflowTemplateApplyUpdate,
  workflowTemplateCreate,
  workflowTemplateRename,
  knowledgePackCreate,
  knowledgePackUpdate,
  knowledgePackPush,
  knowledgeProfileUpdate,
  knowledgeItemCreate,
  knowledgeItemUpdate,
  knowledgeItemPublish,
  knowledgeItemArchive,
  offerCreate,
  offerUpdate,
  offerArchive,
  mainOfferSaveDraft,
  mainOfferDiscardDraft,
  mainOfferScoreSave,
  mainOfferPublish,
  knowledgeItemImportFaqs,
  knowledgeDocumentBeginUpload,
  knowledgeDocumentAdd,
  knowledgeDocumentSaveText,
  knowledgeSourceSet,
  knowledgeScanStart,
  knowledgeSuggestionAccept,
  knowledgeSuggestionReject,
  knowledgeSuggestionPropose,
  knowledgeItemRecordUse,
  leadRecordAnswers,
  conversationHandOff,
  conversationTakeOver,
  conversationHandToAi,
  conversationPickUp,
  aiTeammateCreate,
  aiTeammateSaveConfig,
  aiTeammateRestore,
  aiTeammateSetStatus,
  aiTeammateDecideDraft,
  aiTeammateSendDraft,
  aiTeammateRetry,
  aiSetupSave,
  aiSetupFinish,
  aiSetupNoteFound,
  aiSetupTemplateSave,
  aiSetupTemplateRename,
  aiSetupTemplateDelete,
  appointmentBookForCustomer,
  attendeeRescheduleForCustomer,
  attendeeCancelForCustomer,
  seriesBookForCustomer,
  waitlistJoinForCustomer,
  appointmentAddForCustomer,
  jobSetStatus,
  jobAddVisit,
  invoiceCreateForCustomer,
  estimateCreateForCustomer,
  estimateAnswerForCustomer,
  subscriptionStartForCustomer,
  chatSendCodeForCustomer,
  chatCheckCodeForCustomer,
  portalAccessGive,
  portalAccessRevoke,
  portalSendCode,
  portalCheckCode,
  portalSessionSeen,
  portalSessionEnd,
  // Files in a customer's portal (round two, step 4).
  ...portalFileCommands,
  // Messages in a customer's portal (round two, step 5).
  ...portalMessageCommands,
  intakeSourceCreate,
  intakeSourceUpdate,
  intakeSourceRotateKey,
  intakeSourceArchive,
  intakeSubmit,
  chatWidgetCreate,
  chatWidgetUpdate,
  chatWidgetPause,
  chatWidgetResume,
  chatWidgetRotateKey,
  chatWidgetRecordSeen,
  chatVisitorStart,
  chatVisitorResume,
  chatVisitorRotateToken,
  chatVisitorRecordSeen,
  chatReceive,
  chatIdentify,
  chatMarkSent,
  chatMarkRead,
  chatBlockVisitor,
  chatUnblockVisitor,
  attentionSnooze,
  attentionUnsnooze,
  attentionDismiss,
  attentionRestore,
  attentionAssign,
  attentionLetHandle,
  attentionCancelAuto,
  attentionSaveSettings,
  attentionRecordAuto,
  automationsSaveSettings,
  referralCreateLead,
  teammateLessonApply,
  ...campaignCommands,
  ...aiCallCommands,
  // The AI's pass over the whole customer list, putting tags on and off (0107).
  ...contactAiCommands,
  maintenanceSetSchedule,
  leadCatchUp,
  attendeeConfirm,
  attendeeConfirmOnline,
  attendeeConfirmByCall,
  productCreate,
  productUpdate,
  productArchive,
  planCreate,
  planUpdate,
  planArchive,
  ...paymentConnectionCommands,
  ...estimateCommands,
  ...invoiceCommands,
  ...paymentCommands,
  ...subscriptionCommands,
  ...walletCommands,
  ...foundingCommands,
  ...phoneModelCommands,
  // HandsFreeOS's own business, the one that may use handsfreeos.com for its email (M19).
  ...ownBusinessCommands,
  // Which AI answers: Claude, or OpenAI while Claude is in trouble.
  ...aiProviderCommands,
  moneySaveSettings,
  pushDeviceRegister,
  pushDeviceRemove,
  // Approving an extension sign-in from the phone or the web (20261027002910).
  extensionSignInAnswer,
  ...migrationCommands,
  ...supportTicketCommands,
  ...supportStaffCommands,
  // Viewing the app as a teammate, read-only (20261018000100).
  ...teammateViewCommands,
  ...formCommands,
  ...templateCommands,
  ...reviewCommands,
  ...formResponseCommands,
  ...portCommands,
  // Numbers already in Twilio: a business's own account, or GoHighLevel's LC Phone (20261010000900).
  ...numberImportCommands,
  ...twilioConnectionCommands,
  // Phone & texting on or off: the business's own Twilio subaccount, made or closed on request.
  ...telephonyAccountCommands,
  ...inboxVisibilityCommands,
  ...brandedDomainCommands,
  // Relationships (0101): fields for every kind of record, the kinds a business makes up, and how records relate.
  ...customFieldCommands,
  ...customRecordCommands,
  // Who is on a record kept to its people (Real Estate step 4).
  ...customRecordTeamCommands,
  // Legal holds on records (Real Estate round six).
  ...recordHoldCommands,
  // Deleting customers, conversations and bookings for good, through the 30-day Deleted bin (20261027000400).
  ...binCommands,
  // Check-ins: a person's safety when they're alone at a customer's place (round six).
  ...safetyCommands,
  // HandsFreeOS support let into private records (Real Estate step 4).
  ...supportAccessCommands,
  // Saying you've seen an add-on's alert, from its Home card (Real Estate step 5).
  ...addonAlertCommands,
  ...relationshipCommands,
  // Ideas, the roadmap and What's new (0102).
  ...ideaCommands,
  // A business's RCS sender: connected, paused, looked at again and let go (0103).
  ...rcsCommands,
  ...rcsRequestCommands,
  ...textingFeeCommands,
  // Facebook Messenger and Instagram: the Pages and accounts, their messages, and the ads that start them (20261025000100).
  ...socialCommands,
  // Add-ons: installing, turning on and off, uninstalling, deleting their data, starting fresh, their settings (0108).
  addonInstall,
  addonEnable,
  addonDisable,
  addonUninstall,
  addonPurge,
  addonStartFresh,
  addonSaveSettings,
  addonSaveMySettings,
  addonDismissSuggestion,
  // Voting on what's next (0109).
  addonVote,
  addonUnvote,
  addonMarkNewsSeen,
  addonPickChoose,
  // Staff handing a business an add-on to try (Real Estate, step 2).
  addonGrantGive,
  addonGrantTakeBack,
  // An add-on's accounts at other services (round five).
  addonConnectionSave,
  addonConnectionDisconnect,
  addonConnectionHealth,
  addonConnectionWebhook,
  addonConnectionBeginSignIn,
  addonConnectionEndSignIn,
  addonConnectionTokens,
  addonConnectionPlatform,
  // A sealed value shown again (round seven).
  addonSealedViewed,
  // Getting started.
  onboardingSaveAnswers,
  onboardingSkip,
  onboardingAsYouGo,
  onboardingSetView,
  onboardingFinish,
  onboardingSendLink,
  onboardingSetEnabled,
  onboardingRemind,
  // The onboarding setup: the guided questions a new business goes through.
  onboardingSetupSave,
  onboardingSetupFinish,
  // The business's logo and colour, on its booking page, website chat, invoices and emails.
  lookBeginUpload,
  lookUseUpload,
  lookSet,
  lookFind,
  lookNoteWebsite,
  lookNoteUpload,
] as unknown as readonly CommandDef[];
export { callPreview } from './call';
export { VERIFY_CALLS_PER_DAY, VERIFY_CALLS_PER_HOUR } from './user-phone';
export { attendeeFromPerson } from './appointment';
export { validateIntake } from './appointment-online';
export { DEPOSIT_HOLD_JOB, depositHoldKey, holdState } from './appointment-online';
export * from './calendar-connection';
export * from './meeting-connection';
export * from './live-meeting';
export * from './call-suggestion';
export * from './number-import';
export * from './twilio-connection';
export * from './social';
export * from './telephony-account';
export * from './reminder';
export * from './waitlist-offer';
export * from './form';
export * from './template';
export * from './review';
export * from './form-response';
export * from './workflow';
export * from './workflow-run';
export * from './workflow-template';
export * from './knowledge';
export * from './ai-team';
export * from './ai-setup';
export * from './ai-setup-template';
export * from './appointment-ai';
export * from './money-ai';
export * from './offer';
export * from './main-offer';
export * from './chat-verify';
export * from './portal-access';
export * from './portal-files';
export * from './portal-messages';
export * from './conversation-handling';
export { leadRecordAnswers } from './lead.record_answers';
export * from './chat-widget';
export * from './intake-source';
export * from './onboarding';
export * from './onboarding-setup';
export * from './look';
export * from './intake';
export * from './chat';
export * from './attention';
export * from './automations';
export * from './referral';
export * from './teammate-lesson';
export * from './campaign';
export * from './ai-call';
export * from './contact-ai';
export * from './maintenance';
export * from './attendee-confirm';
export * from './payment-connection';
export * from './money-catalog';
export * from './estimate';
export * from './invoice';
export * from './payment';
export * from './subscription';
export * from './wallet';
export * from './money-shared';
export * from './push-device';
export * from './extension-sign-in';
export * from './migration';
export * from './support';
export * from './support-staff';
export * from './port';
export * from './rcs';
export * from './rcs-request';
export * from './texting-fee';
export * from './inbox-visibility';
export * from './branded-domain';
export * from './founding';
export * from './phone-model';
export * from './own-business';
export * from './mail-folder';
export * from './ai-provider';
export * from './job';
export * from './custom-field';
export * from './custom-record';
export * from './relationship';
export * from './ideas';
