import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import * as React from 'react';

import { useLiveAnswer } from '@/lib/live-answer';

import { CoachCard, LIVE_EVERY_SECONDS, readLive } from './live';

/**
 * The Sales Coach on a HandsFreeOS video call on the phone (docs/video-calls.md, "The coach in the call"): the newest
 * card on the call the person is on, over the top of the video, as the Live call screen shows it. Got it puts it
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
  const call = live.data?.call ?? null;
  const card = call?.state === 'live' ? call.cards[0] : undefined;
  if (!card) return null;
  return <CoachCard workspaceId={workspaceId} card={card} top onGone={live.reload} />;
}
