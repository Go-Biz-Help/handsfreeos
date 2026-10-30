/**
 * The local and test stand-in for LiveKit. Its tickets name who they're for and say they're fake, and nothing
 * connects with them: the call page shows a stand-in for the video. Its webhooks are LiveKit's JSON, signed with a
 * fixed key that isn't a secret, so tests and Playwright can say who came and went. What the worker asked of it
 * (people taken out, muted, changed, rooms closed) is kept for tests to read.
 */
import { reportOf, type LiveKitEvent } from './livekit';
import type { PermitRequest, TicketRequest, VideoCallProvider } from './provider';

/** What the stand-in's webhooks are signed with. Not a secret. */
export const FAKE_VIDEO_WEBHOOK_KEY = 'fake-livekit-webhook';

export interface FakeVideo extends VideoCallProvider {
  readonly name: 'fake';
  readonly tickets: TicketRequest[];
  readonly removed: { room: string; identity: string }[];
  readonly muted: { room: string; identity: string }[];
  /** What people in a room were changed to (a webinar's camera choice, on stage), in order. */
  readonly permits: ({ room: string; identity: string } & PermitRequest)[];
  readonly closed: string[];
  /** The rooms the listener was given a ticket into, in order. */
  readonly listenerTickets: string[];
  /** Who tests say is in each room (`whoIsIn`): nobody, until they say. */
  readonly inRooms: Map<string, { people: number; listener: boolean }>;
  /** What each room was last told about the AI (`markAi`). */
  readonly aiMarks: Map<string, boolean>;
  /** What was sent to rooms on data topics (a live poll), in order. */
  readonly sent: { room: string; topic: string; message: unknown; to: readonly string[] | null }[];
}

const enc = (s: string) => Buffer.from(s).toString('base64url');

/** The ticket the stand-in signs, read back (tests). */
export function readFakeTicket(token: string): TicketRequest | null {
  const [kind, body] = token.split('.');
  if (kind !== 'fake-livekit' || !body) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketRequest;
  } catch {
    return null;
  }
}

/** The room the stand-in's ticket for the AI's listener is into (tests). */
export function readFakeListenerTicket(token: string): string | null {
  const [kind, body] = token.split('.');
  if (kind !== 'fake-livekit-listener' || !body) return null;
  return Buffer.from(body, 'base64url').toString('utf8');
}

/** A webhook from the stand-in, as tests post it: LiveKit's JSON and the stand-in's key. */
export function fakeVideoWebhook(e: LiveKitEvent): {
  body: string;
  authorization: string;
} {
  return {
    body: JSON.stringify({ ...e, createdAt: e.createdAt?.toString() }),
    authorization: FAKE_VIDEO_WEBHOOK_KEY,
  };
}

export function createFakeVideo(): FakeVideo {
  const tickets: TicketRequest[] = [];
  const removed: { room: string; identity: string }[] = [];
  const muted: { room: string; identity: string }[] = [];
  const permits: ({ room: string; identity: string } & PermitRequest)[] = [];
  const closed: string[] = [];
  const listenerTickets: string[] = [];
  const inRooms = new Map<string, { people: number; listener: boolean }>();
  const aiMarks = new Map<string, boolean>();
  const sent: FakeVideo['sent'] = [];
  return {
    name: 'fake',
    tickets,
    removed,
    muted,
    permits,
    closed,
    listenerTickets,
    inRooms,
    aiMarks,
    sent,
    async ticket(t) {
      tickets.push(t);
      return { url: 'fake:', token: `fake-livekit.${enc(JSON.stringify(t))}` };
    },
    async readReport(body, authorization) {
      if (authorization !== FAKE_VIDEO_WEBHOOK_KEY) return null;
      try {
        const e = JSON.parse(body) as LiveKitEvent;
        return typeof e?.event === 'string' && typeof e.id === 'string' ? reportOf(e) : null;
      } catch {
        return null;
      }
    },
    async remove(room, identity) {
      removed.push({ room, identity });
    },
    async mute(room, identity) {
      muted.push({ room, identity });
      return true;
    },
    async close(room) {
      closed.push(room);
    },
    async permit(room, identity, p) {
      permits.push({ room, identity, ...p });
      return true;
    },
    async listenerTicket(room) {
      listenerTickets.push(room);
      return { url: 'fake:', token: `fake-livekit-listener.${enc(room)}` };
    },
    async whoIsIn(room) {
      return inRooms.get(room) ?? { people: 0, listener: false };
    },
    async markAi(room, on) {
      aiMarks.set(room, on);
    },
    async send(room, topic, message, to) {
      sent.push({ room, topic, message, to: to ? [...to] : null });
    },
  };
}
