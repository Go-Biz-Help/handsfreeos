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
  chatSnippet,
  chatSnippetSrc,
  consentPolicyPath,
  consentTermsPath,
  handoverScreen,
  migrationStatusWords,
  notificationStates,
  partSays,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  screenPlace,
  settingsArea,
  settingsWhere,
  type AssistantCard,
  type MainOfferTryOut,
  type SettingsArea,
  type SettingsAreaInfo,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { addOnsRead, addOnsTidy, voteRead } from './addons-page';
import type { ToolContext, ToolOutcome } from './runtime';
import { scheduleWords, type TeamSchedule } from './schedule-words';
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

const DAY = 86_400_000;

type TeammateFix = { id: string; label: string; href?: string; patch?: unknown };

/**
 * The AI teammate's settings with each Fix that opens another screen said as the way there ("Settings → Texting &
 * calls"), never as the page's own path inside the business, which isn't a link anyone can open (tm-16). A fix that
 * changes a setting keeps its patch: the matching tool field makes that change.
 */
export function teammateRead(v: unknown): unknown {
  const issues = (v as { issues?: { fixes?: TeammateFix[] }[] } | null)?.issues;
  if (!Array.isArray(issues)) return v;
  return {
    ...(v as object),
    issues: issues.map((issue) => ({
      ...issue,
      fixes: (issue.fixes ?? []).map(({ href, ...fix }) =>
        href === undefined
          ? fix
          : {
              ...fix,
              opens: screenPlace(`/${href.replace(/^\/+/, '')}`)?.way ?? fix.label,
            },
      ),
    })),
  };
}

type Site = { slug: string; path: string; page: boolean } | null;
const siteOf = (v: unknown): Site => (v as { site?: Site } | null)?.site ?? null;

/**
 * The privacy policy and terms HandsFreeOS hosts for the business, which its simple page, its chat's agreement box and
 * its texting registration link to. Paths here, which the executor writes out whole. Each goes on to the business's
 * own when it gave one in the texting registration.
 */
const legalPages = (site: Site) =>
  site
    ? {
        privacyPolicy: consentPolicyPath(site.slug),
        terms: consentTermsPath(site.slug),
        note: 'The ones HandsFreeOS keeps for the business, written from its texting registration. When it gave its own in the registration, these open those instead.',
      }
    : 'None yet: they come with the booking site (Settings → Calendars → Booking site).';

/** The Migrations list as its badges say it: each move's status in the screen's words beside the stored one. */
export function migrationListRead(v: unknown): unknown {
  const list = v as { migrations?: { status: string }[] } | null;
  if (!list || !Array.isArray(list.migrations)) return v;
  return {
    ...list,
    migrations: list.migrations.map((m) => ({
      ...m,
      statusLabel: migrationStatusWords(m.status),
    })),
  };
}

/**
 * This round's tries as Review and go live's Versions lists them, newest first: each with its scores, the parts it
 * changed and why, what the person asked for, and who made it, with the id manage_main_offer takes parts from.
 */
export function triesRead(v: unknown): unknown {
  const out = v as { round?: number; tries?: MainOfferTryOut[] } | null;
  if (!out || !Array.isArray(out.tries)) return v;
  return {
    round: out.round,
    tries: out.tries.map((t) => ({
      tryId: t.id,
      name: `Try ${t.number}`,
      lowest: t.lowest,
      scores: Object.fromEntries(
        SCORED_PARTS.map((p) => [SCORED_PART_LABELS[p], t.score.parts[p].score]),
      ),
      changed: SCORED_PARTS.filter((p) => t.why[p]).map((p) => ({
        part: p,
        says: partSays(t.parts, p),
        why: t.why[p],
      })),
      ...(t.parts.line ? { line: t.parts.line } : {}),
      ...(Object.keys(t.notes).length ? { askedFor: t.notes } : {}),
      ...(t.keep.length ? { keptAsIs: t.keep } : {}),
      ...(t.direction ? { followed: t.direction } : {}),
      madeBy: t.madeBy?.name ?? null,
      madeAt: t.madeAt,
    })),
  };
}

/** What one area is read with: the same queries the screen behind it runs. */
const QUERIES: Record<SettingsArea, readonly AreaQuery[]> = {
  business: [{ name: 'workspace.get', as: 'business' }],
  branded_domain: [{ name: 'branded_domain.get', as: 'brandedDomain' }],
  main_offer: [
    { name: 'main_offer.get', as: 'mainOffer' },
    { name: 'main_offer.versions', as: 'versions' },
    { name: 'main_offer.tries', as: 'tries', shape: triesRead },
  ],
  add_ons: [
    {
      name: 'addon.list',
      as: 'addOns',
      // What the page shows: each add-on here with where it stands and what it is, and (for whoever manages add-ons)
      // what could be added, each with Install or the note in its place.
      shape: addOnsRead,
    },
    {
      name: 'addon.roadmap',
      as: 'vote',
      // What's coming soon, and the vote on what comes next (0109): the most-voted handful and whether the business
      // voted for each, not all hundred-odd planned add-ons (read_addon_roadmap lists those).
      shape: voteRead,
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
  // Archived ones too, listed last with their status, as Settings → Calendars shows them.
  calendars: [{ name: 'calendar.list', as: 'calendars', input: () => ({ includeArchived: true }) }],
  services: [{ name: 'service.list', as: 'services' }],
  resources: [{ name: 'resource.list', as: 'resources' }],
  territories: [{ name: 'territory.list', as: 'territories' }],
  booking_site: [
    {
      name: 'booking_site.get',
      as: 'bookingSite',
      // Your page (Settings → Workspace) is the booking site's own address once it's on, and the start page of the
      // business's own web address while one is working.
      shape: (v) => {
        const site = siteOf(v);
        return {
          ...(v as object),
          yourPage: !site
            ? 'Off: there’s no booking site yet.'
            : site.page
              ? `Showing at ${site.path}, and at the start of the business’s own web address while one is working`
              : 'Off: Show your page on Settings → Workspace turns it on.',
          privacyAndTerms: legalPages(site),
        };
      },
    },
  ],
  team: [
    { name: 'workspace.members', as: 'team' },
    { name: 'workspace.invitations', as: 'invitations' },
  ],
  tags: [{ name: 'tag.list', as: 'tags' }],
  texting: [
    { name: 'phone.setup_status', as: 'texting' },
    // The policy and terms the registration offers to host, as its Privacy and terms step links to them.
    { name: 'booking_site.get', as: 'privacyAndTerms', shape: (v) => legalPages(siteOf(v)) },
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
  email: [
    { name: 'email.setup_status', as: 'email' },
    { name: 'email_sender_rule.list', as: 'senderRules' },
    { name: 'email_suppression.list', as: 'blockedAddresses' },
  ],
  website_chat: [
    {
      name: 'chat_widget.list',
      as: 'websiteChat',
      // Each chat's snippet, as Add it to your site copies it. Its address is a path here, which the executor writes
      // out whole on the business's own domain when one is serving (full-links.ts), as the screen does.
      shape: (v) => {
        const out = v as { items: { publicKey: string }[] };
        return {
          ...out,
          items: out.items.map((w) => ({
            ...w,
            snippet: chatSnippet(chatSnippetSrc('', w.publicKey)),
          })),
        };
      },
    },
  ],
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
    { name: 'partner.payouts', as: 'payouts' },
    {
      name: 'partner.list',
      as: 'partnerList',
      // Who each one is, what they earn now and their link, as each row's Copy gives it (a path here, which the
      // executor writes out whole on the business's own domain when one is serving); their earnings are the page's.
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
                linkPath: string | null;
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
          link: p.linkPath,
        })),
    },
  ],
  usage: [
    { name: 'wallet.get', as: 'balance' },
    { name: 'usage.prices', as: 'prices' },
    { name: 'usage.statement', as: 'statement' },
    { name: 'founding.mine', as: 'founding' },
  ],
  action_center: [{ name: 'attention.settings', as: 'actionCenter' }],
  ai_teammate: [{ name: 'ai_teammate.get', as: 'aiTeammate', shape: teammateRead }],
  knowledge: [{ name: 'knowledge.profile', as: 'knowledge' }],
  my_account: [
    { name: 'account.me', as: 'me' },
    {
      // The phones their alerts go to, as Settings → Account lists them: none means phone alerts reach nobody.
      name: 'push_device.list',
      as: 'phonesForAlerts',
      shape: (v) =>
        (
          (
            v as {
              devices?: { platform: string; deviceName: string | null; lastSeenAt: string }[];
            }
          )?.devices ?? []
        ).map((d) => ({ phone: d.deviceName ?? d.platform, lastSeenAt: d.lastSeenAt })),
    },
  ],
  my_calendar: [
    {
      // Their own week, time zone and time off from yesterday to two months out, as My calendar lists them.
      name: 'schedule.team',
      as: 'schedules',
      input: (ctx) => ({
        from: new Date(Date.now() - DAY).toISOString(),
        to: new Date(Date.now() + 60 * DAY).toISOString(),
        userIds: [ctx.actor.userId],
      }),
      shape: (v) => {
        const words = scheduleWords(v as TeamSchedule);
        const mine = words.people[0];
        return mine
          ? {
              ...mine,
              note: 'update_my_hours changes the week and the time zone, and adds time off or takes it out by its exceptionId.',
            }
          : null;
      },
    },
    // The calendars and meeting accounts they connected, as Settings → My calendar lists them.
    {
      name: 'calendar_connection.list',
      as: 'connectedCalendars',
      input: (ctx) => ({ userId: ctx.actor.userId }),
    },
    {
      name: 'meeting_connection.list',
      as: 'meetingAccounts',
      input: (ctx) => ({ userId: ctx.actor.userId }),
    },
    { name: 'live_meeting_account.mine', as: 'liveMeetings' },
  ],
  // Check-ins (round six): the business's times and safety person; never anyone's contacts.
  safety: [{ name: 'safety.settings', as: 'safety' }],
  imports: [{ name: 'import.list', as: 'imports' }],
  migrations: [
    {
      name: 'migration.list',
      as: 'migrations',
      input: (ctx) => ({ organizationId: ctx.organizationId }),
      // Each move's status as its badge says it. This is the business's own part; get_agency_area lists the agency's.
      shape: migrationListRead,
    },
  ],
};

/**
 * This person's own account, as Settings → Account shows it: their name and address, their settings, and every alert
 * as it is set now, defaults filled in, so "will I hear about a booking?" has an answer. The rest of `account.me` (the
 * businesses they reach) the model never needs. New support tickets is HandsFreeOS's own support people's alone, as
 * their Notifications show it: anyone else is never told it exists (the owner, 2026-10-27).
 */
const meShape = (me: unknown, answersSupport: boolean) => {
  const user = (me as { user?: Record<string, unknown> } | null)?.user;
  return user
    ? {
        fullName: user['fullName'],
        email: user['email'],
        settings: answersSupport ? user['settings'] : withoutSupportSwitch(user['settings']),
        alerts: notificationStates(user['settings']).filter(
          (a) => answersSupport || !a.supportOnly,
        ),
        alwaysOn: 'Safety check-in alerts always reach their phones; they can’t be turned off.',
      }
    : null;
};

/** Saved settings without New support tickets' switch, which every save of the phone alerts writes for everyone. */
function withoutSupportSwitch(settings: unknown): unknown {
  const push = (settings as { push?: unknown } | null)?.push;
  if (!push || typeof push !== 'object' || !('supportTickets' in push)) return settings;
  const { supportTickets: _supportTickets, ...rest } = push as Record<string, unknown>;
  return { ...(settings as Record<string, unknown>), push: rest };
}

const areaOf = (args: Args): SettingsArea => args['area'] as SettingsArea;

/** An area whose parts are said together, as its page draws them: Coming soon leaves out the add-ons it has. */
const TIDY: Partial<
  Record<SettingsArea, (read: Record<string, unknown>) => Record<string, unknown>>
> = { add_ons: addOnsTidy };

/**
 * Reads one area. A query the person's role refuses answers `null` for that part rather than failing the tool: the
 * model then says who can see it, which is what the screen does by not showing the tab.
 */
async function readArea(db: Db, ctx: ToolContext, info: SettingsAreaInfo): Promise<ToolOutcome> {
  // Whether they answer HandsFreeOS support, which only their own account's alerts ask.
  const answersSupport = QUERIES[info.area].some((q) => q.as === 'me')
    ? query<{ staff: unknown }>(db, ctx, 'platform.me').then(
        (m) => !!m.staff,
        () => false,
      )
    : Promise.resolve(false);
  const parts = await Promise.all(
    QUERIES[info.area].map(async (q) => {
      const value = await query<unknown>(db, ctx, q.name, q.input?.(ctx)).catch(() => null);
      const shaped = value === null ? null : q.shape ? q.shape(value) : value;
      return [q.as, q.as === 'me' ? meShape(value, await answersSupport) : shaped] as const;
    }),
  );
  const missing = parts.filter(([, v]) => v === null).map(([as]) => as);
  const read = Object.fromEntries(parts);
  return {
    result: {
      area: info.area,
      where: settingsWhere(info.area),
      canChange: info.canChange,
      theyDoThemselves: info.handovers.map((h) => h.what),
      ...(TIDY[info.area]?.(read) ?? read),
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
