import {
  IDEA_MINE,
  IDEA_MINE_WORDS,
  IDEA_STATUS_WORDS,
  IDEA_STATUSES,
  IDEAS_WORDS,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Check } from '@/components/icons';
import { ListLabel } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { DEFAULT_FILTERS, isFiltered, type BoardFilters, type IdeaArea } from '@/ideas/use-ideas';
import { cn } from '@/lib/utils';

/**
 * The board's three choosers from the web (status, whose, which part of HandsFreeOS) in one sheet. A choice applies
 * as it is pressed, so the board behind is already right when the sheet closes.
 */
export function IdeaFiltersSheet({
  open,
  onClose,
  filters,
  areas,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  filters: BoardFilters;
  areas: readonly IdeaArea[];
  onChange: (next: BoardFilters) => void;
}) {
  const set = (patch: Partial<BoardFilters>) => onChange({ ...filters, ...patch });
  return (
    <Sheet open={open} onClose={onClose} title={IDEAS_WORDS.filters} scroll testID="ideas-filters">
      <View className="gap-1">
        <ListLabel>{IDEAS_WORDS.statusLabel}</ListLabel>
        <Choice
          label={IDEAS_WORDS.openIdeas}
          chosen={filters.status === 'open'}
          onPress={() => set({ status: 'open' })}
          testID="ideas-status-open"
        />
        {IDEA_STATUSES.map((s) => (
          <Choice
            key={s}
            label={IDEA_STATUS_WORDS[s]}
            chosen={filters.status === s}
            onPress={() => set({ status: s })}
            testID={`ideas-status-${s}`}
          />
        ))}
        <Choice
          label={IDEAS_WORDS.everyIdea}
          chosen={filters.status === 'all'}
          onPress={() => set({ status: 'all' })}
          testID="ideas-status-all"
        />

        <ListLabel>{IDEAS_WORDS.mineLabel}</ListLabel>
        <Choice
          label={IDEAS_WORDS.everybodys}
          chosen={filters.mine === null}
          onPress={() => set({ mine: null })}
          testID="ideas-mine-everybody"
        />
        {IDEA_MINE.map((m) => (
          <Choice
            key={m}
            label={IDEA_MINE_WORDS[m]}
            chosen={filters.mine === m}
            onPress={() => set({ mine: m })}
            testID={`ideas-mine-${m}`}
          />
        ))}

        <ListLabel>{IDEAS_WORDS.areaFilterLabel}</ListLabel>
        <Choice
          label={IDEAS_WORDS.everyArea}
          chosen={filters.areaId === null}
          onPress={() => set({ areaId: null })}
          testID="ideas-area-every"
        />
        {areas.map((a) => (
          <Choice
            key={a.id}
            label={a.openCount ? `${a.name} (${a.openCount})` : a.name}
            chosen={filters.areaId === a.id}
            onPress={() => set({ areaId: a.id })}
            testID={`ideas-area-${a.id}`}
          />
        ))}
      </View>
      <View className="mt-4 gap-2">
        <Button onPress={onClose} testID="ideas-filters-done">
          {IDEAS_WORDS.done}
        </Button>
        {isFiltered(filters) ? (
          <Button
            variant="ghost"
            onPress={() => {
              onChange({ ...DEFAULT_FILTERS, sort: filters.sort });
              onClose();
            }}
            testID="ideas-filters-clear"
          >
            {IDEAS_WORDS.clearFilters}
          </Button>
        ) : null}
      </View>
    </Sheet>
  );
}

function Choice({
  label,
  chosen,
  onPress,
  testID,
}: {
  label: string;
  chosen: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      accessibilityState={{ checked: chosen }}
      onPress={onPress}
      testID={testID}
      className={cn(
        'min-h-11 flex-row items-center gap-3 rounded-control px-3 active:bg-card-2',
        chosen && 'bg-accent-soft',
      )}
    >
      <Text className={cn('flex-1 text-[15px]', chosen && 'font-medium text-accent-text')}>
        {label}
      </Text>
      {chosen ? <Icon as={Check} className="size-4 text-accent-text" /> : null}
    </Pressable>
  );
}
