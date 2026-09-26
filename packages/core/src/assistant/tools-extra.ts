/**
 * Everything else a person does on the screens: the AI teammate’s finer rules, Automations, their own account, Ideas, Get help, adding a business and the agency area.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 */
import type { AssistantTool } from './tool-kit';

export const extraTools: readonly AssistantTool[] = [];
