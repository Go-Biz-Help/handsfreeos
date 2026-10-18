import {
  AccountDeleteInput,
  AccountDeleteOutput,
  ExtensionSignInAnswerInput,
  ExtensionSignInAnswerOutput,
  ActivityLogInput,
  ActivityLogOutput,
  AddonAlertAcknowledgeInput,
  AddonAlertAcknowledgeOutput,
  AddonSaveSettingsInput,
  AddonSettingsSaved,
  AiSetupFinishInput,
  AiSetupFinishOutput,
  AiSetupSaveInput,
  AiSetupSaveOutput,
  AiTeammateAnswerFeedbackInput,
  AiTeammateDecideDraftInput,
  AiTeammateDecideDraftOutput,
  AiTeammateFeedbackOutput,
  AiTeammateGiveFeedbackInput,
  AiTeammateSetStatusInput,
  AiTeammateSetStatusOutput,
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
  KnowledgeItemCreateInput,
  KnowledgeItemWriteOutput,
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
  LookBeginUploadInput,
  LookBeginUploadOutput,
  LookFindInput,
  LookFindOutput,
  LookSetInput,
  LookSetOutput,
  LookUseUploadInput,
  LookUseUploadOutput,
  MainOfferPublishInput,
  MainOfferPublishOutput,
  MainOfferSaveDirectionInput,
  MainOfferSaveDirectionOutput,
  MainOfferSaveDraftInput,
  MainOfferSaveDraftOutput,
  MessageCancelScheduledInput,
  MessageCancelScheduledOutput,
  MessageRetryInput,
  MessageRetryOutput,
  MessageSendInput,
  MessageSendOutput,
  OnboardingSetupFinishInput,
  OnboardingSetupFinishOutput,
  OnboardingSetupSaveInput,
  OnboardingSetupSaveOutput,
  OrganizationCreateInput,
  OrganizationCreateOutput,
  PaymentConnectionConnectInput,
  PaymentConnectionConnectOutput,
  PaymentStateOutput,
  PersonArchiveInput,
  PersonArchiveOutput,
  PersonCreateInput,
  PersonCreateOutput,
  PersonRestoreInput,
  PersonRestoreOutput,
  PersonUpdateInput,
  PersonUpdateOutput,
  PhoneNumberBuyInput,
  PhoneNumberBuyOutput,
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
  TeammateLessonDismissInput,
  TeammateLessonDismissOutput,
  UserPhoneStartVerificationInput,
  UserPhoneStartVerificationOutput,
  UserUpdateProfileInput,
  UserUpdateProfileOutput,
  WorkflowDecideApprovalInput,
  WorkflowDecideApprovalOutput,
  SafetyCheckInInput,
  SafetyCheckInOutput,
  SafetyCheckInRef,
  SafetyWhereInput,
  SafetyWhereOutput,
  SafetyContactOutput,
  SafetyContactRemoveInput,
  SafetyContactRemoveOutput,
  SafetyContactSaveInput,
  SafetyExtendInput,
  SafetyHelpInput,
  type OfflineClass,
  RecordHoldLiftInput,
  RecordHoldLiftOutput,
  RecordHoldOutput,
  RecordHoldPlaceInput,
  PortalAccessGiveInput,
  PortalAccessGiveOutput,
} from '@hfos/core';
// Real Estate's own changes the phone may make (round six): its schemas live with the add-on in core.
import {
  BuyerProfileSaveInput,
  BuyerProfileSaveOutput,
  ClientTaskAddInput,
  ClientTaskAddOutput,
  CmaChangeOutput,
  CmaFindCompsInput,
  CmaFindCompsOutput,
  CmaInput,
  ContingencyAddInput,
  ContingencyOutput,
  ContingencyResolveInput,
  DocumentAddInput,
  DocumentOutput,
  DutyAcknowledgeInput,
  DutyAddEvidenceInput,
  DutyCompleteInput,
  DutyEvidenceOutput,
  DutyOutput,
  DutySetStatusInput,
  DutyWithdrawEvidenceInput,
  FieldNoteAddInput,
  FieldNoteAddOutput,
  FinancingChangeOutput,
  FinancingMarkDoneInput,
  FinancingReopenInput,
  FinancingUpdateStepInput,
  FindingAddInput,
  FindingAddOutput,
  FindingChangeOutput,
  FindingRemoveInput,
  FindingUpdateInput,
  HomeAddInput,
  HomeAddOutput,
  HomeLookupInput,
  HomeLookupOutput,
  HomeSetStatusInput,
  HomeSetStatusOutput,
  InspectionAddInput,
  InspectionAddOutput,
  InspectionChangeOutput,
  InspectionUpdateInput,
  ListingPhotoAddInput,
  ListingPhotosArrangeInput,
  ListingPhotosOutput,
  ListingPriceProposeInput,
  ListingPriceProposeOutput,
  MatchDismissInput,
  MatchDismissOutput,
  MatchSendInput,
  MatchSendOutput,
  MemoryAddInput,
  MemoryAddOutput,
  NetSheetSaveInput,
  NetSheetSaveOutput,
  OfferAddVersionInput,
  OfferAddVersionOutput,
  OfferChangeOutput,
  OfferInput,
  ShowingAddInput,
  ShowingDecideInput,
  ShowingFeedbackInput,
  ShowingOutput,
  StatusEmailDraftInput,
  StatusEmailOutput,
  StatusEmailSaveInput,
  StatusEmailSavedOutput,
  SuggestionChangeOutput,
  SuggestionInput,
  SuggestionNotAFitInput,
  TourChangeOutput,
  TourFeedbackInput,
  TourFeedbackOutput,
  TourPlanInput,
  TourPlanOutput,
  TourRecordVisitInput,
  TourRecordVisitOutput,
  TourSetStopsInput,
  VendorOutput,
  VendorSaveInput,
  WalkthroughAddItemInput,
  WalkthroughCheckInput,
  WalkthroughFinishInput,
  WalkthroughFinishOutput,
  WalkthroughItemOutput,
  WalkthroughOutput,
  WalkthroughRef,
  ContractConfirmInput,
  ContractConfirmOutput,
  DealChangeOutput,
  DealExportInput,
  DealExportOutput,
  DealMoveStageInput,
  DutyReasonInput,
  StatusEmailRequestInput,
  VendorApproveInput,
  ClientTaskChangeOutput,
  ClientTaskMarkDoneInput,
  DutyPickVendorInput,
  DutyVendorOutput,
  DutyVendorQuoteInput,
  ListingConfirmFactsInput,
  ListingConfirmFactsOutput,
  ListingDescriptionOutput,
  ListingDescriptionRequestInput,
  ListingLookupInput,
  ListingLookupOutput,
  ListingMarkLiveInput,
  ListingMarkLiveOutput,
  ListingPostsOutput,
  ListingPostsRequestInput,
  OpenHousePlanInput,
  OpenHousePlanOutput,
  OpenHouseSignInInput,
  OpenHouseSignInOutput,
  RepairChangeOutput,
  RepairSendInput,
  WalkthroughPlanInput,
} from '@hfos/core/addons/realestate/schemas';
// Social Outreach's changes the phone may make (decision 44): its schemas live with the add-on in core.
import {
  AskCancelInput,
  AskChangedOutput,
  AskMakeInput,
  AskMakeOutput,
  AskReplyInput,
  ProfileContactInput,
} from '@hfos/core/addons/outreach/asks';
import {
  AutomationSaveInput,
  AutomationSaveOutput,
  WheelsEndInput,
  WheelsEndOutput,
} from '@hfos/core/addons/outreach/automation';
import { DemoMarkInput, DemoMarkOutput } from '@hfos/core/addons/outreach/demos';
import { FriendSetInput, FriendSetOutput } from '@hfos/core/addons/outreach/friends';
import { DayInput, DayOutput } from '@hfos/core/addons/outreach/live';
import { PartnerMarkInput, PartnerMarkOutput } from '@hfos/core/addons/outreach/partners';
import {
  Playbook,
  PlaybookArchiveInput,
  PlaybookSaveInput,
} from '@hfos/core/addons/outreach/playbooks';
import { PostSkipInput, PostSkipOutput } from '@hfos/core/addons/outreach/posts';
import {
  MessagesOkInput,
  NumbersInput,
  ProfileTickInput,
  ReadinessOutput,
} from '@hfos/core/addons/outreach/readiness';
import { ProfileSaveOutput } from '@hfos/core/addons/outreach/saves';
import {
  SendApproveInput,
  SendApproveOutput,
  SendSkipInput,
  SendSkipOutput,
} from '@hfos/core/addons/outreach/sends';
import { StageMarkInput, StageMarkOutput } from '@hfos/core/addons/outreach/stages';
import {
  HelpfulAskInput,
  HelpfulAskOutput,
  HelpfulChangeOutput,
  HelpfulOkInput,
  HelpfulPostedInput,
  HelpfulSkipInput,
} from '@hfos/core/addons/outreach/helpful';
import {
  NeedClearInput,
  NeedClearOutput,
  RequestSetAsideInput,
  RequestSetAsideOutput,
} from '@hfos/core/addons/outreach/waiting';

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
  // Letting the browser extension sign in by picking its number, from the push (20261027002910).
  'extension_sign_in.answer': command(
    ONLINE,
    ExtensionSignInAnswerInput,
    ExtensionSignInAnswerOutput,
  ),
  'activity.log': command(ANYTIME, ActivityLogInput, ActivityLogOutput),
  // Social Outreach's business settings (decision 44), for owners and admins. Online: the rest of the form is
  // HandsFreeOS's answer, and a change waiting on the phone could undo someone else's.
  'addon.save_settings': command(ONLINE, AddonSaveSettingsInput, AddonSettingsSaved),
  // Got it on an add-on's alert (round six: its Home cards reach phones). Online, as the command is: the add-on hears
  // that someone has seen it, and stops raising it higher, only once HandsFreeOS has it.
  'addon_alert.acknowledge': command(
    ONLINE,
    AddonAlertAcknowledgeInput,
    AddonAlertAcknowledgeOutput,
  ),
  // Quick setup for the AI teammate (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): each screen's answers as
  // it's finished, Save, and turning the teammate on. Online: what each screen shows next comes from HandsFreeOS.
  'ai_setup.finish': command(ONLINE, AiSetupFinishInput, AiSetupFinishOutput),
  'ai_setup.save': command(ONLINE, AiSetupSaveInput, AiSetupSaveOutput),
  // Feedback on a reply the AI teammate wrote, and the answer to its one quick question about it
  // (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md). Online: what it learns comes back from HandsFreeOS while the
  // person waits, and a thumbs down that waited would teach it late.
  'ai_teammate.answer_feedback': command(
    ONLINE,
    AiTeammateAnswerFeedbackInput,
    AiTeammateFeedbackOutput,
  ),
  'ai_teammate.decide_draft': command(
    FRESH,
    AiTeammateDecideDraftInput,
    AiTeammateDecideDraftOutput,
  ),
  'ai_teammate.give_feedback': command(
    ONLINE,
    AiTeammateGiveFeedbackInput,
    AiTeammateFeedbackOutput,
  ),
  'ai_teammate.set_status': command(ONLINE, AiTeammateSetStatusInput, AiTeammateSetStatusOutput),
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
  // An answer added from quick setup's test chat: published at once, so the question can be asked again.
  'knowledge_item.create': command(ONLINE, KnowledgeItemCreateInput, KnowledgeItemWriteOutput),
  'lead.archive': command(ANYTIME, LeadArchiveInput, LeadArchiveOutput),
  'lead.create': command(ANYTIME, LeadCreateInput, LeadCreateOutput),
  'lead.move_stage': command(ANYTIME, LeadMoveStageInput, LeadMoveStageOutput),
  'lead.record_answers': command(ANYTIME, LeadRecordAnswersInput, LeadRecordAnswersOutput),
  'lead.restore': command(ANYTIME, LeadArchiveInput, LeadArchiveOutput),
  'lead.set_next_action': command(ANYTIME, LeadSetNextActionInput, LeadSetNextActionOutput),
  'lead.update': command(ANYTIME, LeadUpdateInput, LeadUpdateOutput),
  // The business's logo and colour, on setup's "Your logo and colour" (§4 of the onboarding plan): online, since an
  // upload goes straight to Storage and the worker makes it ready.
  'look.begin_upload': command(ONLINE, LookBeginUploadInput, LookBeginUploadOutput),
  'look.find': command(ONLINE, LookFindInput, LookFindOutput),
  'look.set': command(ONLINE, LookSetInput, LookSetOutput),
  'look.use_upload': command(ONLINE, LookUseUploadInput, LookUseUploadOutput),
  // Settings → Main offer: a part edited, the direction, and going live. Online, since each is for the draft as the
  // server has it now (its revision) and the score the worker gave it.
  'main_offer.publish': command(ONLINE, MainOfferPublishInput, MainOfferPublishOutput),
  'main_offer.save_direction': command(
    ONLINE,
    MainOfferSaveDirectionInput,
    MainOfferSaveDirectionOutput,
  ),
  'main_offer.save_draft': command(ONLINE, MainOfferSaveDraftInput, MainOfferSaveDraftOutput),
  'message.cancel_scheduled': command(
    ANYTIME,
    MessageCancelScheduledInput,
    MessageCancelScheduledOutput,
  ),
  // A text or email that didn't go out, sent again from its thread: with signal only, since it goes at once.
  'message.retry': command(ONLINE, MessageRetryInput, MessageRetryOutput),
  'message.send': command(FRESH, MessageSendInput, MessageSendOutput),
  // The onboarding setup (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): making the business after
  // signing up, each screen's answers as it's finished, and "Stay in the loop". Online, as quick setup's are: what
  // each screen shows next comes from HandsFreeOS.
  'onboarding_setup.finish': command(
    ONLINE,
    OnboardingSetupFinishInput,
    OnboardingSetupFinishOutput,
  ),
  'onboarding_setup.save': command(ONLINE, OnboardingSetupSaveInput, OnboardingSetupSaveOutput),
  'organization.create': command(ONLINE, OrganizationCreateInput, OrganizationCreateOutput),
  // Social Outreach (decision 44): Waiting for you's OK waits 30 minutes, then asks Still send?; a skip, Not for me,
  // a need cleared, a request left and the day started or stopped wait as long as it takes; the rest need signal,
  // asking the computer among them (decision 43): an ask is for now, and the computer may be on.
  'outreach.ask.cancel': command(ONLINE, AskCancelInput, AskChangedOutput),
  'outreach.ask.make': command(ONLINE, AskMakeInput, AskMakeOutput),
  'outreach.ask.reply': command(ONLINE, AskReplyInput, AskChangedOutput),
  'outreach.automation.save': command(ONLINE, AutomationSaveInput, AutomationSaveOutput),
  'outreach.day.start': command(ANYTIME, DayInput, DayOutput),
  'outreach.day.stop': command(ANYTIME, DayInput, DayOutput),
  'outreach.demo.mark': command(ONLINE, DemoMarkInput, DemoMarkOutput),
  'outreach.friend.set': command(ONLINE, FriendSetInput, FriendSetOutput),
  'outreach.helpful.ask': command(ONLINE, HelpfulAskInput, HelpfulAskOutput),
  'outreach.helpful.ok': command(ONLINE, HelpfulOkInput, HelpfulChangeOutput),
  'outreach.helpful.posted': command(ONLINE, HelpfulPostedInput, HelpfulChangeOutput),
  'outreach.helpful.skip': command(ONLINE, HelpfulSkipInput, HelpfulChangeOutput),
  'outreach.need.clear': command(ANYTIME, NeedClearInput, NeedClearOutput),
  // Where someone stands on the Partners list (decision 81): with signal, as the pipeline's marks are.
  'outreach.partner.mark': command(ONLINE, PartnerMarkInput, PartnerMarkOutput),
  'outreach.playbook.archive': command(ONLINE, PlaybookArchiveInput, Playbook),
  'outreach.playbook.save': command(ONLINE, PlaybookSaveInput, Playbook),
  'outreach.post.skip': command(ANYTIME, PostSkipInput, PostSkipOutput),
  'outreach.profile.contact': command(ONLINE, ProfileContactInput, ProfileSaveOutput),
  // Get ready (decision 63): a profile item ticked, the goal set and the messages OK'd, on Today, with signal.
  'outreach.readiness.messages': command(ONLINE, MessagesOkInput, ReadinessOutput),
  'outreach.readiness.numbers': command(ONLINE, NumbersInput, ReadinessOutput),
  'outreach.readiness.profile': command(ONLINE, ProfileTickInput, ReadinessOutput),
  'outreach.request.set_aside': command(ANYTIME, RequestSetAsideInput, RequestSetAsideOutput),
  'outreach.send.approve': command(FRESH, SendApproveInput, SendApproveOutput),
  'outreach.send.skip': command(ANYTIME, SendSkipInput, SendSkipOutput),
  // Where someone stands, on the Pipeline screen (decision 47): with signal, as the person menu's marks are.
  'outreach.stage.mark': command(ONLINE, StageMarkInput, StageMarkOutput),
  'outreach.wheels.end': command(ONLINE, WheelsEndInput, WheelsEndOutput),
  // The setup's payments stop: Stripe's or Square's own sign-in starts from it, in the phone's browser.
  'payment_connection.connect': command(
    ONLINE,
    PaymentConnectionConnectInput,
    PaymentConnectionConnectOutput,
  ),
  'person.archive': command(ANYTIME, PersonArchiveInput, PersonArchiveOutput),
  'person.create': command(ANYTIME, PersonCreateInput, PersonCreateOutput),
  'person.restore': command(ANYTIME, PersonRestoreInput, PersonRestoreOutput),
  'person.update': command(ANYTIME, PersonUpdateInput, PersonUpdateOutput),
  // The setup's number stop: the number picked near the address, bought right there.
  'phone_number.buy': command(ONLINE, PhoneNumberBuyInput, PhoneNumberBuyOutput),
  // A client let into their portal, or sent the link again, from the client's to-do (board 85): it emails them.
  'portal_access.give': command(ONLINE, PortalAccessGiveInput, PortalAccessGiveOutput),
  'push_device.register': command(ONLINE, PushDeviceRegisterInput, PushDeviceRegisterOutput),
  'push_device.remove': command(ONLINE, PushDeviceRemoveInput, PushDeviceRemoveOutput),
  // Real Estate on the phone (round six, boards 76–93). What's done in the field waits for signal as long as it takes:
  // a duty's proof and marking it done, contingencies, documents from a photo, financing steps, inspections and their
  // findings, homes and what the buyer wants, the listing's photos, net sheets, vendors, tours, what buyers' agents
  // said, notes and the final walkthrough. Anything new keeps the phone's id. What reaches a client or another agent
  // goes while fresh and asks "Still send?" after 30 minutes: a client update, a client's task, a match sent to the
  // client, a price for the seller to sign off, and a showing added or answered. The AI's drafts, exceptions,
  // deciding a contract's terms, offers, signing, export and holds need signal, so they aren't here.
  'realestate.buyer_profile.save': command(ANYTIME, BuyerProfileSaveInput, BuyerProfileSaveOutput),
  'realestate.client_task.add': command(FRESH, ClientTaskAddInput, ClientTaskAddOutput),
  // Boards 85–89 with signal: what the AI, the MLS, the calendar or the other side answers at once.
  'realestate.client_task.mark_done': command(
    ONLINE,
    ClientTaskMarkDoneInput,
    ClientTaskChangeOutput,
  ),
  // The buyer's pages with signal (boards 82–84): looking a home up on the MLS, adding or setting aside one of
  // our listings, planning a tour or changing its homes (the calendar's appointment), writing a counter, sharing
  // an offer's summary, finding a CMA's comps and the AI's summary. Never queued; with no signal the screen says so.
  'realestate.cma.find_comps': command(ONLINE, CmaFindCompsInput, CmaFindCompsOutput),
  'realestate.cma.request_summary': command(ONLINE, CmaInput, CmaChangeOutput),
  'realestate.contingency.add': command(ANYTIME, ContingencyAddInput, ContingencyOutput),
  'realestate.contingency.resolve': command(ANYTIME, ContingencyResolveInput, ContingencyOutput),
  'realestate.contract.confirm': command(ONLINE, ContractConfirmInput, ContractConfirmOutput),
  'realestate.deal.export': command(ONLINE, DealExportInput, DealExportOutput),
  'realestate.deal.move_stage': command(ONLINE, DealMoveStageInput, DealChangeOutput),
  'realestate.document.add': command(ANYTIME, DocumentAddInput, DocumentOutput),
  'realestate.duty.acknowledge': command(ANYTIME, DutyAcknowledgeInput, DutyOutput),
  'realestate.duty.add_evidence': command(ANYTIME, DutyAddEvidenceInput, DutyEvidenceOutput),
  'realestate.duty.complete': command(ANYTIME, DutyCompleteInput, DutyOutput),
  'realestate.duty.complete_with_exception': command(ONLINE, DutyReasonInput, DutyOutput),
  'realestate.duty.pick_vendor': command(ONLINE, DutyPickVendorInput, DutyVendorOutput),
  'realestate.duty.set_status': command(ANYTIME, DutySetStatusInput, DutyOutput),
  'realestate.duty.vendor_quote': command(ONLINE, DutyVendorQuoteInput, DutyVendorOutput),
  'realestate.duty.withdraw_evidence': command(
    ANYTIME,
    DutyWithdrawEvidenceInput,
    DutyEvidenceOutput,
  ),
  'realestate.field_note.add': command(ANYTIME, FieldNoteAddInput, FieldNoteAddOutput),
  'realestate.financing.mark_done': command(ANYTIME, FinancingMarkDoneInput, FinancingChangeOutput),
  'realestate.financing.reopen_step': command(ANYTIME, FinancingReopenInput, FinancingChangeOutput),
  'realestate.financing.update_step': command(
    ANYTIME,
    FinancingUpdateStepInput,
    FinancingChangeOutput,
  ),
  'realestate.finding.add': command(ANYTIME, FindingAddInput, FindingAddOutput),
  'realestate.finding.remove': command(ANYTIME, FindingRemoveInput, FindingChangeOutput),
  'realestate.finding.update': command(ANYTIME, FindingUpdateInput, FindingChangeOutput),
  'realestate.home.add': command(ANYTIME, HomeAddInput, HomeAddOutput),
  'realestate.home.lookup': command(ONLINE, HomeLookupInput, HomeLookupOutput),
  'realestate.home.set_status': command(ANYTIME, HomeSetStatusInput, HomeSetStatusOutput),
  'realestate.inspection.add': command(ANYTIME, InspectionAddInput, InspectionAddOutput),
  'realestate.inspection.update': command(ANYTIME, InspectionUpdateInput, InspectionChangeOutput),
  'realestate.listing.confirm_facts': command(
    ONLINE,
    ListingConfirmFactsInput,
    ListingConfirmFactsOutput,
  ),
  'realestate.listing.description.request': command(
    ONLINE,
    ListingDescriptionRequestInput,
    ListingDescriptionOutput,
  ),
  'realestate.listing.lookup': command(ONLINE, ListingLookupInput, ListingLookupOutput),
  'realestate.listing.mark_live': command(ONLINE, ListingMarkLiveInput, ListingMarkLiveOutput),
  'realestate.listing.photo_add': command(ANYTIME, ListingPhotoAddInput, ListingPhotosOutput),
  'realestate.listing.photos_arrange': command(
    ANYTIME,
    ListingPhotosArrangeInput,
    ListingPhotosOutput,
  ),
  'realestate.listing.posts_request': command(ONLINE, ListingPostsRequestInput, ListingPostsOutput),
  'realestate.listing.price.propose': command(
    FRESH,
    ListingPriceProposeInput,
    ListingPriceProposeOutput,
  ),
  'realestate.match.dismiss': command(ANYTIME, MatchDismissInput, MatchDismissOutput),
  'realestate.match.send': command(FRESH, MatchSendInput, MatchSendOutput),
  'realestate.memory.add': command(ANYTIME, MemoryAddInput, MemoryAddOutput),
  'realestate.net_sheet.save': command(ANYTIME, NetSheetSaveInput, NetSheetSaveOutput),
  'realestate.offer.add_version': command(ONLINE, OfferAddVersionInput, OfferAddVersionOutput),
  'realestate.offer.share_summary': command(ONLINE, OfferInput, OfferChangeOutput),
  'realestate.open_house.plan': command(ONLINE, OpenHousePlanInput, OpenHousePlanOutput),
  // A visitor signing in on the host's phone handed to them (board 88): waits for signal, with the phone's id.
  'realestate.open_house.sign_in': command(ANYTIME, OpenHouseSignInInput, OpenHouseSignInOutput),
  'realestate.repair.send': command(ONLINE, RepairSendInput, RepairChangeOutput),
  'realestate.showing.add': command(FRESH, ShowingAddInput, ShowingOutput),
  'realestate.showing.decide': command(FRESH, ShowingDecideInput, ShowingOutput),
  'realestate.showing.feedback': command(ANYTIME, ShowingFeedbackInput, ShowingOutput),
  'realestate.status_email.request': command(ONLINE, StatusEmailRequestInput, StatusEmailOutput),
  'realestate.status_email.save': command(ANYTIME, StatusEmailSaveInput, StatusEmailSavedOutput),
  'realestate.status_email.send': command(FRESH, StatusEmailDraftInput, StatusEmailOutput),
  'realestate.suggestion.add': command(ONLINE, SuggestionInput, SuggestionChangeOutput),
  'realestate.suggestion.not_a_fit': command(
    ONLINE,
    SuggestionNotAFitInput,
    SuggestionChangeOutput,
  ),
  'realestate.tour.feedback': command(ANYTIME, TourFeedbackInput, TourFeedbackOutput),
  'realestate.tour.plan': command(ONLINE, TourPlanInput, TourPlanOutput),
  'realestate.tour.record_visit': command(ANYTIME, TourRecordVisitInput, TourRecordVisitOutput),
  'realestate.tour.set_stops': command(ONLINE, TourSetStopsInput, TourChangeOutput),
  'realestate.vendor.approve': command(ONLINE, VendorApproveInput, VendorOutput),
  'realestate.vendor.save': command(ANYTIME, VendorSaveInput, VendorOutput),
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
  'realestate.walkthrough.plan': command(ONLINE, WalkthroughPlanInput, WalkthroughOutput),
  'realestate.walkthrough.start': command(ANYTIME, WalkthroughRef, WalkthroughOutput),
  'record.add_tag': command(ANYTIME, RecordTagInput, RecordTagOutput),
  'record.remove_tag': command(ANYTIME, RecordTagInput, RecordTagOutput),
  'record_hold.lift': command(ONLINE, RecordHoldLiftInput, RecordHoldLiftOutput),
  'record_hold.place': command(ONLINE, RecordHoldPlaceInput, RecordHoldOutput),
  // Check-ins (round six): checking in, adding time and checking out work with no signal.
  'safety.check_in': command(ANYTIME, SafetyCheckInInput, SafetyCheckInOutput),
  'safety.check_out': command(ANYTIME, SafetyCheckInRef, SafetyCheckInOutput),
  'safety.extend': command(ANYTIME, SafetyExtendInput, SafetyCheckInOutput),
  // Where the phone is, while a check-in shares it (round seven): only the latest waits, sent by the follower.
  'safety.where': command(ANYTIME, SafetyWhereInput, SafetyWhereOutput),
  // Asking for help, and the person's own safety contacts: online only. Help that waited would tell their contacts
  // too late, so with no signal the screen offers the phone's own call and texting apps instead.
  'safety.help': command(ONLINE, SafetyHelpInput, SafetyCheckInOutput),
  'safety_contact.remove': command(ONLINE, SafetyContactRemoveInput, SafetyContactRemoveOutput),
  'safety_contact.save': command(ONLINE, SafetyContactSaveInput, SafetyContactOutput),
  'subscription.request_card': command(FRESH, SubscriptionRequestCardInput, SubscriptionCardOutput),
  'task.complete': command(ANYTIME, TaskCompleteInput, TaskCompleteOutput),
  'task.create': command(ANYTIME, TaskCreateInput, TaskCreateOutput),
  'task.delete': command(ANYTIME, TaskDeleteInput, TaskDeleteOutput),
  'task.reopen': command(ANYTIME, TaskReopenInput, TaskReopenOutput),
  'task.update': command(ANYTIME, TaskUpdateInput, TaskUpdateOutput),
  // A lesson from correcting the AI, added to what it knows from its Home card or from feedback on a reply. Never
  // queued: it can go against what the AI knows, and whether the old words are still there is the server's to say at
  // the moment it's pressed.
  'teammate_lesson.apply': command(ONLINE, TeammateLessonApplyInput, TeammateLessonApplyOutput),
  // Not now, or Keep what's there, on a rule the AI suggested from feedback: decided on HandsFreeOS, as saving it is.
  'teammate_lesson.dismiss': command(
    ONLINE,
    TeammateLessonDismissInput,
    TeammateLessonDismissOutput,
  ),
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
