import {
  AccountDeleteInput,
  AccountDeleteOutput,
  ActivityLogInput,
  ActivityLogOutput,
  AiTeammateDecideDraftInput,
  AiTeammateDecideDraftOutput,
  AppointmentCancelInput,
  AppointmentCancelOutput,
  AppointmentCreateInput,
  AppointmentCreateOutput,
  AppointmentRescheduleInput,
  AppointmentRescheduleOutput,
  AppointmentSetStatusInput,
  AppointmentStillGoingInput,
  AppointmentStillGoingOutput,
  AppointmentSetStatusOutput,
  AppointmentUpdateInput,
  AppointmentUpdateOutput,
  JobSetStatusInput,
  JobSetStatusOutput,
  AssistantConsentInput,
  AssistantConsentOutput,
  AttendeeConfirmInput,
  AttendeeConfirmOnlineOutput,
  AttentionAssignInput,
  AttentionAssignOutput,
  AttentionCancelAutoOutput,
  AttentionDismissInput,
  AttentionItemRefInput,
  AttentionItemStateOutput,
  AttentionLetHandleInput,
  AttentionLetHandleOutput,
  AttentionSnoozeInput,
  CallCancelConnectInput,
  CallCancelConnectOutput,
  CallConnectMeInput,
  CallConnectMeOutput,
  CompanyArchiveInput,
  CompanyArchiveOutput,
  CompanyCreateInput,
  CompanyCreateOutput,
  CompanyRestoreInput,
  CompanyRestoreOutput,
  CompanyUpdateInput,
  CompanyUpdateOutput,
  ConversationAssignInput,
  ConversationCloseAllOutput,
  ConversationHandToAiOutput,
  ConversationLinkPersonInput,
  ConversationLinkPersonOutput,
  ConversationMoveInput,
  ConversationMoveOutput,
  ConversationOpenInput,
  ConversationOpenOutput,
  ConversationRefInput,
  ConversationRefOutput,
  ConversationShareOutput,
  ConversationSnoozeInput,
  ConversationTakeOverOutput,
  EstimateCreateInput,
  EstimateSendInput,
  EstimateStateOutput,
  EstimateUpdateInput,
  FileBeginUploadInput,
  FileBeginUploadOutput,
  FileConfirmInput,
  FileConfirmOutput,
  FormRecordInput,
  FormResponseDeleteInput,
  FormResponseDeleteOutput,
  FormSubmitOutput,
  FRESH_MINUTES,
  InvoiceCreateInput,
  InvoiceRecordCashPaymentInput,
  InvoiceSendInput,
  InvoiceStateOutput,
  InvoiceUpdateInput,
  LeadArchiveInput,
  LeadArchiveOutput,
  LeadCreateInput,
  LeadCreateOutput,
  LeadMoveStageInput,
  LeadMoveStageOutput,
  LeadRecordAnswersInput,
  LeadRecordAnswersOutput,
  LeadSetNextActionInput,
  LeadSetNextActionOutput,
  LeadUpdateInput,
  LeadUpdateOutput,
  MessageCancelScheduledInput,
  MessageCancelScheduledOutput,
  MessageSendInput,
  MessageSendOutput,
  PaymentStateOutput,
  PersonArchiveInput,
  PersonArchiveOutput,
  PersonCreateInput,
  PersonCreateOutput,
  PersonRestoreInput,
  PersonRestoreOutput,
  PersonUpdateInput,
  PersonUpdateOutput,
  PushDeviceRegisterInput,
  PushDeviceRegisterOutput,
  PushDeviceRemoveInput,
  PushDeviceRemoveOutput,
  RecordTagInput,
  RecordTagOutput,
  SubscriptionCardOutput,
  SubscriptionRequestCardInput,
  TaskCompleteInput,
  TaskCompleteOutput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskDeleteInput,
  TaskDeleteOutput,
  TaskReopenInput,
  TaskReopenOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
  TeammateLessonApplyInput,
  TeammateLessonApplyOutput,
  UserPhoneStartVerificationInput,
  UserPhoneStartVerificationOutput,
  UserUpdateProfileInput,
  UserUpdateProfileOutput,
  WorkflowDecideApprovalInput,
  WorkflowDecideApprovalOutput,
  SafetyCheckInInput,
  SafetyCheckInOutput,
  SafetyCheckInRef,
  SafetyExtendInput,
  type OfflineClass,
} from '@hfos/core';
// Real Estate's own changes the phone may make (round six): its schemas live with the add-on in core.
import {
  FieldNoteAddInput,
  FieldNoteAddOutput,
  WalkthroughAddItemInput,
  WalkthroughCheckInput,
  WalkthroughFinishInput,
  WalkthroughFinishOutput,
  WalkthroughItemOutput,
  WalkthroughOutput,
  WalkthroughRef,
} from '@hfos/core/addons/realestate/schemas';

/**
 * The commands the phone may send: exactly the phone's contract (`packages/core/test/contract/mobile-contract.json`),
 * each with its offline class and the input and output schemas `@hfos/core` exports for it. A test checks this list
 * against the contract, class and input schema alike, so a screen can only make a change the contract allows, typed as
 * the API takes it.
 *
 * - `anytime` changes wait on the phone for as long as it takes.
 * - `{ freshMinutes }` changes reach a customer: they go on their own while fresh, and ask "Still send?" after.
 * - `online` commands are never queued: with signal they go straight to the API, and with none the screen says so.
 */

/** A zod schema as `@hfos/core` exports it: what it takes and what it gives, as types. */
interface Schema {
  readonly _zod: { readonly input: unknown; readonly output: unknown };
}

const ANYTIME = 'anytime';
const ONLINE = 'online';
const FRESH = { freshMinutes: FRESH_MINUTES } as const;

function command<C extends OfflineClass, I extends Schema, O extends Schema>(
  offline: C,
  input: I,
  output: O,
) {
  return { offline, input, output } as const;
}

export const PHONE_COMMANDS = {
  'account.delete': command(ONLINE, AccountDeleteInput, AccountDeleteOutput),
  'activity.log': command(ANYTIME, ActivityLogInput, ActivityLogOutput),
  'ai_teammate.decide_draft': command(
    FRESH,
    AiTeammateDecideDraftInput,
    AiTeammateDecideDraftOutput,
  ),
  'appointment.cancel': command(FRESH, AppointmentCancelInput, AppointmentCancelOutput),
  'appointment.create': command(FRESH, AppointmentCreateInput, AppointmentCreateOutput),
  'appointment.reschedule': command(FRESH, AppointmentRescheduleInput, AppointmentRescheduleOutput),
  'appointment.set_status': command(ANYTIME, AppointmentSetStatusInput, AppointmentSetStatusOutput),
  'appointment.still_going': command(
    ANYTIME,
    AppointmentStillGoingInput,
    AppointmentStillGoingOutput,
  ),
  'appointment.update': command(ANYTIME, AppointmentUpdateInput, AppointmentUpdateOutput),
  'job.set_status': command(FRESH, JobSetStatusInput, JobSetStatusOutput),
  'assistant.consent': command(ONLINE, AssistantConsentInput, AssistantConsentOutput),
  'attendee.confirm': command(ANYTIME, AttendeeConfirmInput, AttendeeConfirmOnlineOutput),
  'attention.assign': command(ANYTIME, AttentionAssignInput, AttentionAssignOutput),
  'attention.cancel_auto': command(ANYTIME, AttentionItemRefInput, AttentionCancelAutoOutput),
  'attention.dismiss': command(ANYTIME, AttentionDismissInput, AttentionItemStateOutput),
  'attention.let_handle': command(FRESH, AttentionLetHandleInput, AttentionLetHandleOutput),
  'attention.restore': command(ANYTIME, AttentionItemRefInput, AttentionItemStateOutput),
  'attention.snooze': command(ANYTIME, AttentionSnoozeInput, AttentionItemStateOutput),
  'attention.unsnooze': command(ANYTIME, AttentionItemRefInput, AttentionItemStateOutput),
  'call.cancel_connect': command(ONLINE, CallCancelConnectInput, CallCancelConnectOutput),
  'call.connect_me': command(ONLINE, CallConnectMeInput, CallConnectMeOutput),
  'company.archive': command(ANYTIME, CompanyArchiveInput, CompanyArchiveOutput),
  'company.create': command(ANYTIME, CompanyCreateInput, CompanyCreateOutput),
  'company.restore': command(ANYTIME, CompanyRestoreInput, CompanyRestoreOutput),
  'company.update': command(ANYTIME, CompanyUpdateInput, CompanyUpdateOutput),
  // Putting a thread away and bringing it back. Both are idempotent — the command returns early when it is
  // already where it is going — which is why they can wait out a tunnel.
  'conversation.archive': command(ANYTIME, ConversationRefInput, ConversationRefOutput),
  'conversation.assign': command(ANYTIME, ConversationAssignInput, ConversationRefOutput),
  'conversation.close': command(ANYTIME, ConversationRefInput, ConversationRefOutput),
  // Closing every line a customer writes on (0089). Idempotent for the same reason the one above is: it
  // closes what is still open and returns a count, so a queued one that lands twice closes nothing the
  // second time.
  'conversation.close_all': command(ANYTIME, ConversationRefInput, ConversationCloseAllOutput),
  'conversation.hand_to_ai': command(FRESH, ConversationRefInput, ConversationHandToAiOutput),
  'conversation.link_person': command(
    ANYTIME,
    ConversationLinkPersonInput,
    ConversationLinkPersonOutput,
  ),
  'conversation.mark_read': command(ANYTIME, ConversationRefInput, ConversationRefOutput),
  // Moving an email thread between the Inbox, Other mail and Spam, and sharing someone's own mail with the team
  // (M19): online only, so the thread is where the person put it when they look again.
  'conversation.move': command(ONLINE, ConversationMoveInput, ConversationMoveOutput),
  'conversation.mark_unread': command(ANYTIME, ConversationRefInput, ConversationRefOutput),
  'conversation.open': command(ANYTIME, ConversationOpenInput, ConversationOpenOutput),
  'conversation.reopen': command(ANYTIME, ConversationRefInput, ConversationRefOutput),
  'conversation.restore': command(ANYTIME, ConversationRefInput, ConversationRefOutput),
  'conversation.share': command(ONLINE, ConversationRefInput, ConversationShareOutput),
  'conversation.snooze': command(ANYTIME, ConversationSnoozeInput, ConversationRefOutput),
  'conversation.take_over': command(ANYTIME, ConversationRefInput, ConversationTakeOverOutput),
  'estimate.create': command(ONLINE, EstimateCreateInput, EstimateStateOutput),
  'estimate.send': command(FRESH, EstimateSendInput, EstimateStateOutput),
  'estimate.update': command(ONLINE, EstimateUpdateInput, EstimateStateOutput),
  'file.begin_upload': command(ANYTIME, FileBeginUploadInput, FileBeginUploadOutput),
  'file.confirm': command(ANYTIME, FileConfirmInput, FileConfirmOutput),
  // M17: a form filled in on a job. Made and sent in one go, with an id from this phone, so the queue
  // retrying it is the same answer sheet rather than a second one.
  // Deleting an answer sheet (a test, or a customer asking to be forgotten): online only, never left waiting.
  'form_response.delete': command(ONLINE, FormResponseDeleteInput, FormResponseDeleteOutput),
  'form_response.record': command(ANYTIME, FormRecordInput, FormSubmitOutput),
  'invoice.create': command(ONLINE, InvoiceCreateInput, InvoiceStateOutput),
  'invoice.record_cash_payment': command(
    ANYTIME,
    InvoiceRecordCashPaymentInput,
    PaymentStateOutput,
  ),
  'invoice.send': command(FRESH, InvoiceSendInput, InvoiceStateOutput),
  'invoice.update': command(ONLINE, InvoiceUpdateInput, InvoiceStateOutput),
  'lead.archive': command(ANYTIME, LeadArchiveInput, LeadArchiveOutput),
  'lead.create': command(ANYTIME, LeadCreateInput, LeadCreateOutput),
  'lead.move_stage': command(ANYTIME, LeadMoveStageInput, LeadMoveStageOutput),
  'lead.record_answers': command(ANYTIME, LeadRecordAnswersInput, LeadRecordAnswersOutput),
  'lead.restore': command(ANYTIME, LeadArchiveInput, LeadArchiveOutput),
  'lead.set_next_action': command(ANYTIME, LeadSetNextActionInput, LeadSetNextActionOutput),
  'lead.update': command(ANYTIME, LeadUpdateInput, LeadUpdateOutput),
  'message.cancel_scheduled': command(
    ANYTIME,
    MessageCancelScheduledInput,
    MessageCancelScheduledOutput,
  ),
  'message.send': command(FRESH, MessageSendInput, MessageSendOutput),
  'person.archive': command(ANYTIME, PersonArchiveInput, PersonArchiveOutput),
  'person.create': command(ANYTIME, PersonCreateInput, PersonCreateOutput),
  'person.restore': command(ANYTIME, PersonRestoreInput, PersonRestoreOutput),
  'person.update': command(ANYTIME, PersonUpdateInput, PersonUpdateOutput),
  'push_device.register': command(ONLINE, PushDeviceRegisterInput, PushDeviceRegisterOutput),
  'push_device.remove': command(ONLINE, PushDeviceRemoveInput, PushDeviceRemoveOutput),
  // Real Estate in the field (round six): notes and the final walkthrough, with no signal.
  'realestate.field_note.add': command(ANYTIME, FieldNoteAddInput, FieldNoteAddOutput),
  'realestate.walkthrough.add_item': command(
    ANYTIME,
    WalkthroughAddItemInput,
    WalkthroughItemOutput,
  ),
  'realestate.walkthrough.check_item': command(
    ANYTIME,
    WalkthroughCheckInput,
    WalkthroughItemOutput,
  ),
  'realestate.walkthrough.finish': command(
    ANYTIME,
    WalkthroughFinishInput,
    WalkthroughFinishOutput,
  ),
  'realestate.walkthrough.start': command(ANYTIME, WalkthroughRef, WalkthroughOutput),
  'record.add_tag': command(ANYTIME, RecordTagInput, RecordTagOutput),
  'record.remove_tag': command(ANYTIME, RecordTagInput, RecordTagOutput),
  // Check-ins (round six): checking in, adding time and checking out work with no signal.
  'safety.check_in': command(ANYTIME, SafetyCheckInInput, SafetyCheckInOutput),
  'safety.check_out': command(ANYTIME, SafetyCheckInRef, SafetyCheckInOutput),
  'safety.extend': command(ANYTIME, SafetyExtendInput, SafetyCheckInOutput),
  'subscription.request_card': command(FRESH, SubscriptionRequestCardInput, SubscriptionCardOutput),
  'task.complete': command(ANYTIME, TaskCompleteInput, TaskCompleteOutput),
  'task.create': command(ANYTIME, TaskCreateInput, TaskCreateOutput),
  'task.delete': command(ANYTIME, TaskDeleteInput, TaskDeleteOutput),
  'task.reopen': command(ANYTIME, TaskReopenInput, TaskReopenOutput),
  'task.update': command(ANYTIME, TaskUpdateInput, TaskUpdateOutput),
  // A lesson from correcting the AI, added to what it knows from its Home card. Never queued: it can go against
  // what the AI knows, and whether the old words are still there is the server's to say at the moment it's pressed.
  'teammate_lesson.apply': command(ONLINE, TeammateLessonApplyInput, TeammateLessonApplyOutput),
  'user_phone.start_verification': command(
    ONLINE,
    UserPhoneStartVerificationInput,
    UserPhoneStartVerificationOutput,
  ),
  'user.update_profile': command(ONLINE, UserUpdateProfileInput, UserUpdateProfileOutput),
  'workflow.decide_approval': command(
    FRESH,
    WorkflowDecideApprovalInput,
    WorkflowDecideApprovalOutput,
  ),
} as const;

type Commands = typeof PHONE_COMMANDS;

/** Every command the phone may send. */
export type CommandName = keyof Commands;

/** What a command takes, as the API takes it (defaults may be left out). */
export type InputOf<N extends CommandName> = Commands[N]['input']['_zod']['input'];

/** What a command gives back when it's done. */
export type OutputOf<N extends CommandName> = Commands[N]['output']['_zod']['output'];

/** Commands that never wait on the phone: with signal they go at once, and with none the screen says so. */
export type OnlineCommand = {
  [N in CommandName]: Commands[N]['offline'] extends 'online' ? N : never;
}[CommandName];

/** Commands that wait on the phone for signal, in the order they were made. */
export type QueuedCommand = Exclude<CommandName, OnlineCommand>;

export function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(PHONE_COMMANDS, name);
}

/** A command's offline class, or null for a name the contract doesn't know. */
export function offlineClassOf(name: string): OfflineClass | null {
  return isCommandName(name) ? PHONE_COMMANDS[name].offline : null;
}

/** How many minutes a customer-facing change goes out on its own, or null for one that never asks. */
export function freshMinutesOf(name: string): number | null {
  const offline = offlineClassOf(name);
  return offline !== null && typeof offline === 'object' ? offline.freshMinutes : null;
}

export function isOnline(name: string): boolean {
  return offlineClassOf(name) === 'online';
}
