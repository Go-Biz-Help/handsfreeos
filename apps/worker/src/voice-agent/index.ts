import type { AiProvider } from '@hfos/ai';
import type { Logger } from 'pino';
import { claudeWithBackup } from '../ai/provider';
import type { AiSwitchboard } from '../ai/switch';
import type { WorkerEnv } from '../env';
import { createDeepgramSpeech } from './deepgram-speech';
import { createFakeSpeech } from './fake-speech';
import { createRimeSpeech } from './rime-speech';
import type { SpeechServices } from './speech';
import { withVoices } from './voices';

/**
 * Hearing and speaking on a live call, from VOICE_AGENT: Deepgram, the stand-in, or off (null). Deepgram listens
 * with VOICE_LISTENER's model. Rime speaks the Rime voices with RIME_API_KEY (voices.ts); the stand-in speaks every
 * voice, Rime's too. `trouble` is told when a Rime voice can't speak (voice-trouble.ts).
 */
export function createSpeech(
  env: Pick<WorkerEnv, 'voiceAgent' | 'deepgramApiKey' | 'voiceListener' | 'rimeApiKey'>,
  log: Logger,
  trouble?: SpeechServices['trouble'],
): SpeechServices | null {
  if (env.voiceAgent === 'deepgram' && env.deepgramApiKey)
    return withVoices({
      base: createDeepgramSpeech({
        apiKey: env.deepgramApiKey,
        log,
        listener: env.voiceListener,
      }),
      rime: env.rimeApiKey ? createRimeSpeech({ apiKey: env.rimeApiKey, log }) : null,
      trouble,
    });
  if (env.voiceAgent === 'fake') {
    const fake = createFakeSpeech();
    return withVoices({ base: fake, rime: fake, trouble });
  }
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
 * Without thinking every turn is a tool call (each ends with reply, end_call or hand_off anyway): Claude Haiku 5.5
 * wrote some of its replies out as text instead. A model that can't turn thinking off answers as it always did, and
 * one with no effort levels (Claude Haiku 4.5) gets none.
 */
const CALL_THINKING = { thinkingOff: true, toolEachTurn: true, effort: 'low' } as const;

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
