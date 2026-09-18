import { ASSISTANT_WORDS } from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Check, CircleAlert } from '@/components/icons';
import { BrandMark } from '@/components/shell/brand';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { AnswerMessage, CallState, ChatMessage, Step } from '@/assistant/chat';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

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
        <Text className="text-[15px] leading-[22px]" testID="assistant-answer-text">
          {message.text}
        </Text>
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
          <Text className="text-[15px] leading-[21px] text-white">{message.text}</Text>
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
