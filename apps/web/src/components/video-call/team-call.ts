'use client';
/**
 * The team's side of a HandsFreeOS video call (docs/video-calls.md): who is in it and who is asking to come in
 * (`video_call.get`), read again every few seconds while the call is open, and what the team does about them. Each
 * change is a command; the worker carries it to LiveKit (taking someone out, a mute, closing the room, and in a
 * webinar the attendees' cameras and who's on stage).
 */
import { VIDEO_CALL_WAIT_POLL_MS, type AttendeeVideo } from '@hfos/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';

export const readVideoCall = (
  workspaceId: string,
  which: { readonly callId: string } | { readonly appointmentId: string },
) =>
  apiBrowser()
    .POST('/v1/queries/video_call.get', { body: { workspaceId, ...which } })
    .then(unwrap);

export type VideoCallGot = Awaited<ReturnType<typeof readVideoCall>>;
export type VideoCallPerson = VideoCallGot['people'][number];

/** The call as the team sees it, kept fresh while `on`. Null until it's first read. */
export function useVideoCall(
  workspaceId: string,
  callId: string,
  on = true,
): { got: VideoCallGot | null; reload: () => void } {
  const [got, setGot] = useState<VideoCallGot | null>(null);
  const live = useRef(true);
  const reload = useCallback(() => {
    void readVideoCall(workspaceId, { callId })
      .then((g) => {
        if (live.current) setGot(g);
      })
      // A missed read is caught up by the next one.
      .catch(() => undefined);
  }, [workspaceId, callId]);
  useEffect(() => {
    live.current = true;
    if (!on) return;
    reload();
    const t = setInterval(reload, VIDEO_CALL_WAIT_POLL_MS);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [on, reload]);
  return { got, reload };
}

type PersonAct = 'admit' | 'turn_away' | 'mute' | 'remove';

/** One of the team's buttons on a person: let in, turn away, mute or take out. */
export async function actOn(
  act: PersonAct,
  body: { workspaceId: string; callId: string; personId: string },
): Promise<void> {
  const api = apiBrowser();
  switch (act) {
    case 'admit':
      unwrap(await api.POST('/v1/commands/video_call.admit', { body }));
      return;
    case 'turn_away':
      unwrap(await api.POST('/v1/commands/video_call.turn_away', { body }));
      return;
    case 'mute':
      unwrap(await api.POST('/v1/commands/video_call.mute', { body }));
      return;
    case 'remove':
      unwrap(await api.POST('/v1/commands/video_call.remove', { body }));
      return;
  }
}

/** End for everyone: the worker closes the room, and everyone's page says the call has ended. */
export async function endForEveryone(body: { workspaceId: string; callId: string }): Promise<void> {
  unwrap(await apiBrowser().POST('/v1/commands/video_call.end', { body }));
}

/** AI notes off or on for this call: off, the AI stops listening and forgets what it heard of the call so far. */
export async function setAiNotes(body: {
  workspaceId: string;
  callId: string;
  on: boolean;
}): Promise<void> {
  unwrap(await apiBrowser().POST('/v1/commands/video_call.set_ai', { body }));
}

/** A webinar's attendees' cameras: off, on with only the team seeing them, or on with everyone seeing everyone. */
export async function setAttendeeVideo(body: {
  workspaceId: string;
  callId: string;
  attendeeVideo: AttendeeVideo;
}): Promise<void> {
  unwrap(await apiBrowser().POST('/v1/commands/video_call.set_attendee_video', { body }));
}

/** Brings an attendee on stage in a webinar, or sends them back to the audience. */
export async function setOnStage(body: {
  workspaceId: string;
  callId: string;
  personId: string;
  on: boolean;
}): Promise<void> {
  unwrap(await apiBrowser().POST('/v1/commands/video_call.stage', { body }));
}
