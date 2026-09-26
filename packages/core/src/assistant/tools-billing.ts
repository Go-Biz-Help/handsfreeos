/**
 * Money: estimates, invoices, refunds, the plans a business sells and the customers on them, balance top-ups.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 */
import type { AssistantTool } from './tool-kit';

export const billingTools: readonly AssistantTool[] = [];
