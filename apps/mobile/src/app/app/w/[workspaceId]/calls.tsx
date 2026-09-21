import { CALL_LOG_WORDS, callLogEmpty, listTime, THREAD_WORDS } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import {
  ChevronDown,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Voicemail,
} from '@/components/icons';
import { VoicemailPlayer } from '@/components/inbox/voicemail-player';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { useCallLog, type CallFilter, type CallLogEntry } from '@/inbox/use-call-log';
import { cn } from '@/lib/utils';

const CALL_ICON = {
  voicemail: Voicemail,
  missed: PhoneMissed,
  incoming: PhoneIncoming,
  outgoing: PhoneOutgoing,
} as const;

const TONE = {
  warning: ['bg-warning-soft', 'text-warning-text'],
  success: ['bg-success-soft', 'text-success-text'],
  accent: ['bg-accent-soft', 'text-accent-text'],
} as const;

/**
 * One call. What is under it — the recording, the words, or why there is neither — is folded away until somebody
 * asks for it, because a whole call's transcript can run to thousands of words and the list has to stay a list.
 */
function CallRow({
  call,
  workspaceId,
  onOpen,
}: {
  call: CallLogEntry;
  workspaceId: string;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const { words } = call;
  const [box, text] = TONE[words.tone];

  return (
    <View className="border-b border-border px-3.5 py-3" testID={`call-${call.id}`}>
      <Pressable
        onPress={() => call.conversationId && onOpen(call.conversationId)}
        disabled={!call.conversationId}
        accessibilityRole={call.conversationId ? 'button' : undefined}
        className="flex-row items-center gap-2.5"
      >
        <View className={cn('size-9 items-center justify-center rounded-full', box)}>
          <Icon as={CALL_ICON[words.icon] ?? Phone} className={cn('size-4', text)} />
        </View>
        <View className="min-w-0 flex-1 gap-px">
          <Text numberOfLines={1} className="text-[15px] font-medium">
            {call.who}
          </Text>
          <Text numberOfLines={1} className="text-[12.5px] text-text-3">
            {[words.title, words.detail].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <View className="items-end gap-px">
          <Text className="text-[12.5px] text-text-3">{listTime(call.occurredAt)}</Text>
          {words.length ? <Text className="text-[12.5px] text-text-3">{words.length}</Text> : null}
        </View>
      </Pressable>

      {words.openable ? (
        <View className="mt-1.5 gap-2 pl-[46px]">
          <Pressable
            onPress={() => setOpen(!open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            testID="call-log-toggle"
            className="min-h-11 flex-row items-center gap-1"
          >
            <Icon
              as={ChevronDown}
              className={cn('size-4 text-accent-text', open ? '' : '-rotate-90')}
            />
            <Text className="text-[13px] font-medium text-accent-text">
              {open ? THREAD_WORDS.hideRecord : THREAD_WORDS.showRecord}
            </Text>
          </Pressable>
          {open ? (
            <View className="gap-2 pb-1">
              {call.hasRecording ? (
                <VoicemailPlayer
                  workspaceId={workspaceId}
                  callId={call.id}
                  voicemail={call.isVoicemail}
                  seconds={call.recordingSeconds}
                />
              ) : null}
              {call.transcript ? (
                <>
                  <Text selectable className="text-[14.5px] leading-[21px]">
                    {call.transcript}
                  </Text>
                  <Text className="text-xs text-text-3">{THREAD_WORDS.transcribed}</Text>
                </>
              ) : null}
              {words.note ? (
                <Text className="text-xs text-text-3" testID="call-log-note">
                  {words.note}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Calls: every call this business made or took, newest first, with All, Missed and Voicemail.
 *
 * The phone had no call log at all — a voicemail could only be found by remembering which conversation it landed
 * in, which is not how anybody looks for one. It reads from the phone's own copy, so the list and the words are
 * there with no signal; only playing the audio needs the network.
 */
export default function Calls() {
  const { business } = useBusiness();
  const [filter, setFilter] = React.useState<CallFilter>('all');
  const { items, loading } = useCallLog(filter);
  const open = React.useCallback(
    (conversationId: string) =>
      router.push(businessHref(business.id, `inbox/${conversationId}`) as Href),
    [business.id],
  );

  return (
    <Screen title={CALL_LOG_WORDS.title} leading="back" testID="calls" scroll={false}>
      <View className="border-b border-border bg-card px-3.5 py-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          label={CALL_LOG_WORDS.which}
          options={[
            { value: 'all', label: CALL_LOG_WORDS.all, testID: 'calls-all' },
            { value: 'missed', label: CALL_LOG_WORDS.missed, testID: 'calls-missed' },
            { value: 'voicemail', label: CALL_LOG_WORDS.voicemail, testID: 'calls-voicemail' },
          ]}
        />
      </View>
      <FlatList
        data={items}
        keyExtractor={(call) => call.id}
        renderItem={({ item }) => <CallRow call={item} workspaceId={business.id} onOpen={open} />}
        testID="call-list"
        ListEmptyComponent={
          loading ? null : (
            <Text className="px-6 py-10 text-center text-[13px] text-text-3" testID="calls-empty">
              {callLogEmpty(filter)}
            </Text>
          )
        }
      />
    </Screen>
  );
}
