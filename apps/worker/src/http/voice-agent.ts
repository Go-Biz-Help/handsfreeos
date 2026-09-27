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
 *
 * A live test call from the test console over the phone line (ai-team/test-call.ts) streams to
 * `/webhooks/twilio/voice/agent/test/<machine>` instead: the machine that holds the console's end of the call,
 * where the call has to run. When Fly hands the stream to another machine, it's sent on there (`fly-replay`)
 * before it opens. Its TwiML hangs up after the stream, so closing it ends the test call.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { answerTestCall, thisMachine } from '../ai-team/test-call';
import { realCall } from '../voice-agent/brain';
import { CallSession, type CallLink } from '../voice-agent/session';
import { openTestTicket, openTicket } from '../voice-agent/ticket';
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

/** A Fly machine id (or `local` off Fly): what a test call's stream path names. */
const MACHINE = /^[a-z0-9]{1,40}$/i;

export async function registerVoiceAgentRoute(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(websocket);
  app.get('/webhooks/twilio/voice/agent', { websocket: true }, (socket) =>
    handleStream(socket, deps, (start, link) => {
      const ticket = openTicket(deps.sealer, start.params['t']);
      if (!ticket || !deps.speech || ticket.callSid !== start.callSid) return null;
      return new CallSession(
        {
          speech: deps.speech,
          log: deps.log,
          ...(deps.voiceTimings ? { timings: deps.voiceTimings } : {}),
        },
        link,
        realCall({ ...deps, transferTwiml: (t) => transferTwimlFor(deps, t) }, ticket),
        { callSid: ticket.callSid },
      );
    }),
  );
  app.get<{ Params: { machine: string } }>(
    '/webhooks/twilio/voice/agent/test/:machine',
    {
      websocket: true,
      // Not this machine: Fly's proxy replays the request on the one named, before the websocket opens.
      preValidation: async (req, reply) => {
        const machine = req.params.machine;
        const here = thisMachine();
        if (MACHINE.test(machine) && machine !== here && here !== 'local')
          return reply.header('fly-replay', `instance=${machine}`).code(409).send();
      },
    },
    (socket) =>
      handleStream(socket, deps, (start, link) => {
        const ticket = openTestTicket(deps.sealer, start.params['t']);
        if (!ticket?.callSid || ticket.callSid !== start.callSid) return null;
        return answerTestCall(ticket, link, ticket.callSid);
      }),
  );
}

/** A stream's `start`: which call it is, and the parameters our TwiML gave it. */
interface StreamStart {
  readonly callSid: string | undefined;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * One call's stream: `open` turns its `start` into the session the call runs on (null refuses the stream, which
 * is closed), and everything after goes to that session.
 */
function handleStream(
  socket: WebSocket,
  deps: HttpDeps,
  open: (start: StreamStart, link: CallLink) => CallSession | null,
): void {
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
        streamSid = m.start?.streamSid ?? m.streamSid ?? null;
        const opened = open(
          { callSid: m.start?.callSid, params: m.start?.customParameters ?? {} },
          link,
        );
        if (!opened) {
          deps.log.warn(
            { callSid: m.start?.callSid },
            'refused a call stream without a good ticket',
          );
          socket.close();
          return;
        }
        session = opened;
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
