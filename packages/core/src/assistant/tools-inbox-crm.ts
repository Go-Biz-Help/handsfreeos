/**
 * The inbox and customers: a conversation’s own actions, companies, archiving and who looks after a customer, consent, pets, vehicles and properties and how they relate, and archiving leads.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 */
import type { AssistantTool } from './tool-kit';

export const inboxCrmTools: readonly AssistantTool[] = [];
