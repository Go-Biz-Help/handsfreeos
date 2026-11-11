import { addDays, fmtAt, startOfLocalDay } from '@hfos/core';
import { CONTRACTOR_PHONE_WORDS as P } from '@hfos/core/addons/contractor/phone-words';
import {
  PHONE_LIMITS,
  phoneDayVisits,
  phoneJobList,
  type PhoneDayVisit,
  type PhoneJobRow,
} from '@hfos/core/addons/contractor/views/phone';
import { CONTRACTOR_WORDS as W } from '@hfos/core/addons/contractor/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronRight } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { deadlineOf, JobStatusBadge, visitDetail, VisitRow } from './bits';
import { useContractorCopy } from './copy';
import { KeptStrip, openCo, SectionLabel, useCoChanges, useCoContext } from './kit';

/**
 * Jobs on the phone (docs/contractor.md, "On the phone"): the person's visits today, each opening its work order,
 * then the business's jobs (theirs, all of them, or the late ones) with a search, worked out from the phone's copy
 * by core's views so it reads the same with no signal. New jobs, dispatch, estimates and costs are the web's.
 */

export type JobsFilter = 'mine' | 'all' | 'late';

const isFilter = (s: string | undefined): s is JobsFilter =>
  s === 'mine' || s === 'all' || s === 'late';

export function JobsScreen({ filter: asked, q }: { filter?: string; q?: string }) {
  const ctx = useCoContext();
  const { business } = useBusiness();
  const copy = useContractorCopy(ctx.workspaceId, { kind: 'lists' });
  const waiting = useCoChanges(ctx.workspaceId).length;
  const [picked, setPicked] = React.useState<JobsFilter | null>(isFilter(asked) ? asked : null);
  const [closedToo, setClosedToo] = React.useState(false);
  const [search, setSearch] = React.useState(q ?? '');
  const at = React.useMemo(() => ({ today: ctx.today, now: ctx.now }), [ctx.today, ctx.now]);

  const visits = React.useMemo(
    () =>
      phoneDayVisits(copy, {
        from: startOfLocalDay(ctx.today, ctx.timeZone),
        to: startOfLocalDay(addDays(ctx.today, 1), ctx.timeZone),
        me: ctx.userId,
      }),
    [copy, ctx.today, ctx.timeZone, ctx.userId],
  );
  // Until the person picks: their own jobs when they have any, the business's otherwise.
  const anyMine = React.useMemo(
    () => phoneJobList(copy, { filter: 'mine', me: ctx.userId }, at).jobs.length > 0,
    [copy, ctx.userId, at],
  );
  const filter = picked ?? (anyMine ? 'mine' : 'all');
  const list = React.useMemo(
    () => phoneJobList(copy, { filter, includeClosed: closedToo, search, me: ctx.userId }, at),
    [copy, filter, closedToo, search, ctx.userId, at],
  );

  return (
    <JobsView
      businessName={business.name}
      timeZone={ctx.timeZone}
      today={ctx.today}
      waiting={waiting}
      visits={visits}
      filter={filter}
      onFilter={setPicked}
      closedToo={closedToo}
      onClosedToo={setClosedToo}
      search={search}
      onSearch={setSearch}
      jobs={list.jobs}
      truncated={list.truncated}
      onOpenJob={(jobId) => openCo(ctx.workspaceId, `jobs/${jobId}`)}
      onOpenVisit={(appointmentId) => openCo(ctx.workspaceId, `visits/${appointmentId}`)}
    />
  );
}

export function JobsView({
  businessName,
  timeZone,
  today,
  waiting = 0,
  visits,
  filter,
  onFilter,
  closedToo,
  onClosedToo,
  search,
  onSearch,
  jobs,
  truncated,
  onOpenJob,
  onOpenVisit,
}: {
  businessName: string;
  timeZone: string;
  today: string;
  /** How many of the add-on's changes wait on this phone. */
  waiting?: number;
  visits: readonly PhoneDayVisit[];
  filter: JobsFilter;
  onFilter: (f: JobsFilter) => void;
  closedToo: boolean;
  onClosedToo: (on: boolean) => void;
  search: string;
  onSearch: (q: string) => void;
  jobs: readonly PhoneJobRow[];
  truncated: boolean;
  onOpenJob: (jobId: string) => void;
  onOpenVisit: (appointmentId: string) => void;
}) {
  const q = search.trim();
  return (
    <Screen title={P.more.jobs} subtitle={businessName} leading="back" testID="co-jobs">
      <KeptStrip waiting={waiting} />

      <View className="gap-1.5" testID="co-today">
        <SectionLabel>{P.jobs.today}</SectionLabel>
        {visits.length === 0 ? (
          <Card className="px-3.5 py-3">
            <Text className="text-[13.5px] text-text-2" testID="co-today-none">
              {P.jobs.noVisits}
            </Text>
          </Card>
        ) : (
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {visits.map((v, i) => (
              <VisitRow
                key={v.appointmentId}
                title={v.job.name}
                lines={[
                  [v.customer, v.property].filter(Boolean).join(' · ') || null,
                  visitDetail(v) || null,
                ]}
                startsAt={v.startsAt}
                endsAt={v.endsAt}
                stage={v.stage}
                timeZone={timeZone}
                first={i === 0}
                onPress={() => onOpenVisit(v.appointmentId)}
                accessibilityLabel={P.jobs.openVisit(v.job.name)}
                testID={`co-today-${v.appointmentId}`}
              />
            ))}
          </View>
        )}
      </View>

      <View className="gap-2">
        <Segmented
          value={filter}
          onChange={onFilter}
          label={P.jobs.whose}
          options={[
            { value: 'mine', label: P.jobs.filters.mine, testID: 'co-jobs-mine' },
            { value: 'all', label: P.jobs.filters.all, testID: 'co-jobs-all' },
            { value: 'late', label: P.jobs.filters.late, testID: 'co-jobs-late' },
          ]}
        />
        <Input
          value={search}
          onChangeText={onSearch}
          placeholder={W.jobs.search}
          accessibilityLabel={W.jobs.search}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="co-jobs-search"
        />
        {filter === 'late' ? null : (
          <View className="flex-row">
            <FilterChip
              label={P.jobs.closedToo}
              on={closedToo}
              onPress={() => onClosedToo(!closedToo)}
              testID="co-jobs-closed"
            />
          </View>
        )}
      </View>

      {jobs.length === 0 ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px] leading-[19px] text-text-2" testID="co-jobs-none">
            {q ? P.jobs.noMatch(q) : P.jobs.none[filter]}
          </Text>
        </Card>
      ) : (
        <View
          className="overflow-hidden rounded-card border border-border bg-card"
          testID="co-job-list"
        >
          {jobs.map((j, i) => (
            <JobRow
              key={j.id}
              job={j}
              today={today}
              timeZone={timeZone}
              first={i === 0}
              onPress={() => onOpenJob(j.id)}
            />
          ))}
        </View>
      )}
      {truncated ? (
        <Text className="px-1 text-[12.5px] text-text-3" testID="co-jobs-truncated">
          {P.jobs.truncated(PHONE_LIMITS.list)}
        </Text>
      ) : null}
      <Text className="px-1 text-[12.5px] leading-[17px] text-text-3">{P.more.onTheWeb}</Text>
    </Screen>
  );
}

function JobRow({
  job,
  today,
  timeZone,
  first,
  onPress,
}: {
  job: PhoneJobRow;
  today: string;
  timeZone: string;
  first: boolean;
  onPress: () => void;
}) {
  const deadline = deadlineOf(job, today);
  const who = [job.customer?.name, job.property?.name].filter(Boolean).join(' · ');
  return (
    <Pressable
      role="button"
      accessibilityLabel={P.jobs.openJob(job.name)}
      onPress={onPress}
      testID={`co-job-${job.id}`}
      className={cn(
        'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
        !first && 'border-t border-border',
      )}
    >
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-[15px]" numberOfLines={2}>
          {job.name}
        </Text>
        {who ? (
          <Text className="text-[13px] text-text-3" numberOfLines={1}>
            {who}
          </Text>
        ) : null}
        <Text className="text-[13px] text-text-3">
          {job.phases.count
            ? P.jobs.phases(job.phases.done, job.phases.count)
            : P.jobs.percentDone(job.percentDone)}
          {deadline ? (
            <Text className={cn('text-[13px]', deadline.late ? 'text-danger-text' : 'text-text-3')}>
              {` · ${deadline.words}`}
            </Text>
          ) : null}
        </Text>
        {job.nextVisitAt ? (
          <Text className="text-[13px] text-text-3">
            {P.jobs.nextVisit(fmtAt(job.nextVisitAt, timeZone))}
          </Text>
        ) : null}
      </View>
      <JobStatusBadge status={job.status} />
      <Icon as={ChevronRight} className="size-4 text-text-3" />
    </Pressable>
  );
}
