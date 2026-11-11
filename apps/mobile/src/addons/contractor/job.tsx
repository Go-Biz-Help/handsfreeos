import { fmtDateShort, fmtMonthDay, localDateOf } from '@hfos/core';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import {
  isOpen,
  JOB_STATUSES,
  PHASE_STATUSES,
  STATUSES_WITH_REASON,
  type JobStatus,
  type PhaseStatus,
} from '@hfos/core/addons/contractor/progress';
import type { TimeKind, TimeTotals } from '@hfos/core/addons/contractor/time';
import { TRADE_NAMES } from '@hfos/core/addons/contractor/trades';
import {
  phoneJob,
  phoneMaterials,
  phoneNotes,
  phoneTime,
  type PhoneJob,
  type PhoneMaterial,
  type PhoneNote,
  type PhonePhase,
} from '@hfos/core/addons/contractor/views/phone';
import {
  CONTRACTOR_WORDS as W,
  JOB_KIND_WORDS,
  JOB_STATUS_HINTS,
  JOB_STATUS_WORDS,
  lateWords,
  PHASE_STATUS_WORDS,
} from '@hfos/core/addons/contractor/words';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronRight, Phone } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

import { setJobStatus, setPercent, setPhaseStatus } from './actions';
import { callNumber, deadlineOf, JobStatusBadge, visitDetail, VisitRow } from './bits';
import { useContractorCopy } from './copy';
import { attempt, useFieldActions } from './field';
import {
  CO_MANAGE,
  coHref,
  Fact,
  KeptStrip,
  openCo,
  SectionLabel,
  useCoChanges,
  useCoContext,
  waitingIds,
} from './kit';
import { MaterialsCard, type CountAmounts } from './materials';
import { NotesCard, type NoteActions } from './notes';
import { TimeCard } from './time';

/**
 * A job on the phone (docs/contractor.md, "On the phone"): where it stands, who it's for and where, the work to do,
 * how far along it is (a service call's %, or a project's phases), its visits with their work orders, its materials,
 * its time and its notes from the field, read from the phone's copy so it's all there with no signal. Moving a phase
 * along, a service call's %, counting materials and adding notes wait on the phone with none; the job's own status
 * needs signal. Its estimate, costs and budget stay on the web (the owner's decision 11).
 */

export interface JobActions {
  openVisit(appointmentId: string): void;
  openCustomer(personId: string): void;
  backToJobs(): void;
  call(phone: string): void;
  /** Resolves with why it was refused, or null once it's through. */
  setStatus(status: JobStatus, reason: string): Promise<string | null>;
  setPercent(percentDone: number): Promise<boolean>;
  setPhase(phase: PhonePhase, status: PhaseStatus): Promise<boolean>;
  count(material: PhoneMaterial, amounts: CountAmounts): Promise<boolean>;
  notes: NoteActions;
}

export interface JobWaiting {
  readonly total: number;
  readonly percent: boolean;
  readonly phases: ReadonlySet<string>;
  readonly materials: ReadonlySet<string>;
  readonly notes: ReadonlySet<string>;
}

export const NOTHING_WAITING: JobWaiting = {
  total: 0,
  percent: false,
  phases: new Set(),
  materials: new Set(),
  notes: new Set(),
};

export function JobScreen({ jobId }: { jobId: string }) {
  const ctx = useCoContext();
  const { online } = useNetwork();
  const copy = useContractorCopy(ctx.workspaceId, { kind: 'job', jobId });
  const changes = useCoChanges(ctx.workspaceId);
  const job = React.useMemo(
    () => phoneJob(copy, jobId, { today: ctx.today, now: ctx.now }),
    [copy, jobId, ctx.today, ctx.now],
  );
  const materials = React.useMemo(() => phoneMaterials(copy, jobId), [copy, jobId]);
  const time = React.useMemo(
    () => phoneTime(copy, jobId, { me: ctx.userId, now: ctx.now }),
    [copy, jobId, ctx.userId, ctx.now],
  );
  const notes = React.useMemo(() => phoneNotes(copy, jobId), [copy, jobId]);
  const photosOf = React.useMemo(
    () => new Map((copy.notes.get(jobId) ?? []).map((n) => [n.id, n.photoFileIds.length])),
    [copy, jobId],
  );
  const waiting = React.useMemo<JobWaiting>(() => {
    const of = (name: string) => changes.filter((c) => c.name === name);
    return {
      total: changes.length,
      percent: of('contractor.job.set_percent').some((c) => c.input.jobId === jobId),
      phases: waitingIds(of('contractor.phase.update'), 'phaseId'),
      materials: waitingIds(of('contractor.material.count'), 'materialId'),
      notes: waitingIds(of('contractor.note.add'), 'id'),
    };
  }, [changes, jobId]);
  const field = useFieldActions({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    jobId,
    jobName: job?.name ?? '',
  });
  const mine = time.mine ? time.entries.find((e) => e.id === time.mine!.entryId) : undefined;
  const { workspaceId } = ctx;
  const actions = React.useMemo<JobActions>(
    () => ({
      openVisit: (appointmentId) => openCo(workspaceId, `visits/${appointmentId}`),
      openCustomer: (personId) =>
        router.push(businessHref(workspaceId, `customers/people/${personId}`) as Href),
      backToJobs: () => router.replace(coHref(workspaceId)),
      call: callNumber,
      setStatus: async (status, reason) => {
        try {
          await setJobStatus({ workspaceId, jobId, status, reason });
          toast.show(W.job.statusSet(JOB_STATUS_WORDS[status]));
          return null;
        } catch (e) {
          return e instanceof Error && e.message ? e.message : P.kept.refused;
        }
      },
      setPercent: (p) => attempt(() => setPercent(workspaceId, jobId, p), W.job.percentSet(p)),
      setPhase: (phase, status) =>
        attempt(
          () =>
            setPhaseStatus({
              workspaceId,
              phaseId: phase.id,
              status,
              percentDone: phase.percentDone,
            }),
          P.job.phaseSaved(phase.name, PHASE_STATUS_WORDS[status]),
        ),
      count: field.count,
      notes: field.notes,
    }),
    [workspaceId, jobId, field],
  );
  return (
    <JobView
      job={job}
      today={ctx.today}
      timeZone={ctx.timeZone}
      online={online}
      me={ctx.userId}
      manages={ctx.holds(CO_MANAGE)}
      customerPhone={job?.customer ? (copy.phones.get(job.customer.personId) ?? null) : null}
      materials={materials.materials}
      materialsMissing={materials.missing}
      totals={time.totals}
      mine={mine ? { kind: mine.kind, startedAt: mine.startedAt } : null}
      notes={notes.notes}
      notesTruncated={notes.truncated}
      photosOf={photosOf}
      waiting={waiting}
      actions={actions}
    />
  );
}

export function JobView({
  job,
  today,
  timeZone,
  online,
  me,
  manages,
  customerPhone,
  materials,
  materialsMissing,
  totals,
  mine,
  notes,
  notesTruncated,
  photosOf,
  waiting = NOTHING_WAITING,
  actions,
}: {
  job: PhoneJob | null;
  today: string;
  timeZone: string;
  online: boolean;
  me: string;
  /** Sets the add-on up here, so may take anyone's note off. */
  manages: boolean;
  customerPhone: string | null;
  materials: readonly PhoneMaterial[];
  materialsMissing: number;
  totals: TimeTotals;
  mine: { readonly kind: TimeKind; readonly startedAt: string } | null;
  notes: readonly PhoneNote[];
  notesTruncated: boolean;
  photosOf: ReadonlyMap<string, number>;
  waiting?: JobWaiting;
  actions: JobActions;
}) {
  const [changingStatus, setChangingStatus] = React.useState(false);
  const [settingPercent, setSettingPercent] = React.useState(false);
  const [phase, setPhase] = React.useState<PhonePhase | null>(null);

  if (!job || job.archived)
    return (
      <Screen title={P.more.jobs} leading="back" testID="co-job">
        <Card className="gap-3 p-4">
          <Text className="text-[14px] leading-[20px] text-text-2" testID="co-job-gone">
            {P.job.gone}
          </Text>
          <Button variant="secondary" onPress={actions.backToJobs} testID="co-job-back">
            {P.job.backToJobs}
          </Button>
        </Card>
      </Screen>
    );

  const open = isOpen(job.status);
  const deadline = deadlineOf(job, today);
  const year = Number(today.slice(0, 4));
  return (
    <Screen title={job.name} subtitle={JOB_KIND_WORDS[job.kind]} leading="back" testID="co-job">
      <KeptStrip waiting={waiting.total} />

      <Card className="gap-2.5 px-3.5 py-3" testID="co-job-status">
        <View className="flex-row flex-wrap items-center gap-2">
          <JobStatusBadge status={job.status} testID="co-job-status-badge" />
          {job.daysLate ? <Badge variant="danger">{lateWords(job.daysLate)}</Badge> : null}
          {deadline && !deadline.late ? (
            <Text className="text-[13px] text-text-3">{deadline.words}</Text>
          ) : null}
        </View>
        {job.statusReason ? (
          <Text className="text-[13.5px] leading-[19px] text-text-2" testID="co-job-reason">
            {P.job.why(job.statusReason)}
          </Text>
        ) : null}
        <Button
          variant="secondary"
          size="md"
          className="self-start"
          disabled={!online}
          onPress={() => setChangingStatus(true)}
          testID="co-job-change-status"
        >
          {P.job.changeStatus}
        </Button>
        {online ? null : (
          <Text className="text-[12.5px] leading-[17px] text-text-3" testID="co-job-status-signal">
            {P.job.statusNeedsSignal}
          </Text>
        )}
      </Card>

      <View className="gap-1.5">
        <SectionLabel>{P.job.about}</SectionLabel>
        <Card className="gap-3 px-3.5 py-3" testID="co-job-about">
          <Fact label={W.job.customer} testID="co-job-customer">
            {job.customer ? (
              <View className="flex-row items-center gap-2">
                <Pressable
                  role="button"
                  accessibilityLabel={job.customer.name}
                  onPress={() => actions.openCustomer(job.customer!.personId)}
                  className="min-w-0 flex-1 flex-row items-center gap-1 py-1"
                  testID="co-job-open-customer"
                >
                  <Text className="text-[14.5px] leading-[20px] text-accent-text" numberOfLines={2}>
                    {job.customer.name}
                  </Text>
                  <Icon as={ChevronRight} className="size-4 text-text-3" />
                </Pressable>
                {customerPhone ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={Phone}
                    accessibilityLabel={P.job.call(job.customer.name)}
                    onPress={() => actions.call(customerPhone)}
                    testID="co-job-call"
                  >
                    {P.job.callShort}
                  </Button>
                ) : null}
              </View>
            ) : (
              <Text className="text-[14.5px] leading-[20px] text-text-2">{W.job.noCustomer}</Text>
            )}
          </Fact>
          <Fact label={W.job.property}>{job.property?.name ?? W.job.noProperty}</Fact>
          <Fact label={W.job.lead}>{job.lead?.name ?? W.job.noLead}</Fact>
          {job.team.length ? (
            <Fact label={W.job.team}>{job.team.map((t) => t.name).join(', ')}</Fact>
          ) : null}
          {job.trade ? <Fact label={W.job.trade}>{TRADE_NAMES[job.trade]}</Fact> : null}
          {job.startsOn ? (
            <Fact label={W.job.startsOn}>{fmtMonthDay(job.startsOn, year)}</Fact>
          ) : null}
          {job.dueOn ? <Fact label={W.job.dueOn}>{fmtMonthDay(job.dueOn, year)}</Fact> : null}
          <Fact label={W.job.details} testID="co-job-details">
            {job.details ?? W.job.noDetails}
          </Fact>
        </Card>
      </View>

      <View className="gap-1.5" testID="co-job-progress">
        <SectionLabel>{job.phaseList.length ? W.job.phases.title : P.job.progress}</SectionLabel>
        {job.phaseList.length ? (
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {job.phaseList.map((p, i) => (
              <Pressable
                key={p.id}
                role="button"
                accessibilityLabel={P.job.phaseTitle(p.name)}
                disabled={!open}
                onPress={() => setPhase(p)}
                testID={`co-phase-${p.id}`}
                className={cn(
                  'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
                  i > 0 && 'border-t border-border',
                )}
              >
                <View className="min-w-0 flex-1 gap-px">
                  <Text className="text-[15px]" numberOfLines={2}>
                    {p.name}
                  </Text>
                  <Text className="text-[13px] text-text-3">
                    {[
                      p.status === 'in_progress' ? P.jobs.percentDone(p.percentDone) : null,
                      p.daysLate
                        ? lateWords(p.daysLate)
                        : p.dueOn && p.status !== 'done'
                          ? P.jobs.due(fmtMonthDay(p.dueOn, year))
                          : null,
                      waiting.phases.has(p.id) ? P.kept.waitingToSend : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Badge
                  variant={
                    p.status === 'done' ? 'ok' : p.status === 'in_progress' ? 'accent' : 'gray'
                  }
                >
                  {PHASE_STATUS_WORDS[p.status]}
                </Badge>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Card className="gap-2 px-3.5 py-3">
          <Text className="text-[15px] font-medium" testID="co-job-percent">
            {P.jobs.percentDone(job.percentDone)}
            {waiting.percent ? (
              <Text className="text-[13px] font-normal text-text-3">
                {` · ${P.kept.waitingToSend}`}
              </Text>
            ) : null}
          </Text>
          <View className="h-1.5 overflow-hidden rounded-full bg-card-2">
            <View className="h-full bg-accent" style={{ width: `${job.percentDone}%` }} />
          </View>
          {job.phaseList.length ? (
            <Text className="text-[12.5px] text-text-3">
              {P.jobs.phases(job.phases.done, job.phases.count)}
            </Text>
          ) : open ? (
            <Button
              variant="secondary"
              size="md"
              className="self-start"
              onPress={() => setSettingPercent(true)}
              testID="co-job-set-percent"
            >
              {W.job.setPercent}
            </Button>
          ) : null}
        </Card>
      </View>

      <View className="gap-1.5" testID="co-job-visits">
        <SectionLabel>{W.job.visits}</SectionLabel>
        {job.visits.length === 0 ? (
          <Card className="px-3.5 py-3">
            <Text className="text-[13.5px] text-text-2">{W.job.visitsNone}</Text>
          </Card>
        ) : (
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {job.visits.map((v, i) => (
              <VisitRow
                key={v.appointmentId}
                title={v.title}
                lines={[v.crew, visitDetail(v) || null]}
                startsAt={v.startsAt}
                endsAt={v.endsAt}
                day={fmtDateShort(localDateOf(Date.parse(v.startsAt), timeZone))}
                stage={v.stage}
                timeZone={timeZone}
                first={i === 0}
                onPress={() => actions.openVisit(v.appointmentId)}
                accessibilityLabel={P.jobs.openVisit(v.title)}
                testID={`co-visit-${v.appointmentId}`}
              />
            ))}
          </View>
        )}
      </View>

      <MaterialsCard
        title={W.materials.title}
        materials={materials}
        missing={materialsMissing}
        none={W.materials.none}
        waiting={waiting.materials}
        canCount={open}
        onCount={actions.count}
      />
      <TimeCard
        title={W.time.title}
        totals={totals}
        mine={mine}
        timeZone={timeZone}
        breakable={false}
        waiting={false}
        onBreak={async () => undefined}
      />
      <NotesCard
        title={W.notes.title}
        none={W.notes.none}
        notes={notes}
        truncated={notesTruncated}
        photosOf={photosOf}
        waiting={waiting.notes}
        jobName={job.name}
        timeZone={timeZone}
        me={me}
        removeAny={manages}
        actions={actions.notes}
      />
      <Text className="px-1 text-[12.5px] leading-[17px] text-text-3">{P.job.onTheWeb}</Text>

      <StatusSheet
        open={changingStatus}
        status={job.status}
        onClose={() => setChangingStatus(false)}
        onSave={actions.setStatus}
      />
      <PercentSheet
        open={settingPercent}
        percent={job.percentDone}
        onClose={() => setSettingPercent(false)}
        onSave={actions.setPercent}
      />
      <PhaseSheet
        phase={phase}
        onClose={() => setPhase(null)}
        onSave={(status) => (phase ? actions.setPhase(phase, status) : Promise.resolve(false))}
      />
    </Screen>
  );
}

/**
 * A job's own status, with signal: on hold and cancelled say why, and Done is refused while a required checklist
 * item is left, with what's left said here. Marking it done anyway is an owner's or admin's, on the web.
 */
export function StatusSheet({
  open,
  status,
  onClose,
  onSave,
}: {
  open: boolean;
  status: JobStatus;
  onClose: () => void;
  onSave: (status: JobStatus, reason: string) => Promise<string | null>;
}) {
  const [to, setTo] = React.useState<JobStatus | null>(null);
  const [reason, setReason] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setTo(null);
      setReason('');
      setProblem(null);
    }
  }, [open]);
  const needsReason = to !== null && STATUSES_WITH_REASON.includes(to);
  return (
    <Sheet open={open} onClose={onClose} title={P.job.statusTitle} testID="co-status-sheet">
      <View className="mt-2 gap-2">
        {JOB_STATUSES.filter((s) => s !== status).map((s) => (
          <Pressable
            key={s}
            role="radio"
            accessibilityState={{ checked: to === s }}
            onPress={() => {
              setTo(s);
              setProblem(null);
            }}
            testID={`co-status-${s}`}
            className={cn(
              'min-h-12 justify-center rounded-menu border px-3.5 py-2',
              to === s ? 'border-accent-soft-2 bg-accent-soft' : 'border-border bg-card',
            )}
          >
            <Text className={cn('text-[15px]', to === s && 'font-medium text-accent-text')}>
              {JOB_STATUS_WORDS[s]}
            </Text>
            <Text className="text-[12.5px] text-text-3">{JOB_STATUS_HINTS[s]}</Text>
          </Pressable>
        ))}
        {needsReason ? (
          <Input
            value={reason}
            onChangeText={(t) => {
              setReason(t);
              setProblem(null);
            }}
            placeholder={W.job.reasonPlaceholder[to as 'on_hold' | 'cancelled'] ?? W.job.reason}
            accessibilityLabel={W.job.reason}
            maxLength={300}
            invalid={!!problem && !reason.trim()}
            testID="co-status-reason"
          />
        ) : null}
        {problem ? (
          <Text className="text-[13px] leading-[18px] text-danger-text" testID="co-status-problem">
            {problem}
          </Text>
        ) : null}
        <Button
          disabled={to === null}
          loading={busy}
          onPress={async () => {
            if (to === null) return;
            if (needsReason && !reason.trim()) {
              setProblem(P.job.reasonNeeded(JOB_STATUS_WORDS[to]));
              return;
            }
            setBusy(true);
            const refused = await onSave(to, needsReason ? reason.trim() : '');
            setBusy(false);
            if (refused) setProblem(refused);
            else onClose();
          }}
          testID="co-status-save"
        >
          {W.job.save}
        </Button>
      </View>
    </Sheet>
  );
}

const TENTHS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** A service call's % done, in tenths: one press saves it, and it waits on the phone with no signal. */
export function PercentSheet({
  open,
  percent,
  onClose,
  onSave,
}: {
  open: boolean;
  percent: number;
  onClose: () => void;
  onSave: (percentDone: number) => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState<number | null>(null);
  return (
    <Sheet open={open} onClose={onClose} title={P.job.percentTitle} testID="co-percent-sheet">
      <View className="mt-2 flex-row flex-wrap gap-2">
        {TENTHS.map((p) => (
          <Button
            key={p}
            size="md"
            variant={p === percent ? 'primary' : 'secondary'}
            className="min-w-[72px]"
            loading={busy === p}
            disabled={busy !== null}
            onPress={async () => {
              setBusy(p);
              const ok = await onSave(p);
              setBusy(null);
              if (ok) onClose();
            }}
            testID={`co-percent-${p}`}
          >
            {P.job.percentOf(p)}
          </Button>
        ))}
      </View>
    </Sheet>
  );
}

/** Where a phase stands: not started, started or done. Its % follows, and the job's with it. */
export function PhaseSheet({
  phase,
  onClose,
  onSave,
}: {
  phase: PhonePhase | null;
  onClose: () => void;
  onSave: (status: PhaseStatus) => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState<PhaseStatus | null>(null);
  return (
    <Sheet
      open={!!phase}
      onClose={onClose}
      title={phase ? P.job.phaseTitle(phase.name) : undefined}
      testID="co-phase-sheet"
    >
      <View className="mt-2 gap-2">
        {PHASE_STATUSES.map((s) => (
          <Button
            key={s}
            variant={phase?.status === s ? 'primary' : 'secondary'}
            loading={busy === s}
            disabled={busy !== null || phase?.status === s}
            onPress={async () => {
              setBusy(s);
              const ok = await onSave(s);
              setBusy(null);
              if (ok) onClose();
            }}
            testID={`co-phase-${s}`}
          >
            {PHASE_STATUS_WORDS[s]}
          </Button>
        ))}
      </View>
    </Sheet>
  );
}
