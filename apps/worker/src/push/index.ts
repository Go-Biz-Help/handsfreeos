/**
 * Push notifications in the worker (M10): the sender (Expo's service or the stand-in), the send and receipt jobs,
 * and the moments that queue a push. `createPush(env)` picks the sender as the other providers do. README.md is
 * the contract the phone app builds on.
 */
import type { WorkerEnv } from '../env';
import { createExpoPush } from './expo';
import { createFakePush, type FakePush } from './fake';
import type { PushProvider } from './provider';

export * from './provider';
export { createFakePush, type FakePush, type FakePushSent } from './fake';
export { messageFor, noticeData, PUSH_TTL_SECONDS, PUSH_WORDS, type PushNotice } from './payload';
export {
  PUSH_JOBS,
  pushAudience,
  pushJobKey,
  queuePush,
  type PushMoment,
  type PushSendPayload,
} from './queue';

export interface PushServices {
  /** Expo's service or the stand-in; null while push is off (production with no Expo access token yet). */
  readonly provider: PushProvider | null;
  /** Locally and in tests: the stand-in, whose `sent` the tests and GET /test/push/sent read. */
  readonly fake: FakePush | null;
}

/** The stand-in (local development, tests and the seed). */
export function fakePushServices(): PushServices & { readonly fake: FakePush } {
  const fake = createFakePush();
  return { provider: fake, fake };
}

export function createPush(env: WorkerEnv): PushServices {
  if (env.pushProvider === 'fake') return fakePushServices();
  if (env.pushProvider === 'expo' && env.expoAccessToken)
    return { provider: createExpoPush({ accessToken: env.expoAccessToken }), fake: null };
  return { provider: null, fake: null };
}
