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
  handoverScreen,
  settingsArea,
  settingsWhere,
  type AssistantCard,
  type SettingsArea,
  type SettingsAreaInfo,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { query, type ReadTool } from './tools-read';

type Args = Record<string, unknown>;

interface AreaQuery {
  readonly name: string;
  readonly as: string;
  /** What it needs besides the workspace (migrations are listed by organization). */
  readonly input?: (ctx: ToolContext) => Record<string, unknown>;
  /** The part of the answer the model needs, when the query says much more. */
  readonly shape?: (value: unknown) => unknown;
}

/** What one area is read with: the same queries the screen behind it runs. */
const QUERIES: Record<SettingsArea, readonly AreaQuery[]> = {
  business: [{ name: 'workspace.get', as: 'business' }],
  branded_domain: [{ name: 'branded_domain.get', as: 'brandedDomain' }],
  main_offer: [
    { name: 'main_offer.get', as: 'mainOffer' },
    { name: 'main_offer.versions', as: 'versions' },
  ],
  add_ons: [
    {
      name: 'addon.list',
      as: 'addOns',
      // What the page shows: each add-on here and whether it runs, and (for whoever manages add-ons) what could be
      // added. What each one lets the business do is find_capabilities' to answer.
      shape: (v) => {
        const list = v as {
          installed?: { addonId: string; name: string; state: string; running: boolean }[];
          catalog?: { addonId: string; name: string; summary: string; status: string }[];
        } | null;
        const here = new Set((list?.installed ?? []).map((i) => i.addonId));
        const catalog = (list?.catalog ?? []).filter((c) => !here.has(c.addonId));
        return {
          inThisBusiness: (list?.installed ?? []).map((i) => ({
            name: i.name,
            state: i.state,
            running: i.running,
          })),
          availableToAdd: catalog
            .filter((c) => c.status === 'available')
            .map((c) => ({ name: c.name, summary: c.summary })),
        };
      },
    },
    {
      name: 'addon.roadmap',
      as: 'vote',
      // What's coming soon, and the vote on what comes next (0109): the most-voted handful and whether the business
      // voted for each, not all hundred-odd planned add-ons.
      shape: (v) => {
        const roadmap = v as {
          comingSoon?: { name: string; voted: boolean }[];
          planned?: { name: string; votes: number; voted: boolean }[];
          nextPickAt?: string;
        } | null;
        const planned = roadmap?.planned ?? [];
        return {
          comingSoon: (roadmap?.comingSoon ?? []).map((c) => c.name),
          mostVotes: [...planned]
            .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))
            .slice(0, 5)
            .map((p) => ({ name: p.name, votes: p.votes, youVoted: p.voted })),
          youVotedFor: planned.filter((p) => p.voted).map((p) => p.name),
          planned: planned.length,
          nextPickAt: roadmap?.nextPickAt ?? null,
        };
      },
    },
  ],
  permissions: [{ name: 'permission.settings', as: 'permissions' }],
  pipelines: [{ name: 'pipeline.list', as: 'pipelines' }],
  fields: [{ name: 'custom_field.list', as: 'fields' }],
  relationships: [
    { name: 'custom_record_type.list', as: 'kindsOfRecords' },
    { name: 'relationship_type.list', as: 'relationshipTypes' },
  ],
  // What's in the bin, by name, when it was deleted and when it goes for good; never what's inside. The id is what
  // restore_from_bin brings back.
  deleted_bin: [
    {
      name: 'bin.list',
      as: 'deletedBin',
      shape: (v) =>
        (
          (
            v as {
              items?: {
                id: string;
                kind: string;
                name: string;
                deletedAt: string;
                purgeAfter: string;
              }[];
            }
          )?.items ?? []
        ).map((i) => ({
          binItemId: i.id,
          kind: i.kind,
          name: i.name,
          deletedAt: i.deletedAt,
          goneForGoodAt: i.purgeAfter,
        })),
    },
  ],
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
  texting: [
    { name: 'phone.setup_status', as: 'texting' },
    // Who sees which conversations lives on the workspace, not the number.
    {
      name: 'workspace.get',
      as: 'inbox',
      shape: (v) => ({
        eachPersonSeesTheirOwn:
          (v as { workspace?: { inboxPerPerson?: boolean } } | null)?.workspace?.inboxPerPerson ??
          false,
      }),
    },
  ],
  email: [{ name: 'email.setup_status', as: 'email' }],
  website_chat: [{ name: 'chat_widget.list', as: 'websiteChat' }],
  facebook_instagram: [{ name: 'meta_account.list', as: 'facebookInstagram' }],
  templates: [{ name: 'template.list', as: 'templates' }],
  lead_intake: [{ name: 'intake.list', as: 'leadIntake' }],
  payments: [
    { name: 'money.settings', as: 'payments' },
    { name: 'payment_connection.list', as: 'accounts' },
  ],
  products: [{ name: 'product.list', as: 'products' }],
  partners: [
    { name: 'partners.settings', as: 'partners' },
    {
      name: 'partner.list',
      as: 'partnerList',
      // Who each one is and what they earn now; their earnings and links are the page's.
      shape: (v) =>
        (
          (
            v as {
              partners?: {
                partnerId: string;
                personId: string;
                name: string;
                status: string;
                rateBp: number;
                ownRate: boolean;
              }[];
            }
          )?.partners ?? []
        ).map((p) => ({
          partnerId: p.partnerId,
          personId: p.personId,
          name: p.name,
          status: p.status,
          sharePercent: p.rateBp / 100,
          ownShare: p.ownRate,
        })),
    },
  ],
  usage: [{ name: 'wallet.get', as: 'balance' }],
  action_center: [{ name: 'attention.settings', as: 'actionCenter' }],
  ai_teammate: [{ name: 'ai_teammate.get', as: 'aiTeammate' }],
  knowledge: [{ name: 'knowledge.profile', as: 'knowledge' }],
  my_account: [{ name: 'account.me', as: 'me' }],
  my_calendar: [{ name: 'schedule.team', as: 'schedules' }],
  // Check-ins (round six): the business's times and safety person; never anyone's contacts.
  safety: [{ name: 'safety.settings', as: 'safety' }],
  imports: [{ name: 'import.list', as: 'imports' }],
  migrations: [
    {
      name: 'migration.list',
      as: 'migrations',
      input: (ctx) => ({ organizationId: ctx.organizationId }),
    },
  ],
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
      const value = await query<unknown>(db, ctx, q.name, q.input?.(ctx)).catch(() => null);
      const shaped = value === null ? null : q.shape ? q.shape(value) : value;
      return [q.as, q.as === 'me' ? meShape(value) : shaped] as const;
    }),
  );
  const missing = parts.filter(([, v]) => v === null).map(([as]) => as);
  return {
    result: {
      area: info.area,
      where: settingsWhere(info.area),
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
  const { where, href } = handoverScreen(workspaceId, info, first);
  return {
    type: 'list',
    title: first.what.charAt(0).toUpperCase() + first.what.slice(1),
    aside: where,
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
        where: settingsWhere(info.area),
        onScreen: info.onScreen,
        what: info.what,
        canChange: info.canChange,
        theyDoThemselves: info.handovers.map((h) => ({
          what: h.what,
          why: h.why,
          where: handoverScreen(ctx.workspaceId, info, h).where,
          steps: h.steps,
        })),
      },
      ...(card ? { card } : {}),
    };
  },
};
