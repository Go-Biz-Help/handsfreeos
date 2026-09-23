/**
 * Automations' "Referral mentioned": turning somebody a customer mentioned into a customer and a lead. What the
 * worker read from the customer's words fills each field; the card lets a person correct them first.
 */
import { z } from 'zod';
import { uuid } from './common';
import { optionalEmail, phoneInput } from './crm';

export const ReferralCreateLeadInput = z.object({
  workspaceId: uuid,
  referralId: uuid,
  /** Their name, when the one the customer gave needs correcting. */
  name: z.string().trim().max(160).nullable().optional(),
  phone: phoneInput,
  email: optionalEmail,
  /** The lead's title; defaults to what they need. */
  title: z.string().trim().max(160).nullable().optional(),
});
export const ReferralCreateLeadOutput = z.object({
  referralId: uuid,
  personId: uuid,
  leadId: uuid,
  /** Whether the person was already a customer (found by their phone or email). */
  existingPerson: z.boolean(),
});
