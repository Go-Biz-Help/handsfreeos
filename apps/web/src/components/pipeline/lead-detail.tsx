'use client';
import { hasWorkspacePermission } from '@hfos/core';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CalendarPlus,
  Clock,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Phone,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppointmentDialog } from '@/components/calendar/appointment-dialog';
import { AppointmentSheet } from '@/components/calendar/appointment-sheet';
import { UpcomingAppointments } from '@/components/calendar/upcoming-card';
import { LeadMoneyCard, useRecordMoney } from '@/components/crm/record-money';
import { NextActionChip, StageBadge } from '@/components/crm/chips';
import { NextActionDialog } from '@/components/crm/next-action-dialog';
import { TagPicker } from '@/components/crm/tag-picker';
import { FileGrid } from '@/components/files/file-grid';
import { UploadZone } from '@/components/files/upload-zone';
import { TaskList } from '@/components/tasks/task-list';
import { LogActivitySheet, type LoggableKind } from '@/components/timeline/log-activity-sheet';
import { Timeline } from '@/components/timeline/timeline';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  AddToWorkflowButton,
  ContactWorkflowsCard,
} from '@/components/workflows/contact-workflows';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { saveTagChanges } from '@/lib/api/edits';
import type {
  Appointment,
  FileItem,
  LeadCard,
  LeadGet,
  Role,
  Tag,
  Task,
  TimelineList,
} from '@/lib/api/types';

type LeadStage = LeadGet['stages'][number];
import { daysLabel, formatDate, formatDateOnly, formatMoney } from '@/lib/format';
import { lastContactWords, moveToast, PIPELINE_WORDS, RECORD_WORDS } from '@hfos/core';
import { useLiveRefresh, useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { leadQualificationOf } from '@/lib/ai-team/inbox-types';
import { AttentionBanner } from './attention-banner';
import { LeadEditDialog } from './lead-edit-dialog';
import { LostReasonDialog } from './lost-reason-dialog';
import { QualificationCard } from './qualification-card';

export interface LeadDetailData {
  lead: LeadCard;
  stages: LeadGet['stages'];
  timeline: TimelineList;
  tasks: Task[];
  files: FileItem[];
}

/**
 * One lead: stage stepper, next action, details, quick actions and timeline. Used compact inside the
 * board's side sheet (client-fetched, live) and in full on /leads/[id] (server-rendered, live refresh).
 */
export function LeadDetail({
  workspaceId,
  leadId,
  initial,
  members,
  myUserId,
  role,
  tags,
  compact,
  onChanged,
  timeZone,
  upcoming,
  teammate,
}: {
  workspaceId: string;
  leadId: string;
  initial?: LeadDetailData;
  members: { id: string; fullName: string }[];
  myUserId: string;
  role: Role;
  tags: Tag[];
  compact?: boolean;
  /** Called after any change the board should reflect (moves, next action, archive). */
  onChanged?: () => void;
  /** The workspace's time zone; with it the full page offers Book and lists upcoming appointments. */
  timeZone?: string;
  upcoming?: Appointment[];
  /** The AI teammate that asks the qualifying questions: its name and its questions now. */
  teammate?: {
    readonly name: string;
    readonly questions: readonly { readonly id: string; readonly question: string }[];
  } | null;
}) {
  const router = useRouter();
  const [data, setData] = useState<LeadDetailData | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LoggableKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [nextOpen, setNextOpen] = useState(false);
  const [lost, setLost] = useState<LeadStage | null>(null);
  const [inlineNext, setInlineNext] = useState('');
  const [inlineAt, setInlineAt] = useState('');
  const [booking, setBooking] = useState(false);
  const [openAppt, setOpenAppt] = useState<string | null>(null);
  const version = useLiveVersion(['lead', 'activity', 'task']);
  useLiveRefresh(initial ? ['lead', 'activity', 'task', 'appointment'] : []);
  const canModerate = role === 'owner' || role === 'admin';
  const canBill = hasWorkspacePermission(role, 'money.manage');
  /** What has been quoted or billed on this job. A member who doesn't own this lead finds nothing here. */
  const leadMoney = useRecordMoney(workspaceId, 'lead', compact ? null : leadId);

  const fetchAll = useCallback(async () => {
    const api = apiBrowser();
    const [got, timeline, tasks, files] = await Promise.all([
      unwrap(await api.POST('/v1/queries/lead.get', { body: { workspaceId, leadId } })),
      unwrap(
        await api.POST('/v1/queries/timeline.list', {
          body: { workspaceId, recordType: 'lead', recordId: leadId, limit: compact ? 10 : 30 },
        }),
      ),
      unwrap(
        await api.POST('/v1/queries/task.list', {
          body: { workspaceId, scope: 'all', status: compact ? 'open' : 'all', leadId, limit: 50 },
        }),
      ),
      compact
        ? Promise.resolve({ files: [] as FileItem[] })
        : unwrap(
            await api.POST('/v1/queries/file.list', {
              body: { workspaceId, recordType: 'lead', recordId: leadId },
            }),
          ),
    ]);
    setData({
      lead: got.lead,
      stages: got.stages,
      timeline,
      tasks: tasks.items,
      files: files.files,
    });
  }, [workspaceId, leadId, compact]);

  useEffect(() => {
    if (initial) {
      setData(initial);
      return;
    }
    fetchAll().catch((e) => toast.error(errorMessage(e)));
  }, [initial, fetchAll, version]);

  const reload = useCallback(() => {
    onChanged?.();
    if (initial) router.refresh();
    else fetchAll().catch(() => {});
  }, [initial, router, fetchAll, onChanged]);

  if (!data)
    return (
      <div className="py-10 text-center text-[13px] text-text-3" data-testid="lead-detail-loading">
        Loading…
      </div>
    );
  const { lead, stages } = data;
  const who = lead.person ?? lead.company;
  const whoHref = lead.person
    ? `/app/w/${workspaceId}/customers/people/${lead.person.id}`
    : lead.company
      ? `/app/w/${workspaceId}/customers/companies/${lead.company.id}`
      : null;
  const whoName = lead.person ? lead.person.fullName : (lead.company?.name ?? '');
  const firstOpen = stages.find((s) => s.kind === 'open');

  async function move(stage: LeadStage, lostReason?: string) {
    if (stage.id === lead.stageId) return;
    if (stage.kind === 'lost' && lead.status !== 'lost' && !lostReason) return setLost(stage);
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/lead.move_stage', {
          body: { workspaceId, leadId, stageId: stage.id, ...(lostReason ? { lostReason } : {}) },
        }),
      );
      // The board's own toast names the lead; moving from the lead's page is already on it, so it says the stage.
      toast.success(
        stage.kind === 'open' ? `Moved to ${stage.name}.` : moveToast(lead.title, stage),
      );
      setLost(null);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function setNext() {
    if (!inlineNext.trim()) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/lead.set_next_action', {
          body: {
            workspaceId,
            leadId,
            text: inlineNext.trim(),
            dueAt: inlineAt ? new Date(inlineAt).toISOString() : null,
          },
        }),
      );
      toast.success(PIPELINE_WORDS.nextActionSet);
      setInlineNext('');
      setInlineAt('');
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function archive(restore: boolean) {
    if (
      !restore &&
      !confirm(
        `Archive ${lead.title}? It leaves the pipeline but keeps its history. Recorded in the audit log.`,
      )
    )
      return;
    try {
      unwrap(
        await apiBrowser().POST(
          restore ? '/v1/commands/lead.restore' : '/v1/commands/lead.archive',
          { body: { workspaceId, leadId } },
        ),
      );
      toast.success(restore ? PIPELINE_WORDS.leadRestored : PIPELINE_WORDS.leadArchived);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  /** One tag on or off at a time, so a teammate tagging this lead at the same moment isn't undone. */
  async function setTags(ids: string[]) {
    try {
      await saveTagChanges(
        workspaceId,
        'lead',
        leadId,
        lead.tags.map((t) => t.id),
        ids,
      );
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const relation = {
    leadId,
    personId: lead.person?.id ?? null,
    companyId: lead.company?.id ?? null,
  };

  return (
    <div className="flex flex-col gap-4" data-testid="lead-detail" data-status={lead.status}>
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <StageBadge name={lead.stageName} kind={lead.stageKind} />
            {lead.archivedAt ? <span className="text-xs text-text-3">Archived</span> : null}
          </span>
          <span className="flex items-center gap-0.5">
            {compact ? (
              <ButtonLink
                href={`/app/w/${workspaceId}/leads/${leadId}`}
                variant="ghost"
                size="icon"
                title="Open full page"
                aria-label="Open full page"
              >
                <ExternalLink className="h-4 w-4" strokeWidth={1.5} />
              </ButtonLink>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Lead actions"
                  data-testid="lead-menu"
                >
                  <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" strokeWidth={1.5} />
                  Edit details
                </DropdownMenuItem>
                {canModerate ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      danger={!lead.archivedAt}
                      onSelect={() => void archive(!!lead.archivedAt)}
                      data-testid="lead-archive"
                    >
                      {lead.archivedAt ? (
                        <ArchiveRestore className="h-4 w-4" strokeWidth={1.5} />
                      ) : (
                        <Archive className="h-4 w-4" strokeWidth={1.5} />
                      )}
                      {lead.archivedAt ? PIPELINE_WORDS.restoreLead : PIPELINE_WORDS.archiveLead}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        <h2
          className={cn('font-semibold tracking-tight', compact ? 'text-xl' : 'text-2xl')}
          data-testid="lead-title"
        >
          {lead.title}
        </h2>
        <p className="mt-0.5 text-[13px] text-text-2">
          {whoHref ? (
            <Link href={whoHref} className="text-accent-text hover:underline">
              {whoName}
              {who?.archived ? ' (archived)' : ''}
            </Link>
          ) : null}
          {' · '}
          {formatMoney(lead.valueCents)} · {daysLabel(lead.stageEnteredAt)} in stage
        </p>
      </div>

      {lead.archivedAt ? null : (
        <AttentionBanner
          workspaceId={workspaceId}
          leadId={leadId}
          person={lead.person}
          timeZone={timeZone}
          onSetNextAction={() => setNextOpen(true)}
          onOpenAppointment={timeZone ? setOpenAppt : undefined}
        />
      )}

      <div
        className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]"
        role="group"
        aria-label="Stage"
        data-testid="stage-stepper"
      >
        {stages.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={busy || !!lead.archivedAt}
            aria-pressed={s.id === lead.stageId}
            onClick={() => void move(s)}
            data-testid={`stage-step-${s.kind}-${s.name.replace(/\s+/g, '-').toLowerCase()}`}
            className={cn(
              'h-[30px] flex-none whitespace-nowrap rounded-full px-3 text-[12.5px] font-medium transition-colors',
              s.id === lead.stageId
                ? 'bg-accent text-white'
                : 'border border-border-strong bg-card text-text hover:bg-card-2',
            )}
          >
            {s.name}
          </button>
        ))}
      </div>

      {lead.status === 'open' && !lead.archivedAt ? (
        lead.nextAction ? (
          <div
            className="flex items-start gap-2.5 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text"
            data-testid="lead-next-action"
          >
            <Clock className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">
              <strong className="font-semibold">Next:</strong> {lead.nextAction}
              {lead.nextActionAt ? (
                <span className="opacity-80">
                  {' '}
                  · {formatDate(lead.nextActionAt, { time: true })}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => setNextOpen(true)}
              className="text-[13px] font-medium underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div
            className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text"
            data-testid="lead-next-action-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span>
                <strong className="font-semibold">{PIPELINE_WORDS.noFollowUpDot}</strong>{' '}
                {PIPELINE_WORDS.goCold}
              </span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  inputSize="sm"
                  placeholder="What is next? e.g. Call Mike"
                  value={inlineNext}
                  onChange={(e) => setInlineNext(e.target.value)}
                  aria-label="Next action"
                  className="bg-card"
                />
                <Input
                  inputSize="sm"
                  type="datetime-local"
                  value={inlineAt}
                  onChange={(e) => setInlineAt(e.target.value)}
                  aria-label="When"
                  className="bg-card sm:w-[190px]"
                />
                <Button size="sm" onClick={setNext} loading={busy} data-testid="lead-next-set">
                  Set
                </Button>
              </div>
            </div>
          </div>
        )
      ) : null}
      {lead.status === 'lost' && lead.lostReason ? (
        <div
          className="rounded-menu bg-danger-soft px-3.5 py-3 text-[13.5px] text-danger-text"
          data-testid="lead-lost-reason"
        >
          <strong className="font-semibold">Lost:</strong> {lead.lostReason}
          {lead.lostAt ? <span className="opacity-80"> · {formatDate(lead.lostAt)}</span> : null}
        </div>
      ) : null}
      {lead.status === 'won' ? (
        <div
          className="rounded-menu bg-success-soft px-3.5 py-3 text-[13.5px] text-success-text"
          data-testid="lead-won"
        >
          <strong className="font-semibold">Won</strong>
          {lead.wonAt ? <span className="opacity-80"> · {formatDate(lead.wonAt)}</span> : null}.
          Jobs and invoices arrive in a later milestone.
        </div>
      ) : null}

      <dl
        className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[13.5px] md:grid-cols-[130px_1fr]"
        data-testid="lead-details"
      >
        <dt className="text-text-2">{RECORD_WORDS.value}</dt>
        <dd className="font-medium">{formatMoney(lead.valueCents)}</dd>
        <dt className="text-text-2">{RECORD_WORDS.assignedTo}</dt>
        <dd className="font-medium">{lead.assignee?.fullName ?? RECORD_WORDS.unassigned}</dd>
        <dt className="text-text-2">{PIPELINE_WORDS.lastContact}</dt>
        <dd className="font-medium" data-testid="lead-last-contact">
          {lastContactWords(lead.lastContactAt)}
        </dd>
        <dt className="text-text-2">{PIPELINE_WORDS.expectedClose}</dt>
        <dd className="font-medium">
          {lead.expectedCloseOn ? formatDateOnly(lead.expectedCloseOn) : '—'}
        </dd>
        <dt className="text-text-2">Source</dt>
        <dd className="font-medium">{lead.source ?? '—'}</dd>
        <dt className="text-text-2">Tags</dt>
        <dd>
          <TagPicker
            workspaceId={workspaceId}
            tags={tags}
            selected={lead.tags.map((t) => t.id)}
            onChange={(ids) => void setTags(ids)}
            compact
          />
        </dd>
      </dl>

      {lead.archivedAt ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLog('note')}
            data-testid="lead-note"
          >
            <Pencil className="h-4 w-4" strokeWidth={1.5} />
            Note
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setLog('call')}>
            <Phone className="h-4 w-4" strokeWidth={1.5} />
            Log call
          </Button>
          {timeZone ? (
            <Button
              variant="secondary"
              size="sm"
              className="border-[color-mix(in_oklab,var(--accent)_45%,var(--border-strong))] text-accent-text"
              onClick={() => setBooking(true)}
              data-testid="lead-book"
            >
              <CalendarPlus className="h-4 w-4" strokeWidth={1.5} />
              Book
            </Button>
          ) : null}
          {compact ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                document.getElementById('lead-files')?.scrollIntoView({ behavior: 'smooth' })
              }
            >
              <Upload className="h-4 w-4" strokeWidth={1.5} />
              File
            </Button>
          )}
          {lead.person && !compact ? (
            <AddToWorkflowButton
              workspaceId={workspaceId}
              person={{ id: lead.person.id, fullName: lead.person.fullName }}
              timeZone={timeZone ?? 'America/Chicago'}
              canManageWorkflows={canModerate}
            />
          ) : null}
          <span className="flex-1" />
          {lead.status === 'open' ? (
            <>
              {stages
                .filter((s) => s.kind === 'won')
                .slice(0, 1)
                .map((s) => (
                  <Button
                    key={s.id}
                    variant="secondary"
                    size="sm"
                    className="text-success-text"
                    onClick={() => void move(s)}
                    disabled={busy}
                    data-testid="lead-won-button"
                  >
                    Won
                  </Button>
                ))}
              {stages
                .filter((s) => s.kind === 'lost')
                .slice(0, 1)
                .map((s) => (
                  <Button
                    key={s.id}
                    variant="secondary"
                    size="sm"
                    className="text-danger-text"
                    onClick={() => void move(s)}
                    disabled={busy}
                    data-testid="lead-lost-button"
                  >
                    Lost
                  </Button>
                ))}
            </>
          ) : firstOpen ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void move(firstOpen)}
              disabled={busy}
              data-testid="lead-reopen-button"
            >
              Reopen
            </Button>
          ) : null}
        </div>
      )}

      {!compact && leadQualificationOf(lead) ? (
        <QualificationCard
          qualification={leadQualificationOf(lead)!}
          teammateName={teammate?.name ?? null}
          questions={teammate?.questions ?? []}
        />
      ) : null}

      {!compact ? (
        <LeadMoneyCard
          workspaceId={workspaceId}
          leadId={leadId}
          personId={lead.person?.id ?? null}
          found={leadMoney}
          canManage={canBill}
          timeZone={timeZone ?? 'UTC'}
        />
      ) : null}

      {timeZone && !compact ? (
        <UpcomingAppointments
          timeZone={timeZone}
          items={upcoming ?? []}
          onBook={lead.archivedAt ? undefined : () => setBooking(true)}
          onOpen={setOpenAppt}
        />
      ) : null}

      {lead.person && !compact ? (
        <ContactWorkflowsCard
          workspaceId={workspaceId}
          person={{ id: lead.person.id, fullName: lead.person.fullName }}
          timeZone={timeZone ?? 'America/Chicago'}
        />
      ) : null}

      <section id="lead-tasks" className="scroll-mt-20">
        <h3 className="mb-2 text-[15px] font-semibold">Tasks</h3>
        <Card>
          <TaskList
            workspaceId={workspaceId}
            tasks={data.tasks}
            members={members}
            myUserId={myUserId}
            canModerate={canModerate}
            relation={lead.archivedAt ? undefined : relation}
            emptyHint="Reminders about this lead."
          />
        </Card>
      </section>

      {compact ? null : (
        <section id="lead-files">
          <h3 className="mb-2 text-[15px] font-semibold">Files</h3>
          <div className="flex flex-col gap-3">
            {lead.archivedAt ? null : (
              <UploadZone workspaceId={workspaceId} recordType="lead" recordId={leadId} compact />
            )}
            <FileGrid workspaceId={workspaceId} files={data.files} canDelete={canModerate} />
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[15px] font-semibold">Timeline</h3>
        <Card>
          <Timeline
            workspaceId={workspaceId}
            recordType="lead"
            recordId={leadId}
            initial={data.timeline}
            timeZone={timeZone}
            myUserId={myUserId}
            canModerate={canModerate}
            subjectName={lead.person?.fullName}
            members={members}
          />
        </Card>
      </section>

      {timeZone && booking ? (
        <AppointmentDialog
          open
          workspaceId={workspaceId}
          timeZone={timeZone}
          people={members.map((m) => ({ userId: m.id, fullName: m.fullName }))}
          myUserId={myUserId}
          prefill={{
            person: lead.person ? { id: lead.person.id, fullName: lead.person.fullName } : null,
            personId: lead.person?.id ?? null,
            leadId,
          }}
          lockCustomer={!!lead.person}
          onOpenChange={(o) => !o && setBooking(false)}
          onBooked={() => {
            setBooking(false);
            reload();
          }}
        />
      ) : null}
      {timeZone && openAppt ? (
        <AppointmentSheet
          workspaceId={workspaceId}
          myUserId={myUserId}
          appointmentId={openAppt}
          timeZone={timeZone}
          people={members.map((m) => ({ userId: m.id, fullName: m.fullName }))}
          myRole={role}
          onClose={() => setOpenAppt(null)}
          onChanged={reload}
        />
      ) : null}
      <LogActivitySheet
        workspaceId={workspaceId}
        open={log !== null}
        onOpenChange={(o) => !o && setLog(null)}
        kind={log ?? 'note'}
        recordName={lead.title}
        record={{ leadId, personId: lead.person?.id, companyId: lead.company?.id }}
        onSaved={reload}
      />
      <LeadEditDialog
        workspaceId={workspaceId}
        lead={lead}
        open={editing}
        onOpenChange={setEditing}
        members={members}
        myUserId={myUserId}
        onSaved={reload}
      />
      <NextActionDialog
        workspaceId={workspaceId}
        leadId={leadId}
        leadTitle={lead.title}
        open={nextOpen}
        onOpenChange={setNextOpen}
        current={{ text: lead.nextAction, at: lead.nextActionAt }}
        onSaved={reload}
      />
      <LostReasonDialog
        open={lost !== null}
        onOpenChange={(o) => !o && setLost(null)}
        leadTitle={lead.title}
        busy={busy}
        onConfirm={(reason) => lost && void move(lost, reason)}
      />
    </div>
  );
}

export { NextActionChip };
