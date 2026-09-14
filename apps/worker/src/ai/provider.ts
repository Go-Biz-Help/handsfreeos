import { AnthropicProvider } from '@hfos/ai';
import type { WorkerEnv } from '../env';
import type { WorkerServices } from '../services';
import { scriptedAi } from './scripted';

/**
 * The model behind workflow AI steps, the AI builder and the knowledge base, from the Assistant's settings:
 * Claude with its key, the scripted stand-in with ASSISTANT_PROVIDER=scripted, otherwise none. They share
 * the Assistant's daily token limit.
 */
export function createAi(
  env: Pick<
    WorkerEnv,
    'assistantProvider' | 'anthropicApiKey' | 'assistantModel' | 'assistantDailyTokens'
  >,
): WorkerServices['ai'] {
  const provider =
    env.assistantProvider === 'anthropic' && env.anthropicApiKey
      ? new AnthropicProvider({ apiKey: env.anthropicApiKey, model: env.assistantModel })
      : env.assistantProvider === 'scripted'
        ? scriptedAi()
        : null;
  return { provider, dailyTokens: env.assistantDailyTokens };
}
