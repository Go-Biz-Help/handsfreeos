import { findZones, zoneChoices, zoneNote } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

import { Chips } from './chips';

/** The chip that opens the search for a zone off the list. */
const MORE_ZONES = 'more';

/**
 * The phone's Time zone pick, as on the web (core `zone-pick.ts`): the US zones as chips, starting on the business's,
 * "Somewhere else" to search the rest of the world, and a line under them saying where the time lands. New appointment
 * says "on your calendar"; Snooze until says "for the business".
 */
export function ZoneChips({
  value,
  onChange,
  homeZone,
  at,
  where,
  testID,
}: {
  value: string;
  onChange: (zone: string) => void;
  /** The zone the calendar or the business shows, which the pick starts on. */
  homeZone: string;
  /** The moment the day and time make on the picked zone's clock. */
  at: number;
  /** Where the time lands, for the line under the chips: "on your calendar" when left out. */
  where?: string;
  testID: string;
}) {
  /** What's typed to find a zone off the chips (a customer in Manila), or null while that search is shut. */
  const [search, setSearch] = React.useState<string | null>(null);
  const away = zoneNote(at, value, homeZone, where);
  return (
    <>
      <Chips
        options={[
          ...zoneChoices(homeZone, value).map((z) => ({ value: z.id, label: z.label })),
          { value: MORE_ZONES, label: 'Somewhere else' },
        ]}
        value={search === null ? value : MORE_ZONES}
        onChange={(v) => {
          if (v === MORE_ZONES) return setSearch('');
          onChange(v);
          setSearch(null);
        }}
        testID={testID}
      />
      {search !== null ? (
        <View className="mt-2 gap-2">
          <Input
            value={search}
            onChangeText={setSearch}
            placeholder="Search a city, like Manila or London"
            accessibilityLabel="Find a time zone"
            autoCorrect={false}
            autoFocus
            testID={`${testID}-search`}
          />
          <Chips
            options={findZones(search).map((z) => ({ value: z.id, label: z.label }))}
            value=""
            onChange={(v) => {
              onChange(v);
              setSearch(null);
            }}
            testID={`${testID}-found`}
          />
        </View>
      ) : null}
      {away ? (
        <Text className="mt-1 text-xs font-medium text-text-2" testID={`${testID}-note`}>
          {away}
        </Text>
      ) : null}
    </>
  );
}
