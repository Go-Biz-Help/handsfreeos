import { fmtMonthDay, localDateOf, localDayOf } from '@hfos/core';
import { inSentence } from '@hfos/core/addons/realestate/contingencies';
import { RE_COORDINATE_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { dueWords } from '@hfos/core/addons/realestate/rule-words';
import {
  exceptionsOfCopy,
  todayOfCopy,
  waitingRoomOfCopy,
  workloadOfCopy,
  type CoordinateFilter,
  type ExceptionsView,
  type TodayView,
  type WaitingRoomView,
  type WorkloadView,
} from '@hfos/core/addons/realestate/views/coordinate';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { CircleAlert, Clock, ShieldCheck, TriangleAlert, WifiOff } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { acknowledgeDuty } from './deal-actions';
import { Footnote, GroupLabel, KeptStrip, Tabs, type Health } from './deal-bits';
import { openRe, useReContext } from './kit';

/**
 * Coordinate (board 77): what needs a person today across the deals they coordinate, most urgent first; anything that
 * skipped the normal path (values to confirm, dates that disagree, linked deals that moved, contingencies past their
 * end, proof missing); who and what is waiting; and, for whoever sees every deal, who carries what. Reading works with
 * no signal; fixing some of it needs signal, and says so.
 */

export type CoordinateTab = 'today' | 'exceptions' | 'waiting' | 'workload';

export function CoordinateScreen({
  tab,
  mine,
  agent,
}: {
  tab?: string;
  mine?: string;
  agent?: string;
}) {
  const ctx = useReContext();
  const { business, me } = useBusiness();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'all' });
  const onlyMine = mine === '1' || mine === 'true';
  const filter = React.useMemo<CoordinateFilter>(
    () => ({ ...(onlyMine ? { mine: true } : {}), ...(agent ? { agentUserId: agent } : {}) }),
    [onlyMine, agent],
  );
  const views = React.useMemo(
    () => ({
      today: todayOfCopy(copy, filter, ctx),
      exceptions: exceptionsOfCopy(copy, filter, ctx),
      waiting: waitingRoomOfCopy(copy, filter, ctx),
      workload: workloadOfCopy(copy, filter, ctx),
    }),
    [copy, ctx, filter],
  );
  const start: CoordinateTab =
    tab === 'exceptions' || tab === 'waiting' || (tab === 'workload' && views.workload)
      ? (tab as CoordinateTab)
      : 'today';
  return (
    <CoordinateView
      initialTab={start}
      subtitle={RE_COORDINATE_WORDS.subtitle(business.name, me.user.fullName || me.user.email)}
      {...views}
      timeZone={ctx.timeZone}
      now={ctx.now}
      workspaceId={ctx.workspaceId}
      onDuty={(dutyId) => openRe(ctx.workspaceId, `coordinate?duty=${dutyId}`)}
      onDeal={(dealId, page) => openRe(ctx.workspaceId, `deals/${dealId}${page ? `/${page}` : ''}`)}
    />
  );
}

export function CoordinateView({
  initialTab,
  subtitle,
  today,
  exceptions,
  waiting,
  workload,
  timeZone,
  now,
  workspaceId,
  onDuty,
  onDeal,
}: {
  initialTab: CoordinateTab;
  subtitle: string;
  today: TodayView;
  exceptions: ExceptionsView;
  waiting: WaitingRoomView;
  workload: WorkloadView | null;
  timeZone: string;
  now: number;
  workspaceId: string;
  onDuty: (dutyId: string) => void;
  onDeal: (dealId: string, page?: string) => void;
}) {
  const [tab, setTab] = React.useState<CoordinateTab>(initialTab);
  const counts = {
    today: today.atRisk.length + today.overdue.length + today.dueToday.length,
    exceptions:
      exceptions.reads.length +
      exceptions.disagree.length +
      exceptions.nobodyAccountable.length +
      exceptions.noProof.length +
      exceptions.contingencies.length +
      exceptions.blocked.length,
    waiting: waiting.items.length,
  };
  return (
    <Screen
      title={RE_COORDINATE_WORDS.title}
      subtitle={subtitle}
      leading="back"
      scroll={false}
      testID="re-coordinate"
    >
      <KeptStrip />
      <Tabs
        value={tab}
        onChange={setTab}
        label={RE_COORDINATE_WORDS.title}
        tabs={[
          { value: 'today', label: RE_COORDINATE_WORDS.tabs.today(counts.today) },
          { value: 'exceptions', label: RE_COORDINATE_WORDS.tabs.exceptions(counts.exceptions) },
          { value: 'waiting', label: RE_COORDINATE_WORDS.tabs.waiting(counts.waiting) },
          ...(workload
            ? [{ value: 'workload' as const, label: RE_COORDINATE_WORDS.tabs.workload }]
            : []),
        ]}
        testID="re-coordinate-tabs"
      />
      <ScrollView contentContainerClassName="gap-2.5 p-3 pb-8">
        {tab === 'today' ? (
          <TodayTab
            today={today}
            timeZone={timeZone}
            now={now}
            workspaceId={workspaceId}
            onDuty={onDuty}
            onDeal={onDeal}
          />
        ) : tab === 'exceptions' ? (
          <ExceptionsTab
            data={exceptions}
            timeZone={timeZone}
            now={now}
            onDuty={onDuty}
            onDeal={onDeal}
          />
        ) : tab === 'waiting' ? (
          <WaitingTab data={waiting} timeZone={timeZone} now={now} onDuty={onDuty} />
        ) : workload ? (
          <WorkloadTab data={workload} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** One thing to look at: its icon, title and deal, when, what it says, and what can be done. */
function Item({
  tone,
  icon,
  title,
  deal,
  aside,
  body,
  children,
  testID,
}: {
  tone: 'danger' | 'warning' | 'quiet' | 'ok';
  icon: React.ComponentProps<typeof Icon>['as'];
  title: string;
  deal?: string;
  aside?: string | null;
  body?: string | null;
  children?: React.ReactNode;
  testID?: string;
}) {
  return (
    <Card
      className={cn('gap-2 px-3.5 py-3', tone === 'danger' && 'border-danger-soft')}
      testID={testID}
    >
      <View className="flex-row items-center gap-2.5">
        <View
          className={cn(
            'size-7 items-center justify-center rounded-[8px]',
            tone === 'danger'
              ? 'bg-danger-soft'
              : tone === 'warning'
                ? 'bg-warning-soft'
                : tone === 'ok'
                  ? 'bg-success-soft'
                  : 'bg-card-2',
          )}
        >
          <Icon
            as={icon}
            className={cn(
              'size-4',
              tone === 'danger'
                ? 'text-danger-text'
                : tone === 'warning'
                  ? 'text-warning-text'
                  : tone === 'ok'
                    ? 'text-success-text'
                    : 'text-text-3',
            )}
          />
        </View>
        <Text className="flex-1 text-[15px]" numberOfLines={1}>
          <Text className="text-[15px] font-semibold">{title}</Text>
          {deal ? <Text className="text-[15px] text-text-2">{` · ${deal}`}</Text> : null}
        </Text>
        {aside ? <Text className="text-[12.5px] font-semibold text-text-2">{aside}</Text> : null}
      </View>
      {body ? <Text className="text-[13.5px] leading-[19px] text-text-2">{body}</Text> : null}
      {children ? <View className="flex-row flex-wrap items-center gap-2">{children}</View> : null}
    </Card>
  );
}

const Empty = ({ children }: { children: string }) => (
  <Card className="px-5 py-8" testID="re-coordinate-empty">
    <Text className="text-center text-[14px] text-text-2">{children}</Text>
  </Card>
);

const toneOf = (h: Health): 'danger' | 'warning' | 'quiet' =>
  h === 'red' ? 'danger' : h === 'yellow' ? 'warning' : 'quiet';

function TodayTab({
  today,
  timeZone,
  now,
  workspaceId,
  onDuty,
  onDeal,
}: {
  today: TodayView;
  timeZone: string;
  now: number;
  workspaceId: string;
  onDuty: (dutyId: string) => void;
  onDeal: (dealId: string) => void;
}) {
  if (!today.atRisk.length && !today.overdue.length && !today.dueToday.length)
    return <Empty>{RE_COORDINATE_WORDS.todayEmpty}</Empty>;
  const day = localDateOf(now, timeZone);
  const when = (dueAt: string | null) => {
    if (!dueAt) return null;
    const d = localDateOf(Date.parse(dueAt), timeZone);
    return d === day ? RE_COORDINATE_WORDS.dueToday : fmtMonthDay(d);
  };
  return (
    <>
      {today.atRisk.map((r, i) => (
        <Item
          key={`risk-${r.dealId}-${r.dutyId ?? i}`}
          tone={r.level === 'red' ? 'danger' : 'warning'}
          icon={TriangleAlert}
          title={r.words}
          deal={r.dealName}
          aside={r.kind === 'duty' ? RE_COORDINATE_WORDS.escalated : null}
          body={r.next}
          testID="re-today-risk"
        >
          {r.kind === 'duty' && r.dutyId ? (
            <Button
              size="md"
              variant="secondary"
              onPress={() =>
                void acknowledgeDuty(workspaceId, r.dutyId!)
                  .then(() => toast.show(RE_COORDINATE_WORDS.acknowledged))
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
              testID="re-today-ack"
            >
              {RE_COORDINATE_WORDS.acknowledge}
            </Button>
          ) : null}
          <Button
            size="md"
            variant="ghost"
            onPress={() => (r.dutyId ? onDuty(r.dutyId) : onDeal(r.dealId))}
            testID="re-today-open"
          >
            {RE_COORDINATE_WORDS.open}
          </Button>
        </Item>
      ))}
      {[...today.overdue, ...today.dueToday].map((d) => (
        <Item
          key={d.dutyId}
          tone={d.dueAt && Date.parse(d.dueAt) <= now ? 'danger' : toneOf(d.health)}
          icon={d.dueAt && Date.parse(d.dueAt) <= now ? TriangleAlert : Clock}
          title={d.title}
          deal={d.dealName}
          aside={
            d.dueAt && Date.parse(d.dueAt) <= now
              ? dueWords(d.dueAt, timeZone, { now })
              : when(d.dueAt)
          }
          body={d.accountableName ?? RE_COORDINATE_WORDS.nobody}
          testID="re-today-duty"
        >
          <Button size="md" variant="secondary" onPress={() => onDuty(d.dutyId)}>
            {RE_COORDINATE_WORDS.open}
          </Button>
        </Item>
      ))}
    </>
  );
}

function ExceptionsTab({
  data,
  timeZone,
  now,
  onDuty,
  onDeal,
}: {
  data: ExceptionsView;
  timeZone: string;
  now: number;
  onDuty: (dutyId: string) => void;
  onDeal: (dealId: string, page?: string) => void;
}) {
  const total =
    data.reads.length +
    data.disagree.length +
    data.nobodyAccountable.length +
    data.noProof.length +
    data.contingencies.length +
    data.blocked.length;
  const year = Number(localDateOf(now, timeZone).slice(0, 4));
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), year);
  const W = RE_COORDINATE_WORDS;
  return (
    <>
      {total === 0 ? <Empty>{W.exceptionsEmpty}</Empty> : null}
      {data.disagree.map((r, i) => (
        <Item
          key={`dis-${r.dealId}-${i}`}
          tone={r.linked ? 'danger' : 'warning'}
          icon={TriangleAlert}
          title={r.linked ? W.linkedTitle : W.disagreeTitle}
          deal={r.dealName}
          body={`${r.words} ${r.next}`}
          testID="re-exception-disagree"
        >
          <Button size="md" variant="secondary" onPress={() => onDeal(r.dealId, 'dates')}>
            {W.open}
          </Button>
          <View className="flex-row items-center gap-1.5">
            <Icon as={WifiOff} className="size-3.5 text-text-3" />
            <Text className="text-[12.5px] text-text-3">{W.fixNeedsSignal}</Text>
          </View>
        </Item>
      ))}
      {data.reads.map((r) => (
        <Item
          key={r.readId}
          tone="warning"
          icon={CircleAlert}
          title={W.readsTitle}
          deal={r.dealName}
          aside={r.scan ? 'Scan' : null}
          body={`${W.readsLine(r.documentTitle, r.waiting)} ${r.scan ? W.readScan : W.readText}`}
          testID="re-exception-read"
        >
          <Button
            size="md"
            variant="secondary"
            onPress={() => onDeal(r.dealId, `contract/${r.readId}`)}
          >
            {W.checkThem}
          </Button>
        </Item>
      ))}
      {data.contingencies.map((c) => (
        <Item
          key={c.contingencyId}
          tone="danger"
          icon={TriangleAlert}
          title={W.contingencyTitle}
          deal={c.dealName}
          aside={fmtMonthDay(c.endedOn, year)}
          body={W.contingencyLine(inSentence(c.label), fmtMonthDay(c.endedOn, year))}
          testID="re-exception-contingency"
        >
          <Button size="md" variant="secondary" onPress={() => onDeal(c.dealId, 'contingencies')}>
            {W.recordIt}
          </Button>
        </Item>
      ))}
      {data.noProof.map((d) => (
        <Item
          key={`proof-${d.dutyId}`}
          tone="warning"
          icon={ShieldCheck}
          title={W.noProofTitle}
          deal={d.dealName}
          aside={d.accountableName ?? W.nobody}
          body={W.noProofLine(
            d.title,
            d.dueAt ? dueWords(d.dueAt, timeZone, { now }) : 'no deadline',
          )}
          testID="re-exception-proof"
        >
          <Button size="md" variant="secondary" onPress={() => onDuty(d.dutyId)}>
            {W.open}
          </Button>
        </Item>
      ))}
      {data.nobodyAccountable.map((d) => (
        <Item
          key={`nobody-${d.dutyId}`}
          tone="quiet"
          icon={CircleAlert}
          title={W.nobodyTitle}
          deal={d.dealName}
          body={W.nobodyLine(d.title)}
          testID="re-exception-nobody"
        >
          <Button size="md" variant="secondary" onPress={() => onDuty(d.dutyId)}>
            {W.open}
          </Button>
        </Item>
      ))}
      {data.blocked.map((d) => (
        <Item
          key={`blocked-${d.dutyId}`}
          tone="danger"
          icon={TriangleAlert}
          title={W.blockedTitle}
          deal={d.dealName}
          body={`${d.title}. ${W.blockedLine(d.blocker, d.owner, day(d.reviewAt))}`}
          testID="re-exception-blocked"
        >
          <Button size="md" variant="secondary" onPress={() => onDuty(d.dutyId)}>
            {W.open}
          </Button>
        </Item>
      ))}
      {data.partial ? <Footnote testID="re-exceptions-partial">{W.partial}</Footnote> : null}
    </>
  );
}

function WaitingTab({
  data,
  timeZone,
  now,
  onDuty,
}: {
  data: WaitingRoomView;
  timeZone: string;
  now: number;
  onDuty: (dutyId: string) => void;
}) {
  if (!data.items.length) return <Empty>{RE_COORDINATE_WORDS.waitingEmpty}</Empty>;
  const year = Number(localDateOf(now, timeZone).slice(0, 4));
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), year);
  return (
    <>
      {data.items.map((w) => (
        <Item
          key={w.dutyId}
          tone={w.past ? 'danger' : 'quiet'}
          icon={Clock}
          title={w.title}
          deal={w.dealName}
          aside={
            w.next
              ? w.status === 'blocked'
                ? RE_COORDINATE_WORDS.review(day(w.next))
                : RE_COORDINATE_WORDS.chase(day(w.next))
              : null
          }
          body={
            w.status === 'blocked'
              ? RE_COORDINATE_WORDS.blockedSince(w.blocker ?? w.waitingOn, day(w.since))
              : RE_COORDINATE_WORDS.waitingSince(w.waitingOn, day(w.since))
          }
          testID="re-waiting-item"
        >
          <Button size="md" variant="secondary" onPress={() => onDuty(w.dutyId)}>
            {RE_COORDINATE_WORDS.open}
          </Button>
        </Item>
      ))}
    </>
  );
}

function WorkloadTab({ data }: { data: WorkloadView }) {
  if (!data.people.length) return <Empty>{RE_COORDINATE_WORDS.workloadEmpty}</Empty>;
  const most = Math.max(1, ...data.people.map((p) => p.openDuties));
  return (
    <>
      <GroupLabel label={RE_COORDINATE_WORDS.byPerson} />
      <View
        className="overflow-hidden rounded-card border border-border bg-card"
        testID="re-workload"
      >
        {data.people.map((p, i) => {
          const share = (n: number) => `${Math.round((n / most) * 100)}%` as const;
          const rest = Math.max(0, p.openDuties - p.overdue - p.dueSoon);
          return (
            <View
              key={p.userId}
              className={cn('flex-row gap-3 px-3.5 py-3', i > 0 && 'border-t border-border')}
              testID={`re-workload-${p.userId}`}
            >
              <Avatar name={p.name} seed={p.userId} size="md" />
              <View className="flex-1 gap-1.5">
                <Text className="text-[15px]">{p.name}</Text>
                <Text className="text-[13px] text-text-3">
                  {RE_COORDINATE_WORDS.personLine(p.openDuties, p.overdue, p.dueSoon)}
                </Text>
                <View className="h-1.5 flex-row overflow-hidden rounded-full bg-card-2">
                  <View className="bg-danger" style={{ width: share(p.overdue) }} />
                  <View className="bg-warning" style={{ width: share(p.dueSoon) }} />
                  <View className="bg-success" style={{ width: share(rest) }} />
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </>
  );
}
