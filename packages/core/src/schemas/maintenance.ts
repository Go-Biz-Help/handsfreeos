/**
 * "Maintenance due": one customer's own schedule for a service, and the list their page shows.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

/** Every N months, never, or back to the plan's or the service's own. */
export const MaintenanceScheduleChoice = z.union([
  z.literal('default'),
  z.literal('never'),
  z.int().min(1, 'At least 1 month.').max(60, 'At most 5 years.'),
]);

export const MaintenanceSetScheduleInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  serviceId: uuid,
  every: MaintenanceScheduleChoice,
});
export const MaintenanceSetScheduleOutput = z.object({
  personId: uuid,
  serviceId: uuid,
  everyMonths: z.int().nullable(),
  source: z.enum(['customer', 'plan', 'service']).nullable(),
  dueOn: z.iso.date().nullable(),
});

export const MaintenanceForPersonInput = z.object({ workspaceId: uuid, personId: uuid });
export const MaintenanceLineOut = z.object({
  serviceId: uuid,
  serviceName: z.string(),
  lastVisitOn: z.iso.date().nullable(),
  everyMonths: z.int().nullable(),
  /** Where "how often" comes from: their own, their plan, or the service. Null: they aren't reminded. */
  source: z.enum(['customer', 'plan', 'service']).nullable(),
  planName: z.string().nullable(),
  /** The service's own "repeats every", to show what "default" means. */
  serviceMonths: z.int().nullable(),
  dueOn: z.iso.date().nullable(),
  bookedAhead: z.boolean(),
  /** The latest reminder: how many texts went, and where it stands. */
  reminder: z
    .object({
      dueOn: z.iso.date(),
      sentCount: z.int(),
      status: z.enum(['reminding', 'booked', 'card', 'stopped']),
      lastSentAt: isoDateTime.nullable(),
    })
    .nullable(),
});
export const MaintenanceForPersonOutput = z.object({ items: z.array(MaintenanceLineOut) });
