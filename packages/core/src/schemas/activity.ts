import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { attachableRecordType, ListInput, UserRef } from './crm';

export const loggableKind = z.enum(['note', 'call', 'visit']);
export const activityKind = z.enum(['note', 'call', 'visit', 'email', 'sms', 'system']);
const body = z.string().trim().min(1, 'Write something.').max(10000);

export const ActivityLogInput = z
  .object({
    workspaceId: uuid,
    /** The id the phone made for it (M10). */
    id: uuid.optional(),
    kind: loggableKind,
    body,
    occurredAt: isoDateTime.optional(),
    personId: uuid.nullable().optional(),
    companyId: uuid.nullable().optional(),
    leadId: uuid.nullable().optional(),
    /** A record of a kind the business made up: a pet, a vehicle, a property (0101). */
    customRecordId: uuid.nullable().optional(),
  })
  .refine((v) => !!v.personId || !!v.companyId || !!v.leadId || !!v.customRecordId, {
    path: ['personId'],
    error: 'Attach it to a person, company, lead or record.',
  });
export const ActivityLogOutput = z.object({ activityId: uuid });
export const ActivityUpdateInput = z.object({
  workspaceId: uuid,
  activityId: uuid,
  body: body.optional(),
  occurredAt: isoDateTime.optional(),
});
export const ActivityUpdateOutput = z.object({ activityId: uuid, updated: z.array(z.string()) });
export const ActivityDeleteInput = z.object({ workspaceId: uuid, activityId: uuid });
export const ActivityDeleteOutput = z.object({ activityId: uuid });

export const TimelineEntry = z.object({
  id: uuid,
  entry: z.enum(['activity', 'task', 'file']),
  kind: z.string(),
  subtype: z.string().nullable(),
  body: z.string().nullable(),
  occurredAt: isoDateTime,
  actor: UserRef,
  actorType: z.string(),
  personId: uuid.nullable(),
  companyId: uuid.nullable(),
  leadId: uuid.nullable(),
  customRecordId: uuid.nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelineListInput = ListInput.extend({
  workspaceId: uuid,
  recordType: attachableRecordType,
  recordId: uuid,
});
export const TimelineListOutput = z.object({
  items: z.array(TimelineEntry),
  nextCursor: z.string().nullable(),
});
