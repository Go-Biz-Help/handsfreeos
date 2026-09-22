import { z } from 'zod';
import { WeeklyHours } from '../calendar/config';
import { parseClock } from '../calendar/engine/zoned';
import {
  displayName,
  industry,
  isoDateTime,
  settings,
  timezone,
  uuid,
  workspaceRole,
} from './common';

/** When the business is open (`settings.openHours`) until someone says otherwise: weekdays, 8 to 5. */
export const DEFAULT_OPEN_HOURS: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '08:00',
  end: '17:00',
}));

/** The business's open hours from its settings, or the default when it hasn't set them (or they're unreadable). */
export function openHoursOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): WeeklyHours {
  const parsed = WeeklyHours.safeParse(settings?.['openHours']);
  return parsed.success ? parsed.data : DEFAULT_OPEN_HOURS.map((h) => ({ ...h }));
}

/** Why open hours can't be saved (a day's stretches overlap), or null. */
function overlapProblem(hours: WeeklyHours): string | null {
  for (let day = 0; day < 7; day++) {
    const list = hours
      .filter((h) => h.day === day)
      .map((h) => [parseClock(h.start), parseClock(h.end)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++)
      if (list[i]![0] < list[i - 1]![1]) return 'These hours overlap.';
  }
  return null;
}

export const WorkspaceCreateInput = z.object({
  organizationId: uuid,
  name: displayName,
  timezone: timezone.default('America/Chicago'),
  industry: industry.default('home_services'),
  /**
   * Whether whoever adds the business is on it, or only administers it from the organization.
   *
   * A business you run yourself wants you on it: its own people are what Calendar shows, what can be
   * booked and assigned, and who its booking emails go to. A business set up for a client does not —
   * an agency has no place in a client's team, and while nobody is on it the organization's owners and
   * admins hear about it instead (`workspaceManagers`). Either way the creator can still open and change
   * everything, which comes from administering the organization, not from this.
   *
   * Left off it is the second, which is what every workspace made this way was before the choice existed.
   * `workspace.join` is the way to change it afterwards.
   */
  joinAsOwner: z.boolean().default(false),
});
export const WorkspaceCreateOutput = z.object({ workspaceId: uuid, slug: z.string() });

export const WorkspaceJoinInput = z.object({ workspaceId: uuid });
export const WorkspaceJoinOutput = z.object({ workspaceId: uuid, role: workspaceRole });

export const WorkspaceUpdateInput = z
  .object({
    workspaceId: uuid,
    name: displayName.optional(),
    timezone: timezone.optional(),
    industry: industry.optional(),
    settings: settings.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.timezone !== undefined ||
      v.industry !== undefined ||
      v.settings !== undefined,
    {
      error: 'Nothing to update.',
    },
  )
  .superRefine((v, ctx) => {
    // The two settings workflows put in customers' texts ({{business.website}}, {{links.review}}) must be links.
    const s = v.settings;
    if (!s) return;
    if ('website' in s) {
      const problem = linkProblem(s['website']);
      if (problem)
        ctx.addIssue({ code: 'custom', message: problem, path: ['settings', 'website'] });
    }
    if ('links' in s) {
      const links = s['links'];
      if (links !== null && (typeof links !== 'object' || Array.isArray(links)))
        ctx.addIssue({
          code: 'custom',
          message: 'Links are web addresses by name.',
          path: ['settings', 'links'],
        });
      else if (links && 'review' in links) {
        const problem = linkProblem((links as Record<string, unknown>)['review']);
        if (problem)
          ctx.addIssue({ code: 'custom', message: problem, path: ['settings', 'links', 'review'] });
      }
    }
    // Open hours: weekly hours in the workspace's time zone. null goes back to the default.
    if ('openHours' in s && s['openHours'] !== null) {
      const parsed = WeeklyHours.safeParse(s['openHours']);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: ['settings', 'openHours', ...issue.path.map((p) => p as string | number)],
          });
      else {
        const problem = overlapProblem(parsed.data);
        if (problem)
          ctx.addIssue({ code: 'custom', message: problem, path: ['settings', 'openHours'] });
      }
    }
  });

/** A link customers open from a text: http or https, at most 500 characters. Empty or null clears it. */
function linkProblem(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return 'Enter a web address.';
  if (v.length > 500) return 'Keep it under 500 characters.';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      return 'Use a web address that starts with https://.';
    return u.hostname.includes('.') ? null : 'Enter a full web address, like https://example.com.';
  } catch {
    return 'Enter a full web address, starting with https://.';
  }
}
export const WorkspaceUpdateOutput = z.object({ workspaceId: uuid, updated: z.array(z.string()) });

export const WorkspaceSummary = z.object({
  id: uuid,
  organizationId: uuid,
  organizationName: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  industry: z.string(),
  role: workspaceRole,
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceGetInput = z.object({ workspaceId: uuid });
export const WorkspaceGetOutput = z.object({
  workspace: WorkspaceSummary.extend({
    settings: settings,
    /**
     * Whether each person sees only their own threads here (M17). It is inside `settings` as well; it is
     * pulled out because two screens branch on it and a screen digging a boolean out of a free-form document
     * is how the wrong key gets read.
     */
    inboxPerPerson: z.boolean(),
    createdAt: isoDateTime,
  }),
  counts: z.object({ members: z.number().int(), pendingInvitations: z.number().int() }),
});
