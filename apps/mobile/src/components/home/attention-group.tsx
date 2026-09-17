import {
  ATTENTION_KIND_LABELS,
  attentionGroupTitle,
  groupDaysSpan,
  groupRowMore,
  groupToggleLabel,
  groupValueCents,
  itemCustomerOf,
  joinAnd,
  moneyLabel,
  type AttentionItemOut,
  type AttentionKind,
  type CardChip,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { ChevronDown } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { CardFrame, HandleButton, MoreButton } from './attention-card';
import { Chips, KindLabel, KindTile, ReasonChip } from './bits';
import { useHomeEnv } from './home-context';

type Item = AttentionItemOut;

/** One item inside an opened group: who, what, whose, and its own main button and ⋯. */
function GroupRow({ item }: { item: Item }) {
  const env = useHomeEnv();
  const name = itemCustomerOf(item) ?? item.title;
  const more = groupRowMore(item, env.myUserId);
  return (
    <View testID="attention-group-row" className="gap-2 border-t border-border px-3.5 py-2.5">
      <View className="flex-row items-center gap-2.5">
        <Avatar name={name} seed={item.personId ?? item.id} size="sm" />
        <Text numberOfLines={2} className="min-w-0 flex-1 text-[13.5px]">
          <Text className="text-[13.5px] font-medium">{name}</Text>
          {more ? <Text className="text-[13.5px] text-text-3"> · {more}</Text> : null}
        </Text>
        {item.valueCents > 0 && !item.valueIsEstimate ? (
          <ReasonChip chip={{ text: moneyLabel(item.valueCents), tone: 'money', icon: null }} />
        ) : null}
      </View>
      <View className="flex-row items-center gap-2">
        <HandleButton item={item} variant="secondary" className="flex-1" />
        <MoreButton onPress={() => env.act.more(item)} />
      </View>
    </View>
  );
}

/**
 * Three or more lower items of one kind, folded into one card: "Unconfirmed appointments · 4 customers", who they are,
 * what's at stake, and Show all to act on each.
 */
export function AttentionGroup({ kind, items }: { kind: AttentionKind; items: readonly Item[] }) {
  const env = useHomeEnv();
  const [open, setOpen] = React.useState(false);
  const { title, count } = attentionGroupTitle(kind, items.length);
  const value = groupValueCents(items);
  const days =
    kind === 'unconfirmed_appointment' ? groupDaysSpan(items, env.timeZone, env.now) : null;
  const chips: CardChip[] = [
    ...(value > 0
      ? [{ key: 'value', text: moneyLabel(value), tone: 'money', icon: null } as const]
      : []),
    ...(days ? [{ key: 'days', text: days, tone: 'time', icon: 'clock' } as const] : []),
  ];
  return (
    <CardFrame testID="attention-group">
      <View className="flex-row items-start gap-3">
        <KindTile kind={kind} />
        <View className="min-w-0 flex-1 gap-px">
          <Text className="text-[15.5px] font-semibold leading-[20px]">
            {title}
            <Text className="text-[15.5px] font-normal text-text-2"> · {count}</Text>
          </Text>
          <KindLabel kind={kind}>{ATTENTION_KIND_LABELS[kind]}</KindLabel>
        </View>
        <View
          className="flex-row"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {items.slice(0, 3).map((i, n) => (
            <View
              key={i.id}
              className={cn('rounded-full border-2 border-card', n > 0 && '-ml-1.5')}
            >
              <Avatar name={itemCustomerOf(i) ?? i.title} seed={i.personId ?? i.id} size="sm" />
            </View>
          ))}
        </View>
      </View>
      <Text className="mt-1 text-[13px] leading-[19px] text-text-2">
        {joinAnd(items.map((i) => itemCustomerOf(i) ?? i.title))}.
      </Text>
      {chips.length ? (
        <View className="mt-2">
          <Chips chips={chips} />
        </View>
      ) : null}
      <Button
        variant="secondary"
        onPress={() => setOpen(!open)}
        accessibilityState={{ expanded: open }}
        testID="attention-group-toggle"
        className="mt-2.5 w-full"
      >
        <Text>{groupToggleLabel(open, items.length)}</Text>
        <View style={open ? { transform: [{ rotate: '180deg' }] } : undefined}>
          <Icon as={ChevronDown} strokeWidth={1.75} className="size-4" />
        </View>
      </Button>
      {open ? (
        <View className="-mx-3.5 -mb-3.5 mt-2.5">
          {items.map((i) => (
            <GroupRow key={i.id} item={i} />
          ))}
        </View>
      ) : null}
    </CardFrame>
  );
}
