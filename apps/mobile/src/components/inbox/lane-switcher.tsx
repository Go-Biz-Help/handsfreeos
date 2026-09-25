import { ALL_LINES_WORDS, unreadLabel, type InboxLane } from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Globe, Layers, Mail, MessageCircle } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Which of the business's lines this customer is being answered on, and a way to change it (0089).
 *
 * The inbox shows a customer once, so this is where the other conversations behind that one row are: a text lane
 * per number they have written to, a mail lane per address, a website chat. Picking one opens that thread, which
 * is also picking what a reply goes out from. "All lines", last as on the web, weaves every lane into one timeline to
 * read; a reply still has to leave from a line, so the box waits for one to be picked. One lane has nothing to switch
 * to or weave, so it draws nothing.
 */
export function LaneSwitcher({
  lanes,
  currentId,
  all,
  onPick,
  onAll,
}: {
  lanes: readonly InboxLane[];
  currentId: string;
  /** Showing every lane at once. */
  all: boolean;
  onPick: (id: string) => void;
  onAll: () => void;
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
          const on = !all && l.id === currentId;
          return (
            <LanePill
              key={l.id}
              on={on}
              icon={l.channel === 'email' ? Mail : l.channel === 'chat' ? Globe : MessageCircle}
              label={l.lineDisplay}
              // Unread elsewhere, not on the thread being read (it is read by being open).
              unread={on ? 0 : l.unreadCount}
              onPress={() => onPick(l.id)}
              testID={`lane-${l.id}`}
            />
          );
        })}
        <LanePill
          on={all}
          icon={Layers}
          label={ALL_LINES_WORDS.label}
          unread={0}
          onPress={onAll}
          testID="lane-all"
        />
      </ScrollView>
    </View>
  );
}

function LanePill({
  on,
  icon,
  label,
  unread,
  onPress,
  testID,
}: {
  on: boolean;
  icon: LucideIcon;
  label: string;
  unread: number;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={unread ? `${label}, ${unread} unread` : label}
      onPress={on ? undefined : onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      testID={testID}
      className={cn(
        'h-8 flex-row items-center gap-1.5 rounded-full border px-3',
        on ? 'border-accent-soft-2 bg-accent-soft' : 'border-border-strong bg-card',
      )}
    >
      <Icon as={icon} className={cn('size-3.5', on ? 'text-accent-text' : 'text-text-3')} />
      <Text
        numberOfLines={1}
        className={cn('text-[13.5px] font-medium', on ? 'text-accent-text' : 'text-text-2')}
      >
        {label}
      </Text>
      {unread > 0 ? (
        <View className="h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px]">
          <Text className="text-[11px] font-semibold text-white">{unreadLabel(unread)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
