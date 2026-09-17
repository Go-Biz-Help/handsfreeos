import {
  ATTENTION_WORDS,
  attentionTargetOf,
  clockLabel,
  handledByHandsFree,
  handledLineOf,
  handledSummary,
  type AttentionItemOut,
  type WordPart,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { CalendarCheck, CircleCheck, MessageCircle } from '@/components/icons';
import { BrandMark } from '@/components/shell/brand';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { openWebPath } from '@/home/open';

import { FoldButton } from './bits';
import { useHomeEnv } from './home-context';

type Item = AttentionItemOut;

/** A sentence with the customer in bold. */
function Words({ parts, className }: { parts: readonly WordPart[]; className?: string }) {
  return (
    <Text className={className}>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <Text key={i} className={cn(className, 'font-semibold')}>
            {part.strong}
          </Text>
        ),
      )}
    </Text>
  );
}

const at = (item: Item, timeZone: string) =>
  item.handled ? clockLabel(Date.parse(item.handled.at), timeZone) : '';

function HandledRow({ item, first }: { item: Item; first: boolean }) {
  const env = useHomeEnv();
  const { text, sub } = handledLineOf(item, env.myUserId);
  const target = attentionTargetOf(item, env.workspaceId);
  const Glyph = item.auto.action === 'confirm_request' ? CalendarCheck : MessageCircle;
  return (
    <View
      testID="handled-row"
      className={cn(
        'flex-row items-center gap-2.5 border-x border-border-strong bg-card px-3.5 py-2.5',
        !first && 'border-t border-t-border',
      )}
    >
      <Text className="w-[58px] text-[12.5px] text-text-3">{at(item, env.timeZone)}</Text>
      <View className="size-6 items-center justify-center rounded-[7px] bg-accent-soft">
        <Icon as={Glyph} strokeWidth={1.75} className="size-[13px] text-accent-text" />
      </View>
      <View className="min-w-0 flex-1">
        <Words parts={text} className="text-[13px]" />
        {sub ? (
          <Text numberOfLines={1} className="text-xs text-text-3">
            {sub}
          </Text>
        ) : null}
      </View>
      <Pressable role="link" hitSlop={10} onPress={() => openWebPath(target.href)}>
        <Text className="text-[13px] font-medium text-accent-text">{ATTENTION_WORDS.open}</Text>
      </Pressable>
    </View>
  );
}

/**
 * "Handled by HandsFreeOS", folded under the list: what it did on its own today (and for whoever chose Let HandsFreeOS
 * Handle), newest first. Nothing shows when it did nothing.
 */
export function HandledByHandsFree({ items }: { items: readonly Item[] }) {
  const [open, setOpen] = React.useState(false);
  const done = items.filter(handledByHandsFree);
  if (!done.length) return null;
  return (
    <View className="mt-3" testID="handled-by-hfos">
      <FoldButton
        open={open}
        onToggle={() => setOpen(!open)}
        icon={<BrandMark size={20} />}
        title={ATTENTION_WORDS.handledByHandsFree}
        sub={handledSummary(done)}
        badge={
          <Badge variant="ok">
            <Text>{ATTENTION_WORDS.handledCount(done.length)}</Text>
          </Badge>
        }
        testID="handled-toggle"
      />
      {open ? (
        <View className="overflow-hidden rounded-b-card border-b border-border-strong">
          {done.map((item, i) => (
            <HandledRow key={item.id} item={item} first={i === 0} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DoneRow({ item, first }: { item: Item; first: boolean }) {
  const env = useHomeEnv();
  const { text, sub } = handledLineOf(item, env.myUserId);
  const by = item.handled?.by ?? null;
  return (
    <View
      className={cn('flex-row items-start gap-3 px-4 py-2.5', !first && 'border-t border-border')}
    >
      <Text className="w-[56px] pt-[3px] text-xs text-text-3">{at(item, env.timeZone)}</Text>
      {handledByHandsFree(item) || !by ? (
        <BrandMark size={24} />
      ) : (
        <Avatar name={by.fullName} seed={by.id} size="sm" />
      )}
      <View className="min-w-0 flex-1">
        <Words parts={text} className="text-[13px]" />
        {sub ? <Text className="text-xs text-text-3">{sub}</Text> : null}
      </View>
    </View>
  );
}

/** The empty list: "You're all caught up", then what got done today, by the team and by HandsFreeOS. */
export function CaughtUp({ items, count }: { items: readonly Item[]; count: number }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? items : items.slice(0, 6);
  const hf = items.filter(handledByHandsFree).length;
  return (
    <View className="gap-4">
      <Card className="items-center gap-1.5 px-6 py-[26px]" testID="attention-empty">
        <View className="size-11 items-center justify-center rounded-full bg-success-soft">
          <Icon as={CircleCheck} strokeWidth={1.75} className="size-[22px] text-success-text" />
        </View>
        <Text className="mt-1 text-base font-semibold">{ATTENTION_WORDS.caughtUpTitle}</Text>
        <Text className="text-center text-[13.5px] leading-[20px] text-text-2">
          {ATTENTION_WORDS.caughtUpBody}
        </Text>
      </Card>
      {items.length ? (
        <Card testID="handled-today">
          <View className="flex-row items-center gap-2 px-4 pb-[9px] pt-[13px]">
            <Text className="flex-1 text-[15px] font-semibold">{ATTENTION_WORDS.handledToday}</Text>
            <Badge variant="ok">
              <Text>{String(Math.max(count, items.length))}</Text>
            </Badge>
          </View>
          <View className="border-t border-border">
            {shown.map((item, i) => (
              <DoneRow key={item.id} item={item} first={i === 0} />
            ))}
          </View>
          <View className="flex-row flex-wrap border-t border-border bg-card-2 px-4 py-[9px]">
            {items.length > shown.length ? (
              <Pressable role="button" onPress={() => setAll(true)} hitSlop={8}>
                <Text className="text-xs font-medium text-accent-text">
                  {ATTENTION_WORDS.showMore(items.length - shown.length)}
                </Text>
              </Pressable>
            ) : null}
            <Text className="text-xs text-text-3">
              {items.length > shown.length ? ' · ' : ''}
              {ATTENTION_WORDS.handledSplit(items.length - hf, hf)}
            </Text>
          </View>
        </Card>
      ) : null}
    </View>
  );
}
