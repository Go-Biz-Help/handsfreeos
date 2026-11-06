/**
 * The screens' own queries as the Assistant's look-ups (packages/core/src/assistant/screen-reads.ts): each runs as
 * the person, through the kernel, with the business's ids put on after the model's arguments, and answers with what
 * the screen would show, cut short when it is too long to read.
 */
import {
  addonToolArguments,
  chatSnippet,
  chatSnippetSrc,
  chatWidgetGet,
  executeQuery,
  leadBoard,
  money,
  registry,
  scheduleTeam,
  screenReadTools,
  videoCallGet,
  webinarDoorPath,
  type Permission,
  type ScreenReadTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { scheduleWords, type TeamSchedule } from './schedule-words';

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

export async function runScreenRead(
  db: Db,
  tool: ScreenReadTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
  /** The web app's address, for the join address a video call's answer adds. */
  webUrl = '',
): Promise<ToolOutcome> {
  const input = {
    ...addonToolArguments(tool, args),
    ...(tool.scope.includes('workspaceId') ? { workspaceId: ctx.workspaceId } : {}),
    ...(tool.scope.includes('organizationId') ? { organizationId: ctx.organizationId } : {}),
  };
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
            : got;
  const json = JSON.stringify(data ?? null);
  return {
    result:
      json.length <= MOST
        ? { data }
        : {
            data: `${json.slice(0, MOST)}…`,
            cutShort: true,
            note: 'That was too long to read whole: ask it for less (a smaller page, a narrower search).',
          },
  };
}

/** What the panel says while one runs. */
export const screenReadStep = (tool: ScreenReadTool) =>
  `Looking at ${tool.query.name.split('.')[0]!.replace(/_/g, ' ')}`;
