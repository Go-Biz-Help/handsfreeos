import { AnthropicProvider } from '@hfos/ai';
import type { WorkerEnv } from '../env';
import type { WorkerServices } from '../services';
import { scriptedAi } from './scripted';

/**
 * The model behind the AI teammate, workflow AI steps, the AI builder and the knowledge base: Claude (AI_MODEL)
 * with the Assistant's key, the scripted stand-in with ASSISTANT_PROVIDER=scripted, otherwise none. They share
 * the Assistant's daily token limit.
 */
export function createAi(
  env: Pick<
    WorkerEnv,
    'assistantProvider' | 'anthropicApiKey' | 'aiModel' | 'assistantDailyTokens'
  >,
): WorkerServices['ai'] {
  const provider =
    env.assistantProvider === 'anthropic' && env.anthropicApiKey
      ? new AnthropicProvider({ apiKey: env.anthropicApiKey, model: env.aiModel })
      : env.assistantProvider === 'scripted'
        ? scriptedAi()
        : null;
  return { provider, dailyTokens: env.assistantDailyTokens };
}
