/**
 * AI outside the Assistant: workflow AI steps, the AI builder and the knowledge base. One structured call at
 * a time through `askStructured`, inside the business's daily AI limit the Assistant shares (`aiBudget`).
 */
export {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
  type AiAskErrorCode,
  type AskStructuredInput,
  type AskStructuredResult,
} from './ask';
export {
  aiBudget,
  chargeAssistantRun,
  recordAiUsage,
  type AiNoRoom,
  type AiToday,
  type AiUsageRef,
  type AiUsageSource,
} from './budget';
export { createAi } from './provider';
export { scriptedAi } from './scripted';
