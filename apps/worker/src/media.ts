/**
 * The worker's media process: the AI's listener for HandsFreeOS video calls (video-calls/listener.ts,
 * docs/video-calls.md "The AI hears it"). It runs beside the worker in the same Fly app, as the `media` process
 * (fly.toml), with the same secrets, because it needs LiveKit's and Deepgram's keys and nothing else does here. On
 * a laptop: `pnpm --filter @hfos/worker media`, with LiveKit set up in apps/worker/.env.
 *
 * Without LiveKit, or without Deepgram, there's nothing to hear calls with: it says so and waits, so Fly doesn't
 * restart it over and over.
 */
import { createDb } from '@hfos/db/client';
import pino from 'pino';
import { loadEnv, readEnv } from './env';
import { errorMessage } from './outbox';
import { createVideoCalls } from './video-calls/index';
import { createListener } from './video-calls/listener';
import { createSpeech } from './voice-agent/index';

loadEnv();
const env = readEnv();
const log = pino(
  env.production
    ? { level: env.logLevel }
    : { level: env.logLevel, transport: { target: 'pino-pretty', options: { colorize: true } } },
).child({ process: 'media' });

/** How often it asks which calls to hear: a call's first words are heard within this of it starting. */
const PASS_MS = 3_000;
const TICK_MS = 1_000;

const video = createVideoCalls(env);
const speech = createSpeech(env, log);

if (video?.name !== 'livekit' || !speech) {
  log.warn(
    { video: env.videoProvider, speech: speech?.name ?? 'none' },
    'the AI can’t hear video calls here: it needs LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) and ' +
      'Deepgram (DEEPGRAM_API_KEY)',
  );
  const idle = setInterval(() => undefined, 60 * 60_000);
  const quit = () => {
    clearInterval(idle);
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
} else {
  // LiveKit's native library loads only here, once there's a call to hear with it.
  const { joinLiveKitRoom } = await import('./video-calls/listener-room');
  // A pass and a second's keeping each hold a connection only per step.
  const handle = createDb(env.databaseUrl, { max: 3, applicationName: 'hfos-media' });
  const listener = createListener({ db: handle.db, log, speech, video, join: joinLiveKitRoom });
  let running = true;

  const every = (ms: number, what: string, fn: () => Promise<void>) =>
    (async () => {
      while (running) {
        try {
          await fn();
        } catch (e) {
          log.error({ err: errorMessage(e) }, `the listener’s ${what} crashed`);
        }
        if (running) await new Promise((r) => setTimeout(r, ms));
      }
    })();
  const loops = [
    every(PASS_MS, 'pass', () => listener.pass()),
    every(TICK_MS, 'tick', () => listener.tick()),
  ];
  log.info({ speech: speech.name }, 'the AI’s listener for video calls started');

  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    log.info({ signal }, 'the listener is stopping: keeping what it heard, then leaving each call');
    await Promise.all(loops);
    await listener.stop();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
