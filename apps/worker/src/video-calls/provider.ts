/**
 * HandsFreeOS video calls' seam (docs/video-calls.md): what the worker asks of the service that carries a call's
 * video and sound. LiveKit in production (livekit.ts); a stand-in on laptops and in tests (fake.ts) that keeps what
 * it was asked. The worker alone holds LiveKit's secret, so nobody gets into a room without a ticket it signed,
 * and it signs one only once core's commands say the person may come in.
 */
import type { VideoCallKind, VideoCallPublish } from '@hfos/core';

export type VideoProviderName = 'livekit' | 'fake';

/** Who a ticket lets into which room. */
export interface TicketRequest {
  /** The call's room (`videoCallRoom`). */
  readonly room: string;
  /** Their identity in the room: their row of `app.video_call_people`. */
  readonly identity: string;
  /** The name everyone else in the call sees. */
  readonly name: string;
  /** Who they are to the call, carried in the room so every page can tell the team from the customer. */
  readonly kind: VideoCallKind;
  /**
   * What core says they may do in the room (`VideoCallRoomRights`): how many it holds, what they may send, and what
   * else they carry (a webinar's format, camera choice, being on stage). Left out, a meeting's: everything, up to 10.
   */
  readonly rights?: RoomRights | null;
}

/** What someone may do in a room, from core (`rightsOf`). */
export interface RoomRights {
  /** How many people the room holds, the listener aside: set by the first ticket used in it. */
  readonly maxPeople: number;
  readonly publish: VideoCallPublish;
  readonly attributes: Readonly<Record<string, string>>;
}

/** What someone in the room is changed to (a webinar's camera choice, or bringing them on stage). */
export interface PermitRequest {
  readonly publish: VideoCallPublish;
  /** Only the ones to change; an empty value takes one off. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** What a browser connects with. */
export interface VideoTicket {
  /** Where to connect: LiveKit's wss:// address, or `fake:` for the stand-in. */
  readonly url: string;
  /** Signed by the worker, good for a few minutes to get in. LiveKit keeps a connection that's in going. */
  readonly token: string;
}

/** One thing LiveKit says happened, from a webhook whose signature checked out. */
export type VideoReport =
  | {
      readonly event: 'joined' | 'left';
      /** LiveKit's id for the report, the same on every retry. */
      readonly id: string;
      readonly room: string;
      readonly roomSid: string;
      readonly identity: string;
      /** LiveKit's id for this one connection: a reload or a second phone is a new one. */
      readonly participantSid: string;
      readonly at: string;
    }
  | {
      readonly event: 'finished';
      readonly id: string;
      readonly room: string;
      readonly roomSid: string;
      readonly at: string;
    }
  /** Anything else (a room starting, a track): nothing to do. */
  | { readonly event: 'other'; readonly id: string };

export interface VideoCallProvider {
  readonly name: VideoProviderName;
  ticket(t: TicketRequest): Promise<VideoTicket>;
  /** A webhook's report, or null when it isn't signed with our key or its body was changed on the way. */
  readReport(body: string, authorization: string | undefined): Promise<VideoReport | null>;
  /** Takes someone out of a room. Someone who isn't in it, or a room that's closed, is no trouble. */
  remove(room: string, identity: string): Promise<void>;
  /** Mutes someone's microphone. False when they aren't in the room or have no microphone on. */
  mute(room: string, identity: string): Promise<boolean>;
  /** Closes a room, taking everyone out. One that's already closed is no trouble. */
  close(room: string): Promise<void>;
  /**
   * Changes what someone in a room may send, and what they carry, at once: LiveKit stops anything they may no longer
   * send. False when they aren't in the room.
   */
  permit(room: string, identity: string, p: PermitRequest): Promise<boolean>;

  // The AI hearing the call (part 2): its listener, in the media process (video-calls/listener.ts).

  /** The listener's ticket into a room: unseen, hearing everyone's microphone, sending only captions. */
  listenerTicket(room: string): Promise<VideoTicket>;
  /** Who's in a room now: how many people, and whether a listener (this machine's or another's) is there too. */
  whoIsIn(room: string): Promise<{ readonly people: number; readonly listener: boolean }>;
  /** Tells everyone in the call whether the AI is hearing it ("AI notes on"). A room that's closed is no trouble. */
  markAi(room: string, on: boolean): Promise<void>;
}

/** LiveKit refused or didn't answer. `permanent` is a refusal that trying again won't change. */
export class VideoCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'VideoCallError';
  }
}
