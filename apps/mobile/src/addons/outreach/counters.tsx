import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  COUNT_PERIOD_KEYS,
  COUNT_PERIODS,
  COUNTER_WORDS as CW,
  countedSinceWords,
  countWords,
  tallyNetworks,
  tallyView,
  TICKER_ASK_SECONDS,
  type CountPeriod,
  type CountsOutput,
  type TallyGroup,
} from '@hfos/core/addons/outreach/tallies';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ChevronDown } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { Note, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * The counters at the top of Today on the phone (docs/outreach.md, decision 140), as the web's: everything the
 * person's extension did on its own today, this week (from Monday) or this month (from the 1st), on each network and
 * all together (`outreach.counts`), each group opening to show its lines; owners and admins can switch to the whole
 * team's, all together and person by person. The phone hears nothing live, so it asks again every few seconds while
 * Today is open (`TICKER_ASK_SECONDS`).
 */

type Whose = 'me' | 'team';
type Net = Platform | 'all';

export function OutreachCounters({ working }: { working: readonly Platform[] }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [period, setPeriod] = React.useState<CountPeriod>('today');
  const [whose, setWhose] = React.useState<Whose>('me');
  const everyone = ctx.manages && whose === 'team';
  const counts = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.counts', {
          body: { workspaceId: ws, period, everyone },
        }),
      ),
    `counts:${ws}:${period}:${everyone}`,
    CW.title,
    { everySeconds: TICKER_ASK_SECONDS },
  );
  return (
    <CountersBody
      counts={counts.data}
      error={counts.data ? null : counts.error}
      working={working}
      period={period}
      onPeriod={setPeriod}
      whose={ctx.manages ? whose : null}
      onWhose={setWhose}
    />
  );
}

/** The counters drawn from an answer: the tests draw it with props. */
export function CountersBody({
  counts,
  error = null,
  working,
  period,
  onPeriod,
  whose,
  onWhose,
}: {
  counts: CountsOutput | null;
  error?: string | null;
  working: readonly Platform[];
  period: CountPeriod;
  onPeriod: (p: CountPeriod) => void;
  /** The person's own or the team's, for owners and admins; null for everyone else. */
  whose: Whose | null;
  onWhose: (w: Whose) => void;
}) {
  const [net, setNet] = React.useState<Net>('all');
  const [open, setOpen] = React.useState<ReadonlySet<TallyGroup>>(new Set());
  const networks = tallyNetworks(counts?.counts ?? [], working);
  const platform = net !== 'all' && networks.includes(net) ? net : null;
  const view = tallyView(counts?.counts ?? [], platform);
  const since = counts ? countedSinceWords(counts) : '';
  const toggle = (key: TallyGroup) =>
    setOpen((had) => {
      const next = new Set(had);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <Card className="gap-3 px-4 py-3.5" testID="outreach-counters">
      <View className="gap-0.5">
        <Text className="text-[15px] font-semibold">{CW.title}</Text>
        <Note>{CW.about}</Note>
      </View>
      <Segmented
        value={period}
        onChange={onPeriod}
        label={CW.title}
        options={COUNT_PERIOD_KEYS.map((p) => ({
          value: p,
          label: COUNT_PERIODS[p],
          testID: `counters-period-${p}`,
        }))}
      />
      {whose ? (
        <Segmented<Whose>
          value={whose}
          onChange={onWhose}
          label={CW.team}
          options={[
            { value: 'me', label: CW.you, testID: 'counters-you' },
            { value: 'team', label: CW.team, testID: 'counters-team' },
          ]}
        />
      ) : null}
      {networks.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-1.5">
            <FilterChip
              label={CW.all}
              on={platform === null}
              onPress={() => setNet('all')}
              testID="counters-net-all"
            />
            {networks.map((p) => (
              <FilterChip
                key={p}
                label={PLATFORMS[p]}
                on={platform === p}
                onPress={() => setNet(p)}
                testID={`counters-net-${p}`}
              />
            ))}
          </View>
        </ScrollView>
      ) : null}
      {!counts ? (
        <Note testID="counters-loading">{error ?? '…'}</Note>
      ) : (
        <>
          <View className="flex-row flex-wrap items-baseline gap-x-2" testID="counters-total">
            <Text className="text-[28px] font-semibold">{countWords(view.total)}</Text>
            <Text className="text-[13px] text-text-2">{CW.things(view.total)}</Text>
            {since ? <Text className="text-[12.5px] text-text-3">{since}</Text> : null}
          </View>
          {view.total === 0 ? (
            <Note testID="counters-none">
              {period === 'today' ? CW.noneToday : CW.noneStretch(period)}
            </Note>
          ) : null}
          <View className="gap-1.5">
            {view.groups.map((g) => {
              const isOpen = open.has(g.key);
              return (
                <View key={g.key} className="rounded-[9px] bg-card-2">
                  <Pressable
                    role="button"
                    accessibilityLabel={`${g.label} ${countWords(g.total)}`}
                    accessibilityState={{ expanded: isOpen }}
                    onPress={() => toggle(g.key)}
                    className="min-h-11 flex-row items-center gap-2 px-3 py-2 active:opacity-80"
                    testID={`counters-group-${g.key}`}
                  >
                    <Text className="min-w-0 flex-1 text-[14px] text-text-2" numberOfLines={1}>
                      {g.label}
                    </Text>
                    <Text className="text-[16px] font-semibold">{countWords(g.total)}</Text>
                    <Icon
                      as={ChevronDown}
                      className={cn('size-4 text-text-3', isOpen && 'rotate-180')}
                    />
                  </Pressable>
                  {isOpen ? (
                    <View className="gap-1 px-3 pb-2.5" testID={`counters-rows-${g.key}`}>
                      {g.rows.length ? (
                        g.rows.map((r) => (
                          <View key={r.kind} className="flex-row items-baseline gap-3">
                            <Text className="min-w-0 flex-1 text-[13px] text-text-2">
                              {r.label}
                            </Text>
                            <Text className="text-[13px] font-medium">{countWords(r.n)}</Text>
                          </View>
                        ))
                      ) : (
                        <Note>{CW.nothing}</Note>
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
          {counts.people ? (
            <View className="gap-1" testID="counters-people">
              <Text className="text-[13px] font-semibold">{CW.person}</Text>
              {counts.people.map((p) => {
                const theirs = tallyView(p.counts, platform);
                return (
                  <View
                    key={p.userId}
                    className="gap-0.5 border-b border-border py-2"
                    testID="counters-person"
                  >
                    <View className="flex-row items-baseline gap-3">
                      <Text className="min-w-0 flex-1 text-[14px] font-medium" numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text className="text-[14px] font-semibold">{countWords(theirs.total)}</Text>
                    </View>
                    {theirs.total ? (
                      <Text className="text-[12px] text-text-3">
                        {theirs.groups
                          .filter((g) => g.total > 0)
                          .map((g) => `${g.label} ${countWords(g.total)}`)
                          .join(' · ')}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}
