import {
  boxLabel,
  CONVERSATION_STATUSES,
  inboxEmptyWords,
  MAIL_BOX_NAMES,
  mailBoxLabel,
  NEEDS_PERSON,
  PRIVATE_THREAD_WORDS,
  STATUS_LABELS,
  unreadFilterLabel,
  type ConversationStatus,
  type InboxBoxKey,
  type InboxMailbox,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import {
  Inbox as InboxIcon,
  Lock,
  Search,
  ShieldAlert,
  Sparkles,
  UserRound,
  X,
} from '@/components/icons';
import { ConversationRow } from '@/components/inbox/conversation-row';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { FilterChip } from '@/components/ui/filter-chip';
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
import { SearchEverythingRow } from '@/search/rows';

/** An Inbox that can't draw shows why, and the other tabs still work. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

/** The boxes of a person's own mail (M19): its Inbox (`all`), Other mail and Spam. */
type OwnBox = 'all' | 'other' | 'spam';

/**
 * Inbox (the canvas's "The list"): Mine, Unassigned and All with their counts; Open, Snoozed and Closed; Unread; the
 * AI teammate's boxes; Other mail and Spam, and My mail for someone with an address of their own (M19); and the
 * conversations, newest first, read from the phone's copy with this phone's own changes over them. The list is
 * virtualized: only the rows on screen are drawn. Its box filters conversations, and ends the list with Search
 * everything for what was typed.
 *
 * My mail is the same list over the person's own mail, as on the web: its own Inbox, Other mail and Spam in place of
 * Mine, Unassigned and All, and Team inbox to go back.
 */
export default function Inbox() {
  const { business, me } = useBusiness();
  const [mailbox, setMailbox] = React.useState<InboxMailbox>('team');
  const [box, setBox] = React.useState<InboxBoxKey>('all');
  const [status, setStatus] = React.useState<ConversationStatus>('open');
  const [unread, setUnread] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const filter = React.useMemo(
    () => ({ box, status, q, unread, mailbox }),
    [box, status, q, unread, mailbox],
  );
  const { items, counts, loading } = useInboxList(filter);
  const { timeZone } = useBusinessSettings();
  const teammate = useTeammate();
  const now = useNow();
  const ai = useAiColors();
  const open = React.useCallback(
    (id: string) => router.push(businessHref(business.id, `inbox/${id}`) as Href),
    [business.id],
  );
  const team = mailbox === 'team';
  const showTeammateBoxes = team && (!!teammate || counts.needsPerson > 0 || counts.ai > 0);
  const empty = inboxEmptyWords(
    box,
    status,
    q,
    teammate?.name ?? 'The AI teammate',
    unread,
    mailbox,
  );
  const segmentBox = box === 'mine' || box === 'unassigned' ? box : 'all';
  const ownBox: OwnBox = box === 'other' || box === 'spam' ? box : 'all';
  // The counts are open conversations in the three boxes, the person's own Inbox and Other mail; anywhere else the
  // chip has no number to show.
  const unreadCount =
    status !== 'open'
      ? null
      : !team
        ? box === 'all'
          ? counts.mail.mine
          : null
        : box === 'mine' || box === 'unassigned' || box === 'all'
          ? counts.unread[box]
          : box === 'other'
            ? counts.mail.other
            : null;
  /** Into the person's own mail, or back to the team's Inbox. */
  const openMailbox = (next: InboxMailbox) => {
    setMailbox(next);
    setBox('all');
  };

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
        {team ? (
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
        ) : (
          <>
            <View className="min-h-8 flex-row items-center gap-2" testID="my-mail">
              <Icon as={Lock} className="size-3.5 text-text-2" />
              <Text numberOfLines={1} className="min-w-0 flex-1 text-[13.5px] text-text-2">
                <Text className="text-[13.5px] font-semibold">{MAIL_BOX_NAMES.mine}</Text>
                {` · ${PRIVATE_THREAD_WORDS.onlyYou}`}
              </Text>
              <Pressable
                role="button"
                onPress={() => openMailbox('team')}
                hitSlop={8}
                className="min-h-11 justify-center px-1"
                testID="mail-back"
              >
                <Text className="text-[13.5px] font-medium text-accent-text">
                  {PRIVATE_THREAD_WORDS.back}
                </Text>
              </Pressable>
            </View>
            <Segmented<OwnBox>
              label={MAIL_BOX_NAMES.mine}
              value={ownBox}
              onChange={setBox}
              options={[
                { value: 'all', label: 'Inbox', testID: 'mail-inbox' },
                { value: 'other', label: MAIL_BOX_NAMES.other, testID: 'mail-other' },
                { value: 'spam', label: MAIL_BOX_NAMES.spam, testID: 'mail-spam' },
              ]}
            />
          </>
        )}
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
          {team && teammate ? (
            <FilterChip
              label={`${teammate.name} · ${counts.ai}`}
              icon={<Sparkles size={14} color={ai.text} strokeWidth={1.5} />}
              on={box === 'ai'}
              onPress={() => setBox(box === 'ai' ? 'all' : 'ai')}
              testID="box-ai"
            />
          ) : null}
          {team && counts.mail.own ? (
            <FilterChip
              label={mailBoxLabel('mine', counts.mail.mine)}
              icon={<Icon as={Lock} className="size-3.5 text-text-2" />}
              on={false}
              onPress={() => openMailbox('mine')}
              testID="box-my-mail"
            />
          ) : null}
          {team ? (
            <>
              <FilterChip
                label={mailBoxLabel('other', counts.mail.other)}
                icon={
                  <Icon
                    as={InboxIcon}
                    className={cn('size-3.5', box === 'other' ? 'text-accent-text' : 'text-text-2')}
                  />
                }
                on={box === 'other'}
                onPress={() => setBox(box === 'other' ? 'all' : 'other')}
                testID="box-other"
              />
              <FilterChip
                label={mailBoxLabel('spam', counts.mail.spam)}
                icon={
                  <Icon
                    as={ShieldAlert}
                    className={cn('size-3.5', box === 'spam' ? 'text-accent-text' : 'text-text-2')}
                  />
                }
                on={box === 'spam'}
                onPress={() => setBox(box === 'spam' ? 'all' : 'spam')}
                testID="box-spam"
              />
            </>
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
        ListFooterComponent={
          <SearchEverythingRow
            workspaceId={business.id}
            q={q}
            className="px-3.5"
            testID="inbox-search-everything"
          />
        }
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
