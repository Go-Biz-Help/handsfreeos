import { AnthropicProvider, type AiProvider } from '@hfos/ai';
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

/**
 * Claude thinking with a model named at run time (a business's phone model, which support picks in /admin), one
 * client per model. Null unless the AI is Claude: the scripted stand-in answers with itself whatever is picked.
 */
export function createModelPicker(
  env: Pick<WorkerEnv, 'assistantProvider' | 'anthropicApiKey'>,
): ((model: string) => AiProvider) | null {
  const apiKey = env.anthropicApiKey;
  if (env.assistantProvider !== 'anthropic' || !apiKey) return null;
  const made = new Map<string, AiProvider>();
  return (model) => {
    let provider = made.get(model);
    if (!provider) {
      provider = new AnthropicProvider({ apiKey, model });
      made.set(model, provider);
    }
    return provider;
  };
}

/** What thinks on a business's calls: the model support picked for it, else VOICE_MODEL's, else the usual one. */
export function callModel(
  deps: {
    readonly ai: { readonly provider: AiProvider | null };
    readonly voiceAi?: AiProvider | null;
    readonly aiFor?: ((model: string) => AiProvider) | null;
  },
  picked: string | null,
): AiProvider | null {
  return (picked ? deps.aiFor?.(picked) : null) ?? deps.voiceAi ?? deps.ai.provider;
}

/** A separate model for calls (VOICE_MODEL), only with Claude: the scripted stand-in answers calls too. */
export function createVoiceAi(
  env: Pick<WorkerEnv, 'assistantProvider' | 'anthropicApiKey' | 'voiceModel'>,
): AnthropicProvider | null {
  return env.assistantProvider === 'anthropic' && env.anthropicApiKey && env.voiceModel
    ? new AnthropicProvider({ apiKey: env.anthropicApiKey, model: env.voiceModel })
    : null;
}
