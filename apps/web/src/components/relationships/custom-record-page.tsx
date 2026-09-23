'use client';
import {
  can,
  customSummary,
  lowerLabel,
  monthYear,
  RECORD_WORDS,
  recordTabLabel,
} from '@hfos/core';
import {
  Archive,
  ArchiveRestore,
  CalendarPlus,
  ClipboardList,
  MoreHorizontal,
  Pencil,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppointmentDialog } from '@/components/calendar/appointment-dialog';
import { AppointmentSheet } from '@/components/calendar/appointment-sheet';
import { AppointmentRow, UpcomingAppointments } from '@/components/calendar/upcoming-card';
import { CustomFieldsSection } from '@/components/crm/custom-fields';
import { FileGrid } from '@/components/files/file-grid';
import { UploadZone } from '@/components/files/upload-zone';
import { ConversationsCard } from '@/components/inbox/conversations-card';
import { MessageSheet } from '@/components/inbox/message-sheet';
import { TaskList } from '@/components/tasks/task-list';
import { LogActivitySheet, type LoggableKind } from '@/components/timeline/log-activity-sheet';
import { Timeline } from '@/components/timeline/timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  Appointment,
  CustomField,
  CustomRecordDetail,
  FileItem,
  Relationship,
  RelationshipType,
  Task,
  TimelineList,
} from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CustomRecordDialog } from './custom-record-dialog';
import { RecordIcon } from './record-icon';
import { RelationshipsCard } from './relationships-card';

type Tab = 'timeline' | 'appointments' | 'tasks' | 'files' | 'details';
const TABS: readonly Tab[] = ['timeline', 'appointments', 'tasks', 'files', 'details'];

export interface CustomRecordPageProps {
  workspaceId: string;
  myUserId: string;
  /** What the business lets them do (0105), as workspace.get gives it. */
  permissions: readonly string[];
  record: CustomRecordDetail;
  /** Its kind's fields. */
  fields: CustomField[];
  timeline: TimelineList;
  tasks: Task[];
  files: FileItem[];
  relationships: Relationship[];
  relationshipTypes: RelationshipType[];
  members: { id: string; fullName: string }[];
  timeZone: string;
  /** Visits for it: the next 62 days, and the last 62 (newest first). */
  upcoming: Appointment[];
  recent: Appointment[];
}

/**
 * One pet, vehicle or property: its own page, like a customer's. Its fields and notes, its timeline, tasks, files and
 * visits, and everyone it's related to — with their conversations beside it, since a pet is talked about with its
 * owners.
 */
export function CustomRecordPage(props: CustomRecordPageProps) {
  const { workspaceId, myUserId, permissions, record, members } = props;
  const router = useRouter();
  const kind = record.type;
  const archived = !!record.archivedAt;
  // Archive and restore it, and take away anyone's tasks and notes on it (records.archive).
  const canModerate = can(permissions, 'records.archive');
  const canWrite = can(permissions, 'records.write');
  const wanted = useSearchParams().get('tab');
  const [tab, setTab] = useState<Tab>(TABS.includes(wanted as Tab) ? (wanted as Tab) : 'timeline');
  const [log, setLog] = useState<LoggableKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState(false);
  const [openAppt, setOpenAppt] = useState<string | null>(null);
  const [talkTo, setTalkTo] = useState<{ personId: string; channel: 'sms' | 'email' } | null>(null);
  const closeTalk = useCallback(() => setTalkTo(null), []);
  useLiveRefresh(['custom_record', 'relationship', 'task', 'activity', 'appointment', 'person']);

  const summary = customSummary(props.fields, record.custom, 3);
  const people = props.relationships.filter((r) => r.other.kind === 'person');
  const staff = members.map((m) => ({ userId: m.id, fullName: m.fullName }));
  // Visits are booked with a customer: the one it's related to, when there's just one.
  const onlyPerson = people.length === 1 ? people[0]!.other : null;
  const relation = { customRecordId: record.id };
  const base = `/app/w/${workspaceId}/customers`;

  async function toggleArchive() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST(
          archived ? '/v1/commands/custom_record.restore' : '/v1/commands/custom_record.archive',
          { body: { workspaceId, customRecordId: record.id } },
        ),
      );
      toast.success(archived ? 'Restored.' : 'Archived.');
      setArchiving(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-6" data-testid="record-page-custom_record">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={base} className="text-accent-text hover:underline">
          Customers
        </Link>
        <span className="text-text-3">/</span>
        <Link href={`${base}?kind=${kind.id}`} className="text-accent-text hover:underline">
          {kind.plural}
        </Link>
        <span className="text-text-3">/</span>
        <span className="truncate text-text-2">{record.name}</span>
      </div>

      <Card className="mb-5 p-4 md:px-6 md:py-5">
        <div className="flex items-start gap-3 md:gap-4">
          <RecordIcon icon={kind.icon} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1
                className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl"
                data-testid="record-name"
              >
                {record.name}
              </h1>
              <Badge variant="gray">{kind.singular}</Badge>
              {archived ? <Badge variant="gray">{RECORD_WORDS.archived}</Badge> : null}
            </div>
            <div className="text-[13px] text-text-2" data-testid="record-summary">
              {[summary, `Added ${monthYear(record.createdAt)}`].filter(Boolean).join(' · ')}
            </div>
          </div>
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
                    {archived
                      ? `Restore ${lowerLabel(kind.singular)}`
                      : `Archive ${lowerLabel(kind.singular)}`}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {archived ? (
          <div
            className="mt-4 rounded-menu bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
            data-testid="archived-notice"
          >
            This {lowerLabel(kind.singular)} is archived: hidden from lists and searches, history
            kept.{canModerate ? ' Restore from the menu to use it again.' : ''}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
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
              onClick={() => setTab('tasks')}
              data-testid="action-task-tab"
            >
              <ClipboardList className="h-4 w-4" strokeWidth={1.5} />
              Task
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

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[3fr_2fr]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="mb-4">
            <TabsTrigger value="timeline" data-testid="tab-timeline">
              {recordTabLabel('timeline', null)}
            </TabsTrigger>
            <TabsTrigger value="appointments" data-testid="tab-appointments">
              {recordTabLabel('appointments', props.upcoming.length)}
            </TabsTrigger>
            <TabsTrigger value="tasks" data-testid="tab-tasks">
              {recordTabLabel('tasks', props.tasks.filter((t) => !t.doneAt).length)}
            </TabsTrigger>
            <TabsTrigger value="files" data-testid="tab-files">
              {recordTabLabel('files', props.files.length)}
            </TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">
              {recordTabLabel('details', null)}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="timeline">
            <Card>
              <Timeline
                workspaceId={workspaceId}
                recordType="custom_record"
                recordId={record.id}
                initial={props.timeline}
                timeZone={props.timeZone}
                myUserId={myUserId}
                canModerate={canModerate}
                members={members}
              />
            </Card>
          </TabsContent>
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
              {props.upcoming.length ? (
                props.upcoming.map((a) => (
                  <AppointmentRow
                    key={a.id}
                    appt={a}
                    timeZone={props.timeZone}
                    onOpen={setOpenAppt}
                  />
                ))
              ) : (
                <p className="border-t border-border py-3 text-[13px] text-text-2">
                  Nothing booked.
                </p>
              )}
              {props.recent.length ? (
                <>
                  <h3 className="mb-1 mt-4 text-[15px] font-semibold">Earlier</h3>
                  {props.recent.map((a) => (
                    <AppointmentRow
                      key={a.id}
                      appt={a}
                      timeZone={props.timeZone}
                      onOpen={setOpenAppt}
                    />
                  ))}
                </>
              ) : null}
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
                emptyHint={`Reminders for the team about this ${lowerLabel(kind.singular)}.`}
              />
            </Card>
          </TabsContent>
          <TabsContent value="files">
            <div className="flex flex-col gap-3.5">
              {archived ? null : (
                <UploadZone
                  workspaceId={workspaceId}
                  recordType="custom_record"
                  recordId={record.id}
                />
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
                <h3 className="text-[15px] font-semibold">{RECORD_WORDS.details}</h3>
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" strokeWidth={1.5} />
                  {RECORD_WORDS.edit}
                </Button>
              </div>
              <dl
                className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-[13.5px] md:grid-cols-[130px_1fr]"
                data-testid="record-details"
              >
                <dt className="text-text-2">{kind.nameLabel}</dt>
                <dd className="font-medium">{record.name}</dd>
                <dt className="text-text-2">Kind</dt>
                <dd className="font-medium">{kind.singular}</dd>
                <dt className="text-text-2">{RECORD_WORDS.labels.created}</dt>
                <dd className="font-medium">
                  {monthYear(record.createdAt)}
                  {record.createdBy ? ` · ${record.createdBy.fullName}` : ''}
                </dd>
                <dt className="text-text-2">{RECORD_WORDS.labels.notes}</dt>
                <dd className="whitespace-pre-wrap">{record.notes ?? RECORD_WORDS.none}</dd>
              </dl>
              <CustomFieldsSection
                workspaceId={workspaceId}
                recordType="custom_record"
                recordId={record.id}
                fields={props.fields}
                values={record.custom}
                canEdit={!archived && canWrite}
                manageHref={
                  can(permissions, 'fields.manage')
                    ? `/app/w/${workspaceId}/settings/fields?for=${kind.id}`
                    : null
                }
              />
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex flex-col gap-4">
          <RelationshipsCard
            workspaceId={workspaceId}
            record={{
              kind: 'custom_record',
              id: record.id,
              name: record.name,
              recordTypeId: kind.id,
            }}
            relationships={props.relationships}
            types={props.relationshipTypes}
            archived={archived}
            canManage={can(permissions, 'fields.manage')}
          />
          <UpcomingAppointments
            timeZone={props.timeZone}
            items={props.upcoming.slice(0, 5)}
            onBook={archived ? undefined : () => setBooking(true)}
            onOpen={setOpenAppt}
          />
          {/* A pet is talked about with its owners: each related customer's conversations. */}
          {people.slice(0, 3).map((p) => (
            <div key={p.id} className="flex flex-col gap-1.5">
              <div className="px-1 text-[12px] text-text-3">
                With {p.other.name} · {p.label}
              </div>
              <ConversationsCard
                workspaceId={workspaceId}
                person={{ id: p.other.id, fullName: p.other.name, phoneE164: null, email: null }}
                onOpen={(channel) => setTalkTo({ personId: p.other.id, channel })}
              />
            </div>
          ))}
        </div>
      </div>

      {booking ? (
        <AppointmentDialog
          open
          workspaceId={workspaceId}
          timeZone={props.timeZone}
          people={staff}
          myUserId={myUserId}
          prefill={{
            customRecordId: record.id,
            ...(onlyPerson
              ? {
                  person: { id: onlyPerson.id, fullName: onlyPerson.name },
                  personId: onlyPerson.id,
                }
              : {}),
          }}
          onOpenChange={(o) => !o && setBooking(false)}
          onBooked={() => {
            setBooking(false);
            router.refresh();
          }}
        />
      ) : null}
      {openAppt ? (
        <AppointmentSheet
          workspaceId={workspaceId}
          appointmentId={openAppt}
          timeZone={props.timeZone}
          people={staff}
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
        recordName={record.name}
        record={relation}
        onSaved={() => setTab('timeline')}
      />
      {talkTo ? (
        <TalkSheet
          workspaceId={workspaceId}
          personId={talkTo.personId}
          channel={talkTo.channel}
          onClose={closeTalk}
        />
      ) : null}
      <CustomRecordDialog
        workspaceId={workspaceId}
        kind={kind}
        initial={record}
        open={editing}
        onOpenChange={setEditing}
      />
      <Dialog open={archiving} onOpenChange={setArchiving}>
        <DialogContent
          title={archived ? `Restore ${record.name}?` : `Archive ${record.name}?`}
          description={
            archived
              ? `It comes back into lists and searches.`
              : `It leaves lists and searches. Its history, tasks, files and relationships are kept.`
          }
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setArchiving(false)}>
              Cancel
            </Button>
            <Button
              variant={archived ? 'primary' : 'danger'}
              loading={busy}
              onClick={() => void toggleArchive()}
              data-testid="archive-confirm"
            >
              {archived ? 'Restore' : 'Archive'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Text or email a related customer from here: their own record says how to reach them. */
function TalkSheet({
  workspaceId,
  personId,
  channel,
  onClose,
}: {
  workspaceId: string;
  personId: string;
  channel: 'sms' | 'email';
  onClose: () => void;
}) {
  const [person, setPerson] = useState<{
    id: string;
    fullName: string;
    phone: string | null;
    phoneE164: string | null;
    email: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/person.get', { body: { workspaceId, personId } })
      .then((r) => {
        if (!cancelled) setPerson(unwrap(r).person);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(errorMessage(e));
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, personId, onClose]);
  if (!person) return null;
  return (
    <MessageSheet
      workspaceId={workspaceId}
      person={person}
      channel={channel}
      open
      onOpenChange={(o) => !o && onClose()}
    />
  );
}
