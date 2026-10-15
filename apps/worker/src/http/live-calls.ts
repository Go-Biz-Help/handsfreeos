/**
 * A person's call heard live (telephony/live.ts): Twilio Media Streams over a websocket, one way.
 *
 * Twilio opens `/webhooks/twilio/voice/live` when `onCallAnswered` starts a stream on an answered call, then sends
 * `connected`, `start` (with our sealed ticket), each side's audio as `media` (`track` says which), and `stop`.
 * Nothing goes back: the call carries on as it was. A stream whose ticket doesn't open, names another call, or comes
 * while the same call is already heard here, is closed at once; so is one that never says `start`.
 *
 * It's registered beside the AI teammate's stream (http/voice-agent.ts), which registers the websocket plugin.
 */
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { LiveCallSession, openLiveTicket, speakerOfTrack } from '../telephony/live';
import type { HttpDeps } from './common';

/** A stream that hasn't said which call it is by now is closed. */
const START_WITHIN_MS = 10_000;

interface StreamMessage {
  readonly event?: string;
  readonly start?: {
    readonly callSid?: string;
    readonly customParameters?: Readonly<Record<string, string>>;
  };
  readonly media?: { readonly payload?: string; readonly track?: string };
}

export function registerLiveCallRoute(app: FastifyInstance, deps: HttpDeps): void {
  app.get('/webhooks/twilio/voice/live', { websocket: true }, (socket) => hear(socket, deps));
}

function hear(socket: WebSocket, deps: HttpDeps): void {
  let session: LiveCallSession | null = null;
  let direction: 'inbound' | 'outbound' = 'inbound';
  const unstarted = setTimeout(() => {
    if (!session) socket.close();
  }, START_WITHIN_MS);

  socket.on('message', (raw: WebSocket.RawData) => {
    let m: StreamMessage;
    try {
      m = JSON.parse(String(raw)) as StreamMessage;
    } catch {
      return;
    }
    switch (m.event) {
      case 'start': {
        if (session) return;
        clearTimeout(unstarted);
        const ticket = openLiveTicket(deps.sealer, m.start?.customParameters?.['t']);
        const opened =
          ticket && deps.speech && ticket.callSid === m.start?.callSid
            ? LiveCallSession.open({ ...deps, hearing: deps.speech }, ticket)
            : null;
        if (!ticket || !opened) {
          deps.log.warn({ callSid: m.start?.callSid }, 'refused a live call stream');
          socket.close();
          return;
        }
        session = opened;
        direction = ticket.direction;
        void opened.start().then(
          (ok) => {
            if (!ok) socket.close();
          },
          (e: unknown) => {
            deps.log.error({ err: e }, 'a live call stream failed to start');
            socket.close();
          },
        );
        return;
      }
      case 'media': {
        const speaker = speakerOfTrack(direction, m.media?.track);
        if (speaker && m.media?.payload)
          session?.audio(speaker, Buffer.from(m.media.payload, 'base64'));
        return;
      }
      case 'stop':
        void session?.stop();
        return;
    }
  });
  socket.on('close', () => {
    clearTimeout(unstarted);
    void session?.stop();
  });
  socket.on('error', (e: Error) => deps.log.warn({ err: e }, 'a live call stream errored'));
}
