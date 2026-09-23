/**
 * Jobs (M18): the work a customer is waiting on, one visit or several, with a status they hear about and a note
 * they may see.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const JOB_STATUSES = [
  'scheduled',
  'on_the_way',
  'in_progress',
  'waiting_on_parts',
  'done',
  'cancelled',
] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

/** The statuses a person sets (a job is cancelled with its visits). */
export const JOB_SET_STATUSES = [
  'scheduled',
  'on_the_way',
  'in_progress',
  'waiting_on_parts',
  'done',
] as const;

/** How each status reads, to the team and the customer. */
export const JOB_STATUS_WORDS: Readonly<Record<JobStatus, string>> = {
  scheduled: 'Scheduled',
  on_the_way: 'On the way',
  in_progress: 'Started',
  waiting_on_parts: 'Waiting on parts',
  done: 'Done',
  cancelled: 'Cancelled',
};

const note = z.string().trim().max(500, 'Keep the note under 500 characters.');

export const JobSetStatusInput = z.object({
  workspaceId: uuid,
  /** The visit being worked: its job is the one that changes. */
  appointmentId: uuid,
  status: z.enum(JOB_SET_STATUSES),
  /** What the customer may be told; null clears it, left out keeps it. */
  customerNote: note.nullable().optional(),
  /** On my way: where the tech is now, for the arrival time. Never kept on the job. */
  origin: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .nullable()
    .optional(),
  /** Text the customer about it (their consent and quiet hours still apply). */
  notify: z.boolean().default(true),
});
export const JobSetStatusOutput = z.object({
  jobId: uuid,
  status: JobStatus,
  changed: z.boolean(),
});

export const JobAddVisitInput = z.object({
  workspaceId: uuid,
  jobId: uuid,
  appointmentId: uuid,
});
export const JobAddVisitOutput = z.object({ jobId: uuid, appointmentId: uuid });

/** One job, as the visit sheet shows it. */
export const JobOut = z.object({
  id: uuid,
  title: z.string(),
  status: JobStatus,
  customerNote: z.string().nullable(),
  statusChangedAt: isoDateTime.nullable(),
  etaAt: isoDateTime.nullable(),
  visits: z.array(
    z.object({
      appointmentId: uuid,
      title: z.string(),
      startsAt: isoDateTime,
      status: z.string(),
    }),
  ),
  /** The customer's other upcoming visits that could join this job. */
  otherVisits: z.array(z.object({ appointmentId: uuid, title: z.string(), startsAt: isoDateTime })),
});
