/**
 * The duty editor (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, step 12; Chris, 2026-09-30): owners and admins
 * (`realestate.manage`) turn catalog duties off, change their timing, reminders, who answers for them, their proof
 * and how much they matter, and write the business's own duties with the same rules. Drafts change nothing until
 * they're published: publishing makes a new version that new deals take; open deals keep theirs, and "Apply to this
 * deal" moves one on after showing what changes.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { uuid } from '../../../schemas/common';
import { HfosError } from '../../../errors';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CATALOG_VERSION,
  catalogDuty,
  dutiesCreatedBy,
  resolveDuty,
  type DealFact,
  type DutyDef,
  type ResolvedDuty,
} from '../catalog';
import { KEY_DATE_KEYS, type KeyDateKey } from '../dates/key-dates';
import {
  buildList,
  CustomDutySchema,
  itemChanges,
  listIssues,
  OverridePatchSchema,
  stableText,
  type CustomDuty,
  type ListItem,
  type OverridePatch,
} from '../editor';
import { realestateAddon } from '../manifest';
import {
  BUYER_STAGES,
  isDoneDuty,
  LISTING_STAGES,
  type DealStage,
  type DutyStatus,
} from '../states';
import {
  customTemplates,
  deals,
  duties,
  templateItems,
  templateOverrides,
  templateSets,
} from '../tables';
import { keyDatesOf, termsNow } from '../terms';
import {
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { replayMoments } from './deals';
import { openWork, pastOf, termEntriesOf } from './engine';

const ws = { workspaceId: uuid };
const catalogKey = z
  .string()
  .regex(/^[BSX]-\d{2}$/, { error: 'That isn’t one of the list’s duties.' });
const customKey = z
  .string()
  .regex(/^C-\d{2,3}$/, { error: 'That isn’t one of the business’s own duties.' });

// ---------- the business's drafts ----------

async function draftsOf(ctx: Ctx) {
  const overrides = await ctx.tx
    .select()
    .from(templateOverrides)
    .where(eq(templateOverrides.workspaceId, ctx.scope.workspaceId!));
  const customs = await ctx.tx
    .select()
    .from(customTemplates)
    .where(
      and(
        eq(customTemplates.workspaceId, ctx.scope.workspaceId!),
        isNull(customTemplates.archivedAt),
      ),
    )
    .orderBy(asc(customTemplates.dutyKey));
  return {
    overrides: new Map(
      overrides.map((o) => [o.dutyKey, { enabled: o.enabled, patch: o.patch as OverridePatch }]),
    ),
    customs: customs.map((c) => ({ key: c.dutyKey, duty: c.definition as unknown as CustomDuty })),
  };
}

/** The list as the drafts make it now. */
async function draftList(ctx: Ctx): Promise<ListItem[]> {
  const d = await draftsOf(ctx);
  return buildList(d.overrides, d.customs);
}

async function latestSet(ctx: Ctx) {
  const [set] = await ctx.tx
    .select()
    .from(templateSets)
    .where(eq(templateSets.workspaceId, ctx.scope.workspaceId!))
    .orderBy(desc(templateSets.version))
    .limit(1);
  return set ?? null;
}

async function itemsOf(ctx: Ctx, templateSetId: string): Promise<ListItem[]> {
  const list = await ctx.tx
    .select()
    .from(templateItems)
    .where(eq(templateItems.templateSetId, templateSetId))
    .orderBy(asc(templateItems.dutyKey));
  return list.map((i) => ({
    key: i.dutyKey,
    enabled: i.enabled,
    definition: i.definition as unknown as ResolvedDuty,
  }));
}

const sameList = (a: readonly ListItem[], b: readonly ListItem[]) => {
  const key = (l: readonly ListItem[]) =>
    stableText([...l].sort((x, y) => x.key.localeCompare(y.key)));
  return key(a) === key(b);
};

function refuseIssues(issues: readonly string[]) {
  if (issues.length)
    throw HfosError.validation(
      issues.map((message) => ({ path: 'duty', message })),
      'That duty can’t work as written. Fix what’s marked and try again.',
    );
}

const Changed = z.object({ dutyKey: z.string(), unpublished: z.boolean() });

export const templateSetOverride = defineAddonCommand(realestateAddon, {
  name: 'realestate.template.set_override',
  description:
    'Change one of the list’s duties for this business: turn it off or on, or change when it’s due, its reminders, who answers for it, what finishes it, or how much it matters. A draft until published.',
  risk: 1,
  input: z.object({
    ...ws,
    dutyKey: catalogKey,
    enabled: z.boolean().default(true),
    patch: OverridePatchSchema.default({}),
  }),
  output: Changed,
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.template.changed'],
  async handler(ctx, input) {
    const def = catalogDuty(input.dutyKey);
    if (!def || def.perDeal === false)
      throw HfosError.notFound(
        'That duty isn’t on the list. Refresh the duty list and pick again.',
      );
    const item = buildList(
      new Map([[input.dutyKey, { enabled: input.enabled, patch: input.patch }]]),
      [],
    ).find((i) => i.key === input.dutyKey)!;
    refuseIssues(listIssues([item]));
    await ctx.tx
      .insert(templateOverrides)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        dutyKey: input.dutyKey,
        enabled: input.enabled,
        patch: input.patch as Record<string, unknown>,
        updatedBy: actorUserId(ctx),
      })
      .onConflictDoUpdate({
        target: [templateOverrides.workspaceId, templateOverrides.dutyKey],
        set: {
          enabled: input.enabled,
          patch: input.patch as Record<string, unknown>,
          updatedBy: actorUserId(ctx),
          updatedAt: new Date(),
        },
      });
    await ctx.emit({
      type: 'realestate.template.changed',
      entityType: 'addon',
      entityId: null,
      payload: {
        addonId: 'realestate',
        dutyKey: input.dutyKey,
        enabled: input.enabled,
        patch: Object.keys(input.patch),
      },
      after: { duty: def.title, on: input.enabled, changed: Object.keys(input.patch) },
    });
    return { dutyKey: input.dutyKey, unpublished: true };
  },
});

export const templateClearOverride = defineAddonCommand(realestateAddon, {
  name: 'realestate.template.clear_override',
  description: 'Put one of the list’s duties back as the catalog has it. A draft until published.',
  risk: 1,
  input: z.object({ ...ws, dutyKey: catalogKey }),
  output: Changed,
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.template.changed'],
  async handler(ctx, input) {
    const gone = await ctx.tx
      .delete(templateOverrides)
      .where(
        and(
          eq(templateOverrides.workspaceId, ctx.scope.workspaceId!),
          eq(templateOverrides.dutyKey, input.dutyKey),
        ),
      )
      .returning({ id: templateOverrides.id });
    if (gone.length)
      await ctx.emit({
        type: 'realestate.template.changed',
        entityType: 'addon',
        entityId: null,
        payload: { addonId: 'realestate', dutyKey: input.dutyKey, cleared: true },
        after: { duty: catalogDuty(input.dutyKey)?.title ?? input.dutyKey, asCatalog: true },
      });
    return { dutyKey: input.dutyKey, unpublished: gone.length > 0 };
  },
});

export const templateSaveCustom = defineAddonCommand(realestateAddon, {
  name: 'realestate.template.save_custom',
  description:
    'Write one of the business’s own duties, or change one: what brings it (a stage, a date confirmed, a moment), when it’s due, its proof, who answers for it and how much it matters. A draft until published.',
  risk: 1,
  input: z.object({ ...ws, dutyKey: customKey.optional(), duty: CustomDutySchema }),
  output: Changed,
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.template.changed'],
  async handler(ctx, input) {
    let key = input.dutyKey;
    if (key) {
      const [was] = await ctx.tx
        .select({ id: customTemplates.id })
        .from(customTemplates)
        .where(
          and(
            eq(customTemplates.workspaceId, ctx.scope.workspaceId!),
            eq(customTemplates.dutyKey, key),
          ),
        );
      if (!was)
        throw HfosError.notFound(
          'That duty of the business’s isn’t there anymore. Refresh the duty list.',
        );
    } else {
      const [last] = await rows<{ n: number | null }>(
        ctx.tx,
        sql`select max(substring(duty_key from 3)::int) as n from addon_realestate.custom_templates
            where workspace_id = ${ctx.scope.workspaceId!}`,
      );
      key = `C-${String((last?.n ?? 0) + 1).padStart(2, '0')}`;
    }
    refuseIssues(
      listIssues(buildList(new Map(), [{ key, duty: input.duty }]).filter((i) => i.key === key)),
    );
    await ctx.tx
      .insert(customTemplates)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        dutyKey: key,
        definition: input.duty as unknown as Record<string, unknown>,
        updatedBy: actorUserId(ctx),
      })
      .onConflictDoUpdate({
        target: [customTemplates.workspaceId, customTemplates.dutyKey],
        set: {
          definition: input.duty as unknown as Record<string, unknown>,
          archivedAt: null,
          updatedBy: actorUserId(ctx),
          updatedAt: new Date(),
        },
      });
    await ctx.emit({
      type: 'realestate.template.changed',
      entityType: 'addon',
      entityId: null,
      payload: { addonId: 'realestate', dutyKey: key, custom: true },
      after: { duty: input.duty.title, own: true },
    });
    return { dutyKey: key, unpublished: true };
  },
});

export const templateArchiveCustom = defineAddonCommand(realestateAddon, {
  name: 'realestate.template.archive_custom',
  description:
    'Take one of the business’s own duties off the list. Deals that have it keep it; new ones won’t once published.',
  risk: 1,
  input: z.object({ ...ws, dutyKey: customKey }),
  output: Changed,
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.template.changed'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(customTemplates)
      .set({ archivedAt: new Date(), updatedBy: actorUserId(ctx), updatedAt: new Date() })
      .where(
        and(
          eq(customTemplates.workspaceId, ctx.scope.workspaceId!),
          eq(customTemplates.dutyKey, input.dutyKey),
          isNull(customTemplates.archivedAt),
        ),
      )
      .returning({ definition: customTemplates.definition });
    if (row)
      await ctx.emit({
        type: 'realestate.template.changed',
        entityType: 'addon',
        entityId: null,
        payload: { addonId: 'realestate', dutyKey: input.dutyKey, archived: true },
        after: {
          duty: (row.definition as { title?: string }).title ?? input.dutyKey,
          archived: true,
        },
      });
    return { dutyKey: input.dutyKey, unpublished: !!row };
  },
});

export const templatePublish = defineAddonCommand(realestateAddon, {
  name: 'realestate.template.publish',
  description:
    'Publish the duty list as it’s drafted now: a new version that every new deal takes. Open deals keep theirs until someone applies it to them.',
  risk: 2,
  input: z.object({ ...ws, note: z.string().trim().max(500).optional() }),
  output: z.object({ templateSetId: uuid, version: z.number().int(), duties: z.number().int() }),
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.template.published'],
  async handler(ctx, input) {
    const list = await draftList(ctx);
    refuseIssues(listIssues(list));
    const last = await latestSet(ctx);
    if (last && sameList(list, await itemsOf(ctx, last.id)))
      throw HfosError.rule(
        'realestate_nothing_to_publish',
        409,
        `The list is the same as version ${last.version}, which is already published. Change something first.`,
      );
    const version = (last?.version ?? 0) + 1;
    const [set] = await ctx.tx
      .insert(templateSets)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        version,
        catalogVersion: CATALOG_VERSION,
        note: input.note ?? null,
        publishedBy: actorUserId(ctx),
      })
      .returning();
    await ctx.tx.insert(templateItems).values(
      list.map((i) => ({
        workspaceId: ctx.scope.workspaceId!,
        templateSetId: set!.id,
        dutyKey: i.key,
        enabled: i.enabled,
        definition: i.definition as unknown as Record<string, unknown>,
      })),
    );
    await ctx.emit({
      type: 'realestate.template.published',
      entityType: 'addon',
      entityId: null,
      payload: { addonId: 'realestate', templateSetId: set!.id, version, duties: list.length },
      after: { version, on: list.filter((i) => i.enabled).length, note: input.note ?? null },
    });
    return { templateSetId: set!.id, version, duties: list.filter((i) => i.enabled).length };
  },
});

// ---------- a deal moved to a newer version ----------

interface Plan {
  readonly cancel: { dutyId: string; title: string }[];
  readonly redefine: {
    dutyId: string;
    title: string;
    changes: string[];
    definition: ResolvedDuty;
  }[];
  readonly add: { key: string; title: string }[];
}

/** What moving a deal to a version would change: open duties turned off, changed, and duties it would gain. */
async function planFor(ctx: Ctx, deal: Deal, items: readonly ListItem[]): Promise<Plan> {
  const target = new Map(items.filter((i) => i.enabled).map((i) => [i.key, i.definition]));
  const list = await ctx.tx.select().from(duties).where(eq(duties.dealRecordId, deal.recordId));
  const plan: Plan = { cancel: [], redefine: [], add: [] };
  for (const d of list) {
    if (isDoneDuty(d.status as DutyStatus) || d.startedBy.startsWith('manual:')) continue;
    const next = target.get(d.dutyKey);
    const now = d.definition as unknown as ResolvedDuty;
    if (!next) plan.cancel.push({ dutyId: d.id, title: d.title });
    else if (stableText(now) !== stableText(next))
      plan.redefine.push({
        dutyId: d.id,
        title: d.title,
        changes: itemChanges(now, next),
        definition: next,
      });
  }
  // What the deal's moments so far would bring from the new list that it doesn't have.
  const had = new Set(list.filter((d) => d.status !== 'cancelled').map((d) => d.dutyKey));
  const past = await pastOf(ctx, deal.recordId);
  const keyDates = keyDatesOf(termsNow(await termEntriesOf(ctx, deal.recordId)));
  const facts = new Set<DealFact>(deal.facts);
  const defs = [...target.values()] as unknown as DutyDef[];
  const run = (deal.side === 'buyer' ? BUYER_STAGES : LISTING_STAGES) as readonly DealStage[];
  const here = run.indexOf(deal.stage);
  const found = new Map<string, string>();
  const take = (made: DutyDef[]) => {
    for (const d of made) if (!had.has(d.id)) found.set(d.id, d.title);
  };
  if (!deal.outcome) {
    for (const [stage, times] of past.entered) {
      const at = run.indexOf(stage);
      if (at < 0 || at > here) continue;
      take(
        dutiesCreatedBy(
          deal.side,
          { on: 'stage', stage },
          facts,
          times > 1 ? 'later' : 'first',
          defs,
        ),
      );
    }
    for (const key of KEY_DATE_KEYS)
      if (keyDates[key as KeyDateKey]?.confirmed)
        take(dutiesCreatedBy(deal.side, { on: 'dates', key }, facts, 'first', defs));
    for (const event of past.eventsSinceRestart)
      take(dutiesCreatedBy(deal.side, { on: 'event', event }, facts, 'first', defs));
  }
  plan.add.push(...[...found].map(([key, title]) => ({ key, title })));
  return plan;
}

async function targetOf(ctx: Ctx, templateSetId: string | undefined) {
  if (!templateSetId) {
    const last = await latestSet(ctx);
    if (!last)
      throw HfosError.rule(
        'realestate_no_version',
        409,
        'The duty list hasn’t been published yet. Publish it in Settings → Real Estate → Duties first.',
      );
    return last;
  }
  const [set] = await ctx.tx
    .select()
    .from(templateSets)
    .where(
      and(eq(templateSets.id, templateSetId), eq(templateSets.workspaceId, ctx.scope.workspaceId!)),
    );
  if (!set)
    throw HfosError.notFound('That version of the duty list isn’t there. Refresh and pick again.');
  return set;
}

const PlanOut = z.object({
  cancel: z.array(z.object({ dutyId: uuid, title: z.string() })),
  redefine: z.array(z.object({ dutyId: uuid, title: z.string(), changes: z.array(z.string()) })),
  add: z.array(z.object({ key: z.string(), title: z.string() })),
});
const planOut = (p: Plan) => ({
  cancel: p.cancel,
  redefine: p.redefine.map(({ dutyId, title, changes }) => ({ dutyId, title, changes })),
  add: p.add,
});

export const templateDiff = defineAddonQuery(realestateAddon, {
  name: 'realestate.template.diff',
  description:
    'What moving an open deal to a version of the duty list (the newest unless said) would change: duties turned off, duties changed, and duties it would gain.',
  input: z.object({ ...ws, dealId: uuid, templateSetId: uuid.optional() }),
  output: z.object({
    dealId: uuid,
    fromVersion: z.number().int().nullable(),
    toVersion: z.number().int(),
    templateSetId: uuid,
    changes: PlanOut,
  }),
  permission: 'realestate.manage',
  ai: { tool: 'realestate_template_diff' },
  scope: inWorkspace,
  handler: async (ctx, input) => {
    const deal = await loadDeal(ctx, input.dealId);
    const set = await targetOf(ctx, input.templateSetId);
    const from = deal.templateSetId
      ? ((
          await ctx.tx
            .select({ version: templateSets.version })
            .from(templateSets)
            .where(eq(templateSets.id, deal.templateSetId))
        )[0]?.version ?? null)
      : null;
    return {
      dealId: deal.recordId,
      fromVersion: from,
      toVersion: set.version,
      templateSetId: set.id,
      changes: planOut(await planFor(ctx, deal, await itemsOf(ctx, set.id))),
    };
  },
});

export const dealApplyTemplateVersion = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.apply_template_version',
  description:
    'Move an open deal to a version of the duty list (the newest unless said): duties it turns off are cancelled, changed ones take its timing and proof, and ones it adds for what already happened are created. Owners and admins.',
  risk: 2,
  input: z.object({ ...ws, dealId: uuid, templateSetId: uuid.optional() }),
  output: z.object({ dealId: uuid, version: z.number().int(), changes: PlanOut }),
  permission: 'realestate.manage',
  scope: inWorkspace,
  emits: ['realestate.deal.template_applied'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const set = await targetOf(ctx, input.templateSetId);
    if (deal.templateSetId === set.id)
      return {
        dealId: deal.recordId,
        version: set.version,
        changes: { cancel: [], redefine: [], add: [] },
      };
    const plan = await planFor(ctx, deal, await itemsOf(ctx, set.id));
    await ctx.tx
      .update(deals)
      .set({ templateSetId: set.id, catalogVersion: set.catalogVersion, updatedAt: new Date() })
      .where(and(eq(deals.recordId, deal.recordId), eq(deals.workspaceId, deal.workspaceId)));
    const moved: Deal = { ...deal, templateSetId: set.id };
    const w = await openWork(ctx, moved);
    const off = new Set(plan.cancel.map((c) => c.dutyId));
    await w.cancel((d) => off.has(d.id), `Turned off in the duty list (version ${set.version}).`);
    for (const r of plan.redefine) await w.redefine(r.dutyId, r.definition, r.changes);
    await replayMoments(w, { onlyNew: true });
    await w.settle();
    await historyLine(ctx, deal, 'template_applied', {
      before: { templateSetId: deal.templateSetId },
      after: {
        templateSetId: set.id,
        version: set.version,
        cancelled: plan.cancel.length,
        changed: plan.redefine.length,
        added: w.counts.created,
      },
    });
    const eventId = await ctx.emit({
      type: 'realestate.deal.template_applied',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, templateSetId: set.id, version: set.version },
      after: { name: deal.name, dutyList: `version ${set.version}` },
    });
    await dealLine(ctx, deal, `moved this deal to version ${set.version} of the duty list`, {
      eventId,
    });
    return { dealId: deal.recordId, version: set.version, changes: planOut(plan) };
  },
});

// ---------- reading ----------

export const templateList = defineAddonQuery(realestateAddon, {
  name: 'realestate.template.list',
  description:
    'The duty list as drafted: every catalog duty (on or off, and what the business changed) and the business’s own, with the version published now and whether the drafts differ from it.',
  input: z.object(ws),
  output: z.object({
    items: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        side: z.string(),
        phase: z.string(),
        tracker: z.string(),
        enabled: z.boolean(),
        own: z.boolean(),
        changed: z.array(z.string()),
        definition: z.record(z.string(), z.unknown()),
      }),
    ),
    published: z
      .object({
        templateSetId: uuid,
        version: z.number().int(),
        publishedAt: z.string(),
        publishedBy: z.object({ userId: uuid, name: z.string() }).nullable(),
        note: z.string().nullable(),
      })
      .nullable(),
    unpublished: z.boolean(),
  }),
  permission: 'realestate.manage',
  ai: { tool: 'realestate_template_list' },
  scope: inWorkspace,
  handler: async (ctx) => {
    const list = await draftList(ctx);
    const last = await latestSet(ctx);
    const names = await userNames(ctx, [last?.publishedBy ?? null]);
    return {
      items: list.map((i) => {
        const base = catalogDuty(i.key);
        return {
          key: i.key,
          title: i.definition.title,
          side: i.definition.side,
          phase: i.definition.phase,
          tracker: i.definition.tracker,
          enabled: i.enabled,
          own: !base,
          changed: base ? itemChanges(resolveDuty(base), i.definition) : [],
          definition: i.definition as unknown as Record<string, unknown>,
        };
      }),
      published: last
        ? {
            templateSetId: last.id,
            version: last.version,
            publishedAt: last.publishedAt.toISOString(),
            publishedBy: last.publishedBy
              ? { userId: last.publishedBy, name: names.get(last.publishedBy) ?? 'Former member' }
              : null,
            note: last.note,
          }
        : null,
      unpublished: last ? !sameList(list, await itemsOf(ctx, last.id)) : true,
    };
  },
});

export const templateVersions = defineAddonQuery(realestateAddon, {
  name: 'realestate.template.versions',
  description:
    'Every published version of the duty list, newest first, with how many open deals follow each.',
  input: z.object(ws),
  output: z.object({
    versions: z.array(
      z.object({
        templateSetId: uuid,
        version: z.number().int(),
        publishedAt: z.string(),
        note: z.string().nullable(),
        openDeals: z.number().int(),
      }),
    ),
  }),
  permission: 'realestate.manage',
  ai: { tool: 'realestate_template_versions' },
  scope: inWorkspace,
  handler: async (ctx) => {
    const list = await rows<{
      id: string;
      version: number;
      published_at: string;
      note: string | null;
      open_deals: number;
    }>(
      ctx.tx,
      sql`select s.id, s.version, s.published_at, s.note,
            (select count(*)::int from addon_realestate.deals d
              where d.template_set_id = s.id and d.outcome is null) as open_deals
          from addon_realestate.template_sets s
          where s.workspace_id = ${ctx.scope.workspaceId!}
          order by s.version desc`,
    );
    return {
      versions: list.map((v) => ({
        templateSetId: v.id,
        version: v.version,
        publishedAt: new Date(v.published_at).toISOString(),
        note: v.note,
        openDeals: v.open_deals,
      })),
    };
  },
});

export const editorCommands = [
  templateSetOverride,
  templateClearOverride,
  templateSaveCustom,
  templateArchiveCustom,
  templatePublish,
  dealApplyTemplateVersion,
];
export const editorQueries = [templateList, templateVersions, templateDiff];
