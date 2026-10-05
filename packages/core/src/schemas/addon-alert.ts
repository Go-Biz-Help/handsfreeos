/**
 * An add-on's alert (Real Estate step 5), acknowledged from its Home card: "I've seen this". The add-on raises and
 * clears alerts from its worker; this is the one thing a person does to one directly.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const AddonAlertAcknowledgeInput = z.object({ workspaceId: uuid, alertId: uuid });
export const AddonAlertAcknowledgeOutput = z.object({
  alertId: uuid,
  acknowledgedAt: isoDateTime,
  /** False when someone had already acknowledged it: nothing changed. */
  changed: z.boolean(),
});
