import { ASSISTANT_WORDS } from '@hfos/core';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { ArrowUp, Square } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/**
 * Where the question is typed. Return adds a line, and the round button sends, as on a phone it must. While an
 * answer comes in, Stop takes its place. With no signal, or when the Assistant is paused or not set up, the box
 * says so and sends nothing.
 */
export function AssistantComposer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  off,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  /** Why the box can't take a question, or null while it can. */
  off: { readonly text: string; readonly hint: string } | null;
}) {
  const colors = useColors();
  const canSend = value.trim().length > 0 && !running;

  if (off)
    return (
      <View
        className="flex-none border-t border-border bg-card px-2.5 pb-2.5 pt-2"
        testID="assistant-composer-off"
      >
        <View className="rounded-card border border-border bg-card-2 px-3 py-2.5">
          <Text className="text-[14.5px] text-placeholder">{off.text}</Text>
          <Text className="pt-1 text-xs text-text-3">{off.hint}</Text>
        </View>
      </View>
    );

  return (
    <View
      className="flex-none flex-row items-end gap-1.5 border-t border-border bg-card px-2.5 pb-2.5 pt-2"
      testID="assistant-composer"
    >
      <View className="min-h-11 min-w-0 flex-1 justify-center rounded-[22px] border border-border-strong bg-card px-4 py-1">
        <TextInput
          value={value}
          onChangeText={onChange}
          multiline
          maxLength={4000}
          placeholder={ASSISTANT_WORDS.placeholder.full}
          placeholderTextColor={colors.placeholder}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          aria-label="Ask HandsFreeOS"
          testID="assistant-input"
          className="max-h-[120px] py-0 font-sans text-base leading-[22px] text-text"
        />
      </View>
      {running ? (
        <Pressable
          role="button"
          accessibilityLabel={ASSISTANT_WORDS.stop}
          testID="assistant-stop"
          onPress={onStop}
          className="size-11 shrink-0 items-center justify-center rounded-full border border-border-strong active:bg-card-2"
        >
          <Icon as={Square} className="size-3.5 text-text-2" />
        </Pressable>
      ) : (
        <Pressable
          role="button"
          accessibilityLabel={ASSISTANT_WORDS.send}
          accessibilityState={{ disabled: !canSend }}
          testID="assistant-send"
          disabled={!canSend}
          onPress={onSend}
          className={cn(
            'size-11 shrink-0 items-center justify-center rounded-full bg-accent active:bg-accent-hover',
            !canSend && 'opacity-45',
          )}
        >
          <Icon as={ArrowUp} className="size-[18px] text-white" />
        </Pressable>
      )}
    </View>
  );
}
