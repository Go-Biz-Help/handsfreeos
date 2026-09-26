import { VOICE_WORDS } from '@hfos/core';
import * as React from 'react';
import { Animated, Pressable, View } from 'react-native';

import { LoaderCircle, Mic, MicOff, Volume2, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';
import type { VoicePhase, VoiceSession, VoiceSnapshot } from '@/voice/session';

const PHASE_WORDS: Readonly<Record<Exclude<VoicePhase, 'off'>, string>> = {
  idle: VOICE_WORDS.paused,
  listening: VOICE_WORDS.listening,
  hearing: VOICE_WORDS.hearing,
  thinking: VOICE_WORDS.thinking,
  speaking: VOICE_WORDS.speaking,
};

/** The microphone's loudness as a ring that grows while they talk, moved without re-rendering. */
function LevelRing({ session, active }: { session: VoiceSession; active: boolean }) {
  const colors = useColors();
  const [scale] = React.useState(() => new Animated.Value(1));
  React.useEffect(
    () => session.onLevel((level) => scale.setValue(1 + level * 0.9)),
    [session, scale],
  );
  if (!active) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.accent,
        opacity: 0.25,
        transform: [{ scale }],
      }}
    />
  );
}

/**
 * What talking out loud is doing now (the web's VoiceBar): listening, with a ring that moves as they talk, getting
 * their words, thinking, or speaking, with Talk to speak now (over it, while it speaks), Done to send what they've
 * said, and Stop to turn it off.
 */
export function VoiceBar({
  session,
  snap,
  onTalk,
  className,
}: {
  session: VoiceSession;
  snap: VoiceSnapshot;
  onTalk: () => void;
  className?: string;
}) {
  if (snap.phase === 'off') return null;
  const { phase } = snap;
  const icon =
    phase === 'speaking'
      ? Volume2
      : phase === 'hearing' || phase === 'thinking'
        ? LoaderCircle
        : phase === 'idle'
          ? MicOff
          : Mic;
  const words = phase === 'idle' && snap.error ? snap.error : PHASE_WORDS[phase];
  const lit = phase === 'listening' || phase === 'speaking';
  return (
    <View
      className={cn('flex-row items-center gap-2.5 bg-accent-soft px-3 py-2', className)}
      testID="voice-bar"
    >
      <View className="size-9 items-center justify-center">
        <LevelRing session={session} active={phase === 'listening'} />
        <View
          className={cn(
            'size-9 items-center justify-center rounded-full',
            lit ? 'bg-accent' : 'bg-card',
          )}
        >
          <Icon as={icon} className={cn('size-4', lit ? 'text-white' : 'text-text-2')} />
        </View>
      </View>
      <Text
        className="min-w-0 flex-1 text-[13px] font-medium text-accent-text"
        accessibilityLiveRegion="polite"
        testID="voice-status"
      >
        {words}
      </Text>
      {phase === 'listening' ? (
        <Button
          size="sm"
          variant="secondary"
          onPress={() => session.finishTurn()}
          testID="voice-done"
        >
          Done
        </Button>
      ) : phase === 'idle' || phase === 'speaking' ? (
        <Button
          size="sm"
          icon={Mic}
          onPress={onTalk}
          accessibilityHint={phase === 'speaking' ? VOICE_WORDS.interrupt : undefined}
          testID="voice-talk"
        >
          {VOICE_WORDS.talk}
        </Button>
      ) : null}
      <Pressable
        role="button"
        accessibilityLabel={VOICE_WORDS.stopTalking}
        onPress={() => session.stop()}
        testID="voice-stop"
        className="size-11 items-center justify-center rounded-full active:bg-card-2"
      >
        <Icon as={X} className="size-[18px] text-text-2" />
      </Pressable>
    </View>
  );
}

/** Why talking out loud couldn't start, when it couldn't (no microphone, no signal, not set up). */
export function VoiceError({ snap, className }: { snap: VoiceSnapshot; className?: string }) {
  if (snap.phase !== 'off' || !snap.error) return null;
  return (
    <Text role="alert" className={cn('text-xs text-danger-text', className)} testID="voice-error">
      {snap.error}
    </Text>
  );
}
