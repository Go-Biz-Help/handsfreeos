'use client';
/**
 * Background blur (the owner's 12b), done in the person's own browser by LiveKit's track processors before their
 * camera is sent, so nobody else ever receives the room behind them. Loaded only when the page needs it: it brings
 * a segmentation model, fetched from its publisher's CDN the first time blur is turned on.
 */
import type * as Processors from '@livekit/track-processors';
import type { LocalVideoTrack } from 'livekit-client';

let loading: Promise<typeof Processors> | null = null;
const load = () => (loading ??= import('@livekit/track-processors'));

/** Whether this browser can blur: Chrome, Edge, Firefox and Safari on computers, and not every phone. */
export async function canBlur(): Promise<boolean> {
  try {
    return (await load()).supportsBackgroundProcessors();
  } catch {
    return false;
  }
}

/** Turns blur on or off for a camera. Turning it on twice is nothing. */
export async function setBlur(track: LocalVideoTrack, on: boolean): Promise<void> {
  if (!on) {
    if (track.getProcessor()) await track.stopProcessor();
    return;
  }
  if (track.getProcessor()) return;
  const { BackgroundProcessor } = await load();
  await track.setProcessor(BackgroundProcessor({ mode: 'background-blur', blurRadius: 10 }));
}
