import {
  assignedToLabel,
  conversationChips,
  listTime,
  previewLine,
  rowName,
  unreadLabel,
  type ConversationShape,
  type RowChip,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import { Clock, Globe, Mail, MessageCircle, Phone, Sparkles, UserRound } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** The customer's avatar, or a tile for a number (a phone) or a website visitor (a globe) nobody has linked. */
export function ContactAvatar({
  person,
  channel,
  size = 'md',
}: {
  person: { id: string; fullName: string } | null;
  channel: 'sms' | 'email' | 'chat';
  size?: 'md' | 'lg';
}) {
  if (person && person.fullName)
    return <Avatar name={person.fullName} seed={person.id} size={size === 'lg' ? 'lg' : 'md'} />;
  return (
    <View
      className={cn(
        'shrink-0 items-center justify-center rounded-full bg-card-3',
        size === 'lg' ? 'size-10' : 'size-8',
      )}
    >
      <Icon as={channel === 'chat' ? Globe : Phone} className="size-3.5 text-text-2" />
    </View>
  );
}

/** One chip under a row, in the web's colours. */
export function RowChipView({ chip }: { chip: RowChip }) {
  const ai = useAiColors();
  const base = 'h-[22px] flex-row items-center gap-1 rounded-[6px] px-1.5';
  switch (chip.kind) {
    case 'wait':
      return (
        <View className={cn(base, 'bg-warning-soft')} testID="wait-chip">
          <Icon as={Clock} className="size-3.5 text-warning-text" strokeWidth={1.75} />
          <Text className="text-xs font-medium text-warning-text">{chip.label}</Text>
        </View>
      );
    case 'needs_person':
      return (
        <View className={cn(base, 'bg-warning-soft')} testID="needs-person-tag">
          <Icon as={UserRound} className="size-3 text-warning-text" strokeWidth={1.75} />
          <Text className="text-xs font-semibold text-warning-text">{chip.label}</Text>
        </View>
      );
    case 'ai':
      return (
        <View className={base} style={{ backgroundColor: ai.soft }} testID="ai-tag">
          <Sparkles size={12} color={ai.text} strokeWidth={1.75} />
          <Text className="text-xs font-semibold" style={{ color: ai.text }}>
            {chip.label}
          </Text>
        </View>
      );
    case 'on_site':
      return (
        <View className={cn(base, 'gap-[5px] bg-success-soft')} testID="row-on-site-now">
          <View className="size-[7px] rounded-full bg-success" />
          <Text className="text-xs font-medium text-success-text">{chip.label}</Text>
        </View>
      );
    case 'closed':
      return (
        <View className={cn(base, 'rounded-full bg-success-soft px-2')}>
          <Text className="text-xs font-medium text-success-text">{chip.label}</Text>
        </View>
      );
    case 'stage':
      // The web shows the lead's stage on wide screens only; the phone's row keeps to what needs attention.
      return null;
    default:
      return (
        <View className={cn(base, 'bg-card-2')}>
          <Text className="text-xs font-medium text-text-2">{chip.label}</Text>
        </View>
      );
  }
}

/**
 * A customer in the list, as the canvas draws it: who (the customer, or the number), the channel, when, the latest
 * message ("You: …" for what you sent), and what needs attention under it ("Text · Email" when they write in more than
 * one place), with the assignee and the unread count.
 */
export const ConversationRow = React.memo(function ConversationRow({
  c,
  myUserId,
  waitThreshold,
  timeZone,
  draftWaiting,
  now,
  onPress,
}: {
  c: ConversationShape;
  myUserId: string;
  waitThreshold: number;
  timeZone: string;
  draftWaiting: boolean;
  now: number;
  onPress: (id: string) => void;
}) {
  // The row is the customer (0089): its badge counts what is unread on every line of theirs, as the web's does.
  const unreadCount = c.unreadTotal ?? c.unreadCount;
  const unread = unreadCount > 0;
  const name = rowName(c);
  const chips = conversationChips(c, {
    waitThreshold,
    draftWaiting,
    timeZone,
    now,
    teammateChip: 'handling',
  });
  const channelIcon = c.channel === 'email' ? Mail : c.channel === 'chat' ? Globe : MessageCircle;
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${name}. ${previewLine(c, myUserId)}`}
      testID={`conversation-row-${c.id}`}
      onPress={() => onPress(c.id)}
      className="min-h-[76px] flex-row gap-3 border-b border-border bg-card px-4 py-3 active:bg-card-2"
    >
      <View className="pt-0.5">
        <ContactAvatar person={c.person} channel={c.channel} />
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-1.5">
          <Text
            numberOfLines={1}
            className={cn('shrink text-base', unread ? 'font-semibold' : 'font-medium')}
            testID="conversation-row-name"
          >
            {name}
          </Text>
          <Icon as={channelIcon} className="size-3.5 text-text-3" />
          <View className="flex-1" />
          <Text
            className={cn(
              'text-[12.5px]',
              unread ? 'font-semibold text-accent-text' : 'text-text-3',
            )}
          >
            {listTime(c.lastMessageAt ?? c.createdAt, new Date(now))}
          </Text>
        </View>
        <Text
          numberOfLines={2}
          className={cn('mt-0.5 text-[14px] leading-[20px]', unread ? 'text-text' : 'text-text-2')}
          testID="conversation-row-preview"
        >
          {previewLine(c, myUserId)}
        </Text>
        {chips.some((chip) => chip.kind !== 'stage') || c.assignee || unread ? (
          <View className="mt-[7px] min-h-[22px] flex-row flex-wrap items-center gap-1.5">
            {chips.map((chip, i) => (
              <RowChipView key={`${chip.kind}-${i}`} chip={chip} />
            ))}
            <View className="flex-1" />
            {c.assignee ? (
              <View accessibilityLabel={assignedToLabel(c.assignee.fullName)}>
                <Avatar name={c.assignee.fullName || '?'} seed={c.assignee.id} size="sm" />
              </View>
            ) : null}
            {unread ? (
              <View
                className="h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-[5px]"
                accessibilityLabel={`${unreadCount} unread`}
              >
                <Text className="text-[11px] font-semibold text-white">
                  {unreadLabel(unreadCount)}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});
