import { CALL_COACH_TEXT_SIZES, VIDEO_CALL_WORDS, callCoachTextStep } from '@hfos/core';
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import * as React from 'react';

import { AArrowDown, AArrowUp } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { deviceStore } from '@/lib/device-store';
import { useLiveAnswer } from '@/lib/live-answer';

import { CoachCard, LIVE_EVERY_SECONDS, readLive } from './live';

/** How big the coach's words are over a video call on this phone: a place in CALL_COACH_TEXT_SIZES. */
export const CALL_TEXT_SIZE_KEY = 'salescoach.callTextSize';

/**
 * The Sales Coach on a HandsFreeOS video call on the phone (docs/video-calls.md, "The coach in the call"): the newest
 * card on the call the person is on, over the top of the video, as the Live call screen shows it, every word of it.
 * A− and A+ make its words smaller or bigger, kept on this phone (the owner's picks, 12 Nov 2026). Got it puts it
 * away. With no coached call, or no card yet, nothing.
 */
export function SalescoachCallCard({ workspaceId }: { workspaceId: string }) {
  const live = useLiveAnswer(
    () => readLive(workspaceId),
    `salescoach-call:${workspaceId}`,
    W.live.none,
    {
      everySeconds: LIVE_EVERY_SECONDS,
    },
  );
  const [size, setSize] = React.useState(() =>
    callCoachTextStep(deviceStore.get(CALL_TEXT_SIZE_KEY)),
  );
  const change = (to: number) => {
    const step = callCoachTextStep(to);
    setSize(step);
    deviceStore.set(CALL_TEXT_SIZE_KEY, step);
  };
  const call = live.data?.call ?? null;
  const card = call?.state === 'live' ? call.cards[0] : undefined;
  if (!card) return null;
  return (
    <CoachCard
      workspaceId={workspaceId}
      card={card}
      top
      onGone={live.reload}
      scale={CALL_COACH_TEXT_SIZES[size]}
      extra={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            icon={AArrowDown}
            disabled={size <= 0}
            onPress={() => change(size - 1)}
            accessibilityLabel={VIDEO_CALL_WORDS.coach.smaller}
            testID="coach-smaller"
          />
          <Button
            variant="ghost"
            size="sm"
            icon={AArrowUp}
            disabled={size >= CALL_COACH_TEXT_SIZES.length - 1}
            onPress={() => change(size + 1)}
            accessibilityLabel={VIDEO_CALL_WORDS.coach.bigger}
            testID="coach-bigger"
          />
        </>
      }
    />
  );
}
