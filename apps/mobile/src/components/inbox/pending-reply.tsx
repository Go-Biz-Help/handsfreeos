import { clockTime, PENDING_REPLY_WORDS, quietQuestion } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Image, Pressable, View } from 'react-native';

import {
  CircleAlert,
  Clock,
  LoaderCircle,
  Moon,
  RectangleEllipsis,
  RefreshCw,
} from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { refusalOf } from '@/changes/rules';
import type { PendingReply } from '@/inbox/outbox';
import { cn } from '@/lib/utils';

import { localPhotoUri } from './composer';

/** The button under a reply that asks something: it opens the question's sheet, as Changes on this phone does. */
export const DECIDE = 'Decide';

/** The business's time and when quiet hours end, from the question the phone or HandsFreeOS asked. */
export function quietFactsOf(answer: string | null): { localTime: string; endsAt: string } | null {
  try {
    const parsed = answer ? (JSON.parse(answer) as unknown) : null;
    const phone = (parsed as { phone?: { localTime?: string; endsAt?: string } } | null)?.phone;
    if (phone?.localTime && phone.endsAt)
      return { localTime: phone.localTime, endsAt: phone.endsAt };
    const details = refusalOf(parsed)?.details as
      { localTime?: string; endsAt?: string } | undefined;
    if (details?.localTime && details.endsAt)
      return { localTime: details.localTime, endsAt: details.endsAt };
  } catch {
    return null;
  }
  return null;
}

/** What the line under a reply written on this phone says, and whether it offers a choice. */
export function pendingLine(
  reply: PendingReply,
  who: string,
): {
  readonly text: string;
  readonly tone: 'quiet' | 'warning' | 'danger';
  readonly action: string | null;
} {
  switch (reply.stage) {
    case 'waiting':
      return {
        text: PENDING_REPLY_WORDS.waiting(clockTime(reply.goesBy)),
        tone: 'warning',
        action: null,
      };
    case 'photo':
      return {
        text: reply.fileIds.length > 1 ? PENDING_REPLY_WORDS.photos : PENDING_REPLY_WORDS.photo,
        tone: 'quiet',
        action: null,
      };
    case 'still-send':
      return {
        text: PENDING_REPLY_WORDS.stillSendBody(reply.channel === 'email' ? 'email' : 'text'),
        tone: 'warning',
        action: PENDING_REPLY_WORDS.stillSend,
      };
    case 'quiet-hours': {
      const facts = quietFactsOf(reply.row.answer);
      const q = quietQuestion(
        { quiet: true, localTime: facts?.localTime ?? '00:00', endsAt: facts?.endsAt ?? null },
        who,
      );
      return {
        text: facts ? q.inline : 'Inside quiet hours. Send now, or when quiet hours end?',
        tone: 'warning',
        action: DECIDE,
      };
    }
    case 'ask':
      return {
        text: reply.row.reason ?? PENDING_REPLY_WORDS.askedFirst,
        tone: 'warning',
        action: DECIDE,
      };
    case 'retry':
      return { text: PENDING_REPLY_WORDS.retry, tone: 'quiet', action: null };
    case 'refused':
      return {
        text: `${PENDING_REPLY_WORDS.notSent} ${reply.row.reason ?? ''}`.trim(),
        tone: 'danger',
        action: PENDING_REPLY_WORDS.edit,
      };
    case 'sent':
    case 'sending':
    default:
      return { text: PENDING_REPLY_WORDS.sending, tone: 'quiet', action: null };
  }
}

/**
 * A reply written on this phone that HandsFreeOS hasn't sent back yet, as the canvas's "A text written with no signal":
 * a dashed bubble, and under it when it goes on its own ("Waiting for signal — sends by 10:42 AM"), what it waits for,
 * or the question it asks (Still send?, quiet hours), with the choice to answer it.
 */
export function PendingReplyBubble({
  reply,
  userId,
  who,
  onAction,
  onDiscard,
}: {
  reply: PendingReply;
  userId: string;
  who: string;
  onAction: (reply: PendingReply) => void;
  onDiscard: (reply: PendingReply) => void;
}) {
  const line = pendingLine(reply, who);
  const { data: photos } = useQuery<{ file_id: string; local_name: string | null }>(
    `SELECT file_id, local_name FROM photo_uploads WHERE file_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(reply.fileIds)],
  );
  const icon =
    reply.stage === 'waiting'
      ? Clock
      : reply.stage === 'quiet-hours'
        ? Moon
        : reply.stage === 'refused' || reply.stage === 'still-send' || reply.stage === 'ask'
          ? CircleAlert
          : reply.stage === 'retry'
            ? RefreshCw
            : LoaderCircle;
  const color =
    line.tone === 'danger'
      ? 'text-danger-text'
      : line.tone === 'warning'
        ? 'text-warning-text'
        : 'text-text-3';
  return (
    <View
      className="mt-2 max-w-[84%] items-end gap-[3px] self-end"
      testID={`pending-${reply.row.id}`}
    >
      {photos.map((p) =>
        p.local_name ? (
          <Image
            key={p.file_id}
            source={{ uri: localPhotoUri(userId, p.local_name) }}
            accessibilityIgnoresInvertColors
            className="h-[136px] w-[180px] rounded-[14px] bg-card-2"
            testID="pending-photo"
          />
        ) : null,
      )}
      {reply.body ? (
        <View
          className={cn(
            'rounded-2xl rounded-br-[5px] border border-dashed px-[13px] py-[9px]',
            reply.stage === 'refused'
              ? 'border-danger bg-danger-soft'
              : 'border-accent bg-accent-soft',
          )}
        >
          {reply.channel === 'email' && reply.subject ? (
            <Text className="mb-0.5 text-[13px] font-medium">{reply.subject}</Text>
          ) : null}
          <Text selectable className="text-[15px] leading-[22px]">
            {reply.body}
          </Text>
        </View>
      ) : null}
      {reply.extras ? (
        // Its buttons, card or carousel (RCS, 0103): they show as the customer sees them once HandsFreeOS has it.
        <View className="flex-row items-center gap-1 px-1" testID="pending-extras">
          <Icon as={RectangleEllipsis} className="size-3.5 text-text-3" strokeWidth={1.75} />
          <Text className="text-xs text-text-3">{reply.extras}</Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-end gap-x-[5px] gap-y-1 px-1">
        <Icon as={icon} className={cn('size-3', color)} strokeWidth={1.75} />
        <Text className={cn('shrink text-right text-xs', color)} testID="pending-line">
          {line.text}
        </Text>
      </View>
      {line.action ? (
        <View className="flex-row items-center gap-1">
          {reply.stage === 'refused' ? (
            <Pressable
              role="button"
              onPress={() => onDiscard(reply)}
              hitSlop={{ top: 10, bottom: 10 }}
              className="h-8 justify-center px-2"
              testID="pending-discard"
            >
              <Text className="text-[13px] font-semibold text-danger-text">
                {PENDING_REPLY_WORDS.discard}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            role="button"
            onPress={() => onAction(reply)}
            hitSlop={{ top: 10, bottom: 10 }}
            className="h-8 justify-center rounded-control border border-border-strong bg-card px-3"
            testID="pending-action"
          >
            <Text className="text-[13px] font-semibold text-accent-text">{line.action}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
