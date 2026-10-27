import { z } from 'zod';
import { WeeklyHours } from '../calendar/config';
import { parseClock } from '../calendar/engine/zoned';
import { BusinessAddress } from '../onboarding-setup/address';
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
export function openHoursProblem(hours: WeeklyHours): string | null {
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

/**
 * The parts of `workspaces.settings` that have a command of their own, with its own permission and checks: who sees
 * which conversations, the money settings (whose numbering only moves forward), quiet hours, the Action Center and
 * Automations. `workspace.update` only needs workspace.update, so writing one of these through its `settings` would
 * step round all of that; they are refused there, and the database refuses the ones behind another permission.
 */
export const SETTINGS_WITH_THEIR_OWN_COMMAND = {
  inbox: 'inbox.set_visibility',
  money: 'money.save_settings',
  // Partners' share, terms and smallest payout (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2).
  partners: 'partners.save_settings',
  telephony: 'phone.update_settings',
  attention: 'attention.save_settings',
  automations: 'automations.save_settings',
  // Which add-ons a business has, and their settings, live in app.addon_installations behind addons.manage
  // (0108), never in these settings, which any admin with workspace.update may write and every member reads.
  addons: 'addon.install',
  // Getting started's answers and skips: the quick questions set the order the business's steps come in.
  onboarding: 'onboarding.save_answers',
  // Quick setup's answers while someone is part way through, and who finished it.
  aiSetup: 'ai_setup.save',
  // The onboarding setup's answers while someone is part way through, and who finished it.
  onboardingSetup: 'onboarding_setup.save',
  // The business's logo and colour, and where the logo's being looked for or made ready (look/look.ts).
  look: 'look.set',
} as const;

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
    for (const key of Object.keys(s))
      if (Object.hasOwn(SETTINGS_WITH_THEIR_OWN_COMMAND, key))
        ctx.addIssue({
          code: 'custom',
          message: 'This is changed on its own settings page.',
          path: ['settings', key],
        });
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
        const problem = openHoursProblem(parsed.data);
        if (problem)
          ctx.addIssue({ code: 'custom', message: problem, path: ['settings', 'openHours'] });
      }
    }
    // The business's address (the onboarding setup asks it): a US street address. null clears it.
    if ('address' in s && s['address'] !== null) {
      const parsed = BusinessAddress.safeParse(s['address']);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: ['settings', 'address', ...issue.path.map((p) => p as string | number)],
          });
    }
  });

/** A link customers open from a text: http or https, at most 500 characters. Empty or null clears it. */
export function linkProblem(v: unknown): string | null {
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

/** Deleting a business: its name, typed again, is the confirmation. */
export const WorkspaceDeleteInput = z.object({
  workspaceId: uuid,
  confirmName: z.string().trim().min(1).max(200),
});
export const WorkspaceDeleteOutput = z.object({ workspaceId: uuid, requestedAt: isoDateTime });

export const WorkspaceSummary = z.object({
  id: uuid,
  organizationId: uuid,
  organizationName: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  industry: z.string(),
  role: workspaceRole,
  /**
   * What you may do here (0106): your role's permissions with the business's settings for the role and for you
   * applied. Screens ask this, not the role, so they show what the server will allow.
   */
  permissions: z.array(z.string()),
  /**
   * The add-ons running here (0108): enabled, and not switched off by HandsFreeOS. What the menu, the add-on pages
   * and the panels on core pages decide from; the server enforces the same on every request.
   */
  addons: z.array(z.string()),
  /**
   * Getting started is on here: an owner or admin can turn it off for everyone (Settings → Workspace). The shell
   * reads it for Get help and the tour; `onboarding.status` says the same.
   */
  gettingStarted: z.boolean(),
  /**
   * The business still has to pick a founding spot and pay for it before it is used (20261027012700): it was made
   * while spots were on sale and holds no plan. The web sends its people to the plan page, and the phone to the web.
   */
  needsPlan: z.boolean(),
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
    /**
     * What this person can do here now (0108): core's capabilities and running add-ons', where they hold the
     * permission — `workspace.can('social.publish')` for the screens.
     */
    capabilities: z.array(z.string()),
  }),
  counts: z.object({ members: z.number().int(), pendingInvitations: z.number().int() }),
});
