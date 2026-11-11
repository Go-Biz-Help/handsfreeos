'use client';
/**
 * One job (docs/contractor.md, "A job's page"): its status, customer and property, the work to do, its phases and %
 * done, its lead and team, its visits, its materials, the time tracked on it, the crew's notes from the field, and
 * (for people who may see job costs, the owner's decision 11) its price and budget and what it's costing against
 * them. Files, tasks and the office's own notes are on core's page for its record, linked from here.
 *
 * Each visit opens its work order, and booking one starts it and opens it, to put a crew on. Marking the job Done
 * waits on the required checklist items and photos on its work orders (the owner's decision 8): the server says
 * which are left, and someone who may can mark it done anyway with a reason.
 */
import {
  JOB_STATUSES,
  STATUSES_WITH_REASON,
  type JobStatus,
} from '@hfos/core/addons/contractor/progress';
import { TRADE_NAMES } from '@hfos/core/addons/contractor/trades';
import {
  CONTRACTOR_WORDS,
  hoursWords,
  JOB_KIND_WORDS,
  JOB_STATUS_HINTS,
  JOB_STATUS_WORDS,
  lateWords,
  percentFromBp,
} from '@hfos/core/addons/contractor/words';
import { formatDate, formatDateOnly, money } from '@hfos/core';
import { ArrowLeft, CalendarPlus, ChevronRight, FileText, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AppointmentDialog } from '@/components/calendar/appointment-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import {
  ChecklistLine,
  contractorHref,
  DueLine,
  jobRecordHref,
  PercentBar,
  StageBadge,
  StatusBadge,
  workOrderHref,
} from './bits';
import { EstimateLine } from './estimates-home';
import { JobCostsCard } from './job-costs-card';
import { EditJobDialog, MoneyDialog, ReasonDialog } from './job-dialogs';
import { MaterialsCard, type MaterialProduct } from './materials-card';
import { FieldNotesCard } from './notes-card';
import { PercentInput, PhasesCard } from './phases-card';
import { TimeCard } from './time-card';
import type {
  EstimateList,
  JobCosting,
  JobDetail,
  MaterialList,
  NoteList,
  Overview,
  TimeList,
} from './types';
import { useAct } from './use-act';

const J = CONTRACTOR_WORDS.job;

/** What the server says when a job isn't ready to be marked done (`contractor_job_not_ready`). */
interface NotReady {
  readonly maySkip: boolean;
  readonly left: readonly {
    readonly itemId: string;
    readonly appointmentId: string;
    readonly startsAt: string;
    readonly label: string;
  }[];
}

export function JobPage({
  workspaceId,
  job,
  overview,
  estimates,
  materials,
  time,
  notes,
  costing,
  products,
  myUserId,
  timeZone,
  staff,
}: {
  workspaceId: string;
  job: JobDetail;
  overview: Overview;
  /** The estimates the builder wrote for this job, as far as this person may see them. */
  estimates: EstimateList['estimates'];
  /** The job's materials, with what they cost when this person may see job costs. */
  materials: MaterialList;
  /** The time tracked on the job: never with what it cost. */
  time: TimeList;
  /** The crew's notes from the field, the newest first. */
  notes: NoteList;
  /** What the job is costing against its plan; null for someone who may not see job costs. */
  costing: JobCosting | null;
  /** The price list to pick a material from; empty for someone who can't see it. */
  products: readonly MaterialProduct[];
  myUserId: string;
  timeZone: string;
  /** The team, as the visit booking dialog picks who goes. */
  staff: readonly { userId: string; fullName: string }[];
}) {
  // Time that starts or stops arrives as the add-on's own news about the job's record.
  useLiveRefresh(['custom_record', 'appointment', 'estimate']);
  const router = useRouter();
  const { busy, act } = useAct();
  const [editing, setEditing] = useState(false);
  const [reasonFor, setReasonFor] = useState<JobStatus | null>(null);
  const [booking, setBooking] = useState(false);
  const [notReady, setNotReady] = useState<NotReady | null>(null);
  const closed = job.status === 'done' || job.status === 'cancelled';
  const setStatus = (status: JobStatus, reason?: string, skipReason?: string) =>
    apiBrowser()
      .POST('/v1/commands/contractor.job.set_status', {
        body: {
          workspaceId,
          jobId: job.id,
          status,
          ...(reason ? { reason } : {}),
          ...(skipReason ? { skipReason } : {}),
        },
      })
      .then(unwrap);
  /**
   * A visit just booked: its work order starts now (the worker would start it within moments anyway) and opens. The
   * booking put one person on the visit, and a crew is put on from there.
   */
  const openWorkOrder = async (appointmentId: string) => {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.work_order.start', {
          body: { workspaceId, appointmentId },
        }),
      );
      router.push(workOrderHref(workspaceId, appointmentId));
    } catch {
      // Booked all the same: it shows in the job's visits, and opens from there.
      router.refresh();
    }
  };
  /** Done waits on the required items on its work orders: the server names what's left, and this shows it. */
  const markDone = () =>
    void act('status', async () => {
      try {
        await setStatus('done');
      } catch (e) {
        if (!(e instanceof ApiError) || e.rule !== 'contractor_job_not_ready') throw e;
        setNotReady(e.details as NotReady);
        return;
      }
      toast.success(J.statusSet(JOB_STATUS_WORDS.done));
    });
  return (
    <div data-testid="contractor-job">
      <Link
        href={contractorHref(workspaceId)}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" />
        {J.back}
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
            {job.name}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
            <StatusBadge status={job.status} />
            <Badge variant="member">{JOB_KIND_WORDS[job.kind]}</Badge>
            {job.daysLate ? <Badge variant="danger">{lateWords(job.daysLate)}</Badge> : null}
            {job.trade ? <span>{TRADE_NAMES[job.trade]}</span> : null}
            {job.statusReason && STATUSES_WITH_REASON.includes(job.status) ? (
              <span className="text-danger-text">· {job.statusReason}</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={J.status}
            value={job.status}
            disabled={busy === 'status'}
            className="w-[150px]"
            onChange={(e) => {
              const next = e.target.value as JobStatus;
              if (next === job.status) return;
              if (STATUSES_WITH_REASON.includes(next)) return setReasonFor(next);
              if (next === 'done') return markDone();
              void act('status', () => setStatus(next), J.statusSet(JOB_STATUS_WORDS[next]));
            }}
            data-testid="job-status-pick"
          >
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s} title={JOB_STATUS_HINTS[s]}>
                {JOB_STATUS_WORDS[s]}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            onClick={() => setBooking(true)}
            disabled={closed}
            data-testid="job-book-visit"
          >
            <CalendarPlus className="h-4 w-4" />
            {J.bookVisit}
          </Button>
          <ButtonLink href={jobRecordHref(workspaceId, job.id)} variant="ghost">
            <FileText className="h-4 w-4" />
            {J.openRecord}
          </ButtonLink>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card className="p-0" data-testid="job-details">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="text-[15px] font-semibold">Details</h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(true)}
                data-testid="job-edit"
              >
                {J.edit}
              </Button>
            </div>
            <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[13.5px] sm:grid-cols-2">
              <Fact label={J.customer}>
                {job.customer ? (
                  <Link
                    href={`/app/w/${workspaceId}/customers/people/${job.customer.personId}`}
                    className="font-medium hover:underline"
                  >
                    {job.customer.name}
                  </Link>
                ) : (
                  <span className="text-text-3">{J.noCustomer}</span>
                )}
              </Fact>
              <Fact label={J.property}>
                {job.property ? (
                  <Link
                    href={`/app/w/${workspaceId}/customers/records/${job.property.recordId}`}
                    className="font-medium hover:underline"
                  >
                    {job.property.name}
                  </Link>
                ) : (
                  <span className="text-text-3">{J.noProperty}</span>
                )}
              </Fact>
              <Fact label={J.startsOn}>
                {job.startsOn ? (
                  formatDateOnly(job.startsOn)
                ) : (
                  <span className="text-text-3">Not set</span>
                )}
              </Fact>
              <Fact label={J.dueOn}>
                {job.dueOn ? (
                  <span className="flex flex-wrap gap-x-2">
                    {formatDateOnly(job.dueOn)}
                    <DueLine
                      dueOn={job.dueOn}
                      daysLate={job.daysLate}
                      today={overview.today}
                      finished={closed}
                    />
                  </span>
                ) : (
                  <span className="text-text-3">Not set</span>
                )}
              </Fact>
              <div className="sm:col-span-2">
                <dt className="text-[12px] font-medium uppercase tracking-wide text-text-3">
                  {J.details}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-text">
                  {job.details || <span className="text-text-3">{J.noDetails}</span>}
                </dd>
              </div>
            </dl>
          </Card>

          <PhasesCard workspaceId={workspaceId} job={job} today={overview.today} closed={closed} />

          <Card className="p-0" data-testid="job-visits">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="text-[15px] font-semibold">{J.visits}</h2>
              {!closed ? (
                <Button size="sm" variant="ghost" onClick={() => setBooking(true)}>
                  {J.bookVisit}
                </Button>
              ) : null}
            </div>
            {job.visits.length === 0 ? (
              <p className="px-5 py-4 text-[13.5px] text-text-2">{J.visitsNone}</p>
            ) : (
              <ul>
                {job.visits.map((v) => (
                  <li key={v.appointmentId} className="border-b border-border last:border-b-0">
                    <Link
                      href={workOrderHref(workspaceId, v.appointmentId)}
                      className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13.5px] hover:bg-card-2"
                      aria-label={`${J.openWorkOrder}: ${formatDate(v.startsAt, { time: true, timeZone })}`}
                      data-testid="job-visit"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {formatDate(v.startsAt, { time: true, timeZone })}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-text-3">
                          <span className="truncate">{v.crew ?? v.title}</span>
                          {v.stage === 'cancelled' ? null : (
                            <ChecklistLine checklist={v.checklist} />
                          )}
                          {v.materialsMissing && v.stage !== 'cancelled' && v.stage !== 'done' ? (
                            <span
                              className="text-danger-text"
                              data-testid="visit-materials-missing"
                            >
                              {CONTRACTOR_WORDS.dispatch.materialsMissing(v.materialsMissing)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <StageBadge stage={v.stage} />
                        <ChevronRight className="h-4 w-4 text-text-3" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <MaterialsCard
            workspaceId={workspaceId}
            jobId={job.id}
            materials={materials.materials}
            visits={job.visits
              .filter((v) => v.stage !== 'cancelled')
              .map((v) => ({
                appointmentId: v.appointmentId,
                label: formatDate(v.startsAt, { time: true, timeZone }),
              }))}
            products={products}
            costing={materials.costing}
            mayCost={overview.may.costs}
            readOnly={!materials.canChange}
          />

          <TimeCard
            workspaceId={workspaceId}
            jobId={job.id}
            time={time}
            visits={job.visits.map((v) => ({
              appointmentId: v.appointmentId,
              label: formatDate(v.startsAt, { time: true, timeZone }),
            }))}
            people={overview.people}
            timeZone={timeZone}
          />

          <FieldNotesCard
            workspaceId={workspaceId}
            jobId={job.id}
            notes={notes}
            visits={job.visits.map((v) => ({
              appointmentId: v.appointmentId,
              label: formatDate(v.startsAt, { time: true, timeZone }),
            }))}
            myUserId={myUserId}
            timeZone={timeZone}
          />

          {costing ? (
            <JobCostsCard workspaceId={workspaceId} costing={costing} today={overview.today} />
          ) : null}

          {overview.may.costs || estimates.length ? (
            <Card className="p-0" data-testid="job-estimates">
              <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                <h2 className="text-[15px] font-semibold">{CONTRACTOR_WORDS.estimates.title}</h2>
                {overview.may.costs && !closed ? (
                  <ButtonLink
                    href={contractorHref(workspaceId, `estimates/new?jobId=${job.id}`)}
                    size="sm"
                    variant="ghost"
                    data-testid="job-new-estimate"
                  >
                    {CONTRACTOR_WORDS.estimates.add}
                  </ButtonLink>
                ) : null}
              </div>
              {estimates.length === 0 ? (
                <p className="px-5 py-4 text-[13.5px] text-text-2">
                  {CONTRACTOR_WORDS.estimates.none}
                </p>
              ) : (
                <ul>
                  {estimates.map((e) => (
                    <EstimateLine
                      key={e.id}
                      workspaceId={workspaceId}
                      estimate={e}
                      timeZone={timeZone}
                      // Its builder is for people who may see job costs; everyone else reads it in Money.
                      href={
                        overview.may.costs
                          ? undefined
                          : `/app/w/${workspaceId}/money/estimates/${e.id}`
                      }
                    />
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <ProgressCard workspaceId={workspaceId} job={job} closed={closed} />
          <TeamCard workspaceId={workspaceId} job={job} overview={overview} myUserId={myUserId} />
          {job.money ? <MoneyCard workspaceId={workspaceId} job={job} money={job.money} /> : null}
        </div>
      </div>

      <EditJobDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        job={job}
        overview={overview}
        myUserId={myUserId}
      />
      <ReasonDialog
        open={reasonFor !== null}
        onOpenChange={(o) => !o && setReasonFor(null)}
        title={reasonFor ? `Mark “${job.name}” ${JOB_STATUS_WORDS[reasonFor].toLowerCase()}` : ''}
        description={reasonFor ? JOB_STATUS_HINTS[reasonFor] : undefined}
        placeholder={
          reasonFor === 'on_hold' || reasonFor === 'cancelled'
            ? J.reasonPlaceholder[reasonFor]
            : undefined
        }
        submit={reasonFor ? `Mark ${JOB_STATUS_WORDS[reasonFor].toLowerCase()}` : ''}
        danger={reasonFor === 'cancelled'}
        done={reasonFor ? J.statusSet(JOB_STATUS_WORDS[reasonFor]) : ''}
        run={async (reason) => reasonFor && setStatus(reasonFor, reason)}
      />
      {booking ? (
        <AppointmentDialog
          open
          workspaceId={workspaceId}
          timeZone={timeZone}
          people={staff}
          myUserId={myUserId}
          prefill={{
            customRecordId: job.id,
            ...(job.customer
              ? {
                  person: { id: job.customer.personId, fullName: job.customer.name },
                  personId: job.customer.personId,
                }
              : {}),
          }}
          onOpenChange={(o) => !o && setBooking(false)}
          onBooked={(booked) => {
            setBooking(false);
            void openWorkOrder(booked.appointmentId);
          }}
        />
      ) : null}
      {notReady ? (
        <NotReadyDialog
          workspaceId={workspaceId}
          notReady={notReady}
          timeZone={timeZone}
          onClose={() => setNotReady(null)}
          skip={(why) => setStatus('done', undefined, why)}
        />
      ) : null}
    </div>
  );
}

const N = J.notReady;

/**
 * The required checklist items and photos still left on the job's work orders, by visit. Someone who may mark it
 * done anyway says why; the reason is kept on each item passed over and on the job's timeline.
 */
function NotReadyDialog({
  workspaceId,
  notReady,
  timeZone,
  onClose,
  skip,
}: {
  workspaceId: string;
  notReady: NotReady;
  timeZone: string;
  onClose: () => void;
  skip: (why: string) => Promise<unknown>;
}) {
  const [why, setWhy] = useState('');
  const { busy, errors, act } = useAct(onClose);
  const visits = [...new Set(notReady.left.map((l) => l.appointmentId))].map((id) => ({
    id,
    items: notReady.left.filter((l) => l.appointmentId === id),
  }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={N.title} description={N.left(notReady.left.length)}>
        <div className="mt-3 space-y-3 text-[13.5px]" data-testid="job-not-ready">
          {visits.map((v) => (
            <div key={v.id}>
              <Link
                href={workOrderHref(workspaceId, v.id)}
                className="font-medium text-accent-text hover:underline"
              >
                {N.onVisit(formatDate(v.items[0]!.startsAt, { time: true, timeZone }))}
              </Link>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-2">
                {v.items.map((i) => (
                  <li key={i.itemId}>{i.label}</li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-text-2">
            {N.finish} {notReady.maySkip ? null : N.askAdmin}
          </p>
        </div>
        {notReady.maySkip ? (
          <form
            className="mt-4 space-y-3 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act('skip', () => skip(why.trim()), N.skipped);
            }}
          >
            <div>
              <div className="text-[13.5px] font-semibold">{N.skipTitle}</div>
              <p className="mt-0.5 text-[12.5px] text-text-3">{N.skipHint}</p>
            </div>
            <Field label={N.skipReason} htmlFor="job-skip-reason" error={errors.skipReason}>
              <Textarea
                id="job-skip-reason"
                value={why}
                maxLength={300}
                placeholder={N.skipReasonPlaceholder}
                onChange={(e) => setWhy(e.target.value)}
                className="min-h-[72px]"
                data-testid="job-skip-reason"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {N.close}
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={!why.trim()}
                loading={busy === 'skip'}
                data-testid="job-skip"
              >
                {N.skip}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 flex justify-end">
            <Button onClick={onClose}>{N.close}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium uppercase tracking-wide text-text-3">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/** % done: a service call's set by hand; a project's comes from its phases. */
function ProgressCard({
  workspaceId,
  job,
  closed,
}: {
  workspaceId: string;
  job: JobDetail;
  closed: boolean;
}) {
  const { busy, act } = useAct();
  const fromPhases = job.phaseList.length > 0;
  return (
    <Card className="p-5" data-testid="job-progress">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">{J.percentDone}</h2>
        <span className="text-2xl font-semibold tabular-nums">{job.percentDone}%</span>
      </div>
      <PercentBar percent={job.percentDone} late={!!job.daysLate} className="mt-3" />
      {fromPhases ? (
        <p className="mt-2.5 text-[12.5px] text-text-3">
          From its phases: {job.phases.done} of {job.phases.count} done.
        </p>
      ) : closed ? null : (
        <div className="mt-3 flex items-center gap-2">
          <PercentInput
            key={job.percentDone}
            value={job.percentDone}
            label={J.setPercent}
            disabled={busy === 'percent'}
            onSave={(n) =>
              void act(
                'percent',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/contractor.job.set_percent', {
                      body: { workspaceId, jobId: job.id, percentDone: n },
                    }),
                  ),
                J.percentSet(n),
              )
            }
          />
          <span className="text-[12.5px] text-text-3">Type it and press Enter.</span>
        </div>
      )}
    </Card>
  );
}

/** Who runs the job, and who else is on it. */
function TeamCard({
  workspaceId,
  job,
  overview,
  myUserId,
}: {
  workspaceId: string;
  job: JobDetail;
  overview: Overview;
  myUserId: string;
}) {
  const { busy, act } = useAct();
  const [adding, setAdding] = useState('');
  const on = new Set([...(job.lead ? [job.lead.userId] : []), ...job.team.map((t) => t.userId)]);
  const others = overview.people.filter((p) => !on.has(p.userId));
  const nameOf = (userId: string, name: string) => (userId === myUserId ? `${name} (me)` : name);
  return (
    <Card className="p-5" data-testid="job-team">
      <h2 className="text-[15px] font-semibold">{J.team}</h2>
      <div className="mt-3 text-[13.5px]">
        <div className="text-[12px] font-medium uppercase tracking-wide text-text-3">{J.lead}</div>
        <div className="mt-1 font-medium">
          {job.lead ? (
            nameOf(job.lead.userId, job.lead.name)
          ) : (
            <span className="text-text-3">{J.noLead}</span>
          )}
        </div>
      </div>
      <ul className="mt-3 space-y-1.5 text-[13.5px]">
        {job.team.length === 0 ? <li className="text-text-3">{J.teamNone}</li> : null}
        {job.team.map((t) => (
          <li key={t.userId} className="flex items-center justify-between gap-2">
            <span>{nameOf(t.userId, t.name)}</span>
            <button
              type="button"
              className="rounded p-1 text-text-3 hover:bg-card-2 hover:text-text disabled:opacity-40"
              aria-label={`${J.removeFromTeam}: ${t.name}`}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  `off:${t.userId}`,
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/contractor.job.team_remove', {
                        body: { workspaceId, jobId: job.id, userId: t.userId },
                      }),
                    ),
                  `${t.name} is off the job.`,
                )
              }
              data-testid="team-remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {others.length ? (
        <div className="mt-3 flex gap-2">
          <Select
            selectSize="sm"
            value={adding}
            aria-label={J.addToTeam}
            onChange={(e) => setAdding(e.target.value)}
            data-testid="team-pick"
          >
            <option value="">{J.addToTeam}…</option>
            {others.map((p) => (
              <option key={p.userId} value={p.userId}>
                {nameOf(p.userId, p.name)}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!adding}
            loading={busy === 'add'}
            onClick={() => {
              const who = others.find((p) => p.userId === adding);
              void act(
                'add',
                async () => {
                  unwrap(
                    await apiBrowser().POST('/v1/commands/contractor.job.team_add', {
                      body: { workspaceId, jobId: job.id, userId: adding },
                    }),
                  );
                  setAdding('');
                },
                who ? `${who.name} is on the job.` : undefined,
              );
            }}
            data-testid="team-add"
          >
            Add
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const M = J.money;

/** The price to the customer, the budget and the planned profit: only for people who may see job costs. */
function MoneyCard({
  workspaceId,
  job,
  money: m,
}: {
  workspaceId: string;
  job: JobDetail;
  money: NonNullable<JobDetail['money']>;
}) {
  const [editing, setEditing] = useState(false);
  const line = (label: string, cents: number | null, strong?: boolean) => (
    <div className={cn('flex justify-between gap-3', strong && 'font-semibold')}>
      <dt className={strong ? undefined : 'text-text-2'}>{label}</dt>
      <dd className="tabular-nums">
        {cents === null ? <span className="text-text-3">{M.notSet}</span> : money(cents)}
      </dd>
    </div>
  );
  const marginLow = m.marginBp !== null && m.marginBp < 2000;
  return (
    <Card className="p-5" data-testid="job-money">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{M.title}</h2>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="money-edit">
          {J.edit}
        </Button>
      </div>
      <dl className="mt-3 space-y-1.5 text-[13.5px]">
        {line(M.price, m.priceCents, true)}
        <div className="my-2 border-t border-border" />
        {line(M.labor, m.laborCents)}
        {line(M.materials, m.materialsCents)}
        {line(M.other, m.otherCents)}
        {line(M.total, m.totalCents, true)}
        {m.laborHours !== null ? (
          <div className="flex justify-between gap-3 text-text-2">
            <dt>{M.hours}</dt>
            <dd className="tabular-nums">{hoursWords(m.laborHours)}</dd>
          </div>
        ) : null}
        <div className="my-2 border-t border-border" />
        {line(M.profit, m.profitCents, true)}
        <div className="flex justify-between gap-3">
          <dt className="text-text-2">{M.margin}</dt>
          <dd className={cn('tabular-nums', marginLow && 'font-semibold text-danger-text')}>
            {m.marginBp === null ? (
              <span className="text-text-3">{M.notSet}</span>
            ) : (
              percentFromBp(m.marginBp)
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[12px] text-text-3">{M.hint}</p>
      <MoneyDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        jobId={job.id}
        value={m}
      />
    </Card>
  );
}
