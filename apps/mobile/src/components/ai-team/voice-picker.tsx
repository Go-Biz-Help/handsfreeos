import {
  PHONE_VOICE_GROUPS,
  PHONE_VOICE_PICK_WORDS,
  phoneVoiceInfo,
  voiceReady,
  type PhoneVoice,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { VoicePick } from '@/ai-team/use-voice-pick';
import { Check, Square, Volume2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The test console's voice picker, in its setup sheet (the web's is apps/web/src/components/ai-team/voice-picker.tsx):
 * every voice grouped by model, Hear it, and Use this voice while another is being tried. A Rime voice says "not
 * ready yet" until the worker has Rime's key.
 */
export function VoicePicker({ pick: p }: { pick: VoicePick }) {
  const hearing = p.playing === p.callVoice;
  const rimeWaits = p.known && phoneVoiceInfo(p.callVoice).provider === 'rime' && !p.ready.rime;
  return (
    <View className="gap-2" testID="test-call-voice">
      {PHONE_VOICE_GROUPS.map((g) => (
        <View key={g.model} className="gap-1">
          <Text className="text-xs text-text-3">{g.label}</Text>
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {g.voices.map((v, i) => (
              <VoiceRow
                key={v}
                voice={v}
                first={i === 0}
                on={v === p.callVoice}
                saved={v === p.savedVoice}
                off={
                  v !== p.callVoice &&
                  phoneVoiceInfo(v).provider === 'rime' &&
                  !voiceReady(v, p.ready)
                }
                onPress={() => p.pick(v)}
              />
            ))}
          </View>
        </View>
      ))}
      {p.trying ? (
        <Text className="text-xs text-text-2" testID="test-call-voice-trying">
          {PHONE_VOICE_PICK_WORDS.trying(phoneVoiceInfo(p.callVoice).name)}
        </Text>
      ) : null}
      {rimeWaits ? (
        <Text className="text-xs text-warning-text" testID="voice-not-ready">
          {PHONE_VOICE_PICK_WORDS.notReadyNote}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          variant="secondary"
          size="md"
          icon={hearing ? Square : Volume2}
          accessibilityState={{ selected: hearing }}
          onPress={hearing ? p.stopHearing : p.hear}
          testID="test-call-voice-hear"
        >
          {hearing ? PHONE_VOICE_PICK_WORDS.hearing : PHONE_VOICE_PICK_WORDS.hear}
        </Button>
        {p.trying && p.canKeep ? (
          <Button
            variant="secondary"
            size="md"
            icon={Check}
            loading={p.keeping}
            onPress={() => void p.keep()}
            testID="test-call-voice-use"
          >
            {PHONE_VOICE_PICK_WORDS.use}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function VoiceRow({
  voice,
  first,
  on,
  saved,
  off,
  onPress,
}: {
  voice: PhoneVoice;
  first: boolean;
  on: boolean;
  saved: boolean;
  off: boolean;
  onPress: () => void;
}) {
  const info = phoneVoiceInfo(voice);
  return (
    <Pressable
      role="radio"
      accessibilityState={{ checked: on, disabled: off }}
      accessibilityLabel={`${info.name}: ${info.sound}${off ? `, ${PHONE_VOICE_PICK_WORDS.notReady}` : ''}`}
      disabled={off}
      onPress={onPress}
      testID={`test-call-voice-${voice}`}
      className={cn(
        'min-h-11 flex-row items-center gap-2.5 px-3 py-2 active:bg-card-2',
        !first && 'border-t border-border',
        off && 'opacity-50',
      )}
    >
      <View
        className={cn(
          'size-5 items-center justify-center rounded-full border',
          on ? 'border-transparent bg-accent' : 'border-border-strong',
        )}
      >
        {on ? <Icon as={Check} className="size-3 text-white" /> : null}
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-medium">
          {info.name}
          {saved ? (
            <Text className="text-xs font-normal text-text-3">
              {' · '}
              {PHONE_VOICE_PICK_WORDS.savedTag}
            </Text>
          ) : null}
        </Text>
        <Text className="text-xs text-text-3" numberOfLines={1}>
          {off ? PHONE_VOICE_PICK_WORDS.notReady : info.sound}
        </Text>
      </View>
    </Pressable>
  );
}
