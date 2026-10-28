import {
  clockTime,
  describeTimeline,
  formatDate,
  relativeTimeAgo,
  timelineActor,
  timelineApproval,
  timelineBody,
  timelineTone,
  TIMELINE_WORDS,
  type TimelineEntry,
  type TimelineTone,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { VideoCallNotes } from '@/video-call/call-notes';

/**
 * A record's timeline on the phone, newest first, in the web's own words (core's `describeTimeline`). Each entry says
 * **when it really happened**, not when it arrived: what someone did in a customer's house with no signal is filed at
 * the moment they did it, and the phone adds what the canvas calls the arrival line — "9:40 AM · this phone, no
 * signal · arrived 10:57 AM" — for the changes it made itself.
 */

const DOT: Record<TimelineTone, string> = {
  ai: 'bg-[#7c3aed]',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-card-3',
};

const RECENT_MS = 6 * 86_400_000;

export interface TimelineRowProps {
  readonly entry: TimelineEntry;
  readonly recordType: 'person' | 'company' | 'lead';
  readonly viewerId: string;
  readonly timeZone: string;
  readonly subjectName?: string;
  readonly members?: readonly { readonly id: string; readonly fullName: string }[];
  /** This entry was made on this phone and hasn't reached HandsFreeOS: the canvas's quiet "waiting" line. */
  readonly waiting?: boolean;
  readonly now?: number;
}

export function TimelineRow({
  entry,
  recordType,
  viewerId,
  timeZone,
  subjectName,
  members,
  waiting,
  now = Date.now(),
}: TimelineRowProps) {
  const body = timelineBody(entry);
  const at = Date.parse(entry.occurredAt);
  const when =
    now - at < RECENT_MS ? relativeTimeAgo(entry.occurredAt, now) : formatDate(entry.occurredAt);
  return (
    <View
      className="flex-row gap-3 pb-4"
      testID={`timeline-${entry.kind}${entry.subtype ? `-${entry.subtype}` : ''}`}
    >
      <View className="w-[15px] items-center pt-1">
        <View className={cn('size-[11px] rounded-full', DOT[timelineTone(entry)])} />
        <View className="mt-1 w-px flex-1 bg-border" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-start gap-2">
          <Text className="min-w-0 flex-1 text-[13.5px] leading-5">
            <Text className="font-semibold">{timelineActor(entry, subjectName)}</Text>{' '}
            {describeTimeline(entry, recordType, viewerId, timeZone)}
            {timelineApproval(entry, members)}
          </Text>
          <Text className="flex-none text-[11.5px] text-text-3">{when}</Text>
        </View>
        <Text className="text-[11.5px] text-text-3" testID={`timeline-when-${entry.id}`}>
          {waiting
            ? `${clockTime(entry.occurredAt)} · this phone, no signal · waiting to send`
            : clockTime(entry.occurredAt)}
        </Text>
        {body ? (
          <View className="rounded-control bg-card-2 px-3 py-2">
            {/* Android's high-quality breaker splits inside a word in a narrow well ("dog in t / he yard"). */}
            <Text className="text-[13px] leading-[1.5]" textBreakStrategy="simple">
              {body}
            </Text>
          </View>
        ) : null}
        {entry.kind === 'call' &&
        entry.subtype === 'video' &&
        typeof entry.meta.videoCallId === 'string' ? (
          <VideoCallNotes videoCallId={entry.meta.videoCallId} />
        ) : null}
      </View>
    </View>
  );
}

export function TimelineEmpty() {
  return (
    <View className="items-center gap-1 py-10" testID="timeline-empty">
      <Text className="text-[15px] font-semibold">{TIMELINE_WORDS.emptyTitle}</Text>
      <Text className="px-6 text-center text-[13px] text-text-2">{TIMELINE_WORDS.emptyBody}</Text>
    </View>
  );
}
