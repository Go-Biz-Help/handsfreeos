import { ASSISTANT_PICTURES_MAX, ASSISTANT_WORDS, VOICE_WORDS } from '@hfos/core';
import * as React from 'react';
import { Image, Pressable, TextInput, View } from 'react-native';

import type { DraftPicture } from '@/assistant/pictures';
import type { AssistantVoice } from '@/assistant/voice';
import { ArrowUp, Camera, Images, ImagePlus, Mic, Square, X } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { VoiceBar, VoiceError } from '@/components/voice/voice-bar';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/** Take a photo, or choose pictures: what the picture button offers. */
function PictureSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (source: 'camera' | 'library') => void;
}) {
  const W = ASSISTANT_WORDS.pictures;
  return (
    <Sheet open={open} onClose={onClose} title={W.add} testID="assistant-picture-sheet">
      <View className="gap-1">
        <Pressable
          role="button"
          onPress={() => onPick('camera')}
          className="min-h-14 flex-row items-center gap-3 rounded-menu px-2"
          testID="assistant-picture-camera"
        >
          <Icon as={Camera} className="size-5 text-text-2" />
          <Text className="text-[15px]">{W.take}</Text>
        </Pressable>
        <Pressable
          role="button"
          onPress={() => onPick('library')}
          className="min-h-14 flex-row items-center gap-3 rounded-menu px-2"
          testID="assistant-picture-library"
        >
          <Icon as={Images} className="size-5 text-text-2" />
          <Text className="text-[15px]">{W.choose}</Text>
        </Pressable>
        <Text className="px-2 pt-1 text-[12.5px] text-text-3">{W.hint}</Text>
      </View>
    </Sheet>
  );
}

/** The pictures waiting to go with the question, each with a way to take it off. */
function DraftPictures({
  pictures,
  onRemove,
}: {
  pictures: readonly DraftPicture[];
  onRemove: (id: string) => void;
}) {
  if (!pictures.length) return null;
  return (
    <View className="flex-row flex-wrap gap-2 px-3 pt-2.5" testID="assistant-pictures">
      {pictures.map((p, i) => (
        <View key={p.id} className="relative">
          <Image
            source={{ uri: p.preview }}
            accessibilityLabel={`Picture ${i + 1}`}
            className="size-14 rounded-[10px] border border-border"
            resizeMode="cover"
          />
          <Pressable
            role="button"
            accessibilityLabel={`${ASSISTANT_WORDS.pictures.remove} (${i + 1})`}
            hitSlop={8}
            onPress={() => onRemove(p.id)}
            testID={`assistant-picture-remove-${i + 1}`}
            className="absolute -right-1.5 -top-1.5 size-5 items-center justify-center rounded-full border border-border bg-card"
          >
            <Icon as={X} className="size-3 text-text-2" />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/**
 * Where the question is typed. Return adds a line, and the round button sends, as on a phone it must. While an
 * answer comes in, Stop takes its place. With no signal, or when the Assistant is paused or not set up, the box
 * says so and sends nothing. The mic talks out loud instead: it listens, answers out loud, and listens again,
 * until it's turned off.
 */
export function AssistantComposer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  off,
  voice,
  pictures = [],
  onPickPictures,
  onRemovePicture,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  /** Why the box can't take a question, or null while it can. */
  off: { readonly text: string; readonly hint: string } | null;
  /** Talking out loud; without it there's no mic. */
  voice?: AssistantVoice;
  /** Pictures waiting to go with the question; without `onPickPictures` there's no picture button. */
  pictures?: readonly DraftPicture[];
  onPickPictures?: (source: 'camera' | 'library') => void;
  onRemovePicture?: (id: string) => void;
}) {
  const colors = useColors();
  const [sheet, setSheet] = React.useState(false);
  const canSend = (value.trim().length > 0 || pictures.length > 0) && !running;
  const full = pictures.length >= ASSISTANT_PICTURES_MAX;

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

  const talking = !!voice && voice.snap.phase !== 'off';
  return (
    <View className="flex-none border-t border-border bg-card">
      {voice ? <VoiceBar session={voice.session} snap={voice.snap} onTalk={voice.talk} /> : null}
      {voice ? <VoiceError snap={voice.snap} className="px-3.5 pt-2" /> : null}
      {onRemovePicture ? <DraftPictures pictures={pictures} onRemove={onRemovePicture} /> : null}
      <View className="flex-row items-end gap-1.5 px-2.5 pb-2.5 pt-2" testID="assistant-composer">
        {onPickPictures ? (
          <Pressable
            role="button"
            accessibilityLabel={ASSISTANT_WORDS.pictures.add}
            accessibilityState={{ disabled: full }}
            disabled={full}
            testID="assistant-add-picture"
            onPress={() => setSheet(true)}
            className={cn(
              'size-11 shrink-0 items-center justify-center rounded-full border border-border-strong active:bg-card-2',
              full && 'opacity-45',
            )}
          >
            <Icon as={ImagePlus} className="size-[18px] text-text-2" />
          </Pressable>
        ) : null}
        {voice ? (
          <Pressable
            role="button"
            accessibilityLabel={talking ? VOICE_WORDS.stopTalking : VOICE_WORDS.talkTitle}
            accessibilityState={{ selected: talking }}
            testID="assistant-talk"
            onPress={() => void voice.toggle()}
            className={cn(
              'size-11 shrink-0 items-center justify-center rounded-full border active:bg-card-2',
              talking ? 'border-accent bg-accent-soft' : 'border-border-strong',
            )}
          >
            <Icon
              as={Mic}
              className={cn('size-[18px]', talking ? 'text-accent-text' : 'text-text-2')}
            />
          </Pressable>
        ) : null}
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
      {onPickPictures ? (
        <PictureSheet
          open={sheet}
          onClose={() => setSheet(false)}
          onPick={(source) => {
            setSheet(false);
            onPickPictures(source);
          }}
        />
      ) : null}
    </View>
  );
}
