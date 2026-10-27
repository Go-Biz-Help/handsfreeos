/**
 * The team's side of a HandsFreeOS video call on the phone (docs/video-calls.md), as the web's
 * `components/video-call/team-call.ts`: who is in it and who is asking to come in (`video_call.get`), read again
 * every few seconds while the call is open, and what the team does about them. Each change is a command; the worker
 * carries it to LiveKit. Getting in is the worker's too: it alone holds LiveKit's secret, so it signs the ticket.
 */
import { VIDEO_CALL_WAIT_POLL_MS } from '@hfos/core';
import * as React from 'react';

import { api, unwrap } from '@/lib/api';
import { workerPost } from '@/lib/worker';

/** What LiveKit needs to let the person in: its address and a ticket that lasts minutes. */
export interface VideoTicket {
  readonly url: string;
  readonly token: string;
}

/** The stand-in's tickets (apps/worker/src/video-calls/fake.ts, on laptops and in tests): nothing to connect to. */
export const STAND_IN_URL = 'fake:';

/** The worker's answer to Join: the call, who they are in it, and their ticket. */
export interface TeamJoin {
  readonly workspaceId: string;
  /** Their identity in the room. */
  readonly personId: string;
  readonly name: string;
  readonly ticket: VideoTicket;
}

/** The team's side of a call: the business and who they are in it, for the people sheet and its buttons. */
export interface TeamSide {
  readonly workspaceId: string;
  readonly callId: string;
  readonly personId: string;
}

/** What they picked on the way in. */
export interface CallChoices {
  readonly mic: boolean;
  readonly camera: boolean;
}

/** Someone from the team joins: straight in, on a ticket the worker signs once core says they may. */
export function joinVideoCall(callId: string): Promise<TeamJoin> {
  return workerPost<TeamJoin>('/v1/video-calls/join', { callId });
}

export const readVideoCall = async (workspaceId: string, callId: string) =>
  unwrap(await api.POST('/v1/queries/video_call.get', { body: { workspaceId, callId } }));

export type VideoCallGot = Awaited<ReturnType<typeof readVideoCall>>;
export type VideoCallPerson = VideoCallGot['people'][number];

/** The call as the team sees it, kept fresh while `on`. Null until it's first read; `failed` when that read failed. */
export function useVideoCall(
  workspaceId: string,
  callId: string,
  on = true,
): { got: VideoCallGot | null; failed: unknown; reload: () => void } {
  const [got, setGot] = React.useState<VideoCallGot | null>(null);
  const [failed, setFailed] = React.useState<unknown>(null);
  const live = React.useRef(true);
  const reload = React.useCallback(() => {
    readVideoCall(workspaceId, callId)
      .then((g) => {
        if (!live.current) return;
        setGot(g);
        setFailed(null);
      })
      // A missed read is caught up by the next one; the first one failing is said.
      .catch((e: unknown) => {
        if (live.current) setFailed(e);
      });
  }, [workspaceId, callId]);
  React.useEffect(() => {
    live.current = true;
    if (!on) return;
    reload();
    const t = setInterval(reload, VIDEO_CALL_WAIT_POLL_MS);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [on, reload]);
  return { got, failed, reload };
}

export type PersonAct = 'admit' | 'turn_away' | 'mute' | 'remove';

/** One of the team's buttons on a person: let in, turn away, mute or take out. */
export async function actOn(
  act: PersonAct,
  body: { workspaceId: string; callId: string; personId: string },
): Promise<void> {
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

/** End for everyone: the worker closes the room, and everyone's screen says the call has ended. */
export async function endForEveryone(body: { workspaceId: string; callId: string }): Promise<void> {
  unwrap(await api.POST('/v1/commands/video_call.end', { body }));
}

/** AI notes off or on for this call: off, the AI stops listening and forgets what it heard of the call so far. */
export async function setAiNotes(body: {
  workspaceId: string;
  callId: string;
  on: boolean;
}): Promise<void> {
  unwrap(await api.POST('/v1/commands/video_call.set_ai', { body }));
}

/**
 * Asking to come in: someone waiting, or let in and on their way, who isn't in the room yet. A customer waiting goes
 * in on their own once the team is there, so only a guest on the call's link needs Let in.
 */
export function askingToJoin(
  people: readonly VideoCallPerson[],
  inRoom: ReadonlySet<string>,
): VideoCallPerson[] {
  return people.filter(
    (p) => !inRoom.has(p.id) && (p.state === 'waiting' || p.state === 'admitted'),
  );
}

const namesOf = (people: readonly VideoCallPerson[]) =>
  people.length === 1
    ? people[0]!.name
    : people.length === 2
      ? `${people[0]!.name} and ${people[1]!.name}`
      : `${people[0]!.name} and ${people.length - 1} others`;

/** Before joining: a customer waiting for the team, else who's in the call already, else nobody yet. */
export function whoIsHere(people: readonly VideoCallPerson[]): string {
  const waiting = people.filter((p) => p.state === 'waiting' && p.kind === 'customer');
  if (waiting.length)
    return `${namesOf(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting for you.`;
  const here = people.filter((p) => p.connected);
  if (here.length) return `${namesOf(here)} ${here.length === 1 ? 'is' : 'are'} in the call.`;
  return 'Nobody is in the call yet.';
}
