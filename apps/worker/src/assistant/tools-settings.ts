/**
 * Setting the business up by asking (M12). Two tools to begin with, both read-only:
 *
 * - `get_settings` reads one part of the setup with the person's own queries, so the Assistant proposes changes
 *   against what is really there, and can answer "what are my quiet hours?" without guessing.
 * - `settings_help` answers the things only the person can do — signing in to Google or Stripe, DNS records, the
 *   chat snippet — with where it lives and the steps, as a card that links to the screen.
 *
 * Anything a person may not see is answered as "not yours to see", never as an error: `get_settings` runs the same
 * queries the screens run, so a member asking about payments gets the same answer the screen would give them.
 */

import {
  settingsArea,
  settingsPath,
  type AssistantCard,
  type SettingsArea,
  type SettingsAreaInfo,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { query, type ReadTool } from './tools-read';

type Args = Record<string, unknown>;

/** What one area is read with: the same queries the screen behind it runs. */
const QUERIES: Record<SettingsArea, readonly { readonly name: string; readonly as: string }[]> = {
  business: [{ name: 'workspace.get', as: 'business' }],
  pipelines: [{ name: 'pipeline.list', as: 'pipelines' }],
  calendars: [{ name: 'calendar.list', as: 'calendars' }],
  services: [{ name: 'service.list', as: 'services' }],
  resources: [{ name: 'resource.list', as: 'resources' }],
  territories: [{ name: 'territory.list', as: 'territories' }],
  booking_site: [{ name: 'booking_site.get', as: 'bookingSite' }],
  team: [
    { name: 'workspace.members', as: 'team' },
    { name: 'workspace.invitations', as: 'invitations' },
  ],
  tags: [{ name: 'tag.list', as: 'tags' }],
  texting: [{ name: 'phone.setup_status', as: 'texting' }],
  email: [{ name: 'email.setup_status', as: 'email' }],
  website_chat: [{ name: 'chat_widget.list', as: 'websiteChat' }],
  payments: [
    { name: 'money.settings', as: 'payments' },
    { name: 'payment_connection.list', as: 'accounts' },
  ],
  products: [{ name: 'product.list', as: 'products' }],
  action_center: [{ name: 'attention.settings', as: 'actionCenter' }],
  ai_teammate: [{ name: 'ai_teammate.get', as: 'aiTeammate' }],
  knowledge: [{ name: 'knowledge.profile', as: 'knowledge' }],
  my_account: [{ name: 'account.me', as: 'me' }],
  my_calendar: [{ name: 'schedule.team', as: 'schedules' }],
  imports: [{ name: 'import.list', as: 'imports' }],
};

/** Everything `account.me` holds that isn't this person's own settings; the model never needs it. */
const meShape = (me: unknown) => {
  const user = (me as { user?: Record<string, unknown> } | null)?.user;
  return user
    ? { fullName: user['fullName'], email: user['email'], settings: user['settings'] }
    : null;
};

const areaOf = (args: Args): SettingsArea => args['area'] as SettingsArea;

/**
 * Reads one area. A query the person's role refuses answers `null` for that part rather than failing the tool: the
 * model then says who can see it, which is what the screen does by not showing the tab.
 */
async function readArea(db: Db, ctx: ToolContext, info: SettingsAreaInfo): Promise<ToolOutcome> {
  const parts = await Promise.all(
    QUERIES[info.area].map(async (q) => {
      const value = await query<unknown>(db, ctx, q.name).catch(() => null);
      return [q.as, q.as === 'me' ? meShape(value) : value] as const;
    }),
  );
  const missing = parts.filter(([, v]) => v === null).map(([as]) => as);
  return {
    result: {
      area: info.area,
      where: `Settings → ${info.label}`,
      canChange: info.canChange,
      theyDoThemselves: info.handovers.map((h) => h.what),
      ...Object.fromEntries(parts),
      ...(missing.length
        ? { note: `Not this person's to see: ${missing.join(', ')}. An owner or admin can.` }
        : {}),
    },
  };
}

/** The steps as a card: one row a step, linking to the screen they happen on. */
function helpCard(workspaceId: string, info: SettingsAreaInfo): AssistantCard | null {
  const first = info.handovers[0];
  if (!first) return null;
  const href = settingsPath(workspaceId, info.area);
  return {
    type: 'list',
    title: first.what.charAt(0).toUpperCase() + first.what.slice(1),
    aside: `Settings → ${info.label}`,
    items: first.steps.map((step, i) => ({
      title: `${i + 1}. ${step}`,
      detail: '',
      tone: 'muted' as const,
      href: i === 0 ? href : null,
    })),
  };
}

export const settingsReadTools: Record<string, ReadTool> = {
  async get_settings(db, ctx, args) {
    return readArea(db, ctx, settingsArea(areaOf(args)));
  },

  async settings_help(_db, ctx, args) {
    const info = settingsArea(areaOf(args));
    const card = helpCard(ctx.workspaceId, info);
    return {
      result: {
        area: info.area,
        where: `Settings → ${info.label}`,
        what: info.what,
        canChange: info.canChange,
        theyDoThemselves: info.handovers.map((h) => ({
          what: h.what,
          why: h.why,
          steps: h.steps,
        })),
      },
      ...(card ? { card } : {}),
    };
  },
};
