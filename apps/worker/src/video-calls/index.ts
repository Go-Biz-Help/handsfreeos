/**
 * HandsFreeOS video calls on the worker (docs/video-calls.md): the provider the env asks for, or null when calls
 * aren't set up here yet (production before LiveKit), which every route and handler checks.
 */
import type { WorkerEnv } from '../env';
import { createFakeVideo } from './fake';
import { createLiveKit } from './livekit';
import type { VideoCallProvider } from './provider';

export type { VideoCallProvider } from './provider';

export function createVideoCalls(
  env: Pick<WorkerEnv, 'videoProvider' | 'livekitUrl' | 'livekitApiKey' | 'livekitApiSecret'>,
): VideoCallProvider | null {
  if (env.videoProvider === 'fake') return createFakeVideo();
  if (env.videoProvider === 'livekit')
    return createLiveKit({
      url: env.livekitUrl!,
      apiKey: env.livekitApiKey!,
      apiSecret: env.livekitApiSecret!,
    });
  return null;
}
