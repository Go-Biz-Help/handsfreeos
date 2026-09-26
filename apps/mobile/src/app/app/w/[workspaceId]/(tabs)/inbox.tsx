import {
  boxLabel,
  CONVERSATION_STATUSES,
  inboxEmptyWords,
  NEEDS_PERSON,
  STATUS_LABELS,
  unreadFilterLabel,
  type ConversationStatus,
  type InboxBoxKey,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import { Inbox as InboxIcon, Search, Sparkles, UserRound, X } from '@/components/icons';
import { ConversationRow } from '@/components/inbox/conversation-row';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import {
  useBusinessSettings,
  useInboxList,
  useNow,
  useTeammate,
  type InboxItem,
} from '@/inbox/use-inbox';

/** An Inbox that can't draw shows why, and the other tabs still work. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

/**
 * Inbox (the canvas's "The list"): Mine, Unassigned and All with their counts; Open, Snoozed and Closed; Unread; the
 * AI teammate's boxes; and the conversations, newest first, read from the phone's copy with this phone's own changes over
 * them. The list is virtualized: only the rows on screen are drawn.
 */
export default function Inbox() {
  const { business, me } = useBusiness();
  const [box, setBox] = React.useState<InboxBoxKey>('all');
  const [status, setStatus] = React.useState<ConversationStatus>('open');
  const [unread, setUnread] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const filter = React.useMemo(() => ({ box, status, q, unread }), [box, status, q, unread]);
  const { items, counts, loading } = useInboxList(filter);
  const { timeZone } = useBusinessSettings();
  const teammate = useTeammate();
  const now = useNow();
  const ai = useAiColors();
  const open = React.useCallback(
    (id: string) => router.push(businessHref(business.id, `inbox/${id}`) as Href),
    [business.id],
  );
  const showTeammateBoxes = !!teammate || counts.needsPerson > 0 || counts.ai > 0;
  const empty = inboxEmptyWords(box, status, q, teammate?.name ?? 'The AI teammate', unread);
  const segmentBox = box === 'mine' || box === 'unassigned' ? box : 'all';
  // The counts are open conversations in the three boxes; anywhere else the chip has no number to show.
  const unreadCount = status === 'open' && box === segmentBox ? counts.unread[segmentBox] : null;

  const renderItem = React.useCallback(
    ({ item }: { item: InboxItem }) => (
      <ConversationRow
        c={item.conversation}
        myUserId={me.user.id}
        waitThreshold={counts.waitingThresholdMinutes}
        timeZone={timeZone}
        draftWaiting={item.draftWaiting}
        now={now}
        onPress={open}
      />
    ),
    [me.user.id, counts.waitingThresholdMinutes, timeZone, now, open],
  );

  return (
    <Screen title="Inbox" testID="inbox" scroll={false}>
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <Input
          value={typed}
          onChangeText={setTyped}
          placeholder="Search conversations"
          accessibilityLabel="Search conversations"
          returnKeyType="search"
          autoCorrect={false}
          testID="inbox-search"
          className="h-11"
          trailing={
            typed ? (
              <Pressable
                role="button"
                accessibilityLabel="Clear"
                onPress={() => setTyped('')}
                hitSlop={8}
                className="size-11 items-center justify-center"
              >
                <Icon as={X} className="size-4 text-text-3" />
              </Pressable>
            ) : (
              <View className="size-11 items-center justify-center">
                <Icon as={Search} className="size-[18px] text-text-3" />
              </View>
            )
          }
        />
        <Segmented<'mine' | 'unassigned' | 'all'>
          label="Whose conversations"
          value={segmentBox}
          onChange={setBox}
          options={[
            { value: 'mine', label: boxLabel('mine', counts.open.mine), testID: 'box-mine' },
            {
              value: 'unassigned',
              label: boxLabel('unassigned', counts.open.unassigned),
              testID: 'box-unassigned',
            },
            { value: 'all', label: boxLabel('all', counts.open.all), testID: 'box-all' },
          ]}
        />
        <View className="flex-row flex-wrap items-center gap-1.5">
          {CONVERSATION_STATUSES.map((s) => (
            <FilterChip
              key={s}
              label={STATUS_LABELS[s]}
              on={status === s}
              onPress={() => setStatus(s)}
              testID={`status-${s}`}
            />
          ))}
          <View className="flex-1" />
          <FilterChip
            label={unreadFilterLabel(unreadCount)}
            on={unread}
            onPress={() => setUnread(!unread)}
            testID="filter-unread"
          />
          {showTeammateBoxes && counts.needsPerson > 0 ? (
            <FilterChip
              label={`${NEEDS_PERSON} · ${counts.needsPerson}`}
              icon={<Icon as={UserRound} className="size-3.5 text-warning-text" />}
              on={box === 'needs_person'}
              onPress={() => setBox(box === 'needs_person' ? 'all' : 'needs_person')}
              testID="box-needs_person"
            />
          ) : null}
          {teammate ? (
            <FilterChip
              label={`${teammate.name} · ${counts.ai}`}
              icon={<Sparkles size={14} color={ai.text} strokeWidth={1.5} />}
              on={box === 'ai'}
              onPress={() => setBox(box === 'ai' ? 'all' : 'ai')}
              testID="box-ai"
            />
          ) : null}
        </View>
      </View>
      <FlatList
        data={items as InboxItem[]}
        keyExtractor={(item) => item.conversation.id}
        renderItem={renderItem}
        testID="conversation-list"
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={12}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerClassName="pb-6"
        ListEmptyComponent={
          loading ? null : (
            <View className="items-center gap-2 px-8 py-12" testID="inbox-empty">
              <View className="size-12 items-center justify-center rounded-card bg-accent-soft">
                <Icon as={InboxIcon} className="size-6 text-accent-text" />
              </View>
              <Text className="text-center text-[17px] font-semibold">{empty.title}</Text>
              <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
                {empty.body}
              </Text>
            </View>
          )
        }
      />
    </Screen>
  );
}

function FilterChip({
  label,
  on,
  onPress,
  icon,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  icon?: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      testID={testID}
      className={cn(
        'h-8 flex-row items-center gap-1.5 rounded-full border px-3',
        on ? 'border-accent-soft-2 bg-accent-soft' : 'border-border-strong bg-card',
      )}
    >
      {icon}
      <Text className={cn('text-[13.5px] font-medium', on ? 'text-accent-text' : 'text-text-2')}>
        {label}
      </Text>
    </Pressable>
  );
}
