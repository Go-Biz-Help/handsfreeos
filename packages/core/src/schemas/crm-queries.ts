import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { optionalEmail, phoneInput } from './crm';

export const FindMatchesInput = z.object({
  workspaceId: uuid,
  kind: z.enum(['person', 'company']),
  email: optionalEmail,
  phone: phoneInput,
  name: z.string().trim().max(160).nullable().optional(),
  exceptId: uuid.optional(),
});
export const FindMatchesOutput = z.object({
  matches: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      matchedOn: z.enum(['email', 'phone', 'name']),
    }),
  ),
});

export const CrmSummaryInput = z.object({ workspaceId: uuid });
export const CrmSummaryOutput = z.object({
  openLeads: z.number().int(),
  openValueCents: z.number(),
  leadsWithoutNextAction: z.number().int(),
  tasksDueToday: z.number().int(),
  tasksOverdue: z.number().int(),
  people: z.number().int(),
  companies: z.number().int(),
});

export const CrmMetricsInput = z.object({
  workspaceId: uuid,
  since: isoDateTime,
  /** End of the period, exclusive. Defaults to now. */
  until: isoDateTime.optional(),
});
export const CrmMetricsOutput = z.object({
  leadsCreated: z.number().int(),
  leadsWon: z.number().int(),
  leadsLost: z.number().int(),
  wonValueCents: z.number(),
  newPeople: z.number().int(),
  textsIn: z.number().int(),
  textsOut: z.number().int(),
  emailsIn: z.number().int(),
  emailsOut: z.number().int(),
  callsIn: z.number().int(),
  callsOut: z.number().int(),
  callsMissed: z.number().int(),
});
