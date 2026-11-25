import { ASSISTANT_WORDS } from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, Image, View } from 'react-native';

import { Check, CircleAlert, Image as ImageIcon } from '@/components/icons';
import { BrandMark } from '@/components/shell/brand';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { AnswerMessage, CallState, ChatMessage, Step } from '@/assistant/chat';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { AnswerText } from './answer-text';
import { AnswerCard } from './cards';
import { ConfirmCard } from './confirm-card';
import { NoticeCard } from './notices';

/** What it looked at while answering, one line each. */
function Steps({ steps }: { steps: readonly Step[] }) {
  const colors = useColors();
  if (!steps.length) return null;
  return (
    <View className="gap-1.5 py-0.5" testID="assistant-steps">
      {steps.map((step) => (
        <View key={step.id} className="flex-row items-center gap-2">
          {step.status === 'running' ? (
            <ActivityIndicator size="small" color={colors.text3} />
          ) : (
            <Icon
              as={step.status === 'done' ? Check : CircleAlert}
              className={cn(
                'size-3.5',
                step.status === 'done' ? 'text-text-3' : 'text-danger-text',
              )}
            />
          )}
          <Text className="min-w-0 flex-1 text-[12.5px] text-text-3">{step.label}</Text>
        </View>
      ))}
    </View>
  );
}

function Answer({
  message,
  businessName,
  workspaceId,
  calls,
  setCall,
  onRetry,
  onReload,
}: {
  message: AnswerMessage;
  businessName: string;
  workspaceId: string;
  calls: Readonly<Record<string, CallState>>;
  setCall: (id: string, patch: Partial<CallState>) => void;
  onRetry: () => void;
  onReload?: () => void;
}) {
  const colors = useColors();
  const nothingYet = message.live && !message.text && message.cards.length === 0;
  return (
    <View className="gap-2.5 py-1" testID="assistant-answer">
      <Steps steps={message.steps} />
      {message.text ? (
        <AnswerText text={message.text} />
      ) : nothingYet && message.steps.length === 0 ? (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" color={colors.text3} />
          <Text className="text-[13px] text-text-3">Thinking…</Text>
        </View>
      ) : null}
      {message.cards.map((card, i) =>
        card.type === 'confirm' ? (
          <ConfirmCard
            key={card.toolCallId}
            card={card}
            workspaceId={workspaceId}
            state={calls[card.toolCallId]}
            setCall={setCall}
          />
        ) : (
          <AnswerCard
            key={`${card.type}-${i}`}
            card={card}
            at={message.createdAt}
            workspaceId={workspaceId}
            calls={calls}
            setCall={setCall}
          />
        ),
      )}
      {message.notice ? (
        <NoticeCard
          notice={message.notice}
          businessName={businessName}
          onRetry={message.question ? onRetry : undefined}
          onReload={onReload}
        />
      ) : null}
      {message.notice?.code === 'stopped' ? (
        <Text className="text-[13px] text-text-3">{ASSISTANT_WORDS.stopped}</Text>
      ) : null}
    </View>
  );
}

/** The chat: what was asked on the right, and what came back under it with its cards. */
export function MessageRow({
  message,
  businessName,
  workspaceId,
  calls,
  setCall,
  onRetry,
  onReload,
}: {
  message: ChatMessage;
  businessName: string;
  workspaceId: string;
  calls: Readonly<Record<string, CallState>>;
  setCall: (id: string, patch: Partial<CallState>) => void;
  onRetry: (answerKey: string) => void;
  onReload?: () => void;
}) {
  if (message.role === 'user')
    return (
      <View className="items-end py-1.5" testID="assistant-question">
        <View className="max-w-[86%] rounded-[16px] rounded-br-[5px] bg-accent px-3.5 py-2.5">
          {message.previews?.length ? (
            <View
              className={cn('flex-row flex-wrap justify-end gap-1.5', !!message.text && 'mb-1.5')}
            >
              {message.previews.map((uri, i) => (
                <Image
                  key={i}
                  source={{ uri }}
                  accessibilityLabel={`Picture ${i + 1}`}
                  className="size-28 rounded-[10px]"
                  resizeMode="cover"
                />
              ))}
            </View>
          ) : message.pictures > 0 ? (
            <View
              className={cn('flex-row items-center gap-1.5', !!message.text && 'mb-1')}
              testID="assistant-question-pictures"
            >
              <Icon as={ImageIcon} className="size-3.5 text-white/80" />
              <Text className="text-xs text-white/80">
                {ASSISTANT_WORDS.pictures.sent(message.pictures)}
              </Text>
            </View>
          ) : null}
          {message.text ? (
            <Text selectable className="text-[15px] leading-[21px] text-white">
              {message.text}
            </Text>
          ) : null}
        </View>
      </View>
    );
  return (
    <Answer
      message={message}
      businessName={businessName}
      workspaceId={workspaceId}
      calls={calls}
      setCall={setCall}
      onRetry={() => onRetry(message.key)}
      onReload={onReload}
    />
  );
}

/** Before anything is asked. */
export function EmptyChat() {
  return (
    <View className="items-center gap-3 px-6 py-12" testID="assistant-empty">
      <BrandMark size={48} />
      <Text className="text-center text-[19px] font-semibold">{ASSISTANT_WORDS.emptyTitle}</Text>
      <Text className="text-center text-[14px] leading-[20px] text-text-2">
        {ASSISTANT_WORDS.emptyBody}
      </Text>
    </View>
  );
}
