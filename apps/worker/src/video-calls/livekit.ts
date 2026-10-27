/**
 * LiveKit Cloud, which carries HandsFreeOS video calls (docs/video-calls.md, "Video calls: LiveKit" in
 * docs/operations.md). Rooms are made by the first ticket used in them and close on their own once everyone has
 * gone, so there is nothing to set up per call; the worker signs tickets, reads LiveKit's webhooks, and asks it to
 * take someone out, mute them, or close a room.
 */
import {
  VIDEO_CALL_ATTRIBUTES,
  VIDEO_CALL_MAX_PEOPLE,
  VIDEO_CALL_TICKET_SECONDS,
} from '@hfos/core';
import {
  AccessToken,
  RoomConfiguration,
  RoomServiceClient,
  ServerError,
  TrackSource,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { VideoCallError, type VideoCallProvider, type VideoReport } from './provider';

export interface LiveKitConfig {
  /** The project's wss:// address (ws:// for `livekit-server --dev` on a laptop). */
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * How a room behaves, set by the first ticket used in it. Everyone dropping for a moment (a train, a lift) doesn't
 * end the call: the room waits two minutes after the last person goes before it closes. Room for the AI's listener
 * and a second phone taking over beside the people LiveKit lets in.
 */
const ROOM = {
  emptyTimeout: 5 * 60,
  departureTimeout: 2 * 60,
  maxParticipants: VIDEO_CALL_MAX_PEOPLE + 2,
};

const PRESENCE: Readonly<Record<string, 'joined' | 'left'>> = {
  participant_joined: 'joined',
  participant_left: 'left',
  // They never got all the way in; any time they were in is closed like a leaving.
  participant_connection_aborted: 'left',
};

/** A webhook's event as LiveKit sends it (its JSON, read by the SDK or by the stand-in). */
export interface LiveKitEvent {
  readonly event: string;
  readonly id: string;
  readonly room?: { readonly name?: string; readonly sid?: string };
  readonly participant?: { readonly identity?: string; readonly sid?: string };
  /** Seconds since 1970. */
  readonly createdAt?: bigint | number | string;
}

/** What a webhook's event means for a call. */
export function reportOf(e: LiveKitEvent): VideoReport {
  const at = new Date(e.createdAt ? Number(e.createdAt) * 1000 : Date.now()).toISOString();
  const presence = PRESENCE[e.event];
  if (presence && e.room?.name && e.participant?.identity)
    return {
      event: presence,
      id: e.id,
      room: e.room.name,
      roomSid: e.room.sid ?? '',
      identity: e.participant.identity,
      participantSid: e.participant.sid ?? '',
      at,
    };
  if (e.event === 'room_finished' && e.room?.name)
    return { event: 'finished', id: e.id, room: e.room.name, roomSid: e.room.sid ?? '', at };
  return { event: 'other', id: e.id };
}

/** Not in the room, or no room: what LiveKit says when there's nothing to act on. */
const notThere = (e: unknown) =>
  e instanceof ServerError && (e.status === 404 || e.code === 'not_found');

function failed(e: unknown, what: string): VideoCallError {
  if (e instanceof ServerError)
    return new VideoCallError(
      `LiveKit refused to ${what}: ${e.message}`,
      e.status,
      e.status >= 400 && e.status < 500 && e.status !== 429,
    );
  return new VideoCallError(
    `LiveKit didn’t answer when asked to ${what}: ${e instanceof Error ? e.message : String(e)}`,
    null,
    false,
  );
}

export function createLiveKit(config: LiveKitConfig): VideoCallProvider {
  const rooms = new RoomServiceClient(config.url, config.apiKey, config.apiSecret);
  const receiver = new WebhookReceiver(config.apiKey, config.apiSecret);

  return {
    name: 'livekit',

    async ticket(t) {
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: t.identity,
        name: t.name,
        ttl: VIDEO_CALL_TICKET_SECONDS,
        attributes: { [VIDEO_CALL_ATTRIBUTES.kind]: t.kind },
      });
      at.addGrant({
        roomJoin: true,
        room: t.room,
        canPublish: true,
        canSubscribe: true,
        // Chat and reactions.
        canPublishData: true,
        // Raising and lowering their own hand.
        canUpdateOwnMetadata: true,
      });
      at.roomConfig = new RoomConfiguration(ROOM);
      return { url: config.url, token: await at.toJwt() };
    },

    async readReport(body, authorization) {
      try {
        return reportOf(await receiver.receive(body, authorization));
      } catch {
        return null;
      }
    },

    async remove(room, identity) {
      try {
        await rooms.removeParticipant(room, identity);
      } catch (e) {
        if (!notThere(e)) throw failed(e, 'take someone out of a call');
      }
    },

    async mute(room, identity) {
      try {
        const p = await rooms.getParticipant(room, identity);
        const mic = p.tracks.find((t) => t.source === TrackSource.MICROPHONE && !t.muted);
        if (!mic) return false;
        await rooms.mutePublishedTrack(room, identity, mic.sid, true);
        return true;
      } catch (e) {
        if (notThere(e)) return false;
        throw failed(e, 'mute someone');
      }
    },

    async close(room) {
      try {
        await rooms.deleteRoom(room);
      } catch (e) {
        if (!notThere(e)) throw failed(e, 'close a call');
      }
    },
  };
}
