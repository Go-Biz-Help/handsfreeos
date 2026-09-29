/**
 * The catalogue a business sells from, and the money settings.
 *
 * `app.products` is what goes on a line — parts, work, a call-out fee — each with a unit price, what one is
 * called and whether it is taxed. `app.plans` is what a maintenance plan costs and what it includes. **Neither is
 * ever deleted:** archiving keeps every old document readable, and a name is free again once its product is
 * archived.
 *
 * `money.save_settings` is the settings document (`workspaces.settings.money`) with step 2's checks, and it
 * mirrors the numbering into `app.document_counters` — the counter row is the authority while a document is
 * being sent, and settings are the editable view of it. A next number only ever moves forward.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { plans, products, services, workspaces } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  checkMoneySettings,
  hasBlockingMoneyIssues,
  numberPreview,
  numberingChangeProblem,
  parseMoneySettings,
  type MoneySettings,
} from '../money/index';
import {
  MoneySaveSettingsInput,
  MoneySaveSettingsOutput,
  PlanArchiveInput,
  PlanCreateInput,
  PlanRefOutput,
  PlanSaveOutput,
  PlanUpdateInput,
  ProductArchiveInput,
  ProductCreateInput,
  ProductRefOutput,
  ProductSaveOutput,
  ProductUpdateInput,
  type PlanOut,
  type ProductOut,
} from '../schemas/money';
import {
  DOCUMENT_COUNTER_KINDS,
  countersOf,
  loadMoneySettings,
  type DocumentKind,
} from './money-shared';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Only what the caller actually sent: a patch that leaves out a field leaves the field alone. */
function patch<T extends object>(input: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (input[k] !== undefined) out[String(k)] = input[k];
  return out;
}

// ---------- products ----------

async function requireProduct(ctx: CommandContext, productId: string) {
  const [p] = await ctx.tx
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.workspaceId, ctx.scope.workspaceId!)));
  if (!p)
    throw HfosError.notFound(
      'That product isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return p;
}

const productOut = (p: typeof products.$inferSelect): typeof ProductOut._output => ({
  id: p.id,
  name: p.name,
  description: p.description,
  sku: p.sku,
  kind: p.kind,
  unitPriceCents: Number(p.unitPriceCents),
  unitLabel: p.unitLabel,
  taxable: p.taxable,
  serviceId: p.serviceId,
  archivedAt: iso(p.archivedAt),
});

/** A product may point at a bookable service, so "AC tune-up" is one price in two places: one product each. */
async function assertServiceFree(
  ctx: CommandContext,
  serviceId: string,
  exceptProductId: string | null,
): Promise<void> {
  const [s] = await ctx.tx
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.workspaceId, ctx.scope.workspaceId!)));
  if (!s)
    throw HfosError.validation(
      [{ path: 'serviceId', message: 'That service isn’t there anymore. Pick another one.' }],
      'That service isn’t there anymore. It may have been deleted. Pick another one.',
    );
  const [taken] = await ctx.tx
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(
      and(
        eq(products.workspaceId, ctx.scope.workspaceId!),
        eq(products.serviceId, serviceId),
        isNull(products.archivedAt),
        exceptProductId ? ne(products.id, exceptProductId) : undefined,
      ),
    );
  if (taken)
    throw HfosError.rule(
      'service_already_priced',
      409,
      `${taken.name} is already the price of that service. Change that product’s price instead, or archive it first.`,
    );
}

export const productCreate = defineCommand({
  name: 'product.create',
  description:
    'Add something to sell: a part, work done, or a charge like a call-out fee, with its unit price, what one unit is called and whether it is taxed. It can be the price of a bookable service.',
  risk: 1,
  input: ProductCreateInput,
  output: ProductSaveOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['product.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const settings = await loadMoneySettings(ctx.tx, ctx.scope.workspaceId!);
    if (input.serviceId) await assertServiceFree(ctx, input.serviceId, null);
    const [row] = await ctx.tx
      .insert(products)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        name: input.name,
        description: input.description ?? null,
        sku: input.sku ?? null,
        kind: input.kind,
        unitPriceCents: input.unitPriceCents,
        unitLabel: input.unitLabel,
        // A new item follows the business's "new items are taxable" setting unless it says otherwise.
        taxable: input.taxable ?? settings.tax.newProductsTaxable,
        serviceId: input.serviceId ?? null,
        createdBy: me,
      })
      .returning();
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'product.created',
      entityType: 'product',
      entityId: row.id,
      payload: { kind: row.kind, unitPriceCents: Number(row.unitPriceCents) },
      after: { name: row.name, price: Number(row.unitPriceCents), kind: row.kind },
    });
    return { productId: row.id, archived: false, product: productOut(row), updated: [] };
  },
});

export const productUpdate = defineCommand({
  name: 'product.update',
  description:
    'Change something in the catalogue. Repricing it never reprices a document that has already gone out: every line keeps what the product said when it was added.',
  risk: 1,
  input: ProductUpdateInput,
  output: ProductSaveOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['product.updated'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireProduct(ctx, input.productId);
    if (input.serviceId) await assertServiceFree(ctx, input.serviceId, before.id);
    const set = patch(input, [
      'name',
      'description',
      'sku',
      'kind',
      'unitPriceCents',
      'unitLabel',
      'taxable',
      'serviceId',
    ]);
    if (!Object.keys(set).length)
      return {
        productId: before.id,
        archived: !!before.archivedAt,
        product: productOut(before),
        updated: [],
      };
    const [row] = await ctx.tx
      .update(products)
      .set(set)
      .where(eq(products.id, before.id))
      .returning();
    if (!row) throw HfosError.forbidden();
    const updated = Object.keys(set).filter(
      (k) =>
        JSON.stringify((row as Record<string, unknown>)[k]) !==
        JSON.stringify((before as Record<string, unknown>)[k]),
    );
    await ctx.emit({
      type: 'product.updated',
      entityType: 'product',
      entityId: row.id,
      payload: { updated },
      before: { name: before.name, price: Number(before.unitPriceCents) },
      after: { name: row.name, price: Number(row.unitPriceCents) },
    });
    return { productId: row.id, archived: !!row.archivedAt, product: productOut(row), updated };
  },
});

export const productArchive = defineCommand({
  name: 'product.archive',
  description:
    'Stop selling something, or put it back. Nothing in the catalogue is ever deleted: archiving keeps every old document readable, and frees the name for a new item.',
  risk: 1,
  input: ProductArchiveInput,
  output: ProductRefOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['product.archived', 'product.restored'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requireProduct(ctx, input.productId);
    if (!!before.archivedAt === input.archived)
      return { productId: before.id, archived: input.archived };
    const [row] = await ctx.tx
      .update(products)
      .set({ archivedAt: input.archived ? new Date() : null })
      .where(eq(products.id, before.id))
      .returning({ id: products.id, archivedAt: products.archivedAt });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: input.archived ? 'product.archived' : 'product.restored',
      entityType: 'product',
      entityId: before.id,
      payload: {},
      before: { archived: !!before.archivedAt },
      after: { name: before.name, archived: input.archived },
    });
    return { productId: before.id, archived: input.archived };
  },
});

// ---------- plans ----------

async function requirePlan(ctx: CommandContext, planId: string) {
  const [p] = await ctx.tx
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.workspaceId, ctx.scope.workspaceId!)));
  if (!p)
    throw HfosError.notFound(
      'That plan isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return p;
}

const planOut = (p: typeof plans.$inferSelect): typeof PlanOut._output => ({
  id: p.id,
  name: p.name,
  description: p.description,
  priceCents: Number(p.priceCents),
  interval: p.interval,
  intervalCount: p.intervalCount,
  taxable: p.taxable,
  includes: p.includes ?? [],
  serviceId: p.serviceId,
  visitEveryMonths: p.visitEveryMonths,
  archivedAt: iso(p.archivedAt),
});

/** A plan's maintenance schedule: a service and how often, both or neither. */
function visitScheduleOf(input: {
  readonly serviceId?: string | null;
  readonly visitEveryMonths?: number | null;
}): { serviceId: string | null; visitEveryMonths: number | null } | undefined {
  if (input.serviceId === undefined && input.visitEveryMonths === undefined) return undefined;
  const serviceId = input.serviceId ?? null;
  const visitEveryMonths = input.visitEveryMonths ?? null;
  if (!!serviceId !== !!visitEveryMonths)
    throw HfosError.validation([
      serviceId
        ? { path: 'visitEveryMonths', message: 'Say how often the service is due.' }
        : { path: 'serviceId', message: 'Pick the service this plan covers.' },
    ]);
  return { serviceId, visitEveryMonths };
}

export const planCreate = defineCommand({
  name: 'plan.create',
  description:
    'Add a maintenance plan to sell: what it costs, how often it bills and what the customer gets. Selling it takes a copy, so repricing the plan never reprices a customer already on it.',
  risk: 1,
  input: PlanCreateInput,
  output: PlanSaveOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['plan.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const settings = await loadMoneySettings(ctx.tx, ctx.scope.workspaceId!);
    const [row] = await ctx.tx
      .insert(plans)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        name: input.name,
        description: input.description ?? null,
        priceCents: input.priceCents,
        interval: input.interval,
        intervalCount: input.intervalCount,
        taxable: input.taxable ?? settings.tax.newProductsTaxable,
        includes: input.includes,
        ...(visitScheduleOf(input) ?? {}),
        createdBy: me,
      })
      .returning();
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'plan.created',
      entityType: 'plan',
      entityId: row.id,
      payload: { priceCents: Number(row.priceCents), interval: row.interval },
      after: { name: row.name, price: Number(row.priceCents), every: row.interval },
    });
    return { planId: row.id, archived: false, plan: planOut(row), updated: [] };
  },
});

export const planUpdate = defineCommand({
  name: 'plan.update',
  description:
    'Change a maintenance plan in the catalogue. Customers already on it keep the price they were sold.',
  risk: 1,
  input: PlanUpdateInput,
  output: PlanSaveOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['plan.updated'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requirePlan(ctx, input.planId);
    const set = patch(input, [
      'name',
      'description',
      'priceCents',
      'interval',
      'intervalCount',
      'taxable',
      'includes',
    ]);
    const visits = visitScheduleOf(input);
    if (visits) Object.assign(set, visits);
    if (!Object.keys(set).length)
      return {
        planId: before.id,
        archived: !!before.archivedAt,
        plan: planOut(before),
        updated: [],
      };
    const [row] = await ctx.tx.update(plans).set(set).where(eq(plans.id, before.id)).returning();
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'plan.updated',
      entityType: 'plan',
      entityId: row.id,
      payload: { updated: Object.keys(set) },
      before: { name: before.name, price: Number(before.priceCents) },
      after: { name: row.name, price: Number(row.priceCents) },
    });
    return {
      planId: row.id,
      archived: !!row.archivedAt,
      plan: planOut(row),
      updated: Object.keys(set),
    };
  },
});

export const planArchive = defineCommand({
  name: 'plan.archive',
  description:
    'Stop selling a maintenance plan, or put it back. Customers already on it keep billing: their subscription holds its own copy.',
  risk: 1,
  input: PlanArchiveInput,
  output: PlanRefOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['plan.archived', 'plan.restored'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const before = await requirePlan(ctx, input.planId);
    if (!!before.archivedAt === input.archived)
      return { planId: before.id, archived: input.archived };
    const [row] = await ctx.tx
      .update(plans)
      .set({ archivedAt: input.archived ? new Date() : null })
      .where(eq(plans.id, before.id))
      .returning({ id: plans.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: input.archived ? 'plan.archived' : 'plan.restored',
      entityType: 'plan',
      entityId: before.id,
      payload: {},
      before: { archived: !!before.archivedAt },
      after: { name: before.name, archived: input.archived },
    });
    return { planId: before.id, archived: input.archived };
  },
});

// ---------- settings ----------

export const moneySaveSettings = defineCommand({
  name: 'money.save_settings',
  description:
    'Save the money settings: the sales tax and what it is called, invoice and estimate numbering, payment terms and notes, how long an estimate stays good, the deposit to ask for, whether bank transfer is offered, and when reminders go out. The next number only ever moves forward.',
  risk: 2,
  input: MoneySaveSettingsInput,
  output: MoneySaveSettingsOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['money.settings_saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    if (!w)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
    const stored = (w.settings ?? {}) as Record<string, unknown>;
    const current = await loadMoneySettings(ctx.tx, ws);
    const next: MoneySettings = parseMoneySettings(input.settings);

    // Settings that fight each other: an error stops the save, a warning never does (step 2's checks).
    const issues = checkMoneySettings(next);
    if (hasBlockingMoneyIssues(issues))
      throw HfosError.validation(
        issues
          .filter((i) => i.severity === 'error')
          .map((i) => ({ path: i.fields[0] ?? 'settings', message: i.message })),
        'Some of these settings don’t work together. Fix the ones marked, then save again.',
      );

    // The counter row is the authority, not the settings document: a number already read out loud never
    // comes round again, so "next" is checked against the counter and only ever climbs.
    const counters = await countersOf(ctx.tx, ws);
    for (const kind of DOCUMENT_COUNTER_KINDS) {
      const now = counters.get(kind) ?? current.numbering[kind];
      const problem = numberingChangeProblem(now, next.numbering[kind]);
      if (problem)
        throw HfosError.validation([{ path: `settings.numbering.${kind}.next`, message: problem }]);
    }
    for (const kind of DOCUMENT_COUNTER_KINDS) await mirrorCounter(ctx, kind, next);

    const changed = JSON.stringify(stored['money'] ?? null) !== JSON.stringify(next);
    if (changed) {
      const [row] = await ctx.tx
        .update(workspaces)
        .set({ settings: { ...stored, money: next } })
        .where(eq(workspaces.id, ws))
        .returning({ id: workspaces.id });
      if (!row) throw HfosError.forbidden();
      const fields = (Object.keys(next) as (keyof MoneySettings)[]).filter(
        (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]),
      );
      await ctx.emit({
        type: 'money.settings_saved',
        entityType: 'workspace',
        entityId: ws,
        payload: { fields, warnings: issues.map((i) => i.code) },
        before: { money: current },
        after: { money: next },
      });
    }
    return {
      workspaceId: ws,
      settings: next,
      nextEstimateNumber: numberPreview(next.numbering.estimate),
      nextInvoiceNumber: numberPreview(next.numbering.invoice),
      changed,
    };
  },
});

/** The editable view written back to the counter the send transaction actually reads. */
async function mirrorCounter(
  ctx: CommandContext,
  kind: DocumentKind,
  settings: MoneySettings,
): Promise<void> {
  const n = settings.numbering[kind];
  await rows(
    ctx.tx,
    sql`insert into app.document_counters (workspace_id, kind, next_number, prefix, pad)
        values (${ctx.scope.workspaceId!}, ${kind}, ${n.next}, ${n.prefix}, ${n.pad})
        on conflict (workspace_id, kind) do update
          set next_number = greatest(app.document_counters.next_number, excluded.next_number),
              prefix = excluded.prefix, pad = excluded.pad`,
  );
}
