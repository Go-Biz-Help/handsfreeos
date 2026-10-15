import {
  NETWORK_FILTERS,
  NETWORK_WORDS as NW,
  networksShown,
} from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useOutreachAnswer, useOutreachContext } from './kit';

/**
 * A network on the phone's Social Outreach screens (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Words and the
 * AI"), as the web's: on every row as its name, never a logo (Chris); the filter that narrows a long list to one
 * network; and the networks the person works, for Today. The words and the networks are core's
 * (`@hfos/core/addons/outreach/network-words`).
 */

/** The network something is on, by its name, quietly beside it. */
export function NetworkName({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <Text className={cn('text-[12.5px] font-medium text-text-3', className)} testID="network-name">
      {PLATFORMS[platform]}
    </Text>
  );
}

/** Every network, or one: narrows a long list. */
export function NetworkFilter({
  value,
  onChange,
}: {
  value: Platform | null;
  onChange: (next: Platform | null) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row gap-1.5" accessibilityLabel={NW.filter}>
        {NETWORK_FILTERS.map((k) => {
          const on = (value ?? 'all') === k;
          return (
            <Button
              key={k}
              size="sm"
              variant={on ? 'secondary' : 'ghost'}
              onPress={() => onChange(k === 'all' ? null : k)}
              testID={`network-filter-${k}`}
            >
              {k === 'all' ? NW.all : PLATFORMS[k]}
            </Button>
          );
        })}
      </View>
    </ScrollView>
  );
}

/**
 * The networks the person works, for Today's strip and its list: Facebook's alone while the answer loads, or with no
 * signal and none kept.
 */
export function useNetworksOn(): readonly Platform[] {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const automation = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.automation', { body: { workspaceId: ws } })),
    `automation:${ws}:me`,
    NW.stripTitle,
  );
  const data = automation.data;
  return React.useMemo(
    () => (data ? networksShown(data.settings, data.rules.networksAllowed) : ['facebook']),
    [data],
  );
}
