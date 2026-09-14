import { z } from 'zod';
import {
  displayName,
  industry,
  isoDateTime,
  settings,
  timezone,
  uuid,
  workspaceRole,
} from './common';

export const WorkspaceCreateInput = z.object({
  organizationId: uuid,
  name: displayName,
  timezone: timezone.default('America/Chicago'),
  industry: industry.default('home_services'),
});
export const WorkspaceCreateOutput = z.object({ workspaceId: uuid, slug: z.string() });

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
  workspace: WorkspaceSummary.extend({ settings: settings, createdAt: isoDateTime }),
  counts: z.object({ members: z.number().int(), pendingInvitations: z.number().int() }),
});
