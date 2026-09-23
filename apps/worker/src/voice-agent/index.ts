import { AnthropicProvider } from '@hfos/ai';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { createDeepgramSpeech } from './deepgram-speech';
import { createFakeSpeech } from './fake-speech';
import type { SpeechServices } from './speech';

/** Hearing and speaking on a live call, from VOICE_AGENT: Deepgram, the stand-in, or off (null). */
export function createSpeech(
  env: Pick<WorkerEnv, 'voiceAgent' | 'deepgramApiKey'>,
  log: Logger,
): SpeechServices | null {
  if (env.voiceAgent === 'deepgram' && env.deepgramApiKey)
    return createDeepgramSpeech({ apiKey: env.deepgramApiKey, log });
  if (env.voiceAgent === 'fake') return createFakeSpeech();
  return null;
}

/** A separate model for calls (VOICE_MODEL), only with Claude: the scripted stand-in answers calls too. */
export function createVoiceAi(
  env: Pick<WorkerEnv, 'assistantProvider' | 'anthropicApiKey' | 'voiceModel'>,
): AnthropicProvider | null {
  return env.assistantProvider === 'anthropic' && env.anthropicApiKey && env.voiceModel
    ? new AnthropicProvider({ apiKey: env.anthropicApiKey, model: env.voiceModel })
    : null;
}
