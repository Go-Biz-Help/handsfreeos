/**
 * The swappable AI seam (see `types.ts`). Claude answers the Assistant in production; the scripted
 * provider stands in for tests and the browser suite. Realtime voice arrives in Milestone 11.
 */
export * from './types';
export { AiOutputError, parseStructured } from './structured';
export { structuredOutputSchema } from './json-schema';
export { AnthropicProvider, type AnthropicOptions } from './anthropic';
export { ScriptedProvider, type ScriptRule } from './scripted';
