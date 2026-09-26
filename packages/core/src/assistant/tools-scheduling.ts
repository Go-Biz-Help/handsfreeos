/**
 * Appointments and calendars: finishing a visit, the job’s status, notes and seats, repeat visits, the waitlist, and the calendar sections the Assistant couldn’t reach.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 */
import type { AssistantTool } from './tool-kit';

export const schedulingTools: readonly AssistantTool[] = [];
