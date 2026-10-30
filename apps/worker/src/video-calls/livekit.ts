/**
 * LiveKit Cloud, which carries HandsFreeOS video calls (docs/video-calls.md, "Video calls: LiveKit" in
 * docs/operations.md). Rooms are made by the first ticket used in them and close on their own once everyone has
 * gone, so there is nothing to set up per call; the worker signs tickets, reads LiveKit's webhooks, and asks it to
 * take someone out, mute them, or close a room.
 */
import {
  isPersonIdentity,
  LISTENER_IDENTITY,
  VIDEO_CALL_ATTRIBUTES,
  VIDEO_CALL_MAX_PEOPLE,
  VIDEO_CALL_ROOM_AI,
  VIDEO_CALL_TICKET_SECONDS,
  type VideoCallPublish,
} from '@hfos/core';
import {
  AccessToken,
  DataPacket_Kind,
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
 * and a second phone taking over beside the people LiveKit lets in: 10 for a meeting, 500 for a webinar.
 */
const roomOf = (maxPeople: number) => ({
  emptyTimeout: 5 * 60,
  departureTimeout: 2 * 60,
  maxParticipants: maxPeople + 2,
});

/**
 * What a ticket or a permission change lets someone send. Everything is LiveKit's "no list"; a webinar's attendee gets
 * only what they may (a camera, or a microphone and camera on stage), and nothing at all is no publishing.
 */
export function sourcesOf(p: VideoCallPublish): {
  canPublish: boolean;
  canPublishSources: TrackSource[];
} {
  if (p.camera && p.microphone && p.screen) return { canPublish: true, canPublishSources: [] };
  const sources = [
    ...(p.camera ? [TrackSource.CAMERA] : []),
    ...(p.microphone ? [TrackSource.MICROPHONE] : []),
    ...(p.screen ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
  ];
  return { canPublish: sources.length > 0, canPublishSources: sources };
}

const EVERYTHING: VideoCallPublish = { camera: true, microphone: true, screen: true };

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
        attributes: { ...t.rights?.attributes, [VIDEO_CALL_ATTRIBUTES.kind]: t.kind },
      });
      const { canPublish, canPublishSources } = sourcesOf(t.rights?.publish ?? EVERYTHING);
      at.addGrant({
        roomJoin: true,
        room: t.room,
        canPublish,
        ...(canPublishSources.length ? { canPublishSources } : {}),
        canSubscribe: true,
        // Chat and reactions.
        canPublishData: true,
        // Raising and lowering their own hand.
        canUpdateOwnMetadata: true,
      });
      at.roomConfig = new RoomConfiguration(roomOf(t.rights?.maxPeople ?? VIDEO_CALL_MAX_PEOPLE));
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

    async permit(room, identity, p) {
      try {
        // LiveKit sets all of someone's permissions at once, so everything the ticket gave is said again.
        await rooms.updateParticipant(room, identity, {
          attributes: { ...p.attributes },
          permission: {
            ...sourcesOf(p.publish),
            canSubscribe: true,
            canPublishData: true,
            canUpdateMetadata: true,
          },
        });
        return true;
      } catch (e) {
        if (notThere(e)) return false;
        throw failed(e, 'change what someone may send');
      }
    },

    async listenerTicket(room) {
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: LISTENER_IDENTITY,
        name: 'HandsFreeOS AI notes',
        ttl: VIDEO_CALL_TICKET_SECONDS,
      });
      // Hidden, so nobody's screen shows it; it leaves on its own once nobody else is there (hearing.ts).
      at.kind = 'agent';
      at.addGrant({
        roomJoin: true,
        room,
        hidden: true,
        agent: true,
        canSubscribe: true,
        canPublish: false,
        // Captions.
        canPublishData: true,
      });
      return { url: config.url, token: await at.toJwt() };
    },

    async whoIsIn(room) {
      try {
        const list = await rooms.listParticipants(room);
        return {
          people: list.filter((p) => isPersonIdentity(p.identity)).length,
          listener: list.some((p) => p.identity === LISTENER_IDENTITY),
        };
      } catch (e) {
        if (notThere(e)) return { people: 0, listener: false };
        throw failed(e, 'say who’s in a call');
      }
    },

    async markAi(room, on) {
      try {
        await rooms.updateRoomMetadata(
          room,
          JSON.stringify(on ? { [VIDEO_CALL_ROOM_AI]: 'on' } : {}),
        );
      } catch (e) {
        if (!notThere(e)) throw failed(e, 'say whether the AI hears a call');
      }
    },

    async send(room, topic, message, to) {
      try {
        await rooms.sendData(
          room,
          new TextEncoder().encode(JSON.stringify(message)),
          DataPacket_Kind.RELIABLE,
          { topic, ...(to ? { destinationIdentities: [...to] } : {}) },
        );
      } catch (e) {
        if (!notThere(e)) throw failed(e, 'send something to everyone in a call');
      }
    },
  };
}
