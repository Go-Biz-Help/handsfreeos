/**
 * The Action Center's queries (M8): the ranked list Home shows, the nav badge, the banners on a lead, a
 * conversation or an appointment, and exactly what Let HandsFreeOS Handle would do. Urgency and the chips are
 * worked out at the moment of reading. Approval items only reach the people who can decide them (anyone with
 * records.read can read the rows, so this is where it's enforced).
 */
import { and, eq, gte, inArray, or, type SQL } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { attentionItems, workspaces } from '@hfos/db/schema';
import { askOptions, planAutoAction } from '../attention/auto-plan';
import { loadItemHints } from '../attention/hints';
import {
  chipsOf,
  itemOut,
  scorableOf,
  userIdsOf,
  viewerFor,
  visibleTo,
  type AttentionViewer,
} from '../attention/items';
import { letHandleModeOf, letHandleRefusal, type AttentionKind } from '../attention/kinds';
import { loadAttentionContext, medianWonCents, type AttentionItemRow } from '../attention/load';
import { isUrgent, rankItems } from '../attention/score';
import { attentionSettingsOf, typicalJobValueCents } from '../attention/settings';
import {
  attentionIsMine,
  attentionListOut,
  attentionListView,
  attentionToday,
  defaultAttentionScope,
} from '../attention/view';
import { userNames, uuidArray } from '../calendar/load';
import { workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import type { QueryContext } from '../kernel/types';
import {
  AttentionForRecordInput,
  AttentionForRecordOutput,
  AttentionListInput,
  AttentionListOutput,
  AttentionPreviewHandleInput,
  AttentionPreviewHandleOutput,
  AttentionSettingsGetInput,
  AttentionSettingsGetOutput,
  AttentionSummaryInput,
  AttentionSummaryOutput,
} from '../schemas/attention';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Members see Mine (theirs and unassigned) by default; owners and admins see Everyone. */
const defaultScope = defaultAttentionScope;
const isMine = attentionIsMine;

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
    const today = new Date(attentionToday(at, tz));
    const { list, viewer, me } = await loadView(
      ctx,
      or(
        inArray(attentionItems.state, ['open', 'snoozed']),
        and(eq(attentionItems.state, 'handled'), gte(attentionItems.handledAt, today)),
        and(eq(attentionItems.state, 'resolved'), gte(attentionItems.resolvedAt, today)),
      )!,
    );
    // The same list the phone builds from its copy (view.ts): sorted, then named and hinted, then shaped.
    const view = attentionListView(list, {
      me,
      role: ctx.scope.workspaceRole,
      now: at,
      scope: input.scope ?? null,
      kinds: input.kinds ?? null,
    });
    const names = await userNames(ctx.tx, userIdsOf(view.inScope));
    const hints = await loadItemHints(ctx.tx, ws, [
      ...view.ranked,
      ...(input.includeHandled ? view.handled : []),
    ] as AttentionItemRow[]);
    return attentionListOut(view, {
      viewer,
      names,
      hints,
      now: at,
      includeHandled: input.includeHandled,
    });
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
    const hints = await loadItemHints(ctx.tx, ctx.scope.workspaceId!, list);
    const ranked = rankItems(
      list.map((r) => ({ ...scorableOf(r), row: r })),
      at,
    ).map((x) => x.row);
    return { items: ranked.map((r) => itemOut(r, viewer, names, at, hints.get(r.id))) };
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
      return { ...base, reason: letHandleRefusal(kind) ?? 'A person takes care of this one.' };
    const now = new Date();
    const actx = await loadAttentionContext(ctx.tx, ctx.scope.workspaceId!, now);
    if (mode === 'auto') return { ...base, auto: await planAutoAction(ctx.tx, actx, row, now) };
    // A money follow-up is signed by whoever is reading it: "Hi Robert, it's Dale at Lone Star".
    const me = requireHuman(ctx).userId;
    const sender = (await userNames(ctx.tx, [me])).get(me)?.trim().split(/\s+/)[0] ?? null;
    return { ...base, options: await askOptions(ctx.tx, actx, row, now, sender) };
  },
});

export const attentionSettingsGet = defineQuery({
  name: 'attention.settings',
  description:
    'The Action Center’s settings, every default filled in, and the typical job value HandsFreeOS works out for itself (the median won lead over the last year, else $500), which it uses when the business hasn’t set one.',
  input: AttentionSettingsGetInput,
  output: AttentionSettingsGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w) throw HfosError.notFound('Workspace not found.');
    const settings = attentionSettingsOf(w.settings as Record<string, unknown> | null);
    const median = await medianWonCents(ctx.tx, ws);
    return {
      settings,
      // What it works out on its own, whatever the business set.
      typicalJobValueCents: typicalJobValueCents(
        { ...settings, typicalJobValueCents: null },
        median,
      ),
      typicalFrom: median !== null && median > 0 ? ('won_median' as const) : ('default' as const),
    };
  },
});
