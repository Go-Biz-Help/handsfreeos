import type { CommandDef } from '../kernel/types';
import { formCommands } from './form';
import { formResponseCommands } from './form-response';
import { supportStaffCommands } from './support-staff';
import { supportTicketCommands } from './support';
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
  appointmentUpdate,
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
import { companyArchive } from './company.archive';
import {
  conversationAssign,
  conversationClose,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationReopen,
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
import {
  phoneNumberActivate,
  phoneNumberBuy,
  phoneNumberFail,
  phoneNumberMarkReleased,
  phoneNumberRelease,
  phoneNumberSetCallerId,
  phoneNumberSetRouting,
  phoneUpdateSettings,
} from './phone';
import { registrationSubmit, registrationUpdateStatus } from './registration';
import {
  emailAddressCreate,
  emailAddressUpdate,
  emailClaimUnmatched,
  emailDismissUnmatched,
  emailDomainAdd,
  emailDomainRecord,
  emailDomainRemove,
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
import { fileBeginUpload, fileConfirm, fileDelete } from './file';
import { importCancel, importCreate, importStart } from './import';
import { invitationAccept } from './invitation.accept';
import { invitationResend } from './invitation.resend';
import { invitationRevoke } from './invitation.revoke';
import { leadArchive, leadRestore } from './lead.archive';
import { leadCreate } from './lead.create';
import { leadMoveStage } from './lead.move_stage';
import { leadSetNextAction } from './lead.set_next_action';
import { leadUpdate } from './lead.update';
import { membershipChangeRole } from './membership.change_role';
import { membershipInvite } from './membership.invite';
import { membershipRemove } from './membership.remove';
import { organizationAddOwner } from './organization.add_owner';
import { organizationCreate } from './organization.create';
import { personArchive } from './person.archive';
import { personCreate } from './person.create';
import { personRestore } from './person.restore';
import { personUpdate } from './person.update';
import { pipelineArchive } from './pipeline.archive';
import { pipelineCreate } from './pipeline.create';
import { pipelineUpdate } from './pipeline.update';
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
import {
  aiTeammateCreate,
  aiTeammateDecideDraft,
  aiTeammateRestore,
  aiTeammateRetry,
  aiTeammateSaveConfig,
  aiTeammateSendDraft,
  aiTeammateSetStatus,
} from './ai-team';
import {
  appointmentBookForCustomer,
  attendeeCancelForCustomer,
  attendeeRescheduleForCustomer,
} from './appointment-ai';
import {
  conversationHandOff,
  conversationHandToAi,
  conversationPickUp,
  conversationTakeOver,
} from './conversation-handling';
import { intakeSourceUpdate } from './intake-source';
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
import { attendeeConfirm, attendeeConfirmOnline } from './attendee-confirm';
import { paymentConnectionCommands } from './payment-connection';
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
import { pushDeviceRegister, pushDeviceRemove } from './push-device';
import { migrationCommands } from './migration';

export {
  conversationAssign,
  conversationClose,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationReopen,
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
  phoneNumberSetRouting,
  phoneUpdateSettings,
  registrationSubmit,
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
  emailAddressUpdate,
  emailClaimUnmatched,
  emailDismissUnmatched,
  emailDomainAdd,
  emailDomainRecord,
  emailDomainRemove,
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
  importCancel,
  importCreate,
  importStart,
  invitationAccept,
  invitationResend,
  invitationRevoke,
  leadArchive,
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
  personArchive,
  personCreate,
  personRestore,
  personUpdate,
  pipelineArchive,
  pipelineCreate,
  pipelineUpdate,
  recordAddTag,
  recordRemoveTag,
  recordSetTags,
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
  workspaceUpdate,
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
  scheduleSet,
  timeOffAdd,
  timeOffRemove,
  appointmentCreate,
  appointmentUpdate,
  appointmentReschedule,
  appointmentReassign,
  appointmentCancel,
  appointmentSetStatus,
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
export { INVITATION_TTL_MS } from './membership.invite';
export { DEFAULT_STAGES } from './pipeline.create';

/** Explicit list on purpose: greppable, bundler-safe, and the order the docs list them in. */
export { emailReceive, emailSuppressionRecord };

export const commands: readonly CommandDef[] = [
  organizationCreate,
  workspaceCreate,
  workspaceUpdate,
  membershipInvite,
  invitationResend,
  invitationRevoke,
  invitationAccept,
  membershipChangeRole,
  membershipRemove,
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
  tagCreate,
  tagUpdate,
  tagDelete,
  recordSetTags,
  recordAddTag,
  recordRemoveTag,
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
  importCreate,
  importStart,
  importCancel,
  phoneNumberBuy,
  phoneNumberRelease,
  phoneNumberSetRouting,
  phoneNumberSetCallerId,
  phoneUpdateSettings,
  phoneNumberActivate,
  phoneNumberFail,
  phoneNumberMarkReleased,
  registrationSubmit,
  registrationUpdateStatus,
  conversationOpen,
  conversationMarkRead,
  conversationMarkUnread,
  conversationAssign,
  conversationSnooze,
  conversationClose,
  conversationReopen,
  conversationLinkPerson,
  messageSend,
  messageRetry,
  messageCancelScheduled,
  messageReleaseScheduled,
  messageReceive,
  messageUpdateStatus,
  messageAttachMedia,
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
  emailAddressCreate,
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
  scheduleSet,
  timeOffAdd,
  timeOffRemove,
  appointmentCreate,
  appointmentUpdate,
  appointmentReschedule,
  appointmentReassign,
  appointmentCancel,
  appointmentSetStatus,
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
  appointmentBookForCustomer,
  attendeeRescheduleForCustomer,
  attendeeCancelForCustomer,
  intakeSourceUpdate,
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
  attendeeConfirm,
  attendeeConfirmOnline,
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
  moneySaveSettings,
  pushDeviceRegister,
  pushDeviceRemove,
  ...migrationCommands,
  ...supportTicketCommands,
  ...supportStaffCommands,
  ...formCommands,
  ...formResponseCommands,
] as unknown as readonly CommandDef[];
export { callPreview } from './call';
export { VERIFY_CALLS_PER_DAY, VERIFY_CALLS_PER_HOUR } from './user-phone';
export { attendeeFromPerson } from './appointment';
export { validateIntake } from './appointment-online';
export { DEPOSIT_HOLD_JOB, depositHoldKey, holdState } from './appointment-online';
export * from './calendar-connection';
export * from './reminder';
export * from './waitlist-offer';
export * from './form';
export * from './form-response';
export * from './workflow';
export * from './workflow-run';
export * from './workflow-template';
export * from './knowledge';
export * from './ai-team';
export * from './appointment-ai';
export * from './conversation-handling';
export { leadRecordAnswers } from './lead.record_answers';
export * from './chat-widget';
export * from './intake-source';
export * from './chat';
export * from './attention';
export * from './attendee-confirm';
export * from './payment-connection';
export * from './money-catalog';
export * from './estimate';
export * from './invoice';
export * from './payment';
export * from './subscription';
export * from './money-shared';
export * from './push-device';
export * from './migration';
export * from './support';
export * from './support-staff';
