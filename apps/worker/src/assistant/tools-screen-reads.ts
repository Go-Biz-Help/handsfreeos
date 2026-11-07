/**
 * The screens' own queries as the Assistant's look-ups (packages/core/src/assistant/screen-reads.ts): each runs as
 * the person, through the kernel, with the business's ids put on after the model's arguments, and answers with what
 * the screen would show, cut short when it is too long to read.
 */
import {
  ADDON_CATALOG,
  addonToolArguments,
  AUDIT_CATEGORY_LABEL,
  auditActor,
  auditCategory,
  auditList,
  describeAudit,
  affiliateCodeLink,
  affiliateLink,
  affiliateMine,
  aiSetupGet,
  chatSnippet,
  chatSnippetSrc,
  chatWidgetGet,
  DESK_ONBOARDING_DEFAULT_WINDOW,
  deskMatomoPagesUrl,
  executeQuery,
  HfosError,
  isAuditDetection,
  leadBoard,
  migrationGet,
  migrationStatusWords,
  money,
  onboardingClients,
  onboardingSetupGet,
  onboardingStatus,
  platformAffiliate,
  platformAffiliates,
  platformBusinessGet,
  platformOnboardingCounts,
  platformProblemReportGet,
  problemForClaude,
  registry,
  scheduleTeam,
  screenReadTools,
  videoCallGet,
  webinarDoorPath,
  type AuditEntry,
  type Permission,
  type ScopeKey,
  type ScreenReadTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import { z } from 'zod';
import type { ToolContext, ToolOutcome } from './runtime';
import { scheduleWords, type TeamSchedule } from './schedule-words';
import { aiSetupRead, clientsRead, gettingStartedRead, setupRead } from './setup-screens';
import { query } from './tools-read';

/** The most of an answer, in characters of JSON, the model reads whole. */
const MOST = 16_000;

let derived: ScreenReadTool[] | null = null;
/** Every one, from the registry, made once. */
export const allScreenReadTools = (): readonly ScreenReadTool[] =>
  (derived ??= screenReadTools(registry));

/** The ones a person may use: those their permissions allow, as the screens are. */
export const screenReadToolsFor = (can: (permission: Permission) => boolean): ScreenReadTool[] =>
  allScreenReadTools().filter((t) => can(t.permission));

/**
 * A video call's answer, with the address the team joins it at: the screen's Join opens it. The customer's own link
 * is kept only as a hash, so it never can be. A webinar's Link anyone can use goes as its path, which the executor
 * writes out whole on the business's own domain, as the screen's Copy gives it.
 */
function withJoin(data: unknown, webUrl: string): unknown {
  const call = (
    data as { call?: { id?: unknown; format?: unknown; doorKey?: unknown } | null } | null
  )?.call;
  if (!call || typeof call.id !== 'string') return data;
  const door =
    call.format === 'webinar' && typeof call.doorKey === 'string' && call.doorKey
      ? { linkAnyoneCanUse: webinarDoorPath(call.doorKey) }
      : {};
  return {
    ...(data as object),
    ...(webUrl ? { join: `${webUrl}/call/${call.id}` } : {}),
    ...door,
  };
}

/**
 * A website chat's answer, with the snippet Add it to your site copies. Its address goes as a path, which the executor
 * writes out whole on the business's own domain when one is serving, as the screen does.
 */
function withSnippet(data: unknown): unknown {
  const widget = (data as { widget?: { publicKey?: unknown } | null } | null)?.widget;
  if (!widget || typeof widget.publicKey !== 'string') return data;
  return {
    ...(data as object),
    snippet: chatSnippet(chatSnippetSrc('', widget.publicKey)),
  };
}

type Row = Record<string, unknown>;

/**
 * An affiliate's answer with the links their page copies: their own link, and each code's while the code is on. On the
 * affiliate's own page their link shows once they're approved and have agreed to the terms (`mine`); staff see every
 * affiliate's. These are on HandsFreeOS's own website, the one place a link isn't on a business's address.
 */
function withAffiliateLinks(data: unknown, mine: boolean): unknown {
  if (!data || typeof data !== 'object') return data;
  const code = (c: Row): Row =>
    c.status === 'on' && typeof c.code === 'string' ? { ...c, link: affiliateCodeLink(c.code) } : c;
  const codes = (list: unknown) => (Array.isArray(list) ? (list as Row[]).map(code) : list);
  const person = (a: Row): Row => {
    if (typeof a.code !== 'string') return a;
    if (mine && !(a.status === 'approved' && a.termsAccepted === true)) return a;
    return {
      ...a,
      link: affiliateLink(a.code),
      ...('codes' in a ? { codes: codes(a.codes) } : {}),
    };
  };
  const people = (list: unknown) => (Array.isArray(list) ? (list as Row[]).map(person) : list);
  const d = data as Row;
  return {
    ...d,
    ...(d.affiliate && typeof d.affiliate === 'object'
      ? { affiliate: person(d.affiliate as Row) }
      : {}),
    ...('codes' in d ? { codes: codes(d.codes) } : {}),
    ...('houseCodes' in d ? { houseCodes: codes(d.houseCodes) } : {}),
    ...('applications' in d ? { applications: people(d.applications) } : {}),
    ...('affiliates' in d ? { affiliates: people(d.affiliates) } : {}),
  };
}

/** The cards of each stage the board's summary lists, unless the model asked for more of a stage (`shown`). */
const BOARD_CARDS = 5;

interface BoardCard {
  id: string;
  title: string;
  person: { fullName: string } | null;
  company: { name: string } | null;
  valueCents: number;
  assignee: { fullName: string } | null;
  nextAction: string | null;
  nextActionOverdue: boolean;
  needsNextAction: boolean;
  source: string | null;
  stageEnteredAt: string;
  lostReason: string | null;
}
interface Board {
  pipeline: { id: string; name: string };
  pipelines: { id: string; name: string }[];
  funnel: {
    id: string;
    name: string;
    status: string;
    leads: { leadId: string; paused: boolean }[];
  } | null;
  stages: {
    id: string;
    name: string;
    kind: string;
    count: number;
    valueCents: number;
    leads: BoardCard[];
  }[];
}

/**
 * The pipeline board as its header and columns show it: the open leads and their value, then every stage's count and
 * total first (Won and Lost too), and only then each stage's first cards in the board's order, trimmed to what a card
 * shows. The whole board as it comes is far too long to read, and cut short it lost the later stages' counts.
 */
function boardSummary(board: Board, shown: unknown): unknown {
  const asked = new Map(
    (Array.isArray(shown) ? (shown as { stageId?: unknown; limit?: unknown }[]) : []).flatMap(
      (x): [string, number][] =>
        typeof x.stageId === 'string' ? [[x.stageId, Number(x.limit) || BOARD_CARDS]] : [],
    ),
  );
  const open = board.stages.filter((st) => st.kind === 'open');
  const now = Date.now();
  // The card's funnel badge: In {funnel}, or Paused · {funnel} while the team talks to them.
  const inFunnel = new Map((board.funnel?.leads ?? []).map((x) => [x.leadId, x.paused]));
  const funnelName = board.funnel?.name ?? '';
  return {
    pipeline: board.pipeline,
    pipelines: board.pipelines,
    ...(board.funnel
      ? { funnel: { id: board.funnel.id, name: board.funnel.name, status: board.funnel.status } }
      : {}),
    openLeads: open.reduce((n, st) => n + st.count, 0),
    openValue: money(open.reduce((n, st) => n + st.valueCents, 0)),
    stages: board.stages.map((st) => {
      const cards = st.leads.slice(0, asked.get(st.id) ?? BOARD_CARDS);
      return {
        id: st.id,
        name: st.name,
        kind: st.kind,
        count: st.count,
        value: money(st.valueCents),
        leads: cards.map((l) => ({
          id: l.id,
          title: l.title,
          customer: l.person?.fullName ?? l.company?.name ?? null,
          ...(l.person && l.company ? { company: l.company.name } : {}),
          value: money(l.valueCents),
          assignee: l.assignee?.fullName ?? null,
          nextAction: l.nextAction,
          ...(l.nextActionOverdue ? { nextActionOverdue: true } : {}),
          ...(l.needsNextAction ? { needsNextAction: true } : {}),
          daysInStage: Math.max(0, Math.floor((now - Date.parse(l.stageEnteredAt)) / 86_400_000)),
          ...(l.source ? { source: l.source } : {}),
          ...(inFunnel.has(l.id)
            ? { funnel: inFunnel.get(l.id) ? `Paused · ${funnelName}` : `In ${funnelName}` }
            : {}),
          ...(l.lostReason ? { lostReason: l.lostReason } : {}),
        })),
        ...(st.count > cards.length ? { notListed: st.count - cards.length } : {}),
      };
    }),
    note: 'count and value are every lead in the stage. Only its first cards are listed, in the board’s order: for more of one stage, ask again with shown [{stageId, limit}], or use list_leads with pipelineId. get_lead reads one lead in full (last contact, expected close, tags, when it was won or lost).',
  };
}

/** The add-on settings screen's read. */
const ADDON_SETTINGS = 'addon.settings';

/**
 * An add-on's settings as its settings page shows them: what is saved, with the add-on's defaults where nothing is
 * yet, so a part never saved reads as what it is. What was saved, unchanged, when it doesn't read.
 */
function withDefaults(got: unknown): unknown {
  if (typeof got !== 'object' || got === null) return got;
  const { addonId, settings } = got as { addonId?: unknown; settings?: unknown };
  if (settings === null || settings === undefined) return got;
  const schema = ADDON_CATALOG.find((m) => m.id === addonId)?.settings?.workspace;
  const read = schema?.safeParse(settings);
  return read?.success ? { ...got, settings: read.data, ...labelsOf(schema) } : got;
}

/**
 * What each of an add-on's settings is, in the words its schema gives it ("Years a closed deal is kept"), so the model
 * names a setting the way its page does and never guesses what a key holds. None when the schema gives none.
 */
function labelsOf(schema: unknown): { labels?: Record<string, string> } {
  if (!(schema instanceof z.ZodObject)) return {};
  const labels = Object.fromEntries(
    Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([key, part]) =>
      part.description ? [[key, part.description]] : [],
    ),
  );
  return Object.keys(labels).length ? { labels } : {};
}

/** A screen's look-up or change, as far as which business it is asked in goes. */
interface ScreenTool {
  readonly input: z.ZodObject;
  readonly scope: readonly ScopeKey[];
  readonly agencyDoor: boolean;
  readonly forBusiness?: boolean;
  readonly agencyOnly?: boolean;
}

/** What only the agency's owners and admins may ask, said to anyone else. */
const AGENCY_ONLY =
  'Only the agency’s owners and admins can do that for the whole agency or another of its businesses. Ask one of them, or ask about this business’s own.';

/** The agency's own screens (Client businesses, Templates, Saved setups…), said to anyone else. */
const agencyAdminsOnly = (agency: string) =>
  `Only the owners and admins of ${agency} can do that, in its Agency area. Ask one of them.`;

/** The arguments the screen's own query or command takes: never the business ids, nor the door it's asked through. */
export function ownArguments(tool: ScreenTool, args: Record<string, unknown>) {
  const own = addonToolArguments(tool, args);
  if (tool.agencyDoor) delete own['wholeAgency'];
  if (tool.forBusiness) delete own['businessId'];
  return own;
}

/**
 * The business ids a screen's look-up or change is given, put on after the model's arguments (audit AI-3): the
 * organization and the business asked in. Asked of the whole agency (`wholeAgency`, on one either door takes), only the
 * organization's, so the kernel checks the agency's own permission and answers as its page does. Naming one of its
 * client businesses (`businessId`, on an agency's change that takes one), that business, once it is checked to be one
 * of the agency's. Either is only for the agency's owners and admins (account.me's organizations are those), and so is
 * the agency's own look-up or change (`agencyOnly`): anyone else is told who can, never that the agency isn't there.
 */
export async function scopeIds(
  db: Db,
  ctx: ToolContext,
  tool: ScreenTool,
  args: Record<string, unknown>,
): Promise<{ workspaceId?: string; organizationId?: string }> {
  const ids = tool.scope.includes('organizationId') ? { organizationId: ctx.organizationId } : {};
  const inBusiness = tool.scope.includes('workspaceId');
  const here = inBusiness ? { ...ids, workspaceId: ctx.workspaceId } : ids;
  const whole = inBusiness && tool.agencyDoor && args['wholeAgency'] === true;
  const named =
    inBusiness &&
    tool.forBusiness &&
    typeof args['businessId'] === 'string' &&
    args['businessId'] !== ctx.workspaceId
      ? args['businessId']
      : null;
  if (!whole && !named && !tool.agencyOnly) return here;
  const me = await query<{
    organizations: { id: string }[];
    workspaces: { id: string; organizationId: string; organizationName: string }[];
  }>(db, ctx, 'account.me');
  if (!me.organizations.some((o) => o.id === ctx.organizationId)) {
    if (whole || named) throw HfosError.forbidden(AGENCY_ONLY, 'agency_only');
    const agency =
      me.workspaces.find((w) => w.organizationId === ctx.organizationId)?.organizationName ??
      'this agency';
    throw HfosError.forbidden(agencyAdminsOnly(agency), 'agency_only');
  }
  if (whole) return ids;
  if (!named) return here;
  if (!me.workspaces.some((w) => w.id === named && w.organizationId === ctx.organizationId))
    throw HfosError.validation(
      [{ path: 'businessId', message: 'Not one of this agency’s businesses.' }],
      'That business isn’t one of this agency’s. Its id comes from get_agency_area.',
    );
  return { ...ids, workspaceId: named };
}

/**
 * A business's page in the Admin area, with its Add-ons in testing as the page lists them: each add-on still being
 * built that staff can hand it to try, and whether it has been (they can add it) or not (not handed out).
 */
function withAddonsInTesting(got: unknown): unknown {
  const grants = (got as { addonGrants?: { addonId: string }[] } | null)?.addonGrants;
  if (!Array.isArray(grants)) return got;
  const handed = new Set(grants.map((g) => g.addonId));
  // First, so an answer cut short for length still has it.
  return {
    addonsInTesting: ADDON_CATALOG.filter((m) =>
      ['development', 'beta', 'built'].includes(m.catalog.status),
    ).map((m) => ({
      addonId: m.id,
      name: m.name,
      handedOut: handed.has(m.id) ? 'they can add it' : 'not handed out',
    })),
    ...(got as object),
  };
}

/**
 * A problem report with what its Copy for Claude copies: the report, and the page's outline when one was kept, ready
 * to paste into a session on the code. The outline goes there alone, so it is read once.
 */
function forClaude(got: unknown): unknown {
  if (!got || typeof got !== 'object' || !('reportId' in got)) return got;
  const { outline: _outline, ...report } = got as Record<string, unknown>;
  return { ...report, forClaude: problemForClaude(got as Parameters<typeof problemForClaude>[0]) };
}

/**
 * Getting started's counts with the page's Open the pages report in Matomo, over the days counted. First, so an answer
 * cut short for length still has it.
 */
function withMatomo(got: unknown, args: Record<string, unknown>): unknown {
  const days = typeof args['days'] === 'number' ? args['days'] : DESK_ONBOARDING_DEFAULT_WINDOW;
  return { matomoUrl: deskMatomoPagesUrl(days), ...(got as object) };
}

/** A migration's status as its page says it, and each thing left to do with the link to its screen. */
function migrationRead(got: unknown, webUrl: string): unknown {
  const m = (got as { migration?: Record<string, unknown> | null } | null)?.migration;
  if (!m || typeof m !== 'object') return got;
  const tasks = Array.isArray(m['tasks'])
    ? (m['tasks'] as Record<string, unknown>[]).map((t) => {
        const path =
          typeof t['workspaceId'] === 'string' && typeof t['settingsPath'] === 'string'
            ? `/app/w/${t['workspaceId']}${t['settingsPath']}`
            : null;
        return path ? { ...t, link: `${webUrl}${path}` } : t;
      })
    : m['tasks'];
  return {
    ...(got as object),
    migration: {
      ...m,
      statusLabel: migrationStatusWords(String(m['status'])),
      ...(tasks !== undefined ? { tasks } : {}),
    },
  };
}

/**
 * The audit log as its rows read: who did it, the sentence, the kind Filter by activity sorts it into, and whether
 * HandsFreeOS noticed it on its own (the screen hides those until Show what HandsFreeOS noticed). Before and after stay,
 * for what a change was; the ids the sentence already says go.
 */
export function auditRead(got: unknown): unknown {
  const entries = (got as { entries?: AuditEntry[] } | null)?.entries;
  if (!Array.isArray(entries)) return got;
  return {
    ...(got as object),
    entries: entries.map((e) => ({
      at: e.createdAt,
      who: auditActor(e).name,
      did: describeAudit(e),
      kind: AUDIT_CATEGORY_LABEL[auditCategory(e.action)],
      ...(isAuditDetection(e) ? { noticedByHandsFree: true } : {}),
      action: e.action,
      ...(e.actor.userId ? { actorId: e.actor.userId } : {}),
      channel: e.channel,
      entityType: e.entityType,
      entityId: e.entityId,
      ...(e.reason ? { reason: e.reason } : {}),
      before: e.before,
      after: e.after,
    })),
  };
}

export async function runScreenRead(
  db: Db,
  tool: ScreenReadTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
  /** The web app's address, for the join address a video call's answer adds. */
  webUrl = '',
): Promise<ToolOutcome> {
  const input = { ...ownArguments(tool, args), ...(await scopeIds(db, ctx, tool, args)) };
  const got = await executeQuery(db, tool.query, input, ctx.actor, {
    correlationId: ctx.correlationId,
    channel: 'assistant',
  });
  const data =
    tool.query.name === videoCallGet.name
      ? withJoin(got, webUrl)
      : tool.query.name === leadBoard.name
        ? boardSummary(got as Board, args['shown'])
        : tool.query.name === scheduleTeam.name
          ? scheduleWords(got as TeamSchedule)
          : tool.query.name === chatWidgetGet.name
            ? withSnippet(got)
            : tool.query.name === affiliateMine.name
              ? withAffiliateLinks(got, true)
              : tool.query.name === platformAffiliates.name ||
                  tool.query.name === platformAffiliate.name
                ? withAffiliateLinks(got, false)
                : tool.query.name === ADDON_SETTINGS
                  ? withDefaults(got)
                  : tool.query.name === onboardingSetupGet.name
                    ? setupRead(got)
                    : tool.query.name === aiSetupGet.name
                      ? aiSetupRead(got)
                      : tool.query.name === onboardingStatus.name
                        ? gettingStartedRead(got)
                        : tool.query.name === onboardingClients.name
                          ? clientsRead(got, webUrl)
                          : tool.query.name === migrationGet.name
                            ? migrationRead(got, webUrl)
                            : tool.query.name === platformBusinessGet.name
                              ? withAddonsInTesting(got)
                              : tool.query.name === platformProblemReportGet.name
                                ? forClaude(got)
                                : tool.query.name === platformOnboardingCounts.name
                                  ? withMatomo(got, args)
                                  : tool.query.name === auditList.name
                                    ? auditRead(got)
                                    : got;
  const json = JSON.stringify(data ?? null);
  // A list's next page, kept when the rest is cut, so it can still be read on from.
  const next = (data as { nextCursor?: unknown } | null)?.nextCursor;
  return {
    result:
      json.length <= MOST
        ? { data }
        : {
            data: `${json.slice(0, MOST)}…`,
            cutShort: true,
            ...(typeof next === 'string' && next ? { nextCursor: next } : {}),
            note:
              typeof next === 'string' && next
                ? 'That was too long to read whole: ask it again with a smaller limit or a narrower filter. nextCursor reads on from the end of this page, so it skips what was cut.'
                : 'That was too long to read whole: ask it for less (a smaller page, a narrower search).',
          },
  };
}

/** What the panel says while one runs. */
export const screenReadStep = (tool: ScreenReadTool) =>
  `Looking at ${tool.query.name.split('.')[0]!.replace(/_/g, ' ')}`;
