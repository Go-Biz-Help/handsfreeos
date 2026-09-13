'use client';
import {
  Archive,
  ArchiveRestore,
  Building2,
  CalendarPlus,
  ClipboardList,
  KanbanSquare,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AppointmentDialog } from '@/components/calendar/appointment-dialog';
import { AppointmentSheet } from '@/components/calendar/appointment-sheet';
import { AppointmentRow, UpcomingAppointments } from '@/components/calendar/upcoming-card';
import { FileGrid } from '@/components/files/file-grid';
import { UploadZone } from '@/components/files/upload-zone';
import { TaskList } from '@/components/tasks/task-list';
import { LogActivitySheet, type LoggableKind } from '@/components/timeline/log-activity-sheet';
import { Timeline } from '@/components/timeline/timeline';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  Appointment,
  CompanyDetail,
  CompanyGet,
  FileItem,
  LeadCard,
  PersonDetail,
  Pipeline,
  Role,
  Tag,
  Task,
  TimelineList,
} from '@/lib/api/types';
import { addressLine, daysLabel, formatDate, formatMoney, monthYear, telHref } from '@/lib/format';
import { useCalls } from '@/lib/calls/call-provider';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { ConversationsCard } from '@/components/inbox/conversations-card';
import { MessageSheet } from '@/components/inbox/message-sheet';
import { ArchiveDialog } from './archive-dialog';
import { NextActionChip, StageBadge } from './chips';
import { CompanyDialog } from './company-dialog';
import { LeadDialog } from './lead-dialog';
import { NextActionDialog } from './next-action-dialog';
import { PersonDialog } from './person-dialog';
import { TagPicker } from './tag-picker';

type Tab = 'timeline' | 'appointments' | 'leads' | 'tasks' | 'files' | 'details';

export interface RecordPageProps {
  workspaceId: string;
  myUserId: string;
  role: Role;
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
}

/** The Customer 360 for a person or a company. */
export function RecordPage(props: RecordPageProps) {
  const { workspaceId, myUserId, role, person, company, tags, members, pipelines } = props;
  const router = useRouter();
  const kind = person ? 'person' : 'company';
  const recordId = (person?.id ?? company?.id)!;
  const name = person ? person.fullName : company!.name;
  const archived = !!(person?.archivedAt ?? company?.archivedAt);
  const canModerate = role === 'owner' || role === 'admin';
  const address = addressLine(person ? person.address : company!.address);
  const phoneE164 = person ? person.phoneE164 : company!.phoneE164;
  const phone = person ? person.phone : company!.phone;
  const email = person ? person.email : company!.email;
  const currentTags = (person ?? company)!.tags;
  const openLeads = props.leads.filter((l) => l.status === 'open' && !l.archivedAt);
  const openTasks = props.tasks.filter((t) => !t.doneAt);
  const lead = openLeads[0] ?? null;
  const relation = person ? { personId: person.id } : { companyId: company!.id };

  const [tab, setTab] = useState<Tab>('timeline');
  const [log, setLog] = useState<LoggableKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [newLead, setNewLead] = useState(false);
  const [nextAction, setNextAction] = useState<LeadCard | null>(null);
  const [addPerson, setAddPerson] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetChannel, setSheetChannel] = useState<'sms' | 'email'>('sms');
  const [booking, setBooking] = useState(false);
  const [openAppt, setOpenAppt] = useState<string | null>(null);
  const upcoming = props.upcoming ?? [];
  const recent = props.recent ?? [];
  const people = members.map((m) => ({ userId: m.id, fullName: m.fullName }));
  const openSheet = (channel: 'sms' | 'email') => {
    setSheetChannel(channel);
    setSheetOpen(true);
  };
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
  ]);

  async function setTags(ids: string[]) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/record.set_tags', {
          body: { workspaceId, recordType: kind, recordId, tagIds: ids },
        }),
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
          Customers
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
                <Badge variant="gray">Archived</Badge>
              ) : (
                <Badge variant="gray">
                  Customer since {monthYear((person ?? company)!.createdAt)}
                </Badge>
              )}
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
              {!phone && !email && !address ? (
                <span className="text-text-3">No contact details yet.</span>
              ) : null}
            </div>
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
                  Edit details
                </DropdownMenuItem>
                {canModerate ? (
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
            This {kind} is archived: hidden from lists and searches, history kept.
            {canModerate ? ' Restore from the menu to use it again.' : ''}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {person && (phoneE164 || person.email) ? (
              <>
                {phoneE164 && calls.available ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      calls.openDialer({
                        name: person.fullName,
                        phone: phoneE164,
                        personId: person.id,
                      })
                    }
                    data-testid="action-call-customer"
                  >
                    <Phone className="h-4 w-4" strokeWidth={1.5} />
                    Call
                  </Button>
                ) : null}
                {phoneE164 ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openSheet('sms')}
                    data-testid="action-text"
                  >
                    <MessageCircle className="h-4 w-4" strokeWidth={1.5} />
                    Text
                  </Button>
                ) : null}
                {person.email ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openSheet('email')}
                    data-testid="action-email"
                  >
                    <Mail className="h-4 w-4" strokeWidth={1.5} />
                    Email
                  </Button>
                ) : null}
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
          </div>
        )}
      </Card>

      {lead && !lead.nextAction ? (
        <div className="mb-4 sm:hidden">
          <NextActionChip text={null} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[3fr_2fr]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="mb-4">
            <TabsTrigger value="timeline" data-testid="tab-timeline">
              Timeline
            </TabsTrigger>
            {person && props.timeZone ? (
              <TabsTrigger value="appointments" data-testid="tab-appointments">
                Appointments · {upcoming.length}
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="leads" data-testid="tab-leads">
              Leads · {props.leads.length}
            </TabsTrigger>
            <TabsTrigger value="tasks" data-testid="tab-tasks">
              Tasks · {openTasks.length}
            </TabsTrigger>
            <TabsTrigger value="files" data-testid="tab-files">
              Files · {props.files.length}
            </TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">
              Details
            </TabsTrigger>
          </TabsList>
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
                  title="No leads yet"
                  actions={
                    archived ? undefined : (
                      <Button size="sm" onClick={() => setNewLead(true)}>
                        <Plus className="h-4 w-4" strokeWidth={1.75} />
                        New lead
                      </Button>
                    )
                  }
                >
                  A lead is a job you might win. It moves across the pipeline.
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
                          {formatMoney(l.valueCents)} · {l.assignee?.fullName ?? 'Unassigned'} ·
                          created {formatDate(l.createdAt)}
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
                emptyHint="Reminders for the team about this customer."
              />
            </Card>
          </TabsContent>
          <TabsContent value="files">
            <div className="flex flex-col gap-3.5">
              {archived ? null : (
                <UploadZone workspaceId={workspaceId} recordType={kind} recordId={recordId} />
              )}
              <FileGrid workspaceId={workspaceId} files={props.files} canDelete={canModerate} />
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
                <dt className="text-text-2">Phone</dt>
                <dd className="font-medium">{phone ?? '—'}</dd>
                <dt className="text-text-2">Email</dt>
                <dd className="break-all font-medium">{email ?? '—'}</dd>
                {company ? (
                  <>
                    <dt className="text-text-2">Website</dt>
                    <dd className="break-all font-medium">{company.website ?? '—'}</dd>
                  </>
                ) : null}
                <dt className="text-text-2">Address</dt>
                <dd className="font-medium">{address || '—'}</dd>
                {person ? (
                  <>
                    <dt className="text-text-2">Company</dt>
                    <dd className="font-medium">{person.company?.name ?? '—'}</dd>
                  </>
                ) : null}
                <dt className="text-text-2">Owner</dt>
                <dd className="font-medium">{(person ?? company)!.owner?.fullName ?? '—'}</dd>
                <dt className="text-text-2">Source</dt>
                <dd className="font-medium">{(person ?? company)!.source ?? '—'}</dd>
                <dt className="text-text-2">Created</dt>
                <dd className="font-medium">{formatDate((person ?? company)!.createdAt)}</dd>
                <dt className="text-text-2">Notes</dt>
                <dd className="whitespace-pre-wrap">{(person ?? company)!.notes ?? '—'}</dd>
              </dl>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex flex-col gap-4">
          {person && props.timeZone ? (
            <UpcomingAppointments
              timeZone={props.timeZone}
              items={upcoming.slice(0, 5)}
              onBook={archived ? undefined : () => setBooking(true)}
              onOpen={setOpenAppt}
            />
          ) : null}
          {person ? (
            <ConversationsCard workspaceId={workspaceId} person={person} onOpen={openSheet} />
          ) : null}
          <Card className="p-4 md:p-5" data-testid="open-lead-card">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">{lead ? 'Open lead' : 'Leads'}</h3>
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
                    {daysLabel(lead.stageEnteredAt)} in stage
                  </span>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span className="text-text-2">Value</span>
                  <span className="font-medium">{formatMoney(lead.valueCents)}</span>
                </div>
                <div className="mt-1.5 flex justify-between text-[13px]">
                  <span className="text-text-2">Assigned to</span>
                  <span className="font-medium">{lead.assignee?.fullName ?? 'Unassigned'}</span>
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
                No open leads.{' '}
                {archived ? null : (
                  <button
                    type="button"
                    onClick={() => setNewLead(true)}
                    className="font-medium text-accent-text hover:underline"
                  >
                    Start one
                  </button>
                )}
              </div>
            )}
          </Card>

          <Card className="p-4 md:p-5">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">
                {person ? 'Relationships' : `People · ${props.companyPeople?.length ?? 0}`}
              </h3>
              {company && !archived ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAddPerson(true)}
                  data-testid="company-add-person"
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  Add person
                </Button>
              ) : null}
            </div>
            {person ? (
              person.company ? (
                <Link
                  href={`/app/w/${workspaceId}/customers/companies/${person.company.id}`}
                  className="flex items-center gap-2.5 text-[13px] hover:underline"
                >
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-card-3 text-text">
                    <Building2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </span>
                  {person.company.name}
                </Link>
              ) : (
                <div className="text-[13px] text-text-2">Not linked to a company.</div>
              )
            ) : (props.companyPeople?.length ?? 0) === 0 ? (
              <div className="text-[13px] text-text-2">Nobody linked yet.</div>
            ) : (
              <ul className="flex flex-col gap-2">
                {props.companyPeople!.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/app/w/${workspaceId}/customers/people/${p.id}`}
                      className="flex items-center gap-2.5 text-[13px] hover:underline"
                    >
                      <Avatar name={p.fullName} seed={p.id} size="sm" />
                      <span className="truncate">
                        {p.fullName}
                        {p.archived ? ' (archived)' : ''}
                      </span>
                      <span className="truncate text-text-3">{p.phone ?? p.email ?? ''}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2.5 text-xs text-text-3">
              Properties and equipment arrive with jobs in a later milestone.
            </div>
          </Card>
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
