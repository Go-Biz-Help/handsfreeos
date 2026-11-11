import { fmtWhen } from '@hfos/core';
import { checklistWords } from '@hfos/core/addons/contractor/checklists';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import { isOpen } from '@hfos/core/addons/contractor/progress';
import type { TimeKind, TimeTotals } from '@hfos/core/addons/contractor/time';
import {
  phoneMaterials,
  phoneNotes,
  phoneTime,
  phoneWorkOrder,
  type PhoneItem,
  type PhoneMaterial,
  type PhoneNote,
  type PhoneWorkOrder,
} from '@hfos/core/addons/contractor/views/phone';
import {
  CONTRACTOR_WORDS as W,
  JOB_STATUS_WORDS,
  namesWords,
} from '@hfos/core/addons/contractor/words';
import { useQuery } from '@powersync/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Camera, Check, ChevronRight, MapPin } from '@/components/icons';
import { VisitJob } from '@/components/calendar/visit-job';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openMaps } from '@/lib/maps';
import { cn } from '@/lib/utils';

import { setBreak, setItem } from './actions';
import { JobStatusBadge, StageBadge } from './bits';
import { useContractorCopy } from './copy';
import { attempt, takeJobPhoto, useFieldActions } from './field';
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
 * A visit's work order on the phone (docs/contractor.md, "On the phone"): when and where with directions, the visit's
 * own status buttons (core's, which start and stop the clock), its instructions and what to bring, who's going, the
 * checklist to tick and its photos to take, what this visit needs of the job's materials with a count of what was
 * used, the time on it with a break, and its notes. All of it is the phone's copy, and every change here waits on
 * the phone with no signal. Putting a crew on it, its subcontractors and editing its checklist are the web's.
 */

/**
 * Whether a visit is one the customer booked, which core's status buttons are for, and its saved place, which
 * core's own rule reads to decide whether the buttons fit the visit.
 */
export const CO_VISIT_KIND_SQL = 'SELECT kind, status, location FROM appointments WHERE id = ?';

export interface VisitActions {
  openJob(jobId: string): void;
  backToJobs(): void;
  directions(address: string): void;
  /** Ticks or unticks a checkbox item. */
  setItem(item: PhoneItem, done: boolean): Promise<boolean>;
  /** Takes a photo item's photo, which marks it done. */
  takeItemPhoto(item: PhoneItem): Promise<boolean>;
  setBreak(onBreak: boolean): Promise<boolean>;
  count(material: PhoneMaterial, amounts: CountAmounts): Promise<boolean>;
  notes: NoteActions;
}

export interface VisitWaiting {
  readonly total: number;
  readonly items: ReadonlySet<string>;
  readonly materials: ReadonlySet<string>;
  readonly notes: ReadonlySet<string>;
  readonly time: boolean;
}

export const NO_VISIT_WAITING: VisitWaiting = {
  total: 0,
  items: new Set(),
  materials: new Set(),
  notes: new Set(),
  time: false,
};

export function VisitScreen({ appointmentId }: { appointmentId: string }) {
  const ctx = useCoContext();
  const { workspaceId, userId } = ctx;
  const copy = useContractorCopy(workspaceId, { kind: 'visit', appointmentId });
  const changes = useCoChanges(workspaceId);
  const booked = useQuery<{ kind: string; status: string; location: string | null }>(
    CO_VISIT_KIND_SQL,
    [appointmentId],
  ).data[0];
  const order = React.useMemo(() => phoneWorkOrder(copy, appointmentId), [copy, appointmentId]);
  const jobId = order?.job.id ?? '';
  const time = React.useMemo(
    () => phoneTime(copy, jobId, { appointmentId, me: userId, now: ctx.now }),
    [copy, jobId, appointmentId, userId, ctx.now],
  );
  const notes = React.useMemo(
    () => phoneNotes(copy, jobId, appointmentId),
    [copy, jobId, appointmentId],
  );
  const photosOf = React.useMemo(
    () => new Map((copy.notes.get(jobId) ?? []).map((n) => [n.id, n.photoFileIds.length])),
    [copy, jobId],
  );
  const missing = React.useMemo(
    () => phoneMaterials(copy, jobId, appointmentId).missing,
    [copy, jobId, appointmentId],
  );
  const waiting = React.useMemo<VisitWaiting>(() => {
    const of = (name: string) => changes.filter((c) => c.name === name);
    return {
      total: changes.length,
      items: waitingIds(of('contractor.work_order.item_set'), 'itemId'),
      materials: waitingIds(of('contractor.material.count'), 'materialId'),
      notes: waitingIds(of('contractor.note.add'), 'id'),
      time: of('contractor.time.set_break').some((c) => c.input.appointmentId === appointmentId),
    };
  }, [changes, appointmentId]);
  const field = useFieldActions({
    workspaceId,
    userId,
    jobId,
    jobName: order?.job.name ?? '',
    appointmentId,
  });
  const running = time.mine?.entryId ?? null;
  const mine = running ? time.entries.find((e) => e.id === running) : undefined;
  const actions = React.useMemo<VisitActions>(
    () => ({
      openJob: (id) => openCo(workspaceId, `jobs/${id}`),
      backToJobs: () => router.replace(coHref(workspaceId)),
      directions: (address) => void openMaps(address),
      setItem: (item, done) =>
        attempt(() => setItem({ workspaceId, itemId: item.id, done, userId })),
      takeItemPhoto: async (item) => {
        // Nothing is said when no photo was taken: the camera was closed, or isn't allowed and has said so.
        let taken = false;
        const ok = await attempt(async () => {
          const photo = await takeJobPhoto({ workspaceId, jobId, userId });
          if (!photo) return;
          await setItem({
            workspaceId,
            itemId: item.id,
            done: true,
            userId,
            fileId: photo.fileId,
            dependsOn: [photo.upload],
          });
          taken = true;
        });
        if (ok && taken) toast.show(P.visit.photoKept);
        return ok && taken;
      },
      setBreak: (onBreak) =>
        running
          ? attempt(
              () =>
                setBreak({
                  workspaceId,
                  jobId,
                  appointmentId,
                  userId,
                  onBreak,
                  running: { entryId: running },
                }),
              onBreak ? W.time.breakStarted : W.time.breakEnded,
            )
          : Promise.resolve(false),
      count: field.count,
      notes: field.notes,
    }),
    [workspaceId, userId, jobId, appointmentId, running, field],
  );
  return (
    <VisitView
      order={order}
      timeZone={ctx.timeZone}
      me={userId}
      manages={ctx.holds(CO_MANAGE)}
      materialsMissing={missing}
      totals={time.totals}
      mine={mine ? { kind: mine.kind, startedAt: mine.startedAt } : null}
      notes={notes.notes}
      notesTruncated={notes.truncated}
      photosOf={photosOf}
      waiting={waiting}
      statusButtons={
        order && booked?.kind === 'booking' && booked.status === 'scheduled' ? (
          <VisitJob
            appointmentId={appointmentId}
            location={booked.location ?? null}
            timeZone={ctx.timeZone}
          />
        ) : null
      }
      actions={actions}
    />
  );
}

export function VisitView({
  order,
  timeZone,
  me,
  manages,
  materialsMissing,
  totals,
  mine,
  notes,
  notesTruncated,
  photosOf,
  waiting = NO_VISIT_WAITING,
  statusButtons,
  actions,
}: {
  order: PhoneWorkOrder | null;
  timeZone: string;
  me: string;
  manages: boolean;
  /** How many of this visit's materials aren't all here yet. */
  materialsMissing: number;
  totals: TimeTotals;
  mine: { readonly kind: TimeKind; readonly startedAt: string } | null;
  notes: readonly PhoneNote[];
  notesTruncated: boolean;
  photosOf: ReadonlyMap<string, number>;
  waiting?: VisitWaiting;
  /** Core's own buttons for the visit (On my way, Started, Waiting on parts, Job done), while it's still booked. */
  statusButtons?: React.ReactNode;
  actions: VisitActions;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);

  if (!order)
    return (
      <Screen title={W.workOrder.title} leading="back" testID="co-visit">
        <Card className="gap-3 p-4">
          <Text className="text-[14px] leading-[20px] text-text-2" testID="co-visit-gone">
            {P.visit.gone}
          </Text>
          <Button variant="secondary" onPress={actions.backToJobs} testID="co-visit-back">
            {P.job.backToJobs}
          </Button>
        </Card>
      </Screen>
    );

  const { visit, job } = order;
  const cancelled = visit.status === 'cancelled';
  const open = isOpen(job.status);
  const canChange = open && !cancelled;
  const address = visit.location ?? job.property?.name ?? null;
  const going = [
    ...order.people.map((p) => p.name),
    ...order.subs.map((s) => (s.company ? `${s.name} (${s.company})` : s.name)),
  ];
  const run = async (key: string, act: () => Promise<boolean>) => {
    setBusy(key);
    await act();
    setBusy(null);
  };
  return (
    <Screen title={W.workOrder.title} subtitle={job.name} leading="back" testID="co-visit">
      <KeptStrip waiting={waiting.total} />

      <Card className="gap-3 px-3.5 py-3" testID="co-visit-when">
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-[16px] font-semibold" numberOfLines={3}>
              {visit.title}
            </Text>
            <Text className="text-[14px] text-text-2">
              {fmtWhen(visit.startsAt, visit.endsAt, timeZone)}
            </Text>
          </View>
          <StageBadge stage={visit.stage} testID="co-visit-stage" />
        </View>
        {address ? (
          <Fact label={P.visit.where}>
            <View className="gap-2">
              <Text className="text-[14.5px] leading-[20px]">{address}</Text>
              <Button
                variant="secondary"
                size="sm"
                icon={MapPin}
                className="self-start"
                onPress={() => actions.directions(address)}
                testID="co-visit-directions"
              >
                {P.visit.directions}
              </Button>
            </View>
          </Fact>
        ) : null}
        <Pressable
          role="button"
          accessibilityLabel={P.jobs.openJob(job.name)}
          onPress={() => actions.openJob(job.id)}
          className="min-h-11 flex-row items-center gap-2 border-t border-border pt-2.5"
          testID="co-visit-job"
        >
          <View className="min-w-0 flex-1 gap-px">
            <Text className="text-[12.5px] text-text-3">{W.workOrder.job}</Text>
            <Text className="text-[14.5px] text-accent-text" numberOfLines={2}>
              {[job.name, job.customer?.name].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <JobStatusBadge status={job.status} />
          <Icon as={ChevronRight} className="size-4 text-text-3" />
        </Pressable>
      </Card>

      {cancelled || !open ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px] leading-[19px] text-text-2" testID="co-visit-closed">
            {cancelled ? W.workOrder.cancelled : W.workOrder.closed(JOB_STATUS_WORDS[job.status])}
          </Text>
        </Card>
      ) : null}

      {canChange ? statusButtons : null}

      <View className="gap-1.5">
        <SectionLabel>{W.workOrder.workToDo}</SectionLabel>
        <Card className="gap-3 px-3.5 py-3" testID="co-visit-work">
          {job.details ? <Fact label={W.job.details}>{job.details}</Fact> : null}
          <Fact label={W.workOrder.instructions} testID="co-visit-instructions">
            {order.instructions ?? W.workOrder.noInstructions}
          </Fact>
          <Fact label={W.workOrder.bring} testID="co-visit-bring">
            {order.bring ?? W.workOrder.noBring}
          </Fact>
          <Fact label={W.workOrder.whoGoes} testID="co-visit-going">
            {[order.crew?.name, going.length ? namesWords(going, 6) : W.workOrder.peopleNone]
              .filter(Boolean)
              .join(' · ')}
          </Fact>
        </Card>
      </View>

      <View className="gap-1.5" testID="co-checklist">
        <SectionLabel
          end={
            order.items.length ? (
              <Text className="text-[12.5px] text-text-3" testID="co-checklist-progress">
                {checklistWords(order.progress)}
              </Text>
            ) : undefined
          }
        >
          {W.workOrder.checklist}
        </SectionLabel>
        {order.items.length === 0 ? (
          <Card className="px-3.5 py-3">
            <Text className="text-[13.5px] text-text-2">{W.workOrder.checklistNone}</Text>
          </Card>
        ) : (
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {order.items.map((item, i) => (
              <ItemRow
                key={item.id}
                item={item}
                first={i === 0}
                canChange={canChange}
                waiting={waiting.items.has(item.id)}
                busy={busy === item.id}
                onTick={() =>
                  void run(item.id, () =>
                    item.kind === 'photo' && !item.done
                      ? actions.takeItemPhoto(item)
                      : actions.setItem(item, !item.done),
                  )
                }
                onRetake={() => void run(item.id, () => actions.takeItemPhoto(item))}
              />
            ))}
          </View>
        )}
        {order.items.length ? (
          <Text
            className="px-1 text-[12.5px] leading-[17px] text-text-3"
            testID="co-checklist-left"
          >
            {order.progress.requiredLeft
              ? W.workOrder.left(order.progress.requiredLeft)
              : W.workOrder.ready}
          </Text>
        ) : null}
      </View>

      <MaterialsCard
        title={W.materials.visitTitle}
        materials={order.materials}
        missing={materialsMissing}
        none={W.materials.noneForVisit}
        waiting={waiting.materials}
        canCount={canChange}
        onCount={actions.count}
      />
      <TimeCard
        title={W.time.visitTitle}
        totals={totals}
        mine={mine}
        timeZone={timeZone}
        breakable={canChange}
        waiting={waiting.time}
        onBreak={actions.setBreak}
      />
      <NotesCard
        title={W.notes.visitTitle}
        none={W.notes.noneForVisit}
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
    </Screen>
  );
}

/** One checklist item: a box to tick, or a photo to take, with who did it and what's still waiting to send. */
function ItemRow({
  item,
  first,
  canChange,
  waiting,
  busy,
  onTick,
  onRetake,
}: {
  item: PhoneItem;
  first: boolean;
  canChange: boolean;
  waiting: boolean;
  busy: boolean;
  onTick: () => void;
  onRetake: () => void;
}) {
  const photo = item.kind === 'photo';
  return (
    <View
      className={cn('flex-row items-start gap-3 px-3.5 py-2.5', !first && 'border-t border-border')}
      testID={`co-item-${item.id}`}
    >
      <Pressable
        role="checkbox"
        accessibilityState={{ checked: item.done, disabled: !canChange || busy }}
        accessibilityLabel={
          item.done
            ? W.workOrder.untick(item.label)
            : photo
              ? `${P.visit.takePhoto}: ${item.label}`
              : W.workOrder.tick(item.label)
        }
        disabled={!canChange || busy}
        onPress={onTick}
        hitSlop={8}
        testID={`co-item-tick-${item.id}`}
        className={cn(
          'mt-0.5 size-7 items-center justify-center rounded-[8px] border',
          item.done ? 'border-accent bg-accent' : 'border-border-strong bg-card',
          (!canChange || busy) && 'opacity-60',
        )}
      >
        {item.done ? (
          <Icon as={Check} className="size-4 text-white" />
        ) : photo ? (
          <Icon as={Camera} className="size-4 text-text-2" />
        ) : null}
      </Pressable>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-start gap-2">
          <Text
            className={cn('min-w-0 flex-1 text-[15px] leading-[21px]', item.done && 'text-text-2')}
          >
            {item.label}
          </Text>
          {item.required && !item.done && !item.skipped ? (
            <Badge variant="pending">{W.workOrder.required}</Badge>
          ) : null}
        </View>
        {item.done || item.skipped || waiting ? (
          <Text
            className="text-[12.5px] leading-[17px] text-text-3"
            testID={`co-item-line-${item.id}`}
          >
            {[
              item.done
                ? W.workOrder.doneBy(item.doneBy)
                : item.skipped
                  ? W.workOrder.skipped(item.skipped.by, item.skipped.reason)
                  : null,
              // Ticked with a photo the phone is still uploading: its file isn't in the phone's copy yet.
              item.done && photo && !item.file ? P.visit.photoWaiting : null,
              waiting ? P.kept.waitingToSend : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : null}
        {photo && canChange ? (
          item.done ? (
            <Button
              variant="ghost"
              size="sm"
              icon={Camera}
              className="self-start px-0"
              loading={busy}
              onPress={onRetake}
              testID={`co-item-retake-${item.id}`}
            >
              {P.visit.retakePhoto}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={Camera}
              className="self-start"
              loading={busy}
              onPress={onTick}
              testID={`co-item-photo-${item.id}`}
            >
              {P.visit.takePhoto}
            </Button>
          )
        ) : null}
      </View>
    </View>
  );
}
