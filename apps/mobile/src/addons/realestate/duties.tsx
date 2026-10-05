import { RE_DUTIES_WORDS, RE_DUTY_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { DUTY_STATUS_LABELS } from '@hfos/core/addons/realestate/states';
import { dealListOfCopy } from '@hfos/core/addons/realestate/views/deal-list';
import { dutyListOfCopy, type DutyListItem } from '@hfos/core/addons/realestate/views/duty-list';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { dueChip, dueGroup, GroupLabel, KeptStrip, useReChanges } from './deal-bits';
import { openRe, useReContext } from './kit';

/**
 * My duties (board 77): every open duty that's the person's across their deals, late first, then today and this week;
 * the ones on their deals that others answer for ("I'm watching"); and, for whoever sees every deal, the team's. Each
 * opens the duty, with its proof checklist: nothing is done without its proof.
 */

export type DutyScope = 'mine' | 'watching' | 'team';

/** The web's `?scope=all` is the team's. */
export const scopeOf = (scope: string | undefined, seesEveryDeal: boolean): DutyScope =>
  scope === 'all' && seesEveryDeal ? 'team' : scope === 'watching' ? 'watching' : 'mine';

type GroupKey = 'late' | 'today' | 'week' | 'later' | 'none' | 'waiting' | 'blocked';
const ORDER: readonly GroupKey[] = ['late', 'today', 'week', 'later', 'none', 'waiting', 'blocked'];

/** The groups a list of duties falls into, in the board's order, empty ones left out. */
export function dutyGroups(
  duties: readonly DutyListItem[],
  timeZone: string,
  now: number,
): { key: GroupKey; duties: DutyListItem[] }[] {
  const by = new Map<GroupKey, DutyListItem[]>();
  for (const t of duties) {
    const key: GroupKey =
      t.status === 'waiting_external'
        ? 'waiting'
        : t.status === 'blocked'
          ? 'blocked'
          : dueGroup(t.dueAt, timeZone, now, t.overdue);
    by.set(key, [...(by.get(key) ?? []), t]);
  }
  return ORDER.filter((k) => by.has(k)).map((key) => ({ key, duties: by.get(key)! }));
}

export function DutiesScreen({ scope }: { scope?: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'lists' });
  const changes = useReChanges(ctx.workspaceId);
  const [which, setWhich] = React.useState<DutyScope>(scopeOf(scope, ctx.seesEveryDeal));
  const lists = React.useMemo(() => {
    const mine = dutyListOfCopy(copy, { mine: true, status: 'open', limit: 500 }, ctx);
    const all = dutyListOfCopy(copy, { mine: false, status: 'open', limit: 2000 }, ctx);
    const myDeals = new Set(
      dealListOfCopy(copy, { mine: true, status: 'open', limit: 500 }, ctx).map((d) => d.dealId),
    );
    return {
      mine,
      watching: all.filter((t) => myDeals.has(t.dealId) && t.accountable?.userId !== ctx.userId),
      team: all,
    };
  }, [copy, ctx]);
  const waiting = new Set(
    changes
      .filter((c) => c.name.startsWith('realestate.duty.'))
      .map((c) => c.input.dutyId)
      .filter((id): id is string => typeof id === 'string'),
  );
  return (
    <DutiesView
      scope={which}
      onScope={setWhich}
      lists={lists}
      showTeam={ctx.seesEveryDeal}
      timeZone={ctx.timeZone}
      now={ctx.now}
      waiting={waiting}
      onOpen={(dutyId) => openRe(ctx.workspaceId, `duties?duty=${dutyId}`)}
    />
  );
}

export function DutiesView({
  scope,
  onScope,
  lists,
  showTeam,
  timeZone,
  now,
  waiting,
  onOpen,
}: {
  scope: DutyScope;
  onScope: (s: DutyScope) => void;
  lists: Readonly<Record<DutyScope, readonly DutyListItem[]>>;
  showTeam: boolean;
  timeZone: string;
  now: number;
  /** Duties with a change of the person's still on this phone. */
  waiting: ReadonlySet<string>;
  onOpen: (dutyId: string) => void;
}) {
  const shown = lists[scope];
  const groups = dutyGroups(shown, timeZone, now);
  const late = shown.filter((t) => t.overdue).length;
  return (
    <Screen
      title={RE_DUTIES_WORDS.title}
      subtitle={RE_DUTIES_WORDS.subtitle(shown.length, late)}
      leading="back"
      testID="re-duties"
      header={<KeptStrip inset />}
    >
      <Segmented
        value={scope}
        onChange={onScope}
        label={RE_DUTIES_WORDS.whose}
        options={[
          {
            value: 'mine',
            label: RE_DUTIES_WORDS.mine(lists.mine.length),
            testID: 're-duties-mine',
          },
          {
            value: 'watching',
            label: RE_DUTIES_WORDS.watching(lists.watching.length),
            testID: 're-duties-watching',
          },
          ...(showTeam
            ? [{ value: 'team' as const, label: RE_DUTIES_WORDS.team, testID: 're-duties-team' }]
            : []),
        ]}
      />
      {groups.length === 0 ? (
        <Card className="px-5 py-8" testID="re-duties-empty">
          <Text className="text-center text-[14px] text-text-2">
            {scope === 'mine'
              ? RE_DUTIES_WORDS.emptyMine
              : scope === 'watching'
                ? RE_DUTIES_WORDS.emptyWatching
                : RE_DUTIES_WORDS.emptyTeam}
          </Text>
        </Card>
      ) : (
        groups.map((g) => (
          <View key={g.key} className="gap-1.5" testID={`re-duties-${g.key}`}>
            <GroupLabel
              label={RE_DUTIES_WORDS.groups[g.key]}
              count={g.duties.length}
              tone={g.key === 'late' ? 'danger' : 'muted'}
            />
            <View className="overflow-hidden rounded-card border border-border bg-card">
              {g.duties.map((t, i) => (
                <DutyRow
                  key={t.dutyId}
                  duty={t}
                  first={i === 0}
                  timeZone={timeZone}
                  now={now}
                  waiting={waiting.has(t.dutyId)}
                  onPress={() => onOpen(t.dutyId)}
                />
              ))}
            </View>
          </View>
        ))
      )}
    </Screen>
  );
}

function DutyRow({
  duty,
  first,
  timeZone,
  now,
  waiting,
  onPress,
}: {
  duty: DutyListItem;
  first: boolean;
  timeZone: string;
  now: number;
  waiting: boolean;
  onPress: () => void;
}) {
  const chip = dueChip(duty.dueAt, timeZone, now, duty.overdue);
  const other = duty.status !== 'not_started' && duty.status !== 'in_progress';
  return (
    <Pressable
      role="button"
      accessibilityLabel={RE_DUTIES_WORDS.open(duty.title)}
      onPress={onPress}
      testID={`re-duty-${duty.dutyId}`}
      className={cn(
        'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
        !first && 'border-t border-border',
      )}
    >
      <View className="size-[22px] rounded-[6px] border-[1.5px] border-border-strong" />
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-[15px]">{duty.title}</Text>
        <Text className="text-[13px] text-text-3" numberOfLines={1}>
          {[duty.dealName, duty.accountable?.name, waiting ? RE_DUTY_WORDS.waitingToSend : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {other && duty.status !== 'waiting_external' && duty.status !== 'blocked' ? (
        <Badge variant="gray">
          <Text>{DUTY_STATUS_LABELS[duty.status]}</Text>
        </Badge>
      ) : chip ? (
        <Badge variant={chip.tone} testID="re-duty-due">
          <Text>{chip.words}</Text>
        </Badge>
      ) : null}
    </Pressable>
  );
}
