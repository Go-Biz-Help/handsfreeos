import { unreadLabel, type InboxLane } from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Globe, Mail, MessageCircle } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Which of the business's lines this customer is being answered on, and a way to change it (0089).
 *
 * The inbox shows a customer once, so this is where the other conversations behind that one row are: a text lane
 * per number they have written to, a mail lane per address, a website chat. Picking one opens that thread, which
 * is also picking what a reply goes out from. One lane has nothing to switch to, so it draws nothing.
 */
export function LaneSwitcher({
  lanes,
  currentId,
  onPick,
}: {
  lanes: readonly InboxLane[];
  currentId: string;
  onPick: (id: string) => void;
}) {
  if (lanes.length < 2) return null;
  return (
    <View className="border-b border-border bg-card" testID="lane-switcher">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5 px-3.5 py-2"
      >
        {lanes.map((l) => {
          const on = l.id === currentId;
          return (
            <Pressable
              key={l.id}
              role="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${l.lineDisplay}${l.unreadCount && !on ? `, ${l.unreadCount} unread` : ''}`}
              onPress={() => (on ? undefined : onPick(l.id))}
              hitSlop={{ top: 6, bottom: 6 }}
              testID={`lane-${l.id}`}
              className={cn(
                'h-8 flex-row items-center gap-1.5 rounded-full border px-3',
                on ? 'border-accent-soft-2 bg-accent-soft' : 'border-border-strong bg-card',
              )}
            >
              <Icon
                as={l.channel === 'email' ? Mail : l.channel === 'chat' ? Globe : MessageCircle}
                className={cn('size-3.5', on ? 'text-accent-text' : 'text-text-3')}
              />
              <Text
                numberOfLines={1}
                className={cn('text-[13.5px] font-medium', on ? 'text-accent-text' : 'text-text-2')}
              >
                {l.lineDisplay}
              </Text>
              {l.unreadCount > 0 && !on ? (
                <View className="h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px]">
                  <Text className="text-[11px] font-semibold text-white">
                    {unreadLabel(l.unreadCount)}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
