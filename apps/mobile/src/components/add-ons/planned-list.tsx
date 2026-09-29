import {
  ADDON_CATEGORY_WORDS,
  filterPlanned,
  plannedCategories,
  plannedCategoryCounts,
  plannedGroups,
  withVote,
  type AddonCategory,
  type PlannedAddonView,
  type PlannedSort,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ChevronUp, Search, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { addonCommands } from '@/add-ons/use-add-ons';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const W = ADDON_PHONE_WORDS;
const categoryWord = (c: string) => ADDON_CATEGORY_WORDS[c as AddonCategory] ?? c;

/** A pill in a row of choices: a category, or a group within one. */
function Chip({
  label,
  count,
  on,
  onPress,
  testID,
}: {
  label: string;
  count?: number;
  on: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      testID={testID}
      className={cn(
        'h-9 flex-row items-center gap-1.5 rounded-full border px-3',
        on ? 'border-accent bg-accent' : 'border-border-strong bg-card active:bg-card-2',
      )}
    >
      <Text className={cn('text-[14px]', on ? 'text-white' : 'text-text')}>{label}</Text>
      {count !== undefined ? (
        <Text className={cn('font-mono text-[12px]', on ? 'text-white' : 'text-text-3')}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Settings → Add-ons, "Vote on what's next" (0109), on the phone: every planned add-on still up for a vote, with a
 * search, the categories and their groups, most votes or A to Z, and an upvote on each. The finding and ordering are
 * core's (`filterPlanned` and the rest of addons/roadmap.ts), so it matches the web's page exactly. A vote goes
 * straight out, like a move: it shows at once and puts itself right if HandsFreeOS says otherwise.
 */
export function PlannedList({
  workspaceId,
  planned,
}: {
  workspaceId: string;
  planned: readonly PlannedAddonView[];
}) {
  const [list, setList] = React.useState<readonly PlannedAddonView[]>(planned);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<string | null>(null);
  const [group, setGroup] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<PlannedSort>('votes');
  React.useEffect(() => setList(planned), [planned]);

  const counts = React.useMemo(() => plannedCategoryCounts(list, query), [list, query]);
  const categories = React.useMemo(() => plannedCategories(list), [list]);
  const groups = React.useMemo(
    () => (category ? plannedGroups(list, category) : []),
    [list, category],
  );
  // In the order the page was drawn in, with the votes as they are now: a card never jumps away from the press.
  const shown = React.useMemo(() => {
    const now = new Map(list.map((a) => [a.addonId, a]));
    return filterPlanned(planned, { query, category, group }, sort).map(
      (a) => now.get(a.addonId) ?? a,
    );
  }, [planned, list, query, category, group, sort]);

  const pickCategory = (c: string | null) => {
    setCategory(c);
    setGroup(null);
  };

  const press = (a: PlannedAddonView) => {
    if (busy.has(a.addonId)) return;
    const next = !a.voted;
    const put = (fn: (x: PlannedAddonView) => PlannedAddonView) =>
      setList((all) => all.map((x) => (x.addonId === a.addonId ? fn(x) : x)));
    setBusy((b) => new Set(b).add(a.addonId));
    put((x) => withVote(x, next));
    addonCommands
      .vote(workspaceId, a.addonId, next)
      .then((out) => {
        put((x) => ({ ...x, voted: out.voted, votes: out.votes }));
        toast.show(out.voted ? W.votedDone(a.name) : W.unvotedDone(a.name));
      })
      .catch((e: unknown) => {
        put((x) => withVote(x, !next));
        toast.error(errorMessage(e));
      })
      .finally(() =>
        setBusy((b) => {
          const left = new Set(b);
          left.delete(a.addonId);
          return left;
        }),
      );
  };

  return (
    <View className="gap-2.5" testID="planned-list">
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder={W.searchPlanned}
        accessibilityLabel={W.searchPlannedLabel}
        returnKeyType="search"
        autoCorrect={false}
        testID="planned-search"
        className="h-11"
        trailing={
          query ? (
            <Pressable
              role="button"
              accessibilityLabel="Clear"
              onPress={() => setQuery('')}
              hitSlop={8}
              className="size-11 items-center justify-center"
            >
              <Icon as={X} className="size-4 text-text-3" />
            </Pressable>
          ) : (
            <View className="size-11 items-center justify-center">
              <Icon as={Search} className="size-4 text-text-3" />
            </View>
          )
        }
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5"
        accessibilityLabel="Category"
      >
        <Chip
          label={W.allCategories}
          count={counts['all'] ?? 0}
          on={category === null}
          onPress={() => pickCategory(null)}
          testID="planned-category-all"
        />
        {categories.map((c) => (
          <Chip
            key={c}
            label={categoryWord(c)}
            count={counts[c] ?? 0}
            on={category === c}
            onPress={() => pickCategory(c)}
            testID={`planned-category-${c}`}
          />
        ))}
      </ScrollView>
      {groups.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-1.5"
          accessibilityLabel={W.groupLabel}
        >
          <Chip label={W.allGroups} on={group === null} onPress={() => setGroup(null)} />
          {groups.map((g) => (
            <Chip
              key={g}
              label={g}
              on={group === g}
              onPress={() => setGroup(g)}
              testID={`planned-group-${g}`}
            />
          ))}
        </ScrollView>
      ) : null}
      <Segmented
        value={sort}
        onChange={setSort}
        label={W.sortLabel}
        options={[
          { value: 'votes', label: W.sortVotes, testID: 'planned-sort-votes' },
          { value: 'az', label: W.sortAz, testID: 'planned-sort-az' },
        ]}
      />
      <Text className="px-1 text-[12.5px] text-text-3" testID="planned-count">
        {W.plannedCount(shown.length)}
      </Text>
      {shown.length ? (
        shown.map((a) => (
          <Card key={a.addonId} className="gap-2 px-3.5 py-3" testID={`planned-${a.addonId}`}>
            <View className="flex-row items-start gap-3">
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-[15px] font-semibold">{a.name}</Text>
                <Text className="text-xs text-text-3">
                  {[categoryWord(a.category), ...a.groups].join(' · ')}
                </Text>
              </View>
              <Pressable
                role="button"
                accessibilityState={{ selected: a.voted }}
                accessibilityLabel={
                  a.voted ? W.takeBackLabel(a.name, a.votes) : W.upvoteLabel(a.name, a.votes)
                }
                onPress={() => press(a)}
                testID={`planned-vote-${a.addonId}`}
                className={cn(
                  'h-[52px] w-[52px] items-center justify-center rounded-[10px] border',
                  a.voted
                    ? 'border-accent bg-accent-soft'
                    : 'border-border bg-card active:bg-card-2',
                )}
              >
                <Icon
                  as={ChevronUp}
                  className={cn('size-4', a.voted ? 'text-accent-text' : 'text-text')}
                />
                <Text
                  className={cn(
                    'font-mono text-[13px] font-semibold',
                    a.voted ? 'text-accent-text' : 'text-text',
                  )}
                  testID={`planned-votes-${a.addonId}`}
                >
                  {a.votes}
                </Text>
              </Pressable>
            </View>
            <Text className="text-[14px] leading-5 text-text-2">{a.summary}</Text>
            {a.overlap ? (
              <View className="self-start rounded-md bg-warning-soft px-2 py-1">
                <Text className="text-[12.5px] leading-[18px] text-warning-text">
                  {W.alreadyIn}: {a.overlap}
                </Text>
              </View>
            ) : null}
          </Card>
        ))
      ) : (
        <Card className="items-center gap-1.5 px-5 py-6" testID="planned-none">
          <Text className="text-[15px] font-semibold">{W.noneMatchTitle}</Text>
          <Text className="text-center text-[14px] leading-5 text-text-2">{W.noneMatch}</Text>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              setQuery('');
              pickCategory(null);
            }}
          >
            {W.clearFilters}
          </Button>
        </Card>
      )}
    </View>
  );
}
