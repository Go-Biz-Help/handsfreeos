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
  addressLines,
  binItemDetail,
  binItemWhen,
  binKindLabel,
  businessAddressOf,
  BUSINESS_PAGE_SETTINGS_WORDS,
  CHAT_BUILDERS,
  chatChannelsOf,
  chatSnippet,
  chatSnippetSrc,
  checkMoneySettings,
  consentPolicyPath,
  consentTermsPath,
  CUSTOMIZABLE_PERMISSIONS,
  dayLabel,
  earningsTotals,
  emailDomainRecords,
  handoverScreen,
  hasWorkspacePermission,
  intakeApiUrl,
  intakeCurlExample,
  intakeFormSnippet,
  intakeFormUrl,
  leadsAccessWords,
  metaAccountBadge,
  metaAccountTrouble,
  migrationStatusWords,
  money,
  PARTNERS_WORDS,
  partSays,
  PAYMENT_ACCOUNT_BADGES,
  PERMISSION_GROUPS,
  permissionHeldBack,
  PAYMENTS_PAGE_WORDS,
  PRODUCT_KIND_WORDS,
  readMoneySettings,
  registry,
  SAFETY_DEFAULTS,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  screenPlace,
  settingsArea,
  settingsWhere,
  whoAnswersChat,
  type AssistantCard,
  type BinItemLike,
  type EmailDomainRecordsLike,
  type LeadsAccess,
  type MainOfferTryOut,
  type MetaAccountStateLike,
  type PartnerEarnings,
  type PartnerStatus,
  type PaymentConnectionStatus,
  type Permission,
  type ProductKind,
  type SettingsArea,
  type SettingsAreaInfo,
  type WorkspaceRole,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { WorkerServices } from '../services';
import { addOnsRead, addOnsTidy, voteRead } from './addons-page';
import { publicOriginFor } from './full-links';
import { meRead, myCellRead, phonesRead } from './my-account';
import type { ToolContext, ToolOutcome } from './runtime';
import { scheduleWords, type TeamSchedule } from './schedule-words';
import { query, type ReadTool } from './tools-read';
import { priceWords } from './tools-settings-money';

type Args = Record<string, unknown>;

interface AreaQuery {
  readonly name: string;
  readonly as: string;
  /** What it needs besides the workspace (migrations are listed by organization). */
  readonly input?: (ctx: ToolContext) => Record<string, unknown>;
  /**
   * The part of the answer the model needs, when the query says much more. It may read more as the person (the
   * address their pages are on), and says times in the business's own time zone.
   */
  readonly shape?: (
    value: unknown,
    db: Db,
    ctx: ToolContext,
    services: WorkerServices | null,
  ) => unknown;
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
 * Your page (Settings → Workspace), as its card shows it: on or off, and the link Copy the link copies. On the
 * business's own domain, once it is serving, that is the domain's start page; otherwise the booking site's own address,
 * a path here, which the executor writes out whole. `serving` is that domain's address, or '' when none is serving.
 */
export function yourPageRead(site: Site, serving: string) {
  const W = BUSINESS_PAGE_SETTINGS_WORDS;
  if (!site)
    return {
      yourPage: `Off: there’s no booking site yet. ${W.label}, on Settings → Workspace, turns it on and makes one.`,
      yourPageLink: null,
    };
  if (!site.page)
    return {
      yourPage: `Off: ${W.label} on Settings → Workspace turns it on. Until then ${site.path} shows the booking page.`,
      yourPageLink: null,
    };
  return serving
    ? {
        yourPage: `Showing at ${serving}, the start page of the business’s own web address, and at ${site.path} too. ${W.fill}`,
        yourPageLink: serving,
      }
    : { yourPage: `Showing at ${site.path}. ${W.fill}`, yourPageLink: site.path };
}

/** Your page from what booking_site.get answered, on the address the business's pages are on now. */
const yourPageOf = async (v: unknown, db: Db, ctx: ToolContext) =>
  yourPageRead(siteOf(v), await publicOriginFor(db, ctx, ''));

/**
 * What Home watches for, with Gone quiet after as Settings → Automations sets it: by open stage, each with its own
 * number or every stage's. Won and lost stages never go quiet, so they aren't listed.
 */
const actionCenterOf = async (v: unknown, db: Db, ctx: ToolContext) => {
  const got = v as {
    settings: {
      stale: { days: number; stageDays: Record<string, number> };
      auto: { nudgeReviewedAt: string | null };
    };
  };
  const pipes = await query<{
    pipelines: { name: string; stages: { id: string; name: string; kind: string }[] }[];
  }>(db, ctx, 'pipeline.list').catch(() => null);
  const own = new Map(Object.entries(got.settings.stale.stageDays));
  return {
    ...got,
    goneQuietByStage: pipes?.pipelines.flatMap((p) =>
      p.stages
        .filter((st) => st.kind === 'open')
        .map((st) => ({
          stageId: st.id,
          stage: `${st.name} (${p.name})`,
          days: own.get(st.id) ?? got.settings.stale.days,
          ownNumber: own.has(st.id),
        })),
    ),
    ...(got.settings.auto.nudgeReviewedAt
      ? {}
      : {
          followUps:
            'Off until an owner reads the wording: turning them on puts the wording on a card, and an owner’s Confirm is Looks good, turn on.',
        }),
  };
};

/** How many the Deleted bin lists at once: the most bin.list gives in one page. */
const BIN_LISTED = 100;

/**
 * The Deleted bin as Settings → Deleted bin lists it, newest first: what each thing is in the screen's words, what went
 * with it, who deleted it, and when it goes for good or that it is being deleted now. The binItemId is what
 * restore_from_bin brings back; one older than these it finds by name.
 */
export function binRead(v: unknown, timeZone: string, now = Date.now()) {
  const out = v as {
    items?: (BinItemLike & { id: string; name: string })[];
    nextCursor?: string | null;
  } | null;
  const items = (out?.items ?? []).map((i) => ({
    binItemId: i.id,
    kind: binKindLabel(i),
    name: i.name,
    detail: binItemDetail(i, timeZone),
    deleted: binItemWhen(i, timeZone, now),
    deletedBy: i.deletedBy?.name ?? null,
    deletedAt: i.deletedAt,
    goneForGoodAt: i.purgeAfter,
    ...(i.emptying ? { beingDeletedNow: true } : {}),
  }));
  const more = !!out?.nextCursor;
  return {
    items,
    more,
    ...(more
      ? {
          note: `These are the newest ${items.length}; there are more, older ones (Show more under the list). restore_from_bin finds an older one by its name.`,
        }
      : {}),
  };
}

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

interface ProductRow {
  kind: ProductKind;
  unitPriceCents: number;
  unitLabel: string;
  archivedAt: string | null;
}

/**
 * Settings → Products as its list shows it: each item with its price per unit and its kind in the screen's words,
 * then the archived ones Show archived items lists, which stay on the documents they're already on.
 */
export function productsRead(v: unknown): unknown {
  const list = (v as { products?: ProductRow[] } | null)?.products;
  if (!Array.isArray(list)) return v;
  const row = (p: ProductRow) => ({
    ...p,
    price: priceWords(p),
    kindLabel: PRODUCT_KIND_WORDS[p.kind] ?? p.kind,
  });
  const archived = list.filter((p) => p.archivedAt);
  const one = archived.length === 1;
  return {
    items: list.filter((p) => !p.archivedAt).map(row),
    archived: archived.map(row),
    ...(archived.length
      ? {
          archivedNote: `${archived.length} archived ${one ? 'item' : 'items'}, still on the documents ${one ? 'it’s' : 'they’re'} already on. manage_product put_back brings one back into the picker.`,
        }
      : {}),
  };
}

interface PartnerListRow {
  partnerId: string;
  personId: string;
  name: string;
  email: string | null;
  status: PartnerStatus;
  rateBp: number;
  ownRate: boolean;
  linkPath: string | null;
  clients: number;
  termsAccepted: boolean;
  earnings: PartnerEarnings;
}

const EARNING_KEYS = [
  'earnedCents',
  'waitingCents',
  'payableCents',
  'heldCents',
  'payingCents',
  'paidCents',
] as const;

/** What a partner earned as the screens list it: "Earned $1,200", "Free to pay out $300"… */
const earningsWords = (e: PartnerEarnings) =>
  earningsTotals(e).map(([label, cents]) => `${label} ${money(cents)}`);

/**
 * Your partners as Settings → Partners lists them (part-2): the totals across them at the top, then each partner with
 * their share, how many clients they sent, whether they still have to accept the terms, what they earned in the
 * screen's buckets and their link (a path here, which the executor writes out whole on the business's own domain when
 * one is serving, as Copy their link gives it).
 */
export function partnerListRead(v: unknown): unknown {
  const list = (v as { partners?: PartnerListRow[] } | null)?.partners;
  if (!Array.isArray(list)) return v;
  const sum = Object.fromEntries(
    EARNING_KEYS.map((k) => [k, list.reduce((t, p) => t + (p.earnings?.[k] ?? 0), 0)]),
  ) as PartnerEarnings;
  return {
    totals: list.length ? earningsWords(sum) : [],
    about: PARTNERS_WORDS.earnings.about,
    partners: list.map((p) => ({
      partnerId: p.partnerId,
      personId: p.personId,
      name: p.name,
      email: p.email,
      status: p.status,
      sharePercent: p.rateBp / 100,
      ownShare: p.ownRate,
      clients: p.clients,
      ...(!p.termsAccepted && p.status !== 'ended'
        ? { terms: PARTNERS_WORDS.list.termsWaiting }
        : {}),
      earned: earningsWords(p.earnings),
      earnings: p.earnings,
      link: p.linkPath,
    })),
  };
}

/** "by 12 March", as an account's row says when Stripe needs more from them; null when it says no date. */
function needsInfoBy(capabilities: Record<string, unknown>, timezone: string): string | null {
  const by = capabilities['needsInfoBy'];
  return typeof by === 'number' && Number.isFinite(by) ? dayLabel(by * 1000, timezone) : null;
}

interface AccountRow {
  provider: string;
  status: PaymentConnectionStatus;
  capabilities: Record<string, unknown>;
}

/**
 * Each account under Accounts you get paid into, as its row says it: its badge, what to do when it needs
 * reconnecting (the person's own sign-in, pay-2), when the provider needs more details from them and where, and
 * Square's weekly renewal.
 */
export function accountsRead(v: unknown, timezone: string): unknown {
  const out = v as { connections?: AccountRow[] } | null;
  if (!out || !Array.isArray(out.connections)) return v;
  return {
    ...out,
    connections: out.connections.map((c) => {
      const provider = c.provider === 'square' ? 'Square' : 'Stripe';
      const by = needsInfoBy(c.capabilities ?? {}, timezone);
      return {
        ...c,
        badge: PAYMENT_ACCOUNT_BADGES[c.status] ?? c.status,
        ...(c.status === 'reauth_required' || c.status === 'error'
          ? {
              toFix: `Reconnect it: on Settings → Payments, press Reconnect on this account and sign in to ${provider} again. Only the person can (settings_help, area payments).`,
            }
          : {}),
        ...(c.capabilities?.['needsInfo'] === true
          ? {
              needsMoreDetails: `${provider} needs more details from them ${by ? `by ${by}` : 'before they can keep taking payments'}. They sign in to their ${provider} dashboard${c.provider === 'stripe' ? ' (https://dashboard.stripe.com/)' : ''} to finish, or ${provider} stops this account taking payments.`,
            }
          : {}),
        ...(c.provider === 'square' && c.status === 'active'
          ? { signIn: PAYMENTS_PAGE_WORDS.squareRenews }
          : {}),
      };
    }),
  };
}

const oneLine = (address: string) =>
  address
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(', ');

/**
 * Settings → Payments as the page reads it (pay-1): the settings, then the address documents show (the setup's until
 * one is written under Your address), the page's warnings with whether each stops a save and its fixes, and what the
 * page says about how getting paid works.
 */
async function paymentsRead(v: unknown, db: Db, ctx: ToolContext): Promise<unknown> {
  const got = v as { settings?: unknown } | null;
  if (!got?.settings) return v;
  const settings = readMoneySettings(got.settings);
  // Whether anything has gone out yet: the page's missing-address warning waits for it.
  const sentAny = (name: string, key: string, status: readonly string[]) =>
    query<Record<string, unknown>>(db, ctx, name, { limit: 1, status }).then(
      (r) => Array.isArray(r[key]) && (r[key] as unknown[]).length > 0,
      () => false,
    );
  const [ws, estimate, invoice] = await Promise.all([
    query<{ workspace: { settings: Record<string, unknown> } }>(db, ctx, 'workspace.get').catch(
      () => null,
    ),
    sentAny('estimate.list', 'estimates', ['sent', 'accepted', 'declined', 'expired']),
    sentAny('invoice.list', 'invoices', ['sent', 'partly_paid', 'paid', 'overdue']),
  ]);
  const setup = businessAddressOf(ws?.workspace.settings);
  const setupAddress = setup ? addressLines(setup) : null;
  const { squareRenews: _square, ...words } = PAYMENTS_PAGE_WORDS;
  return {
    ...got,
    addressOnDocuments: settings.businessAddress.trim()
      ? { address: oneLine(settings.businessAddress), from: 'Your address, on this page' }
      : setupAddress
        ? {
            address: oneLine(setupAddress),
            from: 'Your setup: until one is written under Your address, documents show this one',
          }
        : { address: null, from: 'None: documents go out with only the business name at the top' },
    issues: checkMoneySettings(settings, {
      hasSentDocuments: estimate || invoice,
      setupAddress,
    }).map((i) => ({
      message: i.message,
      saving:
        i.severity === 'error' ? 'Nothing is saved until this is fixed' : 'Doesn’t stop it saving',
      fixes: i.fixes.map((f) => f.label),
    })),
    howItWorks: Object.values(words),
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
  business: [
    { name: 'workspace.get', as: 'business' },
    // Your page, on the same screen: on or off, and its whole link as Copy the link gives it.
    { name: 'booking_site.get', as: 'yourPage', shape: yourPageOf },
  ],
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
  permissions: [{ name: 'permission.settings', as: 'permissions', shape: permissionsRead }],
  pipelines: [{ name: 'pipeline.list', as: 'pipelines' }],
  fields: [{ name: 'custom_field.list', as: 'fields' }],
  relationships: [
    { name: 'custom_record_type.list', as: 'kindsOfRecords' },
    { name: 'relationship_type.list', as: 'relationshipTypes' },
  ],
  // What's in the bin as its screen lists it: what each is, what went with it, who deleted it and when it goes for
  // good. The id is what restore_from_bin brings back.
  deleted_bin: [
    {
      name: 'bin.list',
      as: 'deletedBin',
      input: () => ({ limit: BIN_LISTED }),
      shape: (v, _db, ctx) => binRead(v, ctx.timezone),
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
      shape: async (v, db, ctx) => ({
        ...(v as object),
        ...(await yourPageOf(v, db, ctx)),
        privacyAndTerms: legalPages(siteOf(v)),
      }),
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
    { name: 'email.setup_status', as: 'email', shape: emailRead },
    { name: 'email_sender_rule.list', as: 'senderRules' },
    { name: 'email_suppression.list', as: 'blockedAddresses' },
  ],
  website_chat: [
    {
      name: 'chat_widget.list',
      as: 'websiteChat',
      // Each chat's snippet, as Add it to your site copies it. Its address is a path here, which the executor writes
      // out whole on the business's own domain when one is serving (full-links.ts), as the screen does.
      shape: websiteChatRead,
    },
  ],
  facebook_instagram: [
    { name: 'meta_account.list', as: 'facebookInstagram', shape: facebookInstagramRead },
  ],
  templates: [{ name: 'template.list', as: 'templates' }],
  lead_intake: [
    {
      name: 'intake.list',
      as: 'leadIntake',
      shape: (v, _db, _ctx, services) => leadIntakeRead(v, services?.publicUrl ?? null),
    },
  ],
  payments: [
    { name: 'money.settings', as: 'payments', shape: (v, db, ctx) => paymentsRead(v, db, ctx) },
    {
      name: 'payment_connection.list',
      as: 'accounts',
      shape: (v, _db, ctx) => accountsRead(v, ctx.timezone),
    },
  ],
  products: [
    {
      name: 'product.list',
      as: 'products',
      // Archived ones too, as Show archived items lists them.
      input: () => ({ includeArchived: true }),
      shape: productsRead,
    },
  ],
  partners: [
    { name: 'partners.settings', as: 'partners' },
    { name: 'partner.payouts', as: 'payouts' },
    { name: 'partner.list', as: 'partnerList', shape: partnerListRead },
  ],
  usage: [
    { name: 'wallet.get', as: 'balance' },
    { name: 'usage.prices', as: 'prices' },
    { name: 'usage.statement', as: 'statement' },
    { name: 'founding.mine', as: 'founding' },
    // The plan's next payment and date, the cards (which pay the balance too) and anything owed (20261027023600).
    { name: 'billing.get', as: 'billing' },
  ],
  action_center: [{ name: 'attention.settings', as: 'actionCenter', shape: actionCenterOf }],
  ai_teammate: [{ name: 'ai_teammate.get', as: 'aiTeammate', shape: teammateRead }],
  knowledge: [{ name: 'knowledge.profile', as: 'knowledge' }],
  // As Settings → Account shows it to them: only the rows their own screen has (my-account.ts).
  my_account: [
    { name: 'account.me', as: 'me', shape: meRead },
    { name: 'user_phone.get', as: 'myCell', shape: (v, _db, ctx) => myCellRead(v, ctx) },
    // The phones their alerts go to: none means phone alerts reach nobody, and the note says how to fix it.
    { name: 'push_device.list', as: 'phonesForAlerts', shape: phonesRead },
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
  safety: [
    {
      name: 'safety.settings',
      as: 'safety',
      // What Settings → Safety and each person's When show after the first alert, which nothing saves.
      shape: (v) => ({
        ...(v as object),
        repeatMinutes: SAFETY_DEFAULTS.repeatMinutes,
        thenTold: `Their contacts are told again every ${SAFETY_DEFAULTS.repeatMinutes} minutes, for an hour, until someone says they’re OK.`,
        nobodyToTell:
          'Someone has nobody to tell when none of their teammate contacts is still in the business and nobody outside has replied OK (and not STOP): then the safety person is told, or with none picked, the owners and admins.',
      }),
    },
  ],
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

const areaOf = (args: Args): SettingsArea => args['area'] as SettingsArea;

/** An area whose parts are said together, as its page draws them: Coming soon leaves out the add-ons it has. */
const TIDY: Partial<
  Record<SettingsArea, (read: Record<string, unknown>) => Record<string, unknown>>
> = { add_ons: addOnsTidy };

/**
 * Settings → Permissions as its cards read (and a person's What they can do): each group's permissions with their
 * label and description, whether admins and members have it by default, what it needs, and for each role and person
 * the ones turned on that wait on another ("Off until “Y” is on").
 */
function permissionsRead(v: unknown): unknown {
  const out = v as {
    roles: { role: string; settings: Record<string, boolean>; effective: string[] }[];
    people: { role: string; settings: Record<string, boolean>; effective: string[] }[];
  };
  const labelOf = (p: string) =>
    CUSTOMIZABLE_PERMISSIONS.find((c) => c.permission === p)?.label ?? p;
  const waiting = (
    role: string,
    own: Record<string, boolean>,
    effective: readonly string[],
    rolePart?: Record<string, boolean>,
  ) =>
    CUSTOMIZABLE_PERMISSIONS.flatMap((info) => {
      const on =
        own[info.permission] ??
        rolePart?.[info.permission] ??
        hasWorkspacePermission(role as WorkspaceRole, info.permission);
      const note = permissionHeldBack(info, on, effective);
      return note ? [{ permission: info.label, note }] : [];
    });
  const roleSettings = (role: string) => out.roles.find((r) => r.role === role)?.settings;
  return {
    ...out,
    roles: out.roles.map((r) => {
      const held = waiting(r.role, r.settings, r.effective);
      return held.length ? { ...r, offUntil: held } : r;
    }),
    people: out.people.map((p) => {
      if (p.role === 'owner') return p;
      const held = waiting(p.role, p.settings, p.effective, roleSettings(p.role));
      return held.length ? { ...p, offUntil: held } : p;
    }),
    cards: PERMISSION_GROUPS.map((g) => ({
      title: g.title,
      permissions: g.permissions.map((p) => ({
        permission: p.permission,
        label: p.label,
        description: p.description,
        byDefault: {
          admins: hasWorkspacePermission('admin', p.permission),
          members: hasWorkspacePermission('member', p.permission),
        },
        ...(p.requires.length ? { needs: p.requires.map(labelOf) } : {}),
      })),
    })),
  };
}

/**
 * Who sees what a permission opens, by default: owners and admins, owners alone, or owners and whoever an owner gave
 * it to on Settings → Permissions (Delete for good, which the Deleted bin needs, is one).
 */
export function whoSees(permission: Permission | null | undefined): string {
  if (!permission || hasWorkspacePermission('admin', permission)) return 'An owner or admin can.';
  const given = CUSTOMIZABLE_PERMISSIONS.find((c) => c.permission === permission);
  return given
    ? `An owner can, or someone an owner gave “${given.label}” to in Settings → Permissions.`
    : 'Only an owner can.';
}

/**
 * Each website chat as Settings → Website chat shows it: its snippet, as Add it to your site copies it, its Try it
 * link, and who answers it now, as its Who answers says. The snippet's address is a path here, which the executor
 * writes out whole on the business's own domain when one is serving (full-links.ts), and Try it whole on the web app's.
 */
async function websiteChatRead(v: unknown, db: Db, ctx: ToolContext): Promise<unknown> {
  const out = v as {
    items: { id: string; publicKey: string; teammate: { id: string } | null }[];
  };
  const team = await query<{
    teammate: { id: string; name: string; status: string; config: unknown } | null;
  }>(db, ctx, 'ai_teammate.get').catch(() => null);
  const t = team?.teammate ?? null;
  const teammate = t
    ? { ...chatChannelsOf(t.config), id: t.id, name: t.name, status: t.status }
    : null;
  return {
    ...out,
    items: out.items.map((w) => ({
      ...w,
      snippet: chatSnippet(chatSnippetSrc('', w.publicKey)),
      tryIt: `/chat-preview/${w.publicKey}?w=${ctx.workspaceId}`,
      whoAnswers: whoAnswersChat(w, teammate).words,
    })),
  };
}

/**
 * Email as Settings → Email shows it, with each domain's DNS records in the screen's order: the type, what it's for,
 * the host to type at the DNS provider and the value, and whether the last check found it.
 */
function emailRead(v: unknown): unknown {
  const out = v as { inboundMxHost: string; domains: (EmailDomainRecordsLike & object)[] };
  return {
    ...out,
    domains: out.domains.map((d) => ({ ...d, records: emailDomainRecords(d, out.inboundMxHost) })),
  };
}

/**
 * Each Page and Instagram account as Settings → Facebook & Instagram shows it: its badge, what's wrong and what fixes
 * it, and whether its lead ads' leads come in.
 */
function facebookInstagramRead(v: unknown): unknown {
  const out = v as {
    accounts: (MetaAccountStateLike & { name: string; leadsAccess: LeadsAccess })[];
  };
  return {
    ...out,
    accounts: out.accounts.map((a) => {
      const trouble = metaAccountTrouble(a);
      const leads = leadsAccessWords(a.leadsAccess, a.name);
      return {
        ...a,
        badge: metaAccountBadge(a),
        ...(trouble ? { trouble } : {}),
        ...(leads ? { leads: leads.words } : {}),
      };
    }),
  };
}

/**
 * Lead intake as Settings → Lead intake shows it: each website form with its snippet to paste and where it posts, and
 * each connected app with where it sends and an example, on the worker's own address. Without that address (some
 * tests) they're left out. An app's secret key is never here: it's shown once, on that page.
 */
function leadIntakeRead(v: unknown, workerUrl: string | null): unknown {
  const out = v as {
    sources: { kind: string; publicKey: string | null; redirectUrl: string | null }[];
  };
  if (!workerUrl) return out;
  return {
    ...out,
    sources: out.sources.map((x) =>
      x.kind === 'website_form' && x.publicKey
        ? {
            ...x,
            postsTo: intakeFormUrl(workerUrl, x.publicKey),
            snippet: intakeFormSnippet(workerUrl, x.publicKey, x.redirectUrl),
          }
        : x.kind === 'api'
          ? {
              ...x,
              sendsTo: intakeApiUrl(workerUrl),
              example: intakeCurlExample(workerUrl),
              sameOneTwice:
                'Send the same request twice and only one lead opens. Pass your own dedupeKey to decide what counts as the same one.',
            }
          : x,
    ),
  };
}

/** What the person couldn't see in an area, and who can, part by part when they differ. */
function hiddenNote(area: SettingsArea, missing: readonly string[]): string {
  const who = (as: string) =>
    whoSees(registry.query(QUERIES[area].find((q) => q.as === as)?.name ?? '')?.permission);
  const sayings = [...new Set(missing.map(who))];
  return `Not this person's to see: ${missing.join(', ')}. ${
    sayings.length === 1 ? sayings[0] : missing.map((as) => `${as}: ${who(as)}`).join(' ')
  }`;
}

/**
 * Reads one area. A query the person's role refuses answers `null` for that part rather than failing the tool: the
 * model then says who can see it, which is what the screen does by not showing the tab.
 */
async function readArea(
  db: Db,
  ctx: ToolContext,
  info: SettingsAreaInfo,
  services: WorkerServices | null,
): Promise<ToolOutcome> {
  const parts = await Promise.all(
    QUERIES[info.area].map(async (q) => {
      const value = await query<unknown>(db, ctx, q.name, q.input?.(ctx)).catch(() => null);
      const shaped =
        value === null ? null : q.shape ? await q.shape(value, db, ctx, services) : value;
      return [q.as, shaped] as const;
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
      ...(missing.length ? { note: hiddenNote(info.area, missing) } : {}),
    },
  };
}

/** The words of a phrase, for matching what they asked about against an area's steps. */
const wordsOf = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2),
  );

/**
 * The area's steps they asked about: the one named as asked, else the one sharing most words with it ("verify my
 * cell" is confirm your cell number), else the first.
 */
export function handoverAsked(
  info: SettingsAreaInfo,
  what: string | undefined,
): SettingsAreaInfo['handovers'][number] | undefined {
  const asked = what?.trim().toLowerCase();
  if (!asked) return info.handovers[0];
  const same = info.handovers.find((h) => h.what.toLowerCase() === asked);
  if (same) return same;
  const words = wordsOf(asked);
  let best = info.handovers[0];
  let most = 0;
  for (const h of info.handovers) {
    let shared = 0;
    for (const w of wordsOf(`${h.what} ${h.steps.join(' ')}`)) if (words.has(w)) shared += 1;
    if (shared > most) {
      most = shared;
      best = h;
    }
  }
  return best;
}

/** The steps as a card: one row a step, linking to the screen they happen on. */
function helpCard(
  workspaceId: string,
  info: SettingsAreaInfo,
  what: string | undefined,
): AssistantCard | null {
  const first = handoverAsked(info, what);
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

export const settingsReadTools: Record<
  string,
  (...a: [...Parameters<ReadTool>, services?: WorkerServices | null]) => Promise<ToolOutcome>
> = {
  /** With the worker's services, a form's snippet carries the worker's own address, as Lead intake's does. */
  async get_settings(db, ctx, args, services = null) {
    return readArea(db, ctx, settingsArea(areaOf(args)), services);
  },

  async settings_help(_db, ctx, args) {
    const info = settingsArea(areaOf(args));
    const what = typeof args['what'] === 'string' ? args['what'] : undefined;
    const card = helpCard(ctx.workspaceId, info, what);
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
        // Where the chat's snippet goes on each site builder, as Add it to your site says it.
        ...(info.area === 'website_chat'
          ? { onEachBuilder: CHAT_BUILDERS.map((b) => ({ builder: b.name, steps: b.steps })) }
          : {}),
      },
      ...(card ? { card } : {}),
    };
  },
};
