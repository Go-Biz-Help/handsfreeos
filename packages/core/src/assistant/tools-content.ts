/**
 * Marketing and content: campaigns, reviews, forms, the knowledge base, workflows and their runs, and the AI teammate’s drafts.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 */
import type { AssistantTool } from './tool-kit';

export const contentTools: readonly AssistantTool[] = [];
