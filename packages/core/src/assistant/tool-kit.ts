/**
 * What every Assistant tool is made of, and the input pieces they share: the tool's shape, `define`, and the
 * zod helpers for text, dollars, times and working hours. The tool lists (tools.ts and the files beside it that
 * add to it) all build from here, so a tool reads the same wherever it lives.
 */
import { z } from 'zod';
import { isLocalDate } from '../calendar/engine/zoned';
import type { Permission } from '../permissions';

export type ToolAutonomy = 'auto' | 'confirm';

export interface AssistantTool<I extends z.ZodType = z.ZodType> {
  readonly name: string;
  /** What the model reads to decide when to call it. */
  readonly description: string;
  readonly input: I;
  readonly autonomy: ToolAutonomy;
  /** Offered only to people whose role has this permission (the commands check again). */
  readonly permission: Permission;
}

export const define = <I extends z.ZodType>(t: AssistantTool<I>) => t;

export const text = (max: number) => z.string().trim().min(1).max(max);
export const dollars = z.number().min(0).max(1_000_000_000).describe('Amount in US dollars');
/** The model writes local times with their offset; commands take UTC, so the tool turns one into the other. */
export const when = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 date and time with the workspace offset, e.g. 2026-09-14T09:00:00-05:00')
  .transform((s) => new Date(s).toISOString());
/** A whole local day ('2026-09-17', kept as it is for the worker to place in the calendar's zone) or an instant. */
export const dayOrWhen = z.union([
  z
    .string()
    .refine(isLocalDate, { error: 'Use a date like 2026-09-17.' })
    .describe('A local date for the whole day, e.g. 2026-09-17'),
  when,
]);
export const minutes = z.int().min(5).max(720).describe('Length in minutes');
export const clock = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use a 24-hour time like 08:00.');
/** Working hours as the model writes them: a day (0 = Sunday), and 24-hour times. */
export const WeeklyHoursInput = z
  .array(
    z.object({
      day: z.int().min(0).max(6).describe('0 = Sunday … 6 = Saturday'),
      start: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .describe('24-hour, like 08:00'),
      end: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .describe('24-hour, like 17:00'),
    }),
  )
  .max(50);
