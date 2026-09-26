/**
 * How the business is set up: permissions, fields, kinds of records, templates, numbers, who sees which conversations, its own web address and blocked email addresses.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 */
import type { AssistantTool } from './tool-kit';

export const setupTools: readonly AssistantTool[] = [];
