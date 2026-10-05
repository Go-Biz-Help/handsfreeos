import { localDateOf } from '@hfos/core';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_DEALS_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { dueWords } from '@hfos/core/addons/realestate/rule-words';
import { STAGE_LABELS, stagesOf, type DealStage } from '@hfos/core/addons/realestate/states';
import {
  dealListOfCopy,
  type DealListFilter,
  type DealListItem,
} from '@hfos/core/addons/realestate/views/deal-list';
import { dealRisksOfCopy, type DealRisksView } from '@hfos/core/addons/realestate/views/deal-page';
import { dutyListOfCopy, type DutyListItem } from '@hfos/core/addons/realestate/views/duty-list';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ChevronDown, Search, SlidersHorizontal, X } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { UpToDate } from '@/components/shell/up-to-date';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { Chip, dayOf, Footnote, GroupLabel, HealthDot, KeptStrip, type Health } from './deal-bits';
import { openRe, SummaryChip, useReContext } from './kit';

/**
 * Deals (board 76): the person's deals, or every deal for whoever sees them all, each with what could stop it and the
 * next date, worked out from the phone's copy by core's views so it reads the same with no signal. The filters are the
 * web's (side, how they're doing, stage, agent), and the sort is "Needs you", "Closing" or "Newest".
 */

export type Whose = 'mine' | 'every';
export type DealSort = 'needs' | 'closing' | 'newest';
export type DealStatus = 'open' | 'all' | 'closed' | 'ended' | 'archived';

export interface DealFilters {
  readonly status: DealStatus;
  readonly side: 'buyer' | 'listing' | null;
  readonly health: Health | null;
  readonly stage: string | null;
  readonly agentUserId: string | null;
  readonly closingThisMonth: boolean;
  readonly search: string;
  readonly sort: DealSort;
}

export const NO_FILTERS: DealFilters = {
  status: 'open',
  side: null,
  health: null,
  stage: null,
  agentUserId: null,
  closingThisMonth: false,
  search: '',
  sort: 'needs',
};

/** One deal's card: the list's line, what could stop it, and its next duties. */
export interface DealCard {
  readonly deal: DealListItem;
  readonly risks: DealRisksView | null;
  /** Its next open duties with a due time, soonest first (two at most). */
  readonly next: readonly DutyListItem[];
}

/** The web's `?view=`: every deal, or the closed and archived ones. */
export function filtersOfView(view: string | undefined): { whose: Whose; status: DealStatus } {
  if (view === 'all' || view === 'attention') return { whose: 'every', status: 'open' };
  if (view === 'closed' || view === 'archived') return { whose: 'every', status: view };
  return { whose: 'mine', status: 'open' };
}

/** Days from today to the month's last day, for "Closing this month". */
function daysLeftInMonth(today: string): number {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - d;
}

const HEALTH_RANK: Readonly<Record<Health, number>> = { red: 0, yellow: 1, green: 2 };

/** The deals the filters keep, in the chosen order. */
export function shownDeals(cards: readonly DealCard[], whose: Whose, f: DealFilters): DealCard[] {
  const kept = cards.filter(
    (c) => (whose === 'every' || c.deal.mine) && (!f.health || c.deal.health === f.health),
  );
  const due = (c: DealCard) => (c.deal.nextDue ? Date.parse(c.deal.nextDue.dueAt) : Infinity);
  if (f.sort === 'needs')
    return [...kept].sort(
      (a, b) =>
        HEALTH_RANK[a.deal.health] - HEALTH_RANK[b.deal.health] ||
        (b.risks?.reasons.length ?? 0) - (a.risks?.reasons.length ?? 0) ||
        due(a) - due(b),
    );
  if (f.sort === 'closing')
    return [...kept].sort((a, b) =>
      (a.deal.closing ?? '9999').localeCompare(b.deal.closing ?? '9999'),
    );
  return [...kept];
}

export function DealsScreen({ view }: { view?: string }) {
  const ctx = useReContext();
  const { business } = useBusiness();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'lists' });
  const start = filtersOfView(view);
  const [whose, setWhose] = React.useState<Whose>(
    start.whose === 'every' && ctx.seesEveryDeal ? 'every' : 'mine',
  );
  const [filters, setFilters] = React.useState<DealFilters>({
    ...NO_FILTERS,
    status: start.status,
  });

  const cardsFor = React.useCallback(
    (f: DealFilters): DealCard[] => {
      const filter: DealListFilter = {
        status: f.status,
        limit: 500,
        ...(f.side ? { side: f.side } : {}),
        ...(f.stage ? { stage: f.stage } : {}),
        ...(f.agentUserId ? { agentUserId: f.agentUserId } : {}),
        ...(f.closingThisMonth ? { closingWithinDays: daysLeftInMonth(ctx.today) } : {}),
        ...(f.search.trim() ? { search: f.search.trim() } : {}),
      };
      return dealListOfCopy(copy, filter, ctx).map((deal) => ({
        deal,
        risks: dealRisksOfCopy(copy, deal.dealId),
        next: deal.mine
          ? dutyListOfCopy(
              copy,
              { dealId: deal.dealId, mine: false, status: 'open', limit: 10 },
              ctx,
            )
              .filter((t) => t.dueAt !== null)
              .slice(0, 2)
          : [],
      }));
    },
    [copy, ctx],
  );
  const cards = React.useMemo(() => cardsFor(filters), [cardsFor, filters]);
  const open = React.useMemo(() => cardsFor({ ...NO_FILTERS }), [cardsFor]);
  const counts = {
    mine: open.filter((c) => c.deal.mine).length,
    every: open.length,
    atRisk: open.filter((c) => (whose === 'every' || c.deal.mine) && c.deal.health === 'red')
      .length,
  };
  const agents = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const c of open)
      if (c.deal.mainAgent) m.set(c.deal.mainAgent.userId, c.deal.mainAgent.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [open]);

  return (
    <DealsView
      businessName={business.name}
      timeZone={ctx.timeZone}
      now={ctx.now}
      seesEveryDeal={ctx.seesEveryDeal}
      whose={whose}
      onWhose={setWhose}
      filters={filters}
      onFilters={setFilters}
      cards={cards}
      counts={counts}
      agents={agents}
      onOpen={(dealId) => openRe(ctx.workspaceId, `deals/${dealId}`)}
    />
  );
}

export function DealsView({
  businessName,
  timeZone,
  now,
  seesEveryDeal,
  whose,
  onWhose,
  filters,
  onFilters,
  cards,
  counts,
  agents,
  onOpen,
}: {
  businessName: string;
  timeZone: string;
  now: number;
  seesEveryDeal: boolean;
  whose: Whose;
  onWhose: (w: Whose) => void;
  filters: DealFilters;
  onFilters: (f: DealFilters) => void;
  cards: readonly DealCard[];
  counts: { readonly mine: number; readonly every: number; readonly atRisk: number };
  agents: readonly (readonly [string, string])[];
  onOpen: (dealId: string) => void;
}) {
  const [sheet, setSheet] = React.useState(false);
  const [searching, setSearching] = React.useState(filters.search !== '');
  const shown = shownDeals(cards, whose, filters);
  const set = (patch: Partial<DealFilters>) => onFilters({ ...filters, ...patch });
  const everyOne = whose === 'every';
  const filtered =
    filters.side !== null ||
    filters.health !== null ||
    filters.stage !== null ||
    filters.agentUserId !== null ||
    filters.closingThisMonth ||
    filters.search.trim() !== '' ||
    filters.status !== 'open';
  const anyNotMine = shown.some((c) => !c.deal.mine);

  return (
    <Screen
      title={RE_DEALS_WORDS.title}
      subtitle={
        everyOne
          ? RE_DEALS_WORDS.everySubtitle(businessName)
          : RE_DEALS_WORDS.subtitle(counts.mine, businessName)
      }
      leading="back"
      scroll={false}
      testID="re-deals"
      trailing={
        <View className="flex-row">
          <Pressable
            role="button"
            accessibilityLabel={RE_DEALS_WORDS.searchLabel}
            onPress={() => {
              if (searching) set({ search: '' });
              setSearching(!searching);
            }}
            hitSlop={6}
            className="size-10 items-center justify-center"
            testID="re-deals-search"
          >
            <Icon as={searching ? X : Search} className="size-[21px] text-text-2" />
          </Pressable>
          <Pressable
            role="button"
            accessibilityLabel={RE_DEALS_WORDS.filtersLabel}
            onPress={() => setSheet(true)}
            hitSlop={6}
            className="size-10 items-center justify-center"
            testID="re-deals-filters"
          >
            <Icon as={SlidersHorizontal} className="size-[21px] text-text-2" />
          </Pressable>
        </View>
      }
    >
      <KeptStrip />
      <ScrollView contentContainerClassName="gap-2.5 p-3 pb-8" keyboardShouldPersistTaps="handled">
        {searching ? (
          <Input
            value={filters.search}
            onChangeText={(search) => set({ search })}
            placeholder={RE_DEALS_WORDS.search}
            accessibilityLabel={RE_DEALS_WORDS.search}
            autoFocus
            testID="re-deals-search-input"
          />
        ) : null}
        {seesEveryDeal ? (
          <Segmented
            value={whose}
            onChange={onWhose}
            label={RE_DEALS_WORDS.whose}
            options={[
              { value: 'mine', label: RE_DEALS_WORDS.mine(counts.mine), testID: 're-deals-mine' },
              {
                value: 'every',
                label: RE_DEALS_WORDS.every(counts.every),
                testID: 're-deals-every',
              },
            ]}
          />
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
        >
          <Chip
            label={
              filters.status === 'open' || filters.status === 'all'
                ? RE_DEALS_WORDS.chips.open
                : RE_DEALS_WORDS.ended[filters.status]
            }
            on={filters.status !== 'all'}
            onPress={() => set({ status: filters.status === 'open' ? 'all' : 'open' })}
            testID="re-chip-open"
          />
          <Chip
            label={RE_DEALS_WORDS.chips.buyers}
            on={filters.side === 'buyer'}
            onPress={() => set({ side: filters.side === 'buyer' ? null : 'buyer', stage: null })}
            testID="re-chip-buyers"
          />
          <Chip
            label={RE_DEALS_WORDS.chips.listings}
            on={filters.side === 'listing'}
            onPress={() =>
              set({ side: filters.side === 'listing' ? null : 'listing', stage: null })
            }
            testID="re-chip-listings"
          />
          <Chip
            label={RE_DEALS_WORDS.chips.atRisk(counts.atRisk)}
            on={filters.health === 'red'}
            danger
            onPress={() => set({ health: filters.health === 'red' ? null : 'red' })}
            testID="re-chip-risk"
          />
          <Chip
            label={RE_DEALS_WORDS.chips.closingThisMonth}
            on={filters.closingThisMonth}
            onPress={() => set({ closingThisMonth: !filters.closingThisMonth })}
            testID="re-chip-closing"
          />
        </ScrollView>

        <GroupLabel label={RE_DEALS_WORDS.sorts[filters.sort]} end={<UpToDate />} />
        {shown.length === 0 ? (
          <Card className="items-center gap-1.5 px-5 py-8" testID="re-deals-empty">
            <Text className="text-center text-[15px] font-semibold">
              {filtered
                ? RE_DEALS_WORDS.emptyMatch
                : everyOne
                  ? RE_DEALS_WORDS.emptyEvery
                  : RE_DEALS_WORDS.emptyMine}
            </Text>
            <Text className="text-center text-[13px] text-text-2">
              {filtered ? RE_DEALS_WORDS.noMatchBody : RE_DEALS_WORDS.emptyBody}
            </Text>
          </Card>
        ) : (
          shown.map((c) => (
            <DealCardView
              key={c.deal.dealId}
              card={c}
              timeZone={timeZone}
              now={now}
              summary={seesEveryDeal && !c.deal.mine}
              onPress={() => onOpen(c.deal.dealId)}
            />
          ))
        )}
        {everyOne && anyNotMine ? (
          <Footnote testID="re-deals-note">{RE_PHONE_WORDS.summaryNote}</Footnote>
        ) : null}
      </ScrollView>

      <DealFilterSheet
        open={sheet}
        onClose={() => setSheet(false)}
        filters={filters}
        onFilters={onFilters}
        agents={agents}
        count={shown.length}
      />
    </Screen>
  );
}

/** The line of what to know: what could stop it (or its next duty, what it waits on, its dates) and its closing. */
export function dealLine(
  c: DealCard,
  timeZone: string,
  now: number,
): { lead: string | null; rest: string } {
  const d = c.deal;
  const reds = c.risks?.reasons.filter((r) => r.level === 'red').length ?? 0;
  const lead =
    d.outcome === null && !d.archived
      ? RE_DEALS_WORDS.couldStop(reds, c.risks?.reasons.length ?? 0)
      : null;
  const other = lead
    ? null
    : d.nextDue
      ? `${d.nextDue.title} ${dueWords(d.nextDue.dueAt, timeZone, { now })}`
      : d.waiting
        ? RE_DEALS_WORDS.waitingOn(d.waiting.who)
        : d.datesToConfirm
          ? RE_DEALS_WORDS.datesToConfirm(d.datesToConfirm)
          : RE_DEALS_WORDS.onTrack;
  const closing = dayOf(d.closing, timeZone, now);
  return {
    lead,
    rest: [other, closing ? RE_DEALS_WORDS.closing(closing) : null].filter(Boolean).join(' · '),
  };
}

function DealCardView({
  card,
  timeZone,
  now,
  summary,
  onPress,
}: {
  card: DealCard;
  timeZone: string;
  now: number;
  summary: boolean;
  onPress: () => void;
}) {
  const d = card.deal;
  const line = dealLine(card, timeZone, now);
  const who = [
    d.property?.address && !d.name.includes(d.property.address) ? d.property.address : null,
    d.client?.name ?? null,
    !d.mine && d.mainAgent ? RE_DEALS_WORDS.someonesDeal(d.mainAgent.name) : null,
  ].filter(Boolean);
  const today = localDateOf(now, timeZone);
  return (
    <Pressable
      role="button"
      accessibilityLabel={d.name}
      onPress={onPress}
      testID={`re-deal-${d.dealId}`}
      className="gap-1 rounded-card border border-border bg-card px-3.5 py-3 active:bg-card-2"
    >
      <View className="flex-row items-center gap-2">
        <HealthDot health={d.health} />
        <Text className="flex-1 text-[16px] font-semibold" numberOfLines={1}>
          {d.name}
        </Text>
        <Badge variant="accent">
          <Text>{d.stageLabel}</Text>
        </Badge>
      </View>
      {who.length ? (
        <Text className="text-[13.5px] text-text-2" numberOfLines={1}>
          {who.join(' · ')}
        </Text>
      ) : null}
      <Text className="text-[13.5px] text-text-2" testID="re-deal-line">
        {line.lead ? (
          <Text className="text-[13.5px] font-semibold text-text">{line.lead}</Text>
        ) : null}
        {line.lead && line.rest ? ' · ' : ''}
        {line.rest}
      </Text>
      {summary ? (
        <View className="pt-1">
          <SummaryChip />
        </View>
      ) : card.next.length ? (
        <View className="flex-row flex-wrap gap-1.5 pt-1">
          {card.next.map((t) => {
            const day = t.dueAt ? localDateOf(Date.parse(t.dueAt), timeZone) : null;
            const soon = day !== null && day <= today;
            return (
              <Badge
                key={t.dutyId}
                variant={t.overdue || soon ? 'danger' : 'pending'}
                testID="re-deal-next"
              >
                <Text
                  numberOfLines={1}
                >{`${t.title} ${dueWords(t.dueAt, timeZone, { now })}`}</Text>
              </Badge>
            );
          })}
        </View>
      ) : null}
    </Pressable>
  );
}

/** "Show deals": side, how they're doing, stage, agent and the sort, as the web's filters. */
function DealFilterSheet({
  open,
  onClose,
  filters,
  onFilters,
  agents,
  count,
}: {
  open: boolean;
  onClose: () => void;
  filters: DealFilters;
  onFilters: (f: DealFilters) => void;
  agents: readonly (readonly [string, string])[];
  count: number;
}) {
  const [picking, setPicking] = React.useState<'stage' | 'agent' | null>(null);
  const set = (patch: Partial<DealFilters>) => onFilters({ ...filters, ...patch });
  const stages = (
    filters.side
      ? stagesOf(filters.side)
      : [...new Set([...stagesOf('buyer'), ...stagesOf('listing')])]
  ).filter((s) => s !== 'past_client');
  const agentName = agents.find(([id]) => id === filters.agentUserId)?.[1];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RE_DEALS_WORDS.filterTitle}
      scroll
      testID="re-deals-sheet"
    >
      <View className="gap-3 pt-3">
        <Text className="text-[13px] text-text-2">{RE_DEALS_WORDS.side}</Text>
        <Segmented
          value={filters.side ?? 'both'}
          onChange={(v) => set({ side: v === 'both' ? null : v, stage: null })}
          label={RE_DEALS_WORDS.side}
          options={[
            { value: 'both', label: RE_DEALS_WORDS.sides.both },
            { value: 'buyer', label: RE_DEALS_WORDS.sides.buyer },
            { value: 'listing', label: RE_DEALS_WORDS.sides.listing },
          ]}
        />
        <Text className="text-[13px] text-text-2">{RE_DEALS_WORDS.doing}</Text>
        <View className="flex-row flex-wrap gap-2">
          {(['red', 'yellow', 'green'] as const).map((h) => (
            <Chip
              key={h}
              label={RE_DEALS_WORDS.health[h]}
              on={filters.health === h}
              danger={h === 'red'}
              onPress={() => set({ health: filters.health === h ? null : h })}
              testID={`re-sheet-health-${h}`}
            />
          ))}
        </View>
        <Text className="text-[13px] text-text-2">{RE_DEALS_WORDS.stage}</Text>
        <Picker
          value={
            filters.stage
              ? (STAGE_LABELS[filters.stage as DealStage] ?? filters.stage)
              : RE_DEALS_WORDS.anyStage
          }
          open={picking === 'stage'}
          onToggle={() => setPicking(picking === 'stage' ? null : 'stage')}
          options={[
            [null, RE_DEALS_WORDS.anyStage] as const,
            ...stages.map((s) => [s, STAGE_LABELS[s]] as const),
          ]}
          onPick={(stage) => {
            set({ stage });
            setPicking(null);
          }}
          testID="re-sheet-stage"
        />
        <Text className="text-[13px] text-text-2">{RE_DEALS_WORDS.agent}</Text>
        <Picker
          value={agentName ?? RE_DEALS_WORDS.anyone}
          open={picking === 'agent'}
          onToggle={() => setPicking(picking === 'agent' ? null : 'agent')}
          options={[[null, RE_DEALS_WORDS.anyone] as const, ...agents]}
          onPick={(agentUserId) => {
            set({ agentUserId });
            setPicking(null);
          }}
          testID="re-sheet-agent"
        />
        <Text className="text-[13px] text-text-2">{RE_DEALS_WORDS.sortBy}</Text>
        <Segmented
          value={filters.sort}
          onChange={(sort) => set({ sort })}
          label={RE_DEALS_WORDS.sortBy}
          options={[
            { value: 'needs', label: RE_DEALS_WORDS.sorts.needs, testID: 're-sort-needs' },
            { value: 'closing', label: RE_DEALS_WORDS.sorts.closing, testID: 're-sort-closing' },
            { value: 'newest', label: RE_DEALS_WORDS.sorts.newest, testID: 're-sort-newest' },
          ]}
        />
        <Button onPress={onClose} testID="re-sheet-show">
          {RE_DEALS_WORDS.show(count)}
        </Button>
        <Button
          variant="ghost"
          onPress={() => onFilters({ ...NO_FILTERS, sort: filters.sort })}
          testID="re-sheet-clear"
        >
          {RE_DEALS_WORDS.clear}
        </Button>
      </View>
    </Sheet>
  );
}

/** A field that opens its choices under it: Stage, Agent. */
function Picker({
  value,
  open,
  onToggle,
  options,
  onPick,
  testID,
}: {
  value: string;
  open: boolean;
  onToggle: () => void;
  options: readonly (readonly [string | null, string])[];
  onPick: (value: string | null) => void;
  testID?: string;
}) {
  return (
    <View className="overflow-hidden rounded-menu border border-border-strong bg-card">
      <Pressable
        role="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        testID={testID}
        className="h-12 flex-row items-center px-3.5"
      >
        <Text className="flex-1 text-base">{value}</Text>
        <Icon as={ChevronDown} className="size-4 text-text-3" />
      </Pressable>
      {open
        ? options.map(([v, words]) => (
            <Pressable
              key={v ?? 'none'}
              role="button"
              onPress={() => onPick(v)}
              testID={`${testID}-${v ?? 'none'}`}
              className={cn(
                'min-h-11 justify-center border-t border-border px-3.5 active:bg-card-2',
              )}
            >
              <Text className="text-[15px]">{words}</Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}
