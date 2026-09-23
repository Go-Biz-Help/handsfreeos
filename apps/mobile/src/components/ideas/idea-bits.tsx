import {
  IDEA_STATUS_WORDS,
  IDEAS_WORDS,
  WHATS_NEW_KIND_WORDS,
  type IdeaStatus,
  type WhatsNewKind,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { CloudOff, Lightbulb } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The small pieces every Ideas screen on the phone shares: the status and kind badges in the web's colours, an idea's
 * details as the person typed them, and the two cards a live screen shows before it has anything (getting it, or
 * needing a signal).
 */

type BadgeVariant = 'accent' | 'pending' | 'ok' | 'gray' | 'member';

const STATUS_BADGE: Record<IdeaStatus, BadgeVariant> = {
  under_review: 'gray',
  planned: 'accent',
  in_progress: 'pending',
  done: 'ok',
  not_planned: 'member',
};

export function StatusPill({ status, testID }: { status: IdeaStatus; testID?: string }) {
  return (
    <Badge variant={STATUS_BADGE[status]} testID={testID ?? 'idea-status'}>
      <Text>{IDEA_STATUS_WORDS[status]}</Text>
    </Badge>
  );
}

const KIND_BADGE: Record<WhatsNewKind, BadgeVariant> = {
  new: 'accent',
  improved: 'ok',
  fixed: 'gray',
};

export function KindPill({ kind }: { kind: WhatsNewKind }) {
  return (
    <Badge variant={KIND_BADGE[kind]}>
      <Text className="font-semibold">{WHATS_NEW_KIND_WORDS[kind]}</Text>
    </Badge>
  );
}

/**
 * Plain text as people typed it: blank lines make paragraphs, and lines that start "- " make a list. Never markup:
 * what somebody typed is shown as words, whatever it looks like.
 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (!blocks.length) return null;
  return (
    <View className={cn('gap-3', className)}>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^[-•*]\s+/.test(l.trim())))
          return (
            <View key={i} className="gap-1">
              {lines.map((l, j) => (
                <View key={j} className="flex-row gap-2 pr-2">
                  <Text className="text-[14.5px] leading-[22px] text-text-2">•</Text>
                  <Text className="flex-1 text-[14.5px] leading-[22px]">
                    {l.trim().replace(/^[-•*]\s+/, '')}
                  </Text>
                </View>
              ))}
            </View>
          );
        return (
          <Text key={i} className="text-[14.5px] leading-[22px]">
            {block}
          </Text>
        );
      })}
    </View>
  );
}

/** While the first answer is on its way. */
export function IdeasLoading({ testID }: { testID?: string }) {
  return (
    <Card className="items-center gap-2 px-5 py-8" testID={testID ?? 'ideas-loading'}>
      <Icon as={Lightbulb} className="size-6 text-text-3" />
      <Text className="text-[14.5px] text-text-2">{IDEAS_WORDS.loading}</Text>
    </Card>
  );
}

/** Nothing to show: no signal, or HandsFreeOS said no. Try again asks once more. */
export function IdeasNeedSignal({
  error,
  onRetry,
  testID,
}: {
  error: string | null;
  onRetry: () => void;
  testID?: string;
}) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID={testID ?? 'ideas-error'}>
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
        {error ?? IDEAS_WORDS.needsSignal}
      </Text>
      <Button variant="secondary" className="self-stretch" onPress={onRetry} testID="ideas-retry">
        {IDEAS_WORDS.retry}
      </Button>
    </Card>
  );
}
