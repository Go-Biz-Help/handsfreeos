import {
  clockOfSeconds,
  RE_BUYER_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import * as React from 'react';
import { View } from 'react-native';

import { CloudOff } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

import { LEVEL_BARS, useVoiceNoteRecorder } from './recorder';

/**
 * A voice note at a stop (board 83, third panel): it records as soon as the sheet opens, with the bars moving as they
 * talk; Stop ends it, then Keep it or Record again. With no signal it says the words come when it sends, and the
 * recording stays with the stop meanwhile.
 */
export function VoiceNoteSheet({
  open,
  onClose,
  address,
  onKeep,
}: {
  open: boolean;
  onClose: () => void;
  address: string;
  /** Keeps the finished recording; resolves true once it's kept. */
  onKeep: (recording: { readonly uri: string; readonly seconds: number }) => Promise<boolean>;
}) {
  const rec = useVoiceNoteRecorder();
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const started = React.useRef(false);
  const { start, discard } = rec;

  React.useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      void start();
    }
    if (!open) started.current = false;
  }, [open, start]);

  const close = () => {
    if (rec.phase === 'recording') void rec.stop().then(discard);
    else if (rec.phase === 'done') discard();
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={W.voiceTitle} testID="re-voice-sheet">
      <View className="mt-1 gap-3">
        <Text className="text-[14px] text-text-2" testID="re-voice-at">
          {W.voiceAt(address, clockOfSeconds(rec.seconds))}
        </Text>
        <Bars levels={rec.levels} live={rec.phase === 'recording'} />
        {rec.problem ? (
          <Text className="text-[13.5px] leading-[19px] text-danger-text" testID="re-voice-problem">
            {rec.problem === 'microphone' ? W.noMicrophone : W.recordFailed}
          </Text>
        ) : null}
        {rec.phase === 'recording' ? (
          <>
            <Text className="text-[13.5px] text-text-2">{W.recording}</Text>
            <Button onPress={() => void rec.stop()} testID="re-voice-stop">
              {W.stop}
            </Button>
          </>
        ) : rec.phase === 'done' ? (
          <>
            <View
              className={cn(
                'flex-row gap-2.5 rounded-control px-3.5 py-3',
                online ? 'bg-card-2' : 'bg-warning-soft',
              )}
              testID="re-voice-kept-note"
            >
              {!online ? <Icon as={CloudOff} className="mt-0.5 size-4 text-warning-text" /> : null}
              <Text
                className={cn(
                  'flex-1 text-[13.5px] leading-[19px]',
                  online ? 'text-text-2' : 'text-warning-text',
                )}
              >
                {online ? W.recordedOnline : W.recordedOffline}
              </Text>
            </View>
            <Button
              loading={busy}
              onPress={async () => {
                if (!rec.uri) return;
                setBusy(true);
                const ok = await onKeep({ uri: rec.uri, seconds: rec.seconds });
                setBusy(false);
                if (!ok) return;
                // The recording has moved to wait for upload: the sheet starts afresh next time.
                discard();
                onClose();
              }}
              testID="re-voice-keep"
            >
              {W.keepIt}
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                discard();
                void start();
              }}
              testID="re-voice-again"
            >
              {W.recordAgain}
            </Button>
          </>
        ) : rec.problem ? (
          <Button variant="secondary" onPress={() => void start()} testID="re-voice-retry">
            {W.recordAgain}
          </Button>
        ) : null}
      </View>
    </Sheet>
  );
}

/** The loudness as it was recorded, a bar each; quiet bars before anything is heard. */
function Bars({ levels, live }: { levels: readonly number[]; live: boolean }) {
  const shown = [...Array(Math.max(0, LEVEL_BARS - levels.length)).fill(0), ...levels] as number[];
  return (
    <View
      className="h-12 flex-row items-center gap-[3px] overflow-hidden rounded-control bg-card-2 px-2"
      accessibilityLabel={live ? W.recording : W.voiceTitle}
      testID="re-voice-bars"
    >
      {shown.map((l, i) => (
        <View
          key={i}
          className={cn('flex-1 rounded-full', live ? 'bg-accent' : 'bg-border-strong')}
          style={{ height: `${Math.max(12, Math.round(l * 100))}%` }}
        />
      ))}
    </View>
  );
}
