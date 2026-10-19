/**
 * The swappable AI seam (see `types.ts`). Claude answers the Assistant in production, with OpenAI behind it
 * while Claude is in trouble (`FallbackProvider`); the scripted provider stands in for tests and the browser
 * suite. Realtime voice arrives in Milestone 11.
 */
export * from './types';
export { AiOutputError, parseStructured } from './structured';
export { structuredOutputSchema } from './json-schema';
export {
  AnthropicProvider,
  searchesTools,
  takesEffort,
  type AnthropicEffort,
  type AnthropicOptions,
} from './anthropic';
export { OpenAiProvider, openAiSearchesTools, type OpenAiOptions } from './openai';
export { FAILOVER_CODES, FallbackProvider, type AiRoute, type AiSwitch } from './fallback';
export { ScriptedProvider, writeToolCalls, type ScriptRule } from './scripted';
