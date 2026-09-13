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
