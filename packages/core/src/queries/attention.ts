/**
 * The Action Center's queries (M8): the ranked list Home shows, the nav badge, the banners on a lead, a
 * conversation or an appointment, and exactly what Let HandsFreeOS Handle would do. Urgency and the chips are
 * worked out at the moment of reading. Approval items only reach the people who can decide them (anyone with
 * records.read can read the rows, so this is where it's enforced).
 */
import { and, eq, gte, inArray, or, type SQL } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { attentionItems } from '@hfos/db/schema';
import { askOptions, planAutoAction } from '../attention/auto-plan';
import {
  chipsOf,
  itemOut,
  scorableOf,
  userIdsOf,
  viewerFor,
  visibleTo,
  type AttentionViewer,
} from '../attention/items';
import { autoActionOf, letHandleModeOf, type AttentionKind } from '../attention/kinds';
import { DONE_RESOLUTIONS, loadAttentionContext, type AttentionItemRow } from '../attention/load';
import { affectedCents, isUrgent, rankItems } from '../attention/score';
import { localDateOf, startOfLocalDay } from '../calendar/engine/zoned';
import { userNames, uuidArray } from '../calendar/load';
import { workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import type { WorkspaceRole } from '../permissions';
import {
  AttentionForRecordInput,
  AttentionForRecordOutput,
  AttentionListInput,
  AttentionListOutput,
  AttentionPreviewHandleInput,
  AttentionPreviewHandleOutput,
  AttentionSummaryInput,
  AttentionSummaryOutput,
} from '../schemas/attention';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Members see Mine (theirs and unassigned) by default; owners and admins see Everyone. */
const defaultScope = (role: WorkspaceRole | null): 'mine' | 'everyone' =>
  role === 'member' ? 'mine' : 'everyone';
const isMine = (row: AttentionItemRow, me: string) =>
  row.assigneeUserId === null || row.assigneeUserId === me;
const DONE: ReadonlySet<string> = new Set(DONE_RESOLUTIONS);

/** Items in some states (plus today's handled and cleared ones), and who is looking. */
async function loadView(
  ctx: QueryContext,
  where: SQL,
): Promise<{ list: AttentionItemRow[]; viewer: AttentionViewer; me: string }> {
  const me = requireHuman(ctx).userId;
  const ws = ctx.scope.workspaceId!;
  const found = await ctx.tx
    .select()
    .from(attentionItems)
    .where(and(eq(attentionItems.workspaceId, ws), where));
  const viewer = await viewerFor(ctx.tx, ws, ctx.scope.workspaceRole, me, found);
  return { list: found.filter((r) => visibleTo(viewer, r)), viewer, me };
}

export const attentionList = defineQuery({
  name: 'attention.list',
  description:
    'What needs attention: open items ranked (urgent first, then value × urgency × probability × confidence), with each item’s reason chips and what you may do, “$ affected”, the counts, what HandsFreeOS will do next and today’s handled items. Mine is yours plus unassigned ones.',
  input: AttentionListInput,
  output: AttentionListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const now = new Date();
    const at = now.getTime();
    const tz = await workspaceTimezone(ctx.tx, ws);
    const today = new Date(startOfLocalDay(localDateOf(at, tz), tz));
    const { list, viewer, me } = await loadView(
      ctx,
      or(
        inArray(attentionItems.state, ['open', 'snoozed']),
        and(eq(attentionItems.state, 'handled'), gte(attentionItems.handledAt, today)),
        and(eq(attentionItems.state, 'resolved'), gte(attentionItems.resolvedAt, today)),
      )!,
    );
    const kinds = input.kinds ? new Set<string>(input.kinds) : null;
    const wanted = kinds ? list.filter((r) => kinds.has(r.kind)) : list;
    const scope = input.scope ?? defaultScope(ctx.scope.workspaceRole);
    const inScope = wanted.filter((r) => scope === 'everyone' || isMine(r, me));
    const open = inScope.filter((r) => r.state === 'open');
    const ranked = rankItems(
      open.map((r) => ({ ...scorableOf(r), row: r })),
      at,
    ).map((x) => x.row);
    const handled = inScope
      .filter((r) => r.state === 'handled')
      .sort((a, b) => (b.handledAt?.getTime() ?? 0) - (a.handledAt?.getTime() ?? 0));
    const names = await userNames(ctx.tx, userIdsOf(inScope));
    const out = (r: AttentionItemRow) => itemOut(r, viewer, names, at);
    const scheduled = open
      .flatMap((r) => {
        const action = autoActionOf(r.kind as AttentionKind, chipsOf(r));
        return r.autoState === 'scheduled' && r.autoScheduledFor && action
          ? [
              {
                itemId: r.id,
                kind: r.kind as AttentionKind,
                title: r.title,
                action,
                scheduledFor: r.autoScheduledFor.toISOString(),
              },
            ]
          : [];
      })
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
    const openVisible = wanted.filter((r) => r.state === 'open');
    return {
      now: now.toISOString(),
      scope,
      items: ranked.map(out),
      handled: input.includeHandled ? handled.map(out) : [],
      scheduled,
      affectedCents: affectedCents(
        open.map((r) => ({
          value: Number(r.valueCents ?? 0),
          valueIsEstimate: r.valueIsEstimate,
          moneyKey: r.moneyKey,
        })),
      ),
      counts: {
        total: open.length,
        urgent: open.filter((r) => isUrgent(scorableOf(r), at)).length,
        snoozed: inScope.filter((r) => r.state === 'snoozed').length,
        mine: openVisible.filter((r) => isMine(r, me)).length,
        everyone: openVisible.length,
      },
      handledToday: inScope.filter(
        (r) => r.state === 'handled' || (r.state === 'resolved' && DONE.has(r.resolution ?? '')),
      ).length,
    };
  },
});

export const attentionSummary = defineQuery({
  name: 'attention.summary',
  description:
    'The Action Center’s badge: how many items need attention and how many are urgent, for you (yours plus unassigned) and for everyone.',
  input: AttentionSummaryInput,
  output: AttentionSummaryOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx) {
    const at = Date.now();
    const { list, me } = await loadView(ctx, eq(attentionItems.state, 'open'));
    const tally = (items: AttentionItemRow[]) => ({
      total: items.length,
      urgent: items.filter((r) => isUrgent(scorableOf(r), at)).length,
    });
    const mine = tally(list.filter((r) => isMine(r, me)));
    const everyone = tally(list);
    const scope = defaultScope(ctx.scope.workspaceRole);
    return { scope, ...(scope === 'mine' ? mine : everyone), mine, everyone };
  },
});

export const attentionForRecord = defineQuery({
  name: 'attention.for_record',
  description:
    'The attention items about one lead, customer, conversation, appointment or task (open or snoozed), for the banner on its page.',
  input: AttentionForRecordInput,
  output: AttentionForRecordOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const id = input.recordId;
    let where: SQL;
    switch (input.recordType) {
      case 'lead':
        where = or(
          eq(attentionItems.leadId, id),
          and(eq(attentionItems.subjectType, 'lead'), eq(attentionItems.subjectId, id)),
        )!;
        break;
      case 'person':
        where = eq(attentionItems.personId, id);
        break;
      case 'conversation':
        where = or(
          eq(attentionItems.conversationId, id),
          and(eq(attentionItems.subjectType, 'conversation'), eq(attentionItems.subjectId, id)),
        )!;
        break;
      case 'appointment': {
        const seats = await rows<{ id: string }>(
          ctx.tx,
          sql`select id from app.appointment_attendees
              where workspace_id = ${ctx.scope.workspaceId!} and appointment_id = ${id}`,
        );
        if (!seats.length) return { items: [] };
        where = and(
          eq(attentionItems.subjectType, 'attendee'),
          sql`${attentionItems.subjectId} = any(${uuidArray(seats.map((s) => s.id))})`,
        )!;
        break;
      }
      case 'task':
        where = and(eq(attentionItems.subjectType, 'task'), eq(attentionItems.subjectId, id))!;
        break;
    }
    const at = Date.now();
    const { list, viewer } = await loadView(
      ctx,
      and(where, inArray(attentionItems.state, ['open', 'snoozed']))!,
    );
    const names = await userNames(ctx.tx, userIdsOf(list));
    const ranked = rankItems(
      list.map((r) => ({ ...scorableOf(r), row: r })),
      at,
    ).map((x) => x.row);
    return { items: ranked.map((r) => itemOut(r, viewer, names, at)) };
  },
});

export const attentionPreviewHandle = defineQuery({
  name: 'attention.preview_handle',
  description:
    'Exactly what Let HandsFreeOS Handle would do for an item: the message, how it reaches them and when (or why it can’t), or the choices when it asks first.',
  input: AttentionPreviewHandleInput,
  output: AttentionPreviewHandleOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { list } = await loadView(ctx, eq(attentionItems.id, input.itemId));
    const row = list[0];
    if (!row) throw HfosError.notFound('That item isn’t there anymore.');
    const kind = row.kind as AttentionKind;
    const mode = letHandleModeOf(kind, chipsOf(row));
    const base = { itemId: row.id, kind, mode, auto: null, options: [], reason: null };
    if (mode === 'none')
      return {
        ...base,
        reason:
          kind === 'ai_approval'
            ? 'Approvals always wait for a person to decide.'
            : 'This is a to-do for someone on the team.',
      };
    const now = new Date();
    const actx = await loadAttentionContext(ctx.tx, ctx.scope.workspaceId!, now);
    if (mode === 'auto') return { ...base, auto: await planAutoAction(ctx.tx, actx, row, now) };
    return { ...base, options: await askOptions(ctx.tx, actx, row, now) };
  },
});
