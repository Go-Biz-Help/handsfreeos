/** What the call's pages share (docs/video-calls.md). */

import type { MediaTrouble } from '@hfos/core';

/** What the person picked on the way in: their microphone and camera, and whether their background is blurred. */
export interface DeviceChoices {
  readonly mic: boolean;
  readonly camera: boolean;
  readonly blur: boolean;
  readonly audioDeviceId?: string;
  readonly videoDeviceId?: string;
  /** Where the call's sound comes out, on a computer whose browser lets a page pick (./mic.tsx). */
  readonly audioOutputId?: string;
  /** Why their microphone didn't start before joining, so the call says so too (never remembered). */
  readonly micTrouble?: MediaTrouble;
}

/**
 * Why the room let them go: they left; the team took them out; the call was ended for everyone; they joined again in
 * another tab or on another device; or the connection was lost and didn't come back.
 */
export type CallEnd = 'left' | 'removed' | 'ended' | 'elsewhere' | 'lost';

/** The team's side of a call: the business and who they are in it, for the people panel and its buttons. */
export interface TeamSide {
  readonly workspaceId: string;
  readonly callId: string;
  readonly personId: string;
}

/** The line at the top of the call: the business for customers and anyone let in, the appointment for the team. */
export interface CallHeading {
  readonly title: string;
  readonly detail?: string | null;
}
