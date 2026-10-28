import { VIDEO_CALL_WORDS as W } from '@hfos/core';

/**
 * Why the room let them go (as the web's `CallEnd`): they left; the team took them out; the call was ended for
 * everyone; they joined again on another phone or in a browser; or the connection was lost and didn't come back.
 */
export type CallEnd = 'left' | 'removed' | 'ended' | 'elsewhere' | 'lost';

/** LiveKit's `DisconnectReason`, by name, so this file needs nothing of LiveKit's (tests run without it). */
export type Disconnected =
  | 'CLIENT_INITIATED'
  | 'PARTICIPANT_REMOVED'
  | 'ROOM_DELETED'
  | 'ROOM_CLOSED'
  | 'DUPLICATE_IDENTITY'
  | string
  | undefined;

export function endOf(reason: Disconnected): CallEnd {
  switch (reason) {
    case 'CLIENT_INITIATED':
      return 'left';
    case 'PARTICIPANT_REMOVED':
      return 'removed';
    case 'ROOM_DELETED':
    case 'ROOM_CLOSED':
      return 'ended';
    case 'DUPLICATE_IDENTITY':
      return 'elsewhere';
    default:
      return 'lost';
  }
}

/** What the screen says once they're out, and what joining again is called (the team can start an ended call again). */
export function afterCall(end: CallEnd): { title: string; body: string | null; again: string } {
  switch (end) {
    case 'left':
      return { title: W.left, body: null, again: 'Rejoin' };
    case 'removed':
      return {
        title: W.removed,
        body: 'Someone else on the team took you out of the call.',
        again: 'Join again',
      };
    case 'ended':
      return { title: W.ended, body: W.endedTeam, again: 'Start it again' };
    case 'elsewhere':
      return { title: W.elsewhereTitle, body: W.elsewhere, again: 'Join here instead' };
    case 'lost':
      return { title: W.lostTitle, body: W.lost, again: 'Join again' };
  }
}
