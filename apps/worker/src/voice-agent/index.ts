import type { AiProvider } from '@hfos/ai';
import type { Logger } from 'pino';
import { claudeWithBackup } from '../ai/provider';
import type { AiSwitchboard } from '../ai/switch';
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
 * client per model, with OpenAI's fast OPENAI_VOICE_MODEL behind each when there's a backup. Null unless the AI
 * is Claude: the scripted stand-in answers with itself whatever is picked.
 */
export function createModelPicker(
  env: VoiceEnv,
  aiSwitch: AiSwitchboard | null = null,
): ((model: string) => AiProvider) | null {
  if (env.assistantProvider !== 'anthropic' || !env.anthropicApiKey) return null;
  const made = new Map<string, AiProvider>();
  return (model) => {
    let provider = made.get(model);
    if (!provider) {
      provider = claudeWithBackup(env, aiSwitch, { model, ...CALL_THINKING }, voiceBackup(env));
      made.set(model, provider);
    }
    return provider;
  };
}

type VoiceEnv = Pick<
  WorkerEnv,
  'assistantProvider' | 'anthropicApiKey' | 'openAiApiKey' | 'openAiVoiceModel'
>;

/**
 * On a call every pause is heard, so Claude answers without thinking first, at low effort, and so does the backup.
 * A model that can't turn thinking off, or has no effort levels (Claude Haiku 4.5), answers as it always did.
 */
const CALL_THINKING = { thinkingOff: true, effort: 'low' } as const;

const voiceBackup = (env: VoiceEnv) => ({
  model: env.openAiVoiceModel,
  reasoningEffort: 'none' as const,
});

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

/**
 * The model for calls (VOICE_MODEL, Claude Haiku 5.5 unless set), only with Claude: the scripted stand-in answers
 * calls too. A call's backup is OpenAI's fast one.
 */
export function createVoiceAi(
  env: VoiceEnv & Pick<WorkerEnv, 'voiceModel'>,
  aiSwitch: AiSwitchboard | null = null,
): AiProvider | null {
  if (env.assistantProvider !== 'anthropic' || !env.anthropicApiKey) return null;
  return claudeWithBackup(
    env,
    aiSwitch,
    { model: env.voiceModel, ...CALL_THINKING },
    voiceBackup(env),
  );
}
