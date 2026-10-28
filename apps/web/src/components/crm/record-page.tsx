'use client';
import {
  Archive,
  ArchiveRestore,
  Building2,
  CalendarPlus,
  ChevronDown,
  ClipboardList,
  FilePenLine,
  KanbanSquare,
  Mail,
  MapPin,
  Merge,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, type ComponentType } from 'react';
import { toast } from 'sonner';
import { CallConsentRow } from '@/components/crm/call-consent';
import { BIN_WORDS, can } from '@hfos/core';
import { AddonSlot } from '@/components/addons/slot';
import { PersonFunnelLine } from '@/components/funnels/person-funnel';
import { DeleteDialog } from '@/components/bin/delete-dialog';
import { AppointmentDialog } from '@/components/calendar/appointment-dialog';
import { AppointmentSheet } from '@/components/calendar/appointment-sheet';
import { firstName } from '@/components/calendar/appt';
import { AppointmentRow, UpcomingAppointments } from '@/components/calendar/upcoming-card';
import { FileGrid } from '@/components/files/file-grid';
import { UploadZone } from '@/components/files/upload-zone';
import { StartVideoCallButton } from '@/components/video-call/start-call';
import { TaskList } from '@/components/tasks/task-list';
import { LogActivitySheet, type LoggableKind } from '@/components/timeline/log-activity-sheet';
import { Timeline } from '@/components/timeline/timeline';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api/client';
import { saveTagChanges } from '@/lib/api/edits';
import type {
  Appointment,
  CompanyDetail,
  CompanyGet,
  CustomField,
  FileItem,
  LeadCard,
  PersonDetail,
  Pipeline,
  Relationship,
  RelationshipType,
  Tag,
  Task,
  TimelineList,
} from '@/lib/api/types';
import { addressLine, daysLabel, formatDate, formatMoney, telHref } from '@/lib/format';
import {
  archivedNotice,
  contactLabelWords,
  customerSince,
  formatPhone,
  mergedWords,
  recordTabLabel,
  RECORD_WORDS,
} from '@hfos/core';
import { useCalls } from '@/lib/calls/call-provider';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { useRecordTab } from '@/lib/use-record-tab';
import { ConversationsCard } from '@/components/inbox/conversations-card';
import { PartnerCard } from '@/components/partners/partner-card';
import { AttributionCard } from './attribution-card';
import { OwesBadge, RecordMoneyTab, useRecordMoney } from './record-money';
import { MessageSheet } from '@/components/inbox/message-sheet';
import {
  AddToWorkflowButton,
  ContactWorkflowsCard,
} from '@/components/workflows/contact-workflows';
import { RelationshipsCard } from '@/components/relationships/relationships-card';
import { ArchiveDialog } from './archive-dialog';
import { MergeDialog } from './merge-dialog';
import { AssignedCard } from './assigned-card';
import { CustomFieldsSection } from './custom-fields';
import { MaintenanceCard } from './maintenance-card';
import { NextActionChip, StageBadge } from './chips';
import { CompanyDialog } from './company-dialog';
import { LeadDialog } from './lead-dialog';
import { NextActionDialog } from './next-action-dialog';
import { PersonDialog } from './person-dialog';
import { TagPicker } from './tag-picker';

type Tab = 'timeline' | 'appointments' | 'money' | 'leads' | 'tasks' | 'files' | 'details';
const TABS: readonly Tab[] = [
  'timeline',
  'appointments',
  'money',
  'leads',
  'tasks',
  'files',
  'details',
];

export interface RecordPageProps {
  workspaceId: string;
  myUserId: string;
  /** What the business lets them do (0106), as workspace.get gives it. */
  permissions: readonly string[];
  person?: PersonDetail;
  company?: CompanyDetail;
  companyPeople?: CompanyGet['people'];
  timeline: TimelineList;
  tasks: Task[];
  files: FileItem[];
  leads: LeadCard[];
  tags: Tag[];
  members: { id: string; fullName: string }[];
  pipelines: Pipeline[];
  /** The workspace's time zone: appointments and the timeline's appointment times read in it. */
  timeZone?: string;
  /** A person's appointments: coming up (the next 62 days) and recent (the last 62 days, newest first). */
  upcoming?: Appointment[];
  recent?: Appointment[];
  /** Everything this customer or company is related to (0101), and the relationship types there are. */
  relationships: Relationship[];
  relationshipTypes: RelationshipType[];
  /** The fields this business invented for customers or companies. */
  fields: CustomField[];
}

/** The Customer 360 for a person or a company. */
export function RecordPage(props: RecordPageProps) {
  const { workspaceId, myUserId, permissions, person, company, tags, members, pipelines } = props;
  const router = useRouter();
  const kind = person ? 'person' : 'company';
  const recordId = (person?.id ?? company?.id)!;
  const name = person ? person.fullName : company!.name;
  const archived = !!(person?.archivedAt ?? company?.archivedAt);
  // Archive and restore it, and take away anyone's tasks and notes on it (records.archive).
  const canModerate = can(permissions, 'records.archive');
  // Delete a customer or a company for good, through the 30-day Deleted bin: owners, unless one gives it out
  // (records.delete).
  const canDelete = can(permissions, 'records.delete');
  const address = addressLine(person ? person.address : company!.address);
  const phoneE164 = person ? person.phoneE164 : company!.phoneE164;
  const phone = person ? person.phone : company!.phone;
  const email = person ? person.email : company!.email;
  const currentTags = (person ?? company)!.tags;
  const record = (person ?? company)!;
  // Every number and email on file (0103): the main one first, then the others with their labels.
  const numbers = [
    ...(phoneE164 ? [{ phone: phoneE164, label: 'Main' }] : []),
    ...record.otherPhones.map((p) => ({
      phone: p.phoneE164,
      label: contactLabelWords(p.label, 'phone'),
    })),
  ];
  const emails = [
    ...(email ? [{ email, label: 'Main' }] : []),
    ...record.otherEmails.map((e) => ({
      email: e.email,
      label: contactLabelWords(e.label, 'email'),
    })),
  ];
  const others =
    record.otherPhones.length + record.otherEmails.length + record.otherAddresses.length;
  const openLeads = props.leads.filter((l) => l.status === 'open' && !l.archivedAt);
  const openTasks = props.tasks.filter((t) => !t.doneAt);
  const lead = openLeads[0] ?? null;
  const relation = person ? { personId: person.id } : { companyId: company!.id };

  /**
   * This customer's money, for the header's "Owes $X" and the Money tab. `money.for_record` already holds a
   * member to the jobs they are on, so a member who is on none of this customer's simply finds nothing here.
   * Whoever the business lets bill (0106) may write them an estimate or an invoice.
   */
  const recordMoney = useRecordMoney(workspaceId, 'person', person?.id ?? null, { payments: true });
  const canBill = can(permissions, 'money.bill');
  // `?tab=money` so the inbox's "See their money" lands on the tab it names; a search result's note or file opens
  // its own tab, on this page already open too.
  const query = useSearchParams();
  const [tab, setTab] = useRecordTab(TABS, 'timeline');
  const [log, setLog] = useState<LoggableKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  // A duplicate merged into another record stays archived; that record has everything of theirs now.
  const mergedInto = person?.mergedInto ?? null;
  const [newLead, setNewLead] = useState(false);
  const [nextAction, setNextAction] = useState<LeadCard | null>(null);
  const [addPerson, setAddPerson] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetChannel, setSheetChannel] = useState<'sms' | 'email'>('sms');
  /** Another of their numbers or emails the sheet is opened on; null for the main one. */
  const [sheetTo, setSheetTo] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [openAppt, setOpenAppt] = useState<string | null>(null);
  const upcoming = props.upcoming ?? [];
  const recent = props.recent ?? [];
  const people = members.map((m) => ({ userId: m.id, fullName: m.fullName }));
  const openSheet = (channel: 'sms' | 'email', to: string | null = null) => {
    setSheetChannel(channel);
    setSheetTo(to);
    setSheetOpen(true);
  };
  /**
   * Where a search result lands: Text on a contact's row opens the text sheet (`?compose=sms`), and Compare and merge
   * on the duplicate banner opens Merge with the other record chosen (`?merge=<id>`), on this page already open too.
   * Once each, then taken off the address, so a reload doesn't open them again.
   */
  const [mergeWith, setMergeWith] = useState<string | null>(null);
  const landed = useRef('');
  useEffect(() => {
    if (!person) return;
    const compose = query.get('compose');
    const merge = query.get('merge');
    // What the address asked for last, so each ask opens once while the page refreshes.
    const asked = `${compose ?? ''}:${merge ?? ''}`;
    if (landed.current === asked) return;
    landed.current = asked;
    if (!compose && !merge) return;
    if (compose === 'sms') openSheet('sms');
    else if (merge && canModerate && !archived) {
      setMergeWith(merge);
      setMerging(true);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('compose');
    url.searchParams.delete('merge');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [query, person, canModerate, archived]);
  const calls = useCalls();
  useLiveRefresh([
    'person',
    'company',
    'lead',
    'task',
    'activity',
    'tag',
    'message',
    'conversation',
    'call',
    'appointment',
    'relationship',
    'custom_record',
  ]);

  /** One tag on or off at a time, so a teammate tagging this customer at the same moment isn't undone. */
  async function setTags(ids: string[]) {
    try {
      await saveTagChanges(
        workspaceId,
        kind,
        recordId,
        currentTags.map((t) => t.id),
        ids,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const leadsForForms = openLeads.map((l) => ({ id: l.id, title: l.title }));

  return (
    <div className="pb-6" data-testid={`record-page-${kind}`}>
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link
          href={`/app/w/${workspaceId}/customers${kind === 'company' ? '?tab=companies' : ''}`}
          className="text-accent-text hover:underline"
        >
          Contacts
        </Link>
        <span className="text-text-3">/</span>
        <span className="truncate text-text-2">{name}</span>
      </div>

      <Card className="mb-5 p-4 md:px-6 md:py-5">
        <div className="flex items-start gap-3 md:gap-4">
          {person ? (
            <Avatar
              name={name}
              seed={person.id}
              size="lg"
              className="h-12 w-12 text-base md:h-14 md:w-14 md:text-lg"
            />
          ) : (
            <span className="inline-flex h-12 w-12 flex-none items-center justify-center rounded-card bg-card-3 text-text md:h-14 md:w-14">
              <Building2 className="h-6 w-6" strokeWidth={1.5} />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1
                className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl"
                data-testid="record-name"
              >
                {name}
              </h1>
              {person?.company ? (
                <Link
                  href={`/app/w/${workspaceId}/customers/companies/${person.company.id}`}
                  className="text-[13px] text-accent-text hover:underline"
                >
                  {person.company.name}
                  {person.company.archived ? ' (archived)' : ''}
                </Link>
              ) : null}
              {archived ? (
                <Badge variant="gray">{RECORD_WORDS.archived}</Badge>
              ) : (
                <Badge variant="gray">{customerSince((person ?? company)!.createdAt)}</Badge>
              )}
              <OwesBadge found={recordMoney} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px]">
              {phone ? (
                <a
                  href={telHref(phoneE164) ?? '#'}
                  className="inline-flex items-center gap-1.5 text-accent-text hover:underline"
                >
                  <Phone className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {phone}
                </a>
              ) : null}
              {email && person && !archived ? (
                // Email from the workspace address (and into the thread), not the viewer's own mail app.
                <button
                  type="button"
                  onClick={() => openSheet('email')}
                  className="inline-flex items-center gap-1.5 text-accent-text hover:underline"
                  data-testid="header-email"
                >
                  <Mail className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {email}
                </button>
              ) : email ? (
                <a
                  href={`mailto:${email}`}
                  className="inline-flex items-center gap-1.5 text-accent-text hover:underline"
                >
                  <Mail className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {email}
                </a>
              ) : null}
              {address ? (
                <span className="inline-flex items-center gap-1.5 text-text-2">
                  <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {address}
                </span>
              ) : null}
              {!phone && !email && !address && others === 0 ? (
                <span className="text-text-3">{RECORD_WORDS.noContact}</span>
              ) : null}
              {others > 0 ? (
                <button
                  type="button"
                  onClick={() => setTab('details')}
                  className="text-text-3 hover:text-text hover:underline"
                  data-testid="header-more-contacts"
                >
                  +{others} more
                </button>
              ) : null}
            </div>
            {person && !archived ? (
              <PersonFunnelLine workspaceId={workspaceId} personId={person.id} />
            ) : null}
            <TagPicker
              workspaceId={workspaceId}
              tags={tags}
              selected={currentTags.map((t) => t.id)}
              onChange={(ids) => void setTags(ids)}
              compact
            />
          </div>
          <div className="flex flex-none flex-col items-end gap-2">
            {lead ? (
              <NextActionChip text={lead.nextAction} className="hidden sm:inline-flex" />
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More actions"
                  data-testid="record-menu"
                >
                  <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setEditing(true)} data-testid="record-edit">
                  <Pencil className="h-4 w-4" strokeWidth={1.5} />
                  {RECORD_WORDS.editDetails}
                </DropdownMenuItem>
                {canModerate && person && !archived ? (
                  <DropdownMenuItem onSelect={() => setMerging(true)} data-testid="record-merge">
                    <Merge className="h-4 w-4" strokeWidth={1.5} />
                    Merge…
                  </DropdownMenuItem>
                ) : null}
                {canModerate && !mergedInto ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      danger={!archived}
                      onSelect={() => setArchiving(true)}
                      data-testid="record-archive"
                    >
                      {archived ? (
                        <ArchiveRestore className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Archive className="h-4 w-4" strokeWidth={1.5} />
                      )}
                      {archived ? `Restore ${kind}` : `Archive ${kind}`}
                    </DropdownMenuItem>
                    {canDelete ? (
                      <DropdownMenuItem
                        danger
                        onSelect={() => setDeleting(true)}
                        data-testid="record-delete"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                        {BIN_WORDS.menu}
                      </DropdownMenuItem>
                    ) : null}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {archived ? (
          <div
            className="mt-4 rounded-menu bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
            data-testid="archived-notice"
          >
            {mergedInto ? (
              <>
                {mergedWords(mergedInto.fullName)}{' '}
                <Link
                  href={`/app/w/${workspaceId}/customers/people/${mergedInto.id}`}
                  className="text-accent-text hover:underline"
                  data-testid="merged-into-link"
                >
                  Open {mergedInto.fullName}
                </Link>
              </>
            ) : (
              archivedNotice(kind, canModerate)
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {person && (numbers.length > 0 || emails.length > 0) ? (
              <>
                {numbers[0] && calls.available ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      calls.openDialer({
                        name: person.fullName,
                        phone: numbers[0]!.phone,
                        personId: person.id,
                        numbers,
                      })
                    }
                    data-testid="action-call-customer"
                  >
                    <Phone className="h-4 w-4" strokeWidth={1.5} />
                    Call
                  </Button>
                ) : null}
                {numbers.length > 1 ? (
                  <ChooseOne
                    label="Text"
                    icon={MessageCircle}
                    testId="action-text"
                    choices={numbers.map((n) => ({
                      key: n.phone,
                      text: `${formatPhone(n.phone) || n.phone} · ${n.label}`,
                      onSelect: () => openSheet('sms', n.phone === phoneE164 ? null : n.phone),
                    }))}
                  />
                ) : numbers[0] ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      openSheet('sms', numbers[0]!.phone === phoneE164 ? null : numbers[0]!.phone)
                    }
                    data-testid="action-text"
                  >
                    <MessageCircle className="h-4 w-4" strokeWidth={1.5} />
                    Text
                  </Button>
                ) : null}
                {emails.length > 1 ? (
                  <ChooseOne
                    label="Email"
                    icon={Mail}
                    testId="action-email"
                    choices={emails.map((e) => ({
                      key: e.email,
                      text: `${e.email} · ${e.label}`,
                      onSelect: () => openSheet('email', e.email === email ? null : e.email),
                    }))}
                  />
                ) : emails[0] ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      openSheet('email', emails[0]!.email === email ? null : emails[0]!.email)
                    }
                    data-testid="action-email"
                  >
                    <Mail className="h-4 w-4" strokeWidth={1.5} />
                    Email
                  </Button>
                ) : null}
                <StartVideoCallButton
                  workspaceId={workspaceId}
                  personId={person.id}
                  phone={phoneE164 ? formatPhone(phoneE164) || phoneE164 : null}
                  email={email ?? null}
                />
                <span aria-hidden className="mx-1 h-5 w-px bg-border" />
              </>
            ) : null}
            {person && props.timeZone ? (
              <Button
                variant="secondary"
                size="sm"
                className="border-[color-mix(in_oklab,var(--accent)_45%,var(--border-strong))] text-accent-text"
                onClick={() => setBooking(true)}
                data-testid="action-book"
              >
                <CalendarPlus className="h-4 w-4" strokeWidth={1.5} />
                Book
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLog('note')}
              data-testid="action-note"
            >
              <Pencil className="h-4 w-4" strokeWidth={1.5} />
              Note
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLog('call')}
              data-testid="action-call"
            >
              <Phone className="h-4 w-4" strokeWidth={1.5} />
              Log call
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTab('tasks')}
              data-testid="action-task-tab"
            >
              <ClipboardList className="h-4 w-4" strokeWidth={1.5} />
              Task
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNewLead(true)}
              data-testid="action-lead"
            >
              <KanbanSquare className="h-4 w-4" strokeWidth={1.5} />
              Lead
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTab('files')}
              data-testid="action-file"
            >
              <Upload className="h-4 w-4" strokeWidth={1.5} />
              File
            </Button>
            {person && can(permissions, 'documents.send') ? (
              <ButtonLink
                variant="secondary"
                size="sm"
                href={`/app/w/${workspaceId}/documents/send?person=${person.id}`}
                data-testid="action-document"
              >
                <FilePenLine className="h-4 w-4" strokeWidth={1.5} />
                Document
              </ButtonLink>
            ) : null}
            {person ? (
              <AddToWorkflowButton
                workspaceId={workspaceId}
                person={{ id: person.id, fullName: person.fullName }}
                timeZone={props.timeZone ?? 'America/Chicago'}
                canManageWorkflows={can(permissions, 'workflows.manage')}
              />
            ) : null}
          </div>
        )}
      </Card>

      {lead && !lead.nextAction ? (
        <div className="mb-4 sm:hidden">
          <NextActionChip text={null} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-w-0">
          <TabsList className="mb-4">
            <TabsTrigger value="timeline" data-testid="tab-timeline">
              Timeline
            </TabsTrigger>
            {person && props.timeZone ? (
              <TabsTrigger value="appointments" data-testid="tab-appointments">
                {recordTabLabel('appointments', upcoming.length)}
              </TabsTrigger>
            ) : null}
            {person ? (
              <TabsTrigger value="money" data-testid="tab-money">
                {recordTabLabel(
                  'money',
                  recordMoney && !recordMoney.empty
                    ? recordMoney.invoices.length + recordMoney.estimates.length
                    : null,
                )}
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="leads" data-testid="tab-leads">
              {recordTabLabel('leads', props.leads.length)}
            </TabsTrigger>
            <TabsTrigger value="tasks" data-testid="tab-tasks">
              {recordTabLabel('tasks', openTasks.length)}
            </TabsTrigger>
            <TabsTrigger value="files" data-testid="tab-files">
              {recordTabLabel('files', props.files.length)}
            </TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">
              {recordTabLabel('details', null)}
            </TabsTrigger>
          </TabsList>
          {person ? (
            <TabsContent value="money">
              <RecordMoneyTab
                workspaceId={workspaceId}
                personId={person.id}
                personName={firstName(person.fullName)}
                personFullName={person.fullName}
                found={recordMoney}
                canBill={canBill}
                timeZone={props.timeZone ?? 'UTC'}
              />
            </TabsContent>
          ) : null}
          <TabsContent value="timeline">
            <Card>
              <Timeline
                workspaceId={workspaceId}
                recordType={kind}
                recordId={recordId}
                initial={props.timeline}
                timeZone={props.timeZone}
                myUserId={myUserId}
                canModerate={canModerate}
                subjectName={person?.fullName}
                members={members}
              />
            </Card>
          </TabsContent>
          {person && props.timeZone ? (
            <TabsContent value="appointments">
              <Card className="px-4 pb-2 pt-3.5 md:px-5" data-testid="record-appointments">
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-[15px] font-semibold">Coming up</h3>
                  {archived ? null : (
                    <Button variant="ghost" size="sm" onClick={() => setBooking(true)}>
                      <CalendarPlus className="h-4 w-4" strokeWidth={1.5} />
                      Book
                    </Button>
                  )}
                </div>
                {upcoming.length ? (
                  upcoming.map((a) => (
                    <AppointmentRow
                      key={a.id}
                      appt={a}
                      timeZone={props.timeZone!}
                      onOpen={setOpenAppt}
                    />
                  ))
                ) : (
                  <p className="border-t border-border py-3 text-[13px] text-text-2">
                    Nothing booked.
                  </p>
                )}
                {recent.length ? (
                  <>
                    <h3 className="mb-1 mt-4 text-[15px] font-semibold">Earlier</h3>
                    {recent.map((a) => (
                      <AppointmentRow
                        key={a.id}
                        appt={a}
                        timeZone={props.timeZone!}
                        onOpen={setOpenAppt}
                      />
                    ))}
                  </>
                ) : null}
              </Card>
            </TabsContent>
          ) : null}
          <TabsContent value="leads">
            <Card className="overflow-hidden">
              {props.leads.length === 0 ? (
                <EmptyState
                  title={RECORD_WORDS.noLeadsTitle}
                  actions={
                    archived ? undefined : (
                      <Button size="sm" onClick={() => setNewLead(true)}>
                        <Plus className="h-4 w-4" strokeWidth={1.75} />
                        New lead
                      </Button>
                    )
                  }
                >
                  {RECORD_WORDS.noLeadsBody}
                </EmptyState>
              ) : (
                <ul className="divide-y divide-border" data-testid="record-leads">
                  {props.leads.map((l) => (
                    <li
                      key={l.id}
                      className="flex items-center gap-3 px-5 py-3 md:px-6"
                      data-testid={`lead-row-${l.id}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <Link
                          href={`/app/w/${workspaceId}/leads/${l.id}`}
                          className="truncate font-medium hover:underline"
                        >
                          {l.title}
                        </Link>
                        <span className="truncate text-xs text-text-3">
                          {formatMoney(l.valueCents)} ·{' '}
                          {l.assignee?.fullName ?? RECORD_WORDS.unassigned} · created{' '}
                          {formatDate(l.createdAt)}
                        </span>
                      </span>
                      <StageBadge name={l.stageName} kind={l.stageKind} />
                      {l.status === 'open' ? (
                        <button
                          type="button"
                          onClick={() => setNextAction(l)}
                          className="hidden sm:block"
                          aria-label="Set next action"
                        >
                          <NextActionChip text={l.nextAction} compact />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </TabsContent>
          <TabsContent value="tasks">
            <Card>
              <TaskList
                workspaceId={workspaceId}
                tasks={props.tasks}
                members={members}
                myUserId={myUserId}
                canModerate={canModerate}
                relation={archived ? undefined : relation}
                leads={leadsForForms}
                emptyHint={RECORD_WORDS.tasksHint}
              />
            </Card>
          </TabsContent>
          <TabsContent value="files">
            <div className="flex flex-col gap-3.5">
              {archived ? null : (
                <UploadZone workspaceId={workspaceId} recordType={kind} recordId={recordId} />
              )}
              <FileGrid
                workspaceId={workspaceId}
                files={props.files}
                canDelete={can(permissions, 'files.delete')}
              />
            </div>
          </TabsContent>
          <TabsContent value="details">
            <Card className="p-5 md:p-6">
              <div className="mb-3.5 flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">Details</h3>
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" strokeWidth={1.5} />
                  Edit
                </Button>
              </div>
              <dl
                className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-[13.5px] md:grid-cols-[130px_1fr]"
                data-testid="record-details"
              >
                <dt className="text-text-2">{RECORD_WORDS.labels.phone}</dt>
                <dd className="font-medium">{phone ?? RECORD_WORDS.none}</dd>
                {record.otherPhones.map((p) => (
                  <Fragment key={`phone-${p.phoneE164}`}>
                    <dt className="text-text-2">{contactLabelWords(p.label, 'phone')}</dt>
                    <dd className="font-medium">
                      <a href={telHref(p.phoneE164) ?? '#'} className="hover:underline">
                        {p.phone}
                      </a>
                    </dd>
                  </Fragment>
                ))}
                <dt className="text-text-2">{RECORD_WORDS.labels.email}</dt>
                <dd className="break-all font-medium">{email ?? RECORD_WORDS.none}</dd>
                {record.otherEmails.map((e) => (
                  <Fragment key={`email-${e.email}`}>
                    <dt className="text-text-2">{contactLabelWords(e.label, 'email')}</dt>
                    <dd className="break-all font-medium">{e.email}</dd>
                  </Fragment>
                ))}
                {company ? (
                  <>
                    <dt className="text-text-2">{RECORD_WORDS.labels.website}</dt>
                    <dd className="break-all font-medium">
                      {company.website ?? RECORD_WORDS.none}
                    </dd>
                  </>
                ) : null}
                <dt className="text-text-2">{RECORD_WORDS.labels.address}</dt>
                <dd className="font-medium">{address || RECORD_WORDS.none}</dd>
                {record.otherAddresses.map((a, i) => (
                  <Fragment key={`address-${i}`}>
                    <dt className="text-text-2">{contactLabelWords(a.label, 'address')}</dt>
                    <dd className="font-medium">{addressLine(a)}</dd>
                  </Fragment>
                ))}
                {person ? (
                  <>
                    <dt className="text-text-2">{RECORD_WORDS.labels.company}</dt>
                    <dd className="font-medium">{person.company?.name ?? RECORD_WORDS.none}</dd>
                  </>
                ) : null}
                <dt className="text-text-2">{RECORD_WORDS.labels.assignedTo}</dt>
                <dd className="font-medium">
                  {[record.owner, ...record.team]
                    .filter((p): p is NonNullable<typeof p> => !!p)
                    .map((p) => p.fullName)
                    .join(', ') || RECORD_WORDS.none}
                </dd>
                {person ? (
                  <>
                    <dt className="text-text-2">Calls from us</dt>
                    <dd className="font-medium">
                      <CallConsentRow
                        workspaceId={workspaceId}
                        personId={person.id}
                        consent={person.callConsent.consent}
                        source={person.callConsent.source}
                        canEdit={!archived && can(permissions, 'inbox.use')}
                      />
                    </dd>
                  </>
                ) : null}
                <dt className="text-text-2">{RECORD_WORDS.labels.source}</dt>
                <dd className="font-medium">{(person ?? company)!.source ?? RECORD_WORDS.none}</dd>
                <dt className="text-text-2">{RECORD_WORDS.labels.created}</dt>
                <dd className="font-medium">{formatDate((person ?? company)!.createdAt)}</dd>
                <dt className="text-text-2">{RECORD_WORDS.labels.notes}</dt>
                <dd className="whitespace-pre-wrap">
                  {(person ?? company)!.notes ?? RECORD_WORDS.none}
                </dd>
              </dl>
              <CustomFieldsSection
                workspaceId={workspaceId}
                recordType={kind}
                recordId={recordId}
                fields={props.fields}
                values={(person ?? company)!.custom}
                canEdit={!archived && can(permissions, 'records.write')}
                manageHref={
                  can(permissions, 'fields.manage')
                    ? `/app/w/${workspaceId}/settings/fields?for=${kind}`
                    : null
                }
              />
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex min-w-0 flex-col gap-4">
          <AssignedCard
            workspaceId={workspaceId}
            recordType={kind}
            recordId={recordId}
            owner={record.owner}
            team={record.team}
            members={members}
            canEdit={!archived && can(permissions, 'records.assign')}
          />
          {person && props.timeZone ? (
            <UpcomingAppointments
              timeZone={props.timeZone}
              items={upcoming.slice(0, 5)}
              onBook={archived ? undefined : () => setBooking(true)}
              onOpen={setOpenAppt}
            />
          ) : null}
          {person ? (
            <MaintenanceCard
              workspaceId={workspaceId}
              personId={person.id}
              canEdit={!archived && can(permissions, 'records.write')}
            />
          ) : null}
          {person ? (
            <ConversationsCard workspaceId={workspaceId} person={person} onOpen={openSheet} />
          ) : null}
          {/* The Facebook and Instagram ads and links that brought them, only when something did. */}
          {person ? <AttributionCard workspaceId={workspaceId} personId={person.id} /> : null}
          {/* Whether they're a partner, and who sent them: only while partners are on, for Manage partners. */}
          {person ? (
            <PartnerCard
              workspaceId={workspaceId}
              personId={person.id}
              name={person.fullName}
              archived={archived}
            />
          ) : null}
          {person ? (
            <ContactWorkflowsCard
              workspaceId={workspaceId}
              person={{ id: person.id, fullName: person.fullName }}
              timeZone={props.timeZone ?? 'America/Chicago'}
            />
          ) : null}
          <Card className="p-4 md:p-5" data-testid="open-lead-card">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">
                {lead ? RECORD_WORDS.openLead : RECORD_WORDS.leads}
              </h3>
              {lead ? (
                <Link
                  href={`/app/w/${workspaceId}/leads/${lead.id}`}
                  className="text-[13px] text-accent-text hover:underline"
                >
                  Open lead
                </Link>
              ) : null}
            </div>
            {lead ? (
              <>
                <div className="font-medium">{lead.title}</div>
                <div className="my-2 flex items-center gap-2">
                  <StageBadge name={lead.stageName} kind={lead.stageKind} />
                  <span className="text-[13px] text-text-2">
                    {daysLabel(lead.stageEnteredAt)} {RECORD_WORDS.inStage}
                  </span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-text-2">{RECORD_WORDS.value}</span>
                  <span className="font-medium">{formatMoney(lead.valueCents)}</span>
                </div>
                <div className="mt-1.5 flex justify-between text-[13px]">
                  <span className="text-text-2">{RECORD_WORDS.assignedTo}</span>
                  <span className="font-medium">
                    {lead.assignee?.fullName ?? RECORD_WORDS.unassigned}
                  </span>
                </div>
                <div className="my-3 h-px bg-border" />
                {lead.nextAction ? (
                  <div className="flex items-start justify-between gap-2 text-[13px]">
                    <span>
                      <strong className="font-semibold">{lead.nextAction}</strong>
                      {lead.nextActionAt ? (
                        <span className="text-text-2">
                          {' '}
                          · {formatDate(lead.nextActionAt, { time: true })}
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => setNextAction(lead)}
                      className="text-accent-text hover:underline"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text">
                    <span className="min-w-0 flex-1">
                      No follow-up scheduled.{' '}
                      <button
                        type="button"
                        onClick={() => setNextAction(lead)}
                        className="font-medium underline"
                        data-testid="set-next-action"
                      >
                        Set a next action
                      </button>
                    </span>
                  </div>
                )}
                {openLeads.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setTab('leads')}
                    className="mt-3 text-[13px] text-accent-text hover:underline"
                  >
                    {openLeads.length - 1} more open
                  </button>
                ) : null}
              </>
            ) : (
              <div className="text-[13px] text-text-2">
                {RECORD_WORDS.noOpenLeads}{' '}
                {archived ? null : (
                  <button
                    type="button"
                    onClick={() => setNewLead(true)}
                    className="font-medium text-accent-text hover:underline"
                  >
                    {RECORD_WORDS.startOne}
                  </button>
                )}
              </div>
            )}
          </Card>

          <RelationshipsCard
            workspaceId={workspaceId}
            record={{ kind, id: recordId, name }}
            relationships={props.relationships}
            types={props.relationshipTypes}
            archived={archived}
            canManage={can(permissions, 'fields.manage')}
            company={person?.company ?? null}
            companyPeople={company ? (props.companyPeople ?? []) : undefined}
            onAddPerson={company ? () => setAddPerson(true) : undefined}
          />
          {/* Panels the add-ons running here put on a customer or a company (0108); none until one does. */}
          {person ? (
            <AddonSlot name="person.panels" workspaceId={workspaceId} personId={person.id} />
          ) : (
            <AddonSlot name="company.panels" workspaceId={workspaceId} companyId={recordId} />
          )}
        </div>
      </div>

      {person && props.timeZone && booking ? (
        <AppointmentDialog
          open
          workspaceId={workspaceId}
          timeZone={props.timeZone}
          people={people}
          myUserId={myUserId}
          prefill={{ person: { id: person.id, fullName: person.fullName }, personId: person.id }}
          lockCustomer
          onOpenChange={(o) => !o && setBooking(false)}
          onBooked={() => {
            setBooking(false);
            router.refresh();
          }}
        />
      ) : null}
      {props.timeZone && openAppt ? (
        <AppointmentSheet
          workspaceId={workspaceId}
          appointmentId={openAppt}
          timeZone={props.timeZone}
          people={people}
          myUserId={myUserId}
          myPermissions={permissions}
          onClose={() => setOpenAppt(null)}
          onChanged={() => router.refresh()}
        />
      ) : null}
      <LogActivitySheet
        workspaceId={workspaceId}
        open={log !== null}
        onOpenChange={(o) => !o && setLog(null)}
        kind={log ?? 'note'}
        recordName={name}
        record={relation}
        leads={leadsForForms}
        onSaved={() => setTab('timeline')}
      />
      {person ? (
        <MessageSheet
          workspaceId={workspaceId}
          person={{
            id: person.id,
            fullName: person.fullName,
            phone: person.phone,
            phoneE164: person.phoneE164,
            email: person.email,
          }}
          channel={sheetChannel}
          to={sheetTo}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          onEditPerson={() => {
            setSheetOpen(false);
            setEditing(true);
          }}
        />
      ) : null}
      {person ? (
        <PersonDialog
          workspaceId={workspaceId}
          tags={tags}
          open={editing}
          onOpenChange={setEditing}
          initial={person}
        />
      ) : (
        <CompanyDialog
          workspaceId={workspaceId}
          tags={tags}
          open={editing}
          onOpenChange={setEditing}
          initial={company}
        />
      )}
      {company ? (
        <PersonDialog
          workspaceId={workspaceId}
          tags={tags}
          open={addPerson}
          onOpenChange={setAddPerson}
          defaultCompanyId={company.id}
          onSaved={() => router.refresh()}
        />
      ) : null}
      {canModerate && person ? (
        <MergeDialog
          workspaceId={workspaceId}
          person={person}
          open={merging}
          onOpenChange={(o) => {
            setMerging(o);
            if (!o) setMergeWith(null);
          }}
          initialOtherId={mergeWith}
        />
      ) : null}
      {canModerate ? (
        <ArchiveDialog
          workspaceId={workspaceId}
          kind={kind}
          recordId={recordId}
          name={name}
          archived={archived}
          open={archiving}
          onOpenChange={setArchiving}
        />
      ) : null}
      {canDelete ? (
        <DeleteDialog
          workspaceId={workspaceId}
          kind={kind}
          ids={[recordId]}
          names={[name]}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() =>
            router.replace(
              `/app/w/${workspaceId}/customers${kind === 'company' ? '?tab=companies' : ''}`,
            )
          }
        />
      ) : null}
      <LeadDialog
        workspaceId={workspaceId}
        open={newLead}
        onOpenChange={setNewLead}
        pipelines={pipelines}
        members={members}
        myUserId={myUserId}
        record={{ ...relation, name }}
        onCreated={() => setTab('leads')}
      />
      {nextAction ? (
        <NextActionDialog
          workspaceId={workspaceId}
          leadId={nextAction.id}
          leadTitle={nextAction.title}
          open
          onOpenChange={(o) => !o && setNextAction(null)}
          current={{ text: nextAction.nextAction, at: nextAction.nextActionAt }}
        />
      ) : null}
    </div>
  );
}

/** A Text or Email button for a customer with more than one number or address: pick which one first. */
function ChooseOne({
  label,
  icon: Icon,
  testId,
  choices,
}: {
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  testId: string;
  choices: readonly { key: string; text: string; onSelect: () => void }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" data-testid={testId}>
          <Icon className="h-4 w-4" strokeWidth={1.5} />
          {label}
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {choices.map((c) => (
          <DropdownMenuItem key={c.key} onSelect={c.onSelect}>
            {c.text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
