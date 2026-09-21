import {
  ASSISTANT_WORDS,
  assistantNotice,
  assistantNoticeAction,
  type AssistantNoticeIcon,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { CircleAlert, CloudOff, Gauge, Hourglass, Lock, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import type { Notice } from '@/assistant/chat';

import { CardShell, Tile } from './parts';

/** The words are core's; the screen only picks the icon that goes with each. */
const ICONS: Record<AssistantNoticeIcon, LucideIcon> = {
  limit: Gauge,
  offline: CloudOff,
  waiting: Hourglass,
  locked: Lock,
  alert: CircleAlert,
};

/**
 * Why an answer stopped short. With no signal it's the canvas's own card: the question is still in the chat, Ask
 * again sends it, and the line under it says what keeps working without signal.
 */
export function NoticeCard({
  notice,
  businessName,
  onRetry,
  onReload,
}: {
  notice: Notice;
  businessName: string;
  onRetry?: () => void;
  /** The answer went on without this phone: reading the chat again brings it back. */
  onReload?: () => void;
}) {
  if (notice.code === 'no_signal')
    return (
      <CardShell testID="assistant-notice" className="border-warning-soft">
        <View className="gap-1.5 px-3.5 py-3">
          <View className="flex-row items-center gap-2.5">
            <Tile icon={CloudOff} tone="warning" />
            <Text className="min-w-0 flex-1 text-[15px] font-semibold" testID="assistant-offline">
              {ASSISTANT_WORDS.offline.title}
            </Text>
          </View>
          <Text className="text-[13px] leading-[18px] text-text-2">
            {ASSISTANT_WORDS.offline.body}
          </Text>
        </View>
        {onRetry ? (
          <View className="flex-row items-center border-t border-border px-3.5 py-2.5">
            <Button
              variant="secondary"
              size="md"
              icon={RefreshCw}
              onPress={onRetry}
              testID="assistant-ask-again"
            >
              {ASSISTANT_WORDS.offline.again}
            </Button>
          </View>
        ) : null}
        <View className="border-t border-border bg-card-2 px-3.5 py-2.5">
          <Text className="text-[12.5px] leading-[17px] text-text-3">
            {ASSISTANT_WORDS.offline.works}
          </Text>
        </View>
      </CardShell>
    );

  const copy = assistantNotice(notice.code, {
    workspaceName: businessName,
    message: notice.message,
  });
  if (!copy) return null;
  const label = assistantNoticeAction(copy);
  return (
    <CardShell testID="assistant-notice">
      <View className="flex-row items-start gap-2.5 px-3.5 py-3">
        <Tile icon={ICONS[copy.icon]} tone={copy.tone === 'neutral' ? 'neutral' : copy.tone} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[13px] font-medium">{copy.title}</Text>
          <Text className="text-xs leading-[17px] text-text-2">{copy.sub}</Text>
        </View>
      </View>
      {label && (copy.action === 'retry' ? onRetry : onReload) ? (
        <View className="flex-row items-center border-t border-border px-3.5 py-2.5">
          <Button
            variant="secondary"
            size="md"
            icon={RefreshCw}
            onPress={copy.action === 'retry' ? onRetry : onReload}
            testID="assistant-notice-action"
          >
            {label}
          </Button>
        </View>
      ) : null}
    </CardShell>
  );
}

/**
 * No model on the worker (`missing`), or a build that doesn't know where the worker is (`not-in-build`). They read
 * differently on purpose: only the first is fixed by setting the Assistant up.
 */
export function NotSetUp({ reason = 'missing' }: { reason?: 'missing' | 'not-in-build' }) {
  const words =
    reason === 'not-in-build' ? ASSISTANT_WORDS.notInThisBuild : ASSISTANT_WORDS.notAvailable;
  return (
    <View className="items-center gap-3 px-6 py-10" testID="assistant-not-set-up">
      <Tile icon={CircleAlert} tone="accent" size={40} />
      <Text className="text-center text-[17px] font-semibold">{words.title}</Text>
      <Text className="text-center text-[13.5px] leading-[19px] text-text-2">{words.body}</Text>
    </View>
  );
}
