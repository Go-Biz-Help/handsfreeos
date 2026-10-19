import {
  AnthropicProvider,
  FallbackProvider,
  OpenAiProvider,
  type AiProvider,
  type AnthropicOptions,
  type OpenAiOptions,
} from '@hfos/ai';
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import type { Mailer } from '../mailer';
import type { WorkerServices } from '../services';
import { scriptedAi, type TeammateRule } from './scripted';
import { AiSwitchboard } from './switch';

type AiEnv = Pick<
  WorkerEnv,
  'assistantProvider' | 'anthropicApiKey' | 'openAiApiKey' | 'aiModel' | 'assistantDailyTokens'
>;

/**
 * The switch behind every AI feature's backup (ai/switch.ts): only with Claude and an OpenAI key. Without one,
 * Claude answers alone, as it always has.
 */
export function createAiSwitch(
  env: AiEnv & Pick<WorkerEnv, 'aiAlertEmails' | 'webUrl'>,
  deps: { readonly db: Db; readonly log: Logger; readonly mailer: Mailer },
): AiSwitchboard | null {
  if (env.assistantProvider !== 'anthropic' || !env.anthropicApiKey || !env.openAiApiKey)
    return null;
  return new AiSwitchboard({
    ...deps,
    alertEmails: env.aiAlertEmails,
    webUrl: env.webUrl,
    // The check's test question: one try, so a Claude still in trouble shows as that.
    claude: new AnthropicProvider({
      apiKey: env.anthropicApiKey,
      model: env.aiModel,
      maxRetries: 0,
    }),
  });
}

/**
 * Claude with `model`, and OpenAI's `backup` behind it when there is a switch. With a backup, Claude is tried
 * once more rather than twice before the backup answers instead: the point is not to keep people waiting.
 */
export function claudeWithBackup(
  env: Pick<WorkerEnv, 'anthropicApiKey' | 'openAiApiKey'>,
  aiSwitch: AiSwitchboard | null,
  claude: Pick<AnthropicOptions, 'model' | 'toolSearch' | 'effort'>,
  backup: Pick<OpenAiOptions, 'model' | 'reasoningEffort' | 'toolSearch'>,
): AiProvider {
  const apiKey = env.anthropicApiKey ?? '';
  if (!aiSwitch || !env.openAiApiKey) return new AnthropicProvider({ apiKey, ...claude });
  return new FallbackProvider(
    new AnthropicProvider({ apiKey, ...claude, maxRetries: 1 }),
    new OpenAiProvider({ apiKey: env.openAiApiKey, ...backup }),
    aiSwitch,
  );
}

/**
 * The model behind the AI teammate, workflow AI steps, the AI builder and the knowledge base: Claude (AI_MODEL)
 * with the Assistant's key, with OpenAI (OPENAI_MODEL) behind it when there's a key for it, the scripted
 * stand-in with ASSISTANT_PROVIDER=scripted, otherwise none. They share the Assistant's daily token limit.
 */
export function createAi(
  env: AiEnv & Pick<WorkerEnv, 'openAiModel'>,
  aiSwitch: AiSwitchboard | null = null,
  /** Add-ons' own lines for the stand-in's teammate (their modules' `scriptedTeammate`), tried before core's. */
  scriptedTeammate: readonly TeammateRule[] = [],
): WorkerServices['ai'] {
  const provider =
    env.assistantProvider === 'anthropic' && env.anthropicApiKey
      ? claudeWithBackup(env, aiSwitch, { model: env.aiModel }, { model: env.openAiModel })
      : env.assistantProvider === 'scripted'
        ? scriptedAi([], { teammate: scriptedTeammate })
        : null;
  return { provider, dailyTokens: env.assistantDailyTokens };
}
