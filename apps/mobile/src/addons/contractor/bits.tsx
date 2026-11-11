import { daysBetween, fmtMonthDay, fmtRange, type JobStatus as VisitStage } from '@hfos/core';
import { checklistWords, type ChecklistProgress } from '@hfos/core/addons/contractor/checklists';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import { isOpen, type JobStatus } from '@hfos/core/addons/contractor/progress';
import {
  dueWords,
  JOB_STATUS_WORDS,
  lateWords,
  materialsMissingWords,
  VISIT_STAGE_WORDS,
} from '@hfos/core/addons/contractor/words';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { ChevronRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The small pieces Contractor Operations' phone screens share: a job's status and a visit's stage as badges, a
 * deadline in words, and a visit's row in a list.
 */

type Tone = 'accent' | 'pending' | 'ok' | 'gray';

const JOB_TONE: Readonly<Record<JobStatus, Tone>> = {
  new: 'gray',
  scheduled: 'accent',
  in_progress: 'accent',
  on_hold: 'pending',
  done: 'ok',
  cancelled: 'gray',
};

export function JobStatusBadge({ status, testID }: { status: JobStatus; testID?: string }) {
  return (
    <Badge variant={JOB_TONE[status]} testID={testID}>
      {JOB_STATUS_WORDS[status]}
    </Badge>
  );
}

const STAGE_TONE: Readonly<Record<VisitStage, Tone>> = {
  scheduled: 'gray',
  on_the_way: 'accent',
  in_progress: 'accent',
  waiting_on_parts: 'pending',
  done: 'ok',
  cancelled: 'gray',
};

export function StageBadge({ stage, testID }: { stage: VisitStage; testID?: string }) {
  return (
    <Badge variant={STAGE_TONE[stage]} testID={testID}>
      {VISIT_STAGE_WORDS[stage]}
    </Badge>
  );
}

/** "3 days late" · "Due in 4 days" · "Due Nov 28", as the web's lists say it. Nothing for a job that's closed. */
export function deadlineOf(
  job: {
    readonly status: JobStatus;
    readonly dueOn: string | null;
    readonly daysLate: number | null;
  },
  today: string,
): { readonly words: string; readonly late: boolean } | null {
  if (!isOpen(job.status) || !job.dueOn) return null;
  if (job.daysLate) return { words: lateWords(job.daysLate), late: true };
  const left = daysBetween(today, job.dueOn);
  return {
    words:
      left <= 14 ? dueWords(left) : P.jobs.due(fmtMonthDay(job.dueOn, Number(today.slice(0, 4)))),
    late: false,
  };
}

/** A visit's second line in a list: its checklist, and what's still missing for it while it's still to do. */
export function visitDetail(v: {
  readonly stage: VisitStage;
  readonly checklist: ChecklistProgress | null;
  readonly materialsMissing: number;
}): string {
  return [
    v.checklist ? checklistWords(v.checklist) : null,
    v.materialsMissing && v.stage !== 'done' && v.stage !== 'cancelled'
      ? materialsMissingWords(v.materialsMissing)
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One visit in a list: when, what it's called or whose job it is, where it stands, and how far its checklist is. */
export function VisitRow({
  title,
  lines,
  startsAt,
  endsAt,
  day,
  stage,
  timeZone,
  first,
  onPress,
  accessibilityLabel,
  testID,
}: {
  title: string;
  /** Under the title: the customer and property, the checklist. Empty ones are left out. */
  lines: readonly (string | null)[];
  startsAt: string;
  endsAt: string;
  /** Its day ("Tue, Nov 12"), where the list spans more than one. */
  day?: string;
  stage: VisitStage;
  timeZone: string;
  first: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
      className={cn(
        'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
        !first && 'border-t border-border',
      )}
    >
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-[12.5px] font-medium text-text-2">
          {[day, fmtRange(startsAt, endsAt, timeZone)].filter(Boolean).join(' · ')}
        </Text>
        <Text className="text-[15px]" numberOfLines={2}>
          {title}
        </Text>
        {lines.filter(Boolean).map((line, i) => (
          <Text key={i} className="text-[13px] text-text-3" numberOfLines={2}>
            {line}
          </Text>
        ))}
      </View>
      <StageBadge stage={stage} />
      <Icon as={ChevronRight} className="size-4 text-text-3" />
    </Pressable>
  );
}

/** Calls a number in the phone's own dialer. */
export const callNumber = (phone: string) =>
  void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => undefined);
