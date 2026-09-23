/**
 * The AI teammate's end of a live call (M18 step 5): Twilio Media Streams over a websocket.
 *
 * Twilio opens `/webhooks/twilio/voice/agent` when a call reaches the `<Connect><Stream>` in agentTwiml, then
 * sends `connected`, `start` (with the stream's parameters: our sealed ticket), the caller's audio as `media`,
 * `mark` when something we sent has played, and `stop`. We send audio back as `media`, a `mark` after each reply,
 * and `clear` to stop what's playing. A stream whose ticket doesn't open, or names another call, is closed at
 * once; so is one that never says `start`.
 *
 * Closing the stream without having given the call new instructions sends it on to the voicemail after the
 * stream in the TwiML, which is how every failure here still reaches a person.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { CallSession, type CallLink } from '../voice-agent/session';
import { openTicket } from '../voice-agent/ticket';
import type { HttpDeps } from './common';
import { transferTwimlFor } from './voice';

/** A stream that hasn't said which call it is by now is closed. */
const START_WITHIN_MS = 10_000;

interface StreamMessage {
  readonly event?: string;
  readonly streamSid?: string;
  readonly start?: {
    readonly streamSid?: string;
    readonly callSid?: string;
    readonly customParameters?: Readonly<Record<string, string>>;
  };
  readonly media?: { readonly payload?: string; readonly track?: string };
  readonly mark?: { readonly name?: string };
}

export async function registerVoiceAgentRoute(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(websocket);
  app.get('/webhooks/twilio/voice/agent', { websocket: true }, (socket) =>
    handleStream(socket, deps),
  );
}

function handleStream(socket: WebSocket, deps: HttpDeps): void {
  let session: CallSession | null = null;
  let streamSid: string | null = null;
  const send = (m: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
  };
  const link: CallLink = {
    sendAudio: (audio) =>
      send({ event: 'media', streamSid, media: { payload: audio.toString('base64') } }),
    sendMark: (name) => send({ event: 'mark', streamSid, mark: { name } }),
    clear: () => send({ event: 'clear', streamSid }),
    close: () => socket.close(),
  };
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
        const ticket = openTicket(deps.sealer, m.start?.customParameters?.['t']);
        if (!ticket || !deps.speech || ticket.callSid !== m.start?.callSid) {
          deps.log.warn(
            { callSid: m.start?.callSid },
            'refused a call stream without a good ticket',
          );
          socket.close();
          return;
        }
        streamSid = m.start?.streamSid ?? m.streamSid ?? null;
        session = new CallSession(
          {
            ...deps,
            speech: deps.speech,
            transferTwiml: (t) => transferTwimlFor(deps, t),
            ...(deps.voiceTimings ? { timings: deps.voiceTimings } : {}),
          },
          link,
          ticket,
        );
        const started = session;
        void started.start().then(
          (ok) => {
            if (!ok) socket.close();
          },
          (e: unknown) => {
            deps.log.error({ err: e }, 'a call stream failed to start');
            socket.close();
          },
        );
        return;
      }
      case 'media':
        // Only the caller's side is sent (the stream's default), but a both-sides stream is read the same.
        if (m.media?.payload && m.media.track !== 'outbound')
          session?.onAudio(Buffer.from(m.media.payload, 'base64'));
        return;
      case 'mark':
        if (m.mark?.name) session?.onMark(m.mark.name);
        return;
      case 'stop':
        void session?.stop();
        return;
    }
  });
  socket.on('close', () => {
    clearTimeout(unstarted);
    void session?.stop();
  });
  socket.on('error', (e: Error) => deps.log.warn({ err: e }, 'a call stream errored'));
}
