import { callClock } from '@hfos/core';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Pause, Play } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { recordingUrl } from '@/inbox/storage';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/** The bars drawn for a recording: the same for the same call, so the picture doesn't jump between renders. */
export function barsFor(seed: string, count = 28): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: count }, () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return 0.25 + (((h >>> 0) % 1000) / 1000) * 0.75;
  });
}

export const PLAYER_WORDS = {
  play: 'Play the recording',
  pause: 'Pause',
  needsSignal: 'Plays with signal',
  missing: 'This recording isn’t available.',
} as const;

/**
 * A voicemail's (or a call through someone's cell's) recording, as the Calls board draws it: play, the bars filling as
 * it plays, and "0:07 / 0:18". The recording is fetched from Storage on the first press, so it plays with signal.
 */
export function VoicemailPlayer({
  workspaceId,
  callId,
  voicemail,
  seconds,
}: {
  workspaceId: string;
  callId: string;
  voicemail: boolean;
  seconds: number | null;
}) {
  const { online } = useNetwork();
  const colors = useColors();
  const [url, setUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const wantPlay = React.useRef(false);
  const player = useAudioPlayer(url ? { uri: url } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const bars = React.useMemo(() => barsFor(callId), [callId]);

  const total = status.duration > 0 ? status.duration : (seconds ?? 0);
  const at = Math.min(status.currentTime, total || status.currentTime);
  const played = total > 0 ? at / total : 0;

  React.useEffect(() => {
    if (url && status.isLoaded && wantPlay.current) {
      wantPlay.current = false;
      player.play();
    }
  }, [url, status.isLoaded, player]);

  const press = async () => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (url) {
      if (total > 0 && at >= total - 0.3) await player.seekTo(0);
      player.play();
      return;
    }
    if (!online) return;
    setLoading(true);
    try {
      await setAudioModeAsync({ playsInSilentMode: true });
      const next = await recordingUrl(workspaceId, callId, voicemail);
      if (!next) toast.error(PLAYER_WORDS.missing);
      else {
        wantPlay.current = true;
        setUrl(next);
      }
    } finally {
      setLoading(false);
    }
  };

  const off = !online && !url;
  return (
    <View className="flex-row items-center gap-2.5" testID={`player-${callId}`}>
      <Pressable
        role="button"
        accessibilityLabel={status.playing ? PLAYER_WORDS.pause : PLAYER_WORDS.play}
        accessibilityState={{ disabled: off }}
        disabled={off || loading}
        onPress={() => void press()}
        testID="player-play"
        className={cn(
          'size-11 items-center justify-center rounded-full',
          off ? 'bg-card-3' : 'bg-accent active:opacity-80',
        )}
      >
        {loading || (url && !status.isLoaded) ? (
          <ActivityIndicator size="small" color={colors.onSolid} />
        ) : (
          <Icon
            as={status.playing ? Pause : Play}
            className={cn('size-4', off ? 'text-text-3' : 'text-white')}
            fill={off ? undefined : '#ffffff'}
          />
        )}
      </Pressable>
      <View className="h-7 min-w-0 flex-1 flex-row items-center gap-[2px]" role="none">
        {bars.map((b, i) => (
          <View
            key={i}
            className={cn(
              'flex-1 rounded-full',
              (i + 0.5) / bars.length <= played ? 'bg-accent' : 'bg-border-strong',
            )}
            style={{ height: `${Math.round(b * 100)}%` }}
          />
        ))}
      </View>
      <Text className="min-w-[72px] text-right text-xs text-text-3" testID="player-time">
        {off ? PLAYER_WORDS.needsSignal : `${callClock(at)} / ${callClock(total)}`}
      </Text>
    </View>
  );
}
