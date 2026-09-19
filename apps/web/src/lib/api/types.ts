import type { paths } from '@hfos/api-client';

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type Me = Ok<'/v1/queries/account.me'>;
// Milestone 10: a person's own account (Settings → Account, Delete my account)
export type AccountDeletionCheck = Ok<'/v1/queries/account.deletion_check'>;
export type PushDeviceList = Ok<'/v1/queries/push_device.list'>;
export type CellPhone = NonNullable<Ok<'/v1/queries/user_phone.get'>['phone']>;
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

// Milestone 2: CRM
export type PersonList = Ok<'/v1/queries/person.list'>;
export type PersonSummary = PersonList['items'][number];
export type PersonGet = Ok<'/v1/queries/person.get'>;
export type PersonDetail = PersonGet['person'];
export type CompanyList = Ok<'/v1/queries/company.list'>;
export type CompanySummary = CompanyList['items'][number];
export type CompanyGet = Ok<'/v1/queries/company.get'>;
export type CompanyDetail = CompanyGet['company'];
export type TagList = Ok<'/v1/queries/tag.list'>;
export type Tag = TagList['tags'][number];
export type TimelineList = Ok<'/v1/queries/timeline.list'>;
export type TimelineEntry = TimelineList['items'][number];
export type TaskList = Ok<'/v1/queries/task.list'>;
export type Task = TaskList['items'][number];
export type FileList = Ok<'/v1/queries/file.list'>;
export type FileItem = FileList['files'][number];
export type LeadList = Ok<'/v1/queries/lead.list'>;
export type LeadCard = LeadList['items'][number];
export type LeadGet = Ok<'/v1/queries/lead.get'>;
export type LeadBoard = Ok<'/v1/queries/lead.board'>;
export type PipelineList = Ok<'/v1/queries/pipeline.list'>;
export type Pipeline = PipelineList['pipelines'][number];
export type Stage = Pipeline['stages'][number];
export type CrmSummary = Ok<'/v1/queries/crm.summary'>;
export type ImportGet = Ok<'/v1/queries/import.get'>;
export type ImportList = Ok<'/v1/queries/import.list'>;
export type FindMatches = Ok<'/v1/queries/crm.find_matches'>;
export type Match = FindMatches['matches'][number];
export type RecordType = 'person' | 'company' | 'lead';

// Milestone 3: texting and the inbox
export type InboxList = Ok<'/v1/queries/inbox.list'>;
export type CallLogItem = Ok<'/v1/queries/call.log'>['items'][number];
export type ConversationSummary = InboxList['items'][number];
export type InboxSummary = Ok<'/v1/queries/inbox.summary'>;
export type ConversationGet = Ok<'/v1/queries/conversation.get'>;
export type ConversationThread = Ok<'/v1/queries/conversation.thread'>;
export type ThreadItem = ConversationThread['items'][number];
export type PhoneSetupStatus = Ok<'/v1/queries/phone.setup_status'>;
export type PhoneNumberInfo = NonNullable<PhoneSetupStatus['number']>;
export type RegistrationSubmitBody = NonNullable<
  paths['/v1/commands/registration.submit']['post']['requestBody']
>['content']['application/json'];
export type RegistrationInfo = PhoneSetupStatus['registrations'][number];
export type InboxBox = 'mine' | 'unassigned' | 'all';
export type ConversationStatus = 'open' | 'snoozed' | 'closed';

// Milestone 3: email
export type EmailSetupStatus = Ok<'/v1/queries/email.setup_status'>;
export type EmailAddressInfo = EmailSetupStatus['addresses'][number];
export type EmailDomainInfo = EmailSetupStatus['domains'][number];
export type MailboxInfo = EmailSetupStatus['mailboxes'][number];
export type EmailSuppressionList = Ok<'/v1/queries/email_suppression.list'>;
export type EmailSuppression = EmailSuppressionList['items'][number];
export type EmailUnmatchedList = Ok<'/v1/queries/email.unmatched_list'>;
export type EmailUnmatched = EmailUnmatchedList['items'][number];
export type EmailComposeOptions = Ok<'/v1/queries/email.compose_options'>;

// Milestone 4: the Assistant
export type AssistantThreadList = Ok<'/v1/queries/assistant_thread.list'>;
export type AssistantThreadSummary = AssistantThreadList['items'][number];
export type AssistantThreadGet = Ok<'/v1/queries/assistant_thread.get'>;
export type AssistantSavedMessage = AssistantThreadGet['messages'][number];
export type AssistantToolCall = AssistantThreadGet['toolCalls'][number];
export type AssistantToolStatus = AssistantToolCall['status'];

// Milestone 5: the calendar
type Body<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export type CalendarList = Ok<'/v1/queries/calendar.list'>;
export type CalendarSummary = CalendarList['items'][number];
export type CalendarGet = Ok<'/v1/queries/calendar.get'>;
export type CalendarDetail = CalendarGet['calendar'];
export type CalendarRevision = CalendarGet['revisions'][number];
export type CalendarIssueOut = CalendarDetail['issues'][number];
export type CalendarSaveOut = Ok<'/v1/commands/calendar.save'>;
export type CalendarSaveBody = Body<'/v1/commands/calendar.save'>;
export type CalendarStatus = CalendarSummary['status'];
export type AppointmentList = Ok<'/v1/queries/appointment.list'>;
export type Appointment = AppointmentList['items'][number];
export type AppointmentGet = Ok<'/v1/queries/appointment.get'>;
export type AppointmentDetail = AppointmentGet['appointment'];
export type AppointmentCreateBody = Body<'/v1/commands/appointment.create'>;
export type AppointmentLocationIn = NonNullable<AppointmentCreateBody['location']>;
export type AppointmentWarning = Ok<'/v1/commands/appointment.create'>['warnings'][number];
export type ScheduleTeam = Ok<'/v1/queries/schedule.team'>;
export type TeamSchedule = ScheduleTeam['people'][number];
export type TimeOffSpan = TeamSchedule['timeOff'][number];
export type CalendarConnection = Ok<'/v1/queries/calendar_connection.list'>['items'][number];
export type WeeklyHoursIn = Body<'/v1/commands/schedule.set'>['weekly'];
export type ServiceList = Ok<'/v1/queries/service.list'>;
export type ServiceItem = ServiceList['items'][number];
export type ResourceList = Ok<'/v1/queries/resource.list'>;
export type ResourceItem = ResourceList['items'][number];
export type ResourceKind = ResourceItem['kind'];
export type TerritoryList = Ok<'/v1/queries/territory.list'>;
export type TerritoryItem = TerritoryList['items'][number];
export type BookingSite = NonNullable<Ok<'/v1/queries/booking_site.get'>['site']>;
export type SlotOut = Ok<'/v1/queries/calendar.availability'>['slots'][number];

// Milestone 6: workflows
export type WorkflowList = Ok<'/v1/queries/workflow.list'>;
export type WorkflowSummary = WorkflowList['items'][number];
export type WorkflowStatus = WorkflowSummary['status'];
export type WorkflowGet = Ok<'/v1/queries/workflow.get'>;
export type WorkflowDetail = WorkflowGet['workflow'];
export type WorkflowVersion = WorkflowGet['versions'][number];
export type WorkflowVersionGet = Ok<'/v1/queries/workflow.version_get'>;
export type WorkflowCatalogsOut = Ok<'/v1/queries/workflow.catalogs'>['catalogs'];
export type WorkflowSaveDraftBody = Body<'/v1/commands/workflow.save_draft'>;
export type WorkflowCreateBody = Body<'/v1/commands/workflow.create'>;
export type WorkflowRunList = Ok<'/v1/queries/workflow.run_list'>;
export type WorkflowRunSummary = WorkflowRunList['items'][number];
export type WorkflowRunStatus = WorkflowRunSummary['status'];
export type WorkflowRunListBody = Body<'/v1/queries/workflow.run_list'>;
export type WorkflowRunGet = Ok<'/v1/queries/workflow.run_get'>;
export type WorkflowRunDetail = WorkflowRunGet['run'];
export type WorkflowRunStep = WorkflowRunGet['steps'][number];
export type WorkflowApproval = WorkflowRunGet['approvals'][number];
export type WorkflowStats = Ok<'/v1/queries/workflow.stats'>;
export type WorkflowTestBody = Body<'/v1/commands/workflow.test'>;
export type WorkflowProposal = Ok<'/v1/queries/workflow.proposal_get'>['proposal'];

// Milestone 6: the knowledge base
export type KnowledgeProfileGet = Ok<'/v1/queries/knowledge.profile'>;
export type KnowledgeProfileValue = KnowledgeProfileGet['profile'];
export type KnowledgeItemList = Ok<'/v1/queries/knowledge_item.list'>;
export type KnowledgeItem = KnowledgeItemList['items'][number];
export type KnowledgeItemDetail = Ok<'/v1/queries/knowledge_item.get'>['item'];
export type KnowledgeItemKind = KnowledgeItem['kind'];
export type KnowledgeItemStatus = KnowledgeItem['status'];
export type KnowledgeItemSource = KnowledgeItem['source'];
export type KnowledgeMatch = Ok<'/v1/queries/knowledge.search'>['matches'][number];
export type KnowledgeScanGet = Ok<'/v1/queries/knowledge_scan.get'>;
export type KnowledgeScan = NonNullable<KnowledgeScanGet['scan']>;
export type KnowledgeSuggestionList = Ok<'/v1/queries/knowledge_suggestion.list'>;
export type KnowledgeSuggestion = KnowledgeSuggestionList['items'][number];
export type KnowledgeItemListBody = Body<'/v1/queries/knowledge_item.list'>;

// Milestone 6: the agency area (templates and knowledge packs)
export type WorkflowTemplateList = Ok<'/v1/queries/workflow_template.list'>;
export type WorkflowTemplateSummary = WorkflowTemplateList['items'][number];
export type WorkflowTemplateGet = Ok<'/v1/queries/workflow_template.get'>;
export type WorkflowTemplateDetail = WorkflowTemplateGet['template'];
export type WorkflowTemplateInstall = WorkflowTemplateGet['installs'][number];
export type WorkflowTemplateVersion = WorkflowTemplateGet['versions'][number];
export type WorkflowTemplateSaveDraftBody = Body<'/v1/commands/workflow_template.save_draft'>;
export type KnowledgePackList = Ok<'/v1/queries/knowledge_pack.list'>;
export type KnowledgePack = KnowledgePackList['items'][number];
export type KnowledgePackItem = KnowledgePack['items'][number];

// Milestone 7: the AI teammate
export type AiTeammateGet = Ok<'/v1/queries/ai_teammate.get'>;
export type AiTeammateActivity = Ok<'/v1/queries/ai_teammate.activity'>;
export type AiTeammateSaveOut = Ok<'/v1/commands/ai_teammate.save_config'>;
export type AiTeammateSaveBody = Body<'/v1/commands/ai_teammate.save_config'>;

// Milestone 7: website chat
export type ChatWidgetList = Ok<'/v1/queries/chat_widget.list'>;
export type ChatWidget = ChatWidgetList['items'][number];
export type ChatWidgetUpdateBody = Body<'/v1/commands/chat_widget.update'>;

// Milestone 8: the Action Center outside Home (Settings, the lead and inbox banners) and confirming bookings
export type AttentionForRecord = Ok<'/v1/queries/attention.for_record'>;
export type AttentionRecordItem = AttentionForRecord['items'][number];
export type AttentionSettingsSaveBody = Body<'/v1/commands/attention.save_settings'>;
export type AttentionSettingsSaved = Ok<'/v1/commands/attention.save_settings'>;
export type AttendeeConfirmOut = Ok<'/v1/commands/attendee.confirm'>;

// Milestone 8: Home as the Action Center
export type AttentionList = Ok<'/v1/queries/attention.list'>;
export type AttentionItem = AttentionList['items'][number];
export type AttentionChipOut = AttentionItem['reasons'][number];
export type AttentionScheduled = AttentionList['scheduled'][number];
export type AttentionScope = AttentionList['scope'];
export type AttentionSummary = Ok<'/v1/queries/attention.summary'>;
export type AttentionPreview = Ok<'/v1/queries/attention.preview_handle'>;
export type AttentionAutoPlan = NonNullable<AttentionPreview['auto']>;
export type AttentionAskOption = AttentionPreview['options'][number];
export type AttentionLetHandleBody = Body<'/v1/commands/attention.let_handle'>;
export type AttentionLetHandleOut = Ok<'/v1/commands/attention.let_handle'>;
export type AttentionAssignOut = Ok<'/v1/commands/attention.assign'>;

// Milestone 9: the Money section, the documents and the catalogue
export type MoneySummaryOut = Ok<'/v1/queries/money.summary'>;
export type MoneySettingsOut = Ok<'/v1/queries/money.settings'>;
export type EstimateListOut = Ok<'/v1/queries/estimate.list'>;
export type EstimateSummary = EstimateListOut['estimates'][number];
export type EstimateGetOut = Ok<'/v1/queries/estimate.get'>;
export type EstimateDetail = EstimateGetOut['estimate'];
export type InvoiceListOut = Ok<'/v1/queries/invoice.list'>;
export type InvoiceSummary = InvoiceListOut['invoices'][number];
export type InvoiceGetOut = Ok<'/v1/queries/invoice.get'>;
export type InvoiceDetail = InvoiceGetOut['invoice'];
export type MoneyTotalsRow = InvoiceSummary['totals'];
export type MoneyLineRow = InvoiceDetail['lines'][number];
export type PaymentRow = InvoiceGetOut['payments'][number];
export type RefundRow = InvoiceGetOut['refunds'][number];
export type PaymentListOut = Ok<'/v1/queries/payment.list'>;
export type PaymentListRow = PaymentListOut['payments'][number];
export type ProductListOut = Ok<'/v1/queries/product.list'>;
export type ProductRow = ProductListOut['products'][number];
export type PlanListOut = Ok<'/v1/queries/plan.list'>;
export type PlanRow = PlanListOut['plans'][number];
export type SubscriptionListOut = Ok<'/v1/queries/subscription.list'>;
export type SubscriptionRow = SubscriptionListOut['subscriptions'][number];
export type PaymentConnectionListOut = Ok<'/v1/queries/payment_connection.list'>;
export type PaymentConnectionRow = PaymentConnectionListOut['connections'][number];
export type MoneyForRecordOut = Ok<'/v1/queries/money.for_record'>;
export type EstimateListBody = Body<'/v1/queries/estimate.list'>;
export type InvoiceListBody = Body<'/v1/queries/invoice.list'>;
export type PaymentListBody = Body<'/v1/queries/payment.list'>;
export type SubscriptionListBody = Body<'/v1/queries/subscription.list'>;
export type EstimateUpdateBody = Body<'/v1/commands/estimate.update'>;
export type InvoiceUpdateBody = Body<'/v1/commands/invoice.update'>;
export type MoneyLineBody = NonNullable<EstimateUpdateBody['lines']>[number];
export type MoneyTermsBody = NonNullable<EstimateUpdateBody['discount']>;
export type EstimateConvertOut = Ok<'/v1/commands/estimate.convert'>;

// Milestone 15: forms, surveys and quizzes
export type FormListOut = Ok<'/v1/queries/form.list'>;
export type FormSummary = FormListOut['items'][number];
export type FormStatus = FormSummary['status'];
export type FormMode = FormSummary['mode'];
export type FormGet = Ok<'/v1/queries/form.get'>;
export type FormIssue = FormGet['issues'][number];
export type FormVersionRow = FormGet['versions'][number];
export type FormCatalogsOut = Ok<'/v1/queries/form.catalogs'>;
export type FormResultsOut = Ok<'/v1/queries/form.results'>;
export type FormQuestionSummary = FormResultsOut['questions'][number];
export type FormResponseListOut = Ok<'/v1/queries/form.response_list'>;
export type FormResponseRow = FormResponseListOut['items'][number];
export type FormResponseGetOut = Ok<'/v1/queries/form.response_get'>;
export type FormSaveDraftBody = Body<'/v1/commands/form.save_draft'>;

export type TemplateList = Ok<'/v1/queries/template.list'>;
export type Template = TemplateList['templates'][number];

export type ReviewListOut = Ok<'/v1/queries/review.list'>;
export type ReviewRow = ReviewListOut['reviews'][number];
export type ReviewConnectionRow = ReviewListOut['connections'][number];
