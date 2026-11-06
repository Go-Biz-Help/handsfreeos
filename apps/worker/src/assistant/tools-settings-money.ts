/**
 * Money, the Action Center and the AI teammate, set up by asking (M12, step five).
 *
 * All three commands take a whole document rather than a patch — money settings, attention settings and the
 * teammate's configuration — so each one is read back first and merged. Changing your sales tax must not blank
 * your reminders, and turning on "books visits" must not reset the teammate's name.
 *
 * Two guardrails kept deliberately: HandsFreeOS's own follow-ups stay off until somebody has read the wording
 * (the command refuses otherwise, and the card says so), and the teammate's save is pinned to the revision it was
 * read at, so two people editing it at once conflict instead of one silently winning.
 */

import {
  addressLines,
  applyTeammatePatch,
  AUTOMATIONS,
  businessAddressOf,
  checkMoneySettings,
  HfosError,
  numberingAtCounter,
  reminderSchedule,
  type AutomationDef,
  type AttentionSettings,
  type MoneySettings,
  type TeammateConfig,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
import { settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Warning = { kind: string; text: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : undefined);
const action = (args: Args) => String(args['action'] ?? '');
const cents = (d: number) => Math.round(d * 100);
const money = (c: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

// ---------- how you get paid ----------

const TERMS_WORDS: Record<string, string> = {
  due_on_receipt: 'As soon as it arrives',
  net_7: 'Within 7 days',
  net_14: 'Within 14 days',
  net_30: 'Within 30 days',
};

const nothingChanges = (why: string) => HfosError.validation([], `Nothing would change. ${why}`);

type MoneySettingsGet = {
  settings: MoneySettings;
  nextEstimateNumber: string;
  nextInvoiceNumber: string;
};

const moneySettingsOf = (db: Db, ctx: ToolContext) =>
  query<MoneySettingsGet>(db, ctx, 'money.settings');

/**
 * The settings as they really stand. The whole document is saved, so its numbering starts where documents really
 * are: sending one moves the counter, not the settings, and a next number behind the counter is refused.
 */
const atCounter = (got: MoneySettingsGet): MoneySettings => ({
  ...got.settings,
  numbering: {
    estimate: numberingAtCounter(got.settings.numbering.estimate, got.nextEstimateNumber),
    invoice: numberingAtCounter(got.settings.numbering.invoice, got.nextInvoiceNumber),
  },
});

/** A box the person can empty: null empties it, words fill it, and leaving it out keeps what is there. */
const textOr = (v: unknown, now: string) => (v === null ? '' : (str(v) ?? now));
/** Reminder days as the screen keeps them: each once, in order. */
const dayListOf = (v: unknown) => {
  const l = list<number>(v);
  return l ? [...new Set(l)].sort((a, b) => a - b) : undefined;
};

/** The whole settings document, with only what was asked for changed. */
function nextMoneySettings(now: MoneySettings, args: Args): MoneySettings {
  const rate = num(args['taxRatePercent']);
  const depositPercent = num(args['depositPercent']);
  const depositDollars = num(args['depositDollars']);
  // A share or an amount on its own says which kind of deposit it is, the way the screen's two boxes do.
  const depositKind =
    (str(args['depositKind']) as MoneySettings['deposit']['kind'] | undefined) ??
    (depositPercent !== undefined && depositDollars === undefined
      ? 'percent'
      : depositDollars !== undefined && depositPercent === undefined
        ? 'amount'
        : now.deposit.kind);
  return {
    ...now,
    businessAddress: textOr(args['businessAddress'], now.businessAddress),
    tax: {
      ...now.tax,
      rateBp: rate === undefined ? now.tax.rateBp : Math.round(rate * 100),
      name: str(args['taxName']) ?? now.tax.name,
      newProductsTaxable: bool(args['newItemsTaxable']) ?? now.tax.newProductsTaxable,
    },
    terms: (str(args['terms']) as MoneySettings['terms']) ?? now.terms,
    notes: {
      ...now.notes,
      estimate: textOr(args['estimateNote'], now.notes.estimate),
      invoice: textOr(args['invoiceNote'], now.notes.invoice),
    },
    estimateGoodForDays: num(args['estimateGoodForDays']) ?? now.estimateGoodForDays,
    deposit: {
      ...now.deposit,
      kind: depositKind,
      percentBp:
        depositPercent === undefined ? now.deposit.percentBp : Math.round(depositPercent * 100),
      amountCents: depositDollars === undefined ? now.deposit.amountCents : cents(depositDollars),
    },
    bankTransfer: bool(args['offerBankTransfer']) ?? now.bankTransfer,
    reminders: {
      ...now.reminders,
      beforeDueDays: dayListOf(args['remindBeforeDueDays']) ?? now.reminders.beforeDueDays,
      onDue: bool(args['remindOnDueDay']) ?? now.reminders.onDue,
      afterDueDays: dayListOf(args['remindAfterDueDays']) ?? now.reminders.afterDueDays,
      estimateAfterDays:
        args['nudgeEstimateAfterDays'] === undefined
          ? now.reminders.estimateAfterDays
          : (num(args['nudgeEstimateAfterDays']) ?? null),
    },
  };
}

const percentWords = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;
const quote = (t: string) => (t ? `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”` : 'None');

function depositWords(d: MoneySettings['deposit']): string {
  if (d.kind === 'none') return 'None';
  return d.kind === 'percent'
    ? `${percentWords(d.percentBp)} up front`
    : `${money(d.amountCents)} up front`;
}

/** "3 days before, on the day, 3, 7 and 14 days after", as the screen counts them. */
function reminderWords(s: MoneySettings): string {
  const steps = reminderSchedule(s);
  if (!steps.length) return 'None';
  const before = steps.filter((x) => x.when === 'before').map((x) => x.days);
  const after = steps.filter((x) => x.when === 'after').map((x) => x.days);
  const run = (ns: number[]) =>
    ns.length === 1 ? days(ns[0]!) : `${ns.slice(0, -1).join(', ')} and ${days(ns.at(-1)!)}`;
  return [
    before.length ? `${run(before)} before` : null,
    s.reminders.onDue ? 'on the day' : null,
    after.length ? `${run(after)} after` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** What the card lists: only what changes, each the way the screen says it. */
function moneyChanges(now: MoneySettings, next: MoneySettings): Field[] {
  const fields: Field[] = [];
  if (next.tax.rateBp !== now.tax.rateBp || next.tax.name !== now.tax.name)
    fields.push({
      label: next.tax.name,
      value: `${percentWords(next.tax.rateBp)}${
        next.tax.name === now.tax.name ? '' : ` · was called ${now.tax.name}`
      }`,
    });
  if (next.tax.newProductsTaxable !== now.tax.newProductsTaxable)
    fields.push({
      label: 'New items',
      value: next.tax.newProductsTaxable ? 'Start taxable' : 'Start with no tax',
    });
  if (next.terms !== now.terms)
    fields.push({ label: 'Invoices due', value: TERMS_WORDS[next.terms] ?? next.terms });
  if (next.businessAddress !== now.businessAddress)
    fields.push({
      label: 'Your address',
      value: next.businessAddress
        ? next.businessAddress
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .join(', ')
        : 'Off documents',
    });
  if (next.estimateGoodForDays !== now.estimateGoodForDays)
    fields.push({ label: 'Estimates good for', value: days(next.estimateGoodForDays) });
  const invoiceNote = next.notes.invoice !== now.notes.invoice;
  const estimateNote = next.notes.estimate !== now.notes.estimate;
  // One row for both notes keeps every change on a card of ten.
  if (invoiceNote && estimateNote)
    fields.push({
      label: 'Notes',
      value: `Invoices: ${quote(next.notes.invoice)} · Estimates: ${quote(next.notes.estimate)}`,
    });
  else if (invoiceNote)
    fields.push({ label: 'Note on invoices', value: quote(next.notes.invoice) });
  else if (estimateNote)
    fields.push({ label: 'Note on estimates', value: quote(next.notes.estimate) });
  if (depositWords(next.deposit) !== depositWords(now.deposit))
    fields.push({ label: 'Deposit', value: depositWords(next.deposit) });
  if (next.bankTransfer !== now.bankTransfer)
    fields.push({
      label: 'Bank transfer',
      value: next.bankTransfer
        ? 'Offered, and shown first'
        : 'Not offered: customers see card only',
    });
  if (reminderWords(next) !== reminderWords(now))
    fields.push({ label: 'Invoice reminders', value: reminderWords(next) });
  if (next.reminders.estimateAfterDays !== now.reminders.estimateAfterDays)
    fields.push({
      label: 'Nudge an unanswered estimate',
      value: next.reminders.estimateAfterDays
        ? `After ${days(next.reminders.estimateAfterDays)}, once`
        : 'Never',
    });
  return fields;
}

/** A deposit of nothing, refused the way the screen refuses it, before anyone presses Confirm. */
function depositProblem(next: MoneySettings): HfosError | null {
  const issue = checkMoneySettings(next).find((i) => i.severity === 'error');
  if (!issue) return null;
  const message =
    next.deposit.kind === 'amount'
      ? 'A deposit of $0 asks for nothing. Give an amount, like $500, or turn the deposit off.'
      : 'A deposit of 0% asks for nothing. Give a share, like 25%, or turn the deposit off.';
  return HfosError.validation(
    [{ path: next.deposit.kind === 'amount' ? 'depositDollars' : 'depositPercent', message }],
    message,
  );
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** Settings this change sets fighting, said the way the screen's warnings say it, with its fixes as words. */
function newMoneyWarnings(now: MoneySettings, next: MoneySettings): Warning[] {
  const had = new Set(checkMoneySettings(now).map((i) => i.code));
  return checkMoneySettings(next)
    .filter((i) => i.severity === 'warning' && !had.has(i.code))
    .map((i) => ({
      kind: 'caution',
      text: `${i.message}.${
        i.fixes.length
          ? ` To fix it: ${i.fixes.map((f) => lowerFirst(f.label)).join(', or ')}.`
          : ''
      }`,
    }));
}

/** Taking the address off: what documents show instead. */
async function addressWarning(
  db: Db,
  ctx: ToolContext,
  now: MoneySettings,
  next: MoneySettings,
): Promise<Warning[]> {
  if (next.businessAddress || !now.businessAddress) return [];
  const got = await query<{ workspace: { settings: Record<string, unknown> } }>(
    db,
    ctx,
    'workspace.get',
  ).catch(() => null);
  const setup = businessAddressOf(got?.workspace.settings);
  return [
    setup
      ? {
          kind: 'note',
          text: `New estimates and invoices show the address from your setup instead: ${addressLines(setup).split('\n').join(', ')}.`,
        }
      : {
          kind: 'caution',
          text: 'New estimates and invoices go out with only your business name at the top.',
        },
  ];
}

async function moneyPlan(db: Db, ctx: ToolContext, args: Args) {
  const now = atCounter(await moneySettingsOf(db, ctx));
  const next = nextMoneySettings(now, args);
  if (next.businessAddress.split('\n').length > 5) {
    const message = 'Your address can be five lines at most. Put it on fewer lines.';
    throw HfosError.validation([{ path: 'businessAddress', message }], message);
  }
  const problem = depositProblem(next);
  if (problem) throw problem;
  return { now, next };
}

const updateMoneySettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { now, next } = await moneyPlan(db, ctx, args);
    const fields = moneyChanges(now, next);
    if (!fields.length) throw nothingChanges('Payments are already set that way.');
    const warnings = [
      ...(await addressWarning(db, ctx, now, next)),
      ...newMoneyWarnings(now, next),
    ];
    if (next.tax.rateBp !== now.tax.rateBp)
      warnings.push({
        kind: 'note',
        text: 'Estimates and invoices already sent keep the rate they went out with.',
      });
    return {
      card: settingsCard(toolCallId, 'update_money_settings', {
        title: 'Change how you get paid',
        fields,
        confirmLabel: 'Save the change',
        warnings,
      }),
      result: { waiting: true, changes: fields.map((f) => `${f.label}: ${f.value}`) },
    };
  },

  async commit(db, ctx, args) {
    const { next } = await moneyPlan(db, ctx, args);
    await command(db, ctx, 'money.save_settings', { settings: next });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/payments`,
      command: 'money.save_settings',
    };
  },
};

// ---------- what goes on a document ----------

interface Product {
  id: string;
  name: string;
  unitPriceCents: number;
}

const manageProduct: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { items } = await query<{ items: Product[] }>(db, ctx, 'product.list').catch(() => ({
      items: [] as Product[],
    }));
    const current = items.find((p) => p.id === args['productId']);
    const price = num(args['priceDollars']);
    return {
      card: settingsCard(toolCallId, 'manage_product', {
        title:
          act === 'create'
            ? `Add ${str(args['name']) ?? 'an item'}`
            : act === 'archive'
              ? `Archive ${current?.name ?? 'the item'}`
              : `Change ${current?.name ?? 'the item'}`,
        fields: [
          { label: 'Item', value: str(args['name']) ?? current?.name ?? '' },
          ...(price === undefined ? [] : [{ label: 'Price', value: money(cents(price)) }]),
          ...(str(args['unitLabel']) ? [{ label: 'Per', value: str(args['unitLabel'])! }] : []),
          ...(bool(args['taxable']) === undefined
            ? []
            : [{ label: 'Taxed', value: args['taxable'] ? 'Yes' : 'No' }]),
        ],
        confirmLabel:
          act === 'create' ? 'Add it' : act === 'archive' ? 'Archive it' : 'Save the change',
        warnings:
          act === 'archive'
            ? [{ kind: 'note', text: 'Documents that already have it keep it.' }]
            : [],
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/settings/payments/products`;
    if (act === 'archive') {
      await command(db, ctx, 'product.archive', { productId: args['productId'] });
      return { outcome: 'Archived', href, command: 'product.archive' };
    }
    const price = num(args['priceDollars']);
    const input = {
      ...(str(args['name']) ? { name: str(args['name']) } : {}),
      ...(str(args['description']) ? { description: str(args['description']) } : {}),
      ...(price === undefined ? {} : { unitPriceCents: cents(price) }),
      ...(str(args['unitLabel']) ? { unitLabel: str(args['unitLabel']) } : {}),
      ...(bool(args['taxable']) === undefined ? {} : { taxable: args['taxable'] }),
      ...(args['serviceId'] === undefined ? {} : { serviceId: args['serviceId'] }),
    };
    if (act === 'create') {
      await command(db, ctx, 'product.create', input);
      return { outcome: `${str(args['name'])} is added`, href, command: 'product.create' };
    }
    await command(db, ctx, 'product.update', { productId: args['productId'], ...input });
    return { outcome: 'Changed', href, command: 'product.update' };
  },
};

// ---------- where the money lands ----------

interface Connection {
  id: string;
  provider: string;
  environment: string;
  status: string;
  label: string | null;
  displayName: string | null;
  isDefault: boolean;
  connectedAt: string | null;
  liveSubscriptions: number;
}

const PROVIDER_NAMES: Record<string, string> = { stripe: 'Stripe', square: 'Square' };
const providerOf = (c: Connection) => PROVIDER_NAMES[c.provider] ?? c.provider;
/** "Stripe · Main shop", the way the account's own row on Settings → Payments names it. */
const accountName = (c: Connection) =>
  `${providerOf(c)}${c.label || c.displayName ? ` · ${c.label ?? c.displayName}` : ''}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

async function accountPlan(db: Db, ctx: ToolContext, args: Args) {
  const { connections } = await query<{ connections: Connection[] }>(
    db,
    ctx,
    'payment_connection.list',
  );
  const c = connections.find((x) => x.id === args['connectionId']);
  if (!c)
    throw HfosError.notFound(
      'No connected payment account has that id. They’re in get_settings (area payments).',
    );
  const act = action(args);
  const name = accountName(c);
  const notConnected = (what: string) =>
    HfosError.rule(
      'payment_connection_not_active',
      409,
      `${name} isn’t connected, so it can’t ${what}. Reconnect it in Settings → Payments first.`,
    );
  if (act === 'rename') {
    const label = args['label'] === null ? null : (str(args['label']) ?? null);
    if ((c.label ?? null) === label)
      throw nothingChanges(
        label ? `It’s already called ${label}.` : 'It already goes by its own name.',
      );
    if (c.status !== 'active') throw notConnected('be renamed');
    return { act, c, name, label };
  }
  if (act === 'make_default') {
    if (c.isDefault) throw nothingChanges(`${name} is already where new invoices are paid.`);
    if (c.status !== 'active') throw notConnected('be the default');
    const was = connections.find((x) => x.isDefault && x.environment === c.environment);
    return { act, c, name, was };
  }
  // Plans keep billing at the provider after a disconnect, so only the person's say-so leaves them billing. Cancelling
  // them is their own step: the provider is told by the worker, which needs the sign-in a disconnect destroys.
  const keepBilling = c.liveSubscriptions > 0 && args['keepPlansBilling'] === true;
  if (c.liveSubscriptions > 0 && !keepBilling) {
    const n = c.liveSubscriptions;
    throw HfosError.rule(
      'payment_connection_has_plans',
      409,
      `${n === 1 ? 'A plan still bills' : `${n} plans still bill`} through ${name}. Cancel ${plural(n, 'it', 'them')} first and disconnect a few minutes later, or disconnect anyway and ${providerOf(c)} keeps charging ${plural(n, 'it', 'them')}.`,
    );
  }
  // A business without a default has nowhere to be paid: the oldest account still connected takes over.
  const next = c.isDefault
    ? connections
        .filter((x) => x.id !== c.id && x.status === 'active' && x.environment === c.environment)
        .sort((a, b) => (a.connectedAt ?? '').localeCompare(b.connectedAt ?? ''))[0]
    : undefined;
  return { act, c, name, keepBilling, next };
}

const managePaymentAccount: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await accountPlan(db, ctx, args);
    const { c, name } = plan;
    const fields: Field[] = [{ label: 'Account', value: name }];
    const warnings: Warning[] = [];
    if ('label' in plan)
      fields.push({
        label: 'Now called',
        value: plan.label ?? `Its own name (${c.displayName ?? providerOf(c)})`,
      });
    if ('was' in plan) {
      fields.push({ label: 'New invoices', value: `Paid into ${name}` });
      if (plan.was)
        warnings.push({
          kind: 'note',
          text: `Instead of ${accountName(plan.was)}. Invoices already sent keep the account they went out with.`,
        });
    }
    if (plan.act === 'disconnect') {
      const n = c.liveSubscriptions;
      if (n && 'keepBilling' in plan && plan.keepBilling) {
        fields.push({
          label: 'Plans billing through it',
          value: `${n}, still billing at ${providerOf(c)}`,
        });
        warnings.push({
          kind: 'caution',
          text: `${providerOf(c)} keeps charging ${plural(n, 'that customer', 'those customers')} every cycle, and HandsFreeOS stops managing ${plural(n, 'the plan', 'them')}.`,
        });
      }
      if (c.isDefault && 'next' in plan)
        warnings.push(
          plan.next
            ? {
                kind: 'note',
                text: `New invoices are paid into ${accountName(plan.next)} instead.`,
              }
            : {
                kind: 'caution',
                text: 'It’s the only account connected, so customers can’t pay an invoice online until another is connected.',
              },
        );
      warnings.push({
        kind: 'note',
        text: 'Payments already on their way still settle. Reconnect the same account later and refunds on its old payments work again.',
      });
    }
    return {
      card: settingsCard(toolCallId, 'manage_payment_account', {
        title:
          plan.act === 'rename'
            ? `Rename ${name}`
            : plan.act === 'make_default'
              ? `Take payments through ${name}`
              : `Disconnect ${name}`,
        fields,
        confirmLabel:
          plan.act === 'rename'
            ? 'Rename it'
            : plan.act === 'make_default'
              ? 'Use it'
              : 'Disconnect it',
        warnings,
      }),
      result: { waiting: true, action: plan.act },
    };
  },

  async commit(db, ctx, args) {
    const plan = await accountPlan(db, ctx, args);
    const href = `/app/w/${ctx.workspaceId}/settings/payments`;
    if (plan.act === 'rename') {
      await command(db, ctx, 'payment_connection.set_label', {
        connectionId: plan.c.id,
        label: 'label' in plan ? plan.label : null,
      });
      return { outcome: 'Renamed', href, command: 'payment_connection.set_label' };
    }
    if (plan.act === 'make_default') {
      await command(db, ctx, 'payment_connection.set_default', { connectionId: plan.c.id });
      return {
        outcome: `New invoices are paid into ${plan.name}`,
        href,
        command: 'payment_connection.set_default',
      };
    }
    const keepBilling = 'keepBilling' in plan && plan.keepBilling;
    // Only the person's say-so leaves plans billing: one started since the card was shown is refused.
    await command(db, ctx, 'payment_connection.disconnect', {
      connectionId: plan.c.id,
      acknowledgeSubscriptions: keepBilling,
    });
    return {
      outcome: keepBilling
        ? `Disconnected. The plans keep billing at ${providerOf(plan.c)}`
        : 'Disconnected',
      href,
      command: 'payment_connection.disconnect',
    };
  },
};

// ---------- what Home watches for ----------

const attentionOf = (db: Db, ctx: ToolContext) =>
  query<{ settings: AttentionSettings }>(db, ctx, 'attention.settings');

/** What Settings → Automations shows without a switch (Drafts awaiting review, Connection broke), by kind. */
const ALWAYS_WATCHED: ReadonlyMap<string, string> = new Map(
  (AUTOMATIONS as readonly AutomationDef[]).flatMap((a) =>
    a.locked && a.binding.store === 'attention_kind'
      ? a.binding.kinds.map((k) => [k, a.label] as const)
      : [],
  ),
);

function nextAttention(now: AttentionSettings, args: Args): AttentionSettings {
  const on = list<string>(args['kindsOn']) ?? [];
  const off = (list<string>(args['kindsOff']) ?? []).filter((k) => !ALWAYS_WATCHED.has(k));
  const kinds = { ...now.kinds } as Record<string, boolean>;
  for (const k of on) kinds[k] = true;
  for (const k of off) kinds[k] = false;
  const bigJob = num(args['bigJobDollars']);
  const typical = args['typicalJobValueDollars'];
  const ignoreUnder = num(args['ignoreBalancesUnderDollars']);
  return {
    ...now,
    kinds: kinds as AttentionSettings['kinds'],
    hot: {
      minValueCents: bigJob === undefined ? now.hot.minValueCents : cents(bigJob),
      urgentAfterMinutes: num(args['hotLeadUrgentAfterMinutes']) ?? now.hot.urgentAfterMinutes,
    },
    unanswered: {
      afterOpenMinutes: num(args['newLeadWaitingAfterMinutes']) ?? now.unanswered.afterOpenMinutes,
    },
    stale: { ...now.stale, days: num(args['goneQuietAfterDays']) ?? now.stale.days },
    appointments: {
      windowHours: num(args['unconfirmedVisitWindowHours']) ?? now.appointments.windowHours,
    },
    money: {
      ...now.money,
      estimateWaitingDays: num(args['estimateWaitingDays']) ?? now.money.estimateWaitingDays,
      invoiceOverdueDays: num(args['invoiceOverdueDays']) ?? now.money.invoiceOverdueDays,
      minBalanceCents: ignoreUnder === undefined ? now.money.minBalanceCents : cents(ignoreUnder),
    },
    typicalJobValueCents:
      typical === undefined
        ? now.typicalJobValueCents
        : typical === null
          ? null
          : cents(Number(typical)),
    auto: {
      ...now.auto,
      confirmRequests: bool(args['askCustomersToConfirmVisits']) ?? now.auto.confirmRequests,
      nudges: bool(args['followUpOnQuietLeads']) ?? now.auto.nudges,
    },
    nudge: {
      template: str(args['followUpMessage']) ?? now.nudge.template,
      cooldownDays: num(args['followUpCooldownDays']) ?? now.nudge.cooldownDays,
    },
    replyToConfirm: bool(args['replyCToConfirm']) ?? now.replyToConfirm,
  };
}

const updateActionCenterSettings: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { settings } = await attentionOf(db, ctx);
    const next = nextAttention(settings, args);
    const fields: Field[] = [];
    const on = list<string>(args['kindsOn']);
    const off = list<string>(args['kindsOff']);
    if (on?.length) fields.push({ label: 'Watching for', value: on.join(', ').replace(/_/g, ' ') });
    if (off?.length)
      fields.push({ label: 'No longer watching', value: off.join(', ').replace(/_/g, ' ') });
    if (num(args['bigJobDollars']) !== undefined)
      fields.push({ label: 'A big job is', value: `${money(next.hot.minValueCents)} or more` });
    if (num(args['hotLeadUrgentAfterMinutes']) !== undefined)
      fields.push({
        label: 'Hot lead is urgent after',
        value: `${next.hot.urgentAfterMinutes} min`,
      });
    if (num(args['newLeadWaitingAfterMinutes']) !== undefined)
      fields.push({
        label: 'New lead is waiting after',
        value: `${next.unanswered.afterOpenMinutes} min of open hours`,
      });
    if (num(args['goneQuietAfterDays']) !== undefined)
      fields.push({ label: 'Gone quiet after', value: days(next.stale.days) });
    if (num(args['estimateWaitingDays']) !== undefined)
      fields.push({
        label: 'An estimate waits for a decision after',
        value: days(next.money.estimateWaitingDays),
      });
    if (num(args['invoiceOverdueDays']) !== undefined)
      fields.push({
        label: 'An unpaid invoice shows',
        value:
          next.money.invoiceOverdueDays === 0
            ? 'The morning after it’s due'
            : `${days(next.money.invoiceOverdueDays)} after it’s due`,
      });
    if (num(args['ignoreBalancesUnderDollars']) !== undefined)
      fields.push({ label: 'Ignore balances under', value: money(next.money.minBalanceCents) });
    if (args['typicalJobValueDollars'] !== undefined)
      fields.push({
        label: 'A typical job is worth',
        value:
          next.typicalJobValueCents === null
            ? 'Worked out from what you win'
            : money(next.typicalJobValueCents),
      });
    if (bool(args['askCustomersToConfirmVisits']) !== undefined)
      fields.push({
        label: 'Asks customers to confirm visits',
        value: next.auto.confirmRequests ? 'Yes, on its own' : 'No',
      });
    if (bool(args['followUpOnQuietLeads']) !== undefined)
      fields.push({
        label: 'Follows up quiet leads',
        value: next.auto.nudges ? 'Yes, on its own' : 'No',
      });
    if (bool(args['replyCToConfirm']) !== undefined)
      fields.push({ label: 'Reply C to confirm', value: next.replyToConfirm ? 'On' : 'Off' });
    const nudgeBlocked =
      bool(args['followUpOnQuietLeads']) === true && !settings.auto.nudgeReviewedAt;
    // The screen has no switch for these, so a change that turns one off can't be saved here either.
    const lockedOff = [...new Set((off ?? []).flatMap((k) => ALWAYS_WATCHED.get(k) ?? []))];
    const why = lockedOff.length
      ? `${lockedOff.join(' and ')} ${lockedOff.length === 1 ? 'is' : 'are'} always on; Settings → Automations has no switch for ${lockedOff.length === 1 ? 'it' : 'them'}.`
      : nudgeBlocked
        ? 'Automatic follow-ups can only be turned on from Settings → Automations, where the message is shown to read first.'
        : null;
    return {
      card: settingsCard(toolCallId, 'update_action_center_settings', {
        title: 'Change what Home watches for',
        fields,
        confirmLabel: why ? '' : 'Save the change',
        warnings: lockedOff.length
          ? [{ kind: 'blocked', text: why! }]
          : nudgeBlocked
            ? [
                {
                  kind: 'blocked',
                  text: 'Automatic follow-ups need the wording read and agreed first, on Settings → Automations.',
                },
              ]
            : [],
      }),
      result: why ? { blocked: true, why } : { waiting: true, changes: fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const { settings } = await attentionOf(db, ctx);
    await command(db, ctx, 'attention.save_settings', {
      settings: nextAttention(settings, args),
    });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/automations`,
      command: 'attention.save_settings',
    };
  },
};

// ---------- the AI teammate ----------

interface TeammateGet {
  teammate: {
    id: string;
    name: string;
    status: string;
    revision: number;
    config: TeammateConfig;
  } | null;
}

const teammateOf = (db: Db, ctx: ToolContext) =>
  query<TeammateGet>(db, ctx, 'ai_teammate.get').catch(() => ({ teammate: null }));

const STATUS_WORDS: Record<string, string> = {
  off: 'Off',
  training: 'Training wheels — every message waits for you',
  automatic: 'Automatic — it answers on its own',
};

/** Only the parts this tool offers; everything else in the teammate's settings is left exactly as it is. */
function teammatePatch(args: Args) {
  const patch: Record<string, unknown> = {};
  const identity: Record<string, unknown> = {};
  if (str(args['name'])) identity['name'] = str(args['name']);
  if (str(args['disclosure'])) identity['disclosure'] = str(args['disclosure']);
  if (Object.keys(identity).length) patch['identity'] = identity;

  const channels: Record<string, unknown> = {};
  if (bool(args['answersTexts']) !== undefined) channels['sms'] = args['answersTexts'];
  if (bool(args['answersEmail']) !== undefined) channels['email'] = args['answersEmail'];
  if (bool(args['answersWebsiteChat']) !== undefined) channels['chat'] = args['answersWebsiteChat'];
  if (Object.keys(channels).length) patch['channels'] = channels;

  if (bool(args['repliesToLeads']) !== undefined)
    patch['respond'] = { enabled: args['repliesToLeads'] };
  if (bool(args['answersQuestions']) !== undefined || bool(args['handOffWhenUnsure']) !== undefined)
    patch['answer'] = {
      ...(bool(args['answersQuestions']) === undefined
        ? {}
        : { enabled: args['answersQuestions'] }),
      ...(bool(args['handOffWhenUnsure']) === undefined
        ? {}
        : { whenUnsure: args['handOffWhenUnsure'] ? 'hand_off' : 'take_message' }),
    };
  if (bool(args['booksVisits']) !== undefined || list(args['bookableCalendarIds']))
    patch['book'] = {
      ...(bool(args['booksVisits']) === undefined ? {} : { enabled: args['booksVisits'] }),
      ...(list(args['bookableCalendarIds']) ? { calendarIds: args['bookableCalendarIds'] } : {}),
    };
  if (bool(args['followsUp']) !== undefined || num(args['followUpMonths']) !== undefined)
    patch['followUp'] = {
      ...(bool(args['followsUp']) === undefined ? {} : { enabled: args['followsUp'] }),
      ...(num(args['followUpMonths']) === undefined
        ? {}
        : { monthlyForMonths: args['followUpMonths'] }),
    };
  if (str(args['hoursMode'])) patch['hours'] = { mode: str(args['hoursMode']) };
  return patch;
}

const manageAiTeammate: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { teammate } = await teammateOf(db, ctx);
    if (act === 'set_status') {
      const status = str(args['status']) ?? 'off';
      return {
        card: settingsCard(toolCallId, 'manage_ai_teammate', {
          title: `Put ${teammate?.name ?? 'your AI teammate'} on ${status === 'automatic' ? 'automatic' : status === 'training' ? 'training wheels' : 'off'}`,
          fields: [
            { label: 'Teammate', value: teammate?.name ?? '' },
            { label: 'Now', value: STATUS_WORDS[status] ?? status },
            { label: 'Was', value: STATUS_WORDS[teammate?.status ?? ''] ?? '' },
          ],
          confirmLabel: 'Save it',
          warnings:
            status === 'automatic'
              ? [
                  {
                    kind: 'note',
                    text: 'It will message customers by itself, without waiting for you.',
                  },
                ]
              : [],
        }),
        result: { waiting: true, status },
      };
    }
    const creating = act === 'create';
    // Respond's switch covers its whole section; the New lead greeting is only the first message inside it.
    const respond = bool(args['repliesToLeads']);
    const respondNote =
      respond === false
        ? `New leads get no first message while Respond is off, even with New lead greeting on. ${str(args['name']) ?? teammate?.name ?? 'It'} still answers people who write in.`
        : respond && teammate && !teammate.config.respond.newLeads.enabled
          ? 'New leads get a first message only once New lead greeting is on too, in Settings → Automations.'
          : null;
    // Calendars by name, so the person sees where it may book rather than ids.
    const calendarIds = list<string>(args['bookableCalendarIds']);
    const calendarNames = calendarIds
      ? await query<{ items: { id: string; name: string }[] }>(db, ctx, 'calendar.list').then(
          ({ items }) =>
            calendarIds.map((id) => items.find((c) => c.id === id)?.name ?? 'A calendar'),
        )
      : null;
    const fields: Field[] = [
      { label: 'Teammate', value: str(args['name']) ?? teammate?.name ?? '' },
      ...(str(args['disclosure'])
        ? [
            {
              label: 'Says it is AI',
              value: args['disclosure'] === 'first_message' ? 'In its first message' : 'When asked',
            },
          ]
        : []),
      ...(bool(args['answersTexts']) === undefined
        ? []
        : [{ label: 'Answers texts', value: args['answersTexts'] ? 'Yes' : 'No' }]),
      ...(bool(args['answersEmail']) === undefined
        ? []
        : [{ label: 'Answers email', value: args['answersEmail'] ? 'Yes' : 'No' }]),
      ...(bool(args['answersWebsiteChat']) === undefined
        ? []
        : [{ label: 'Answers website chat', value: args['answersWebsiteChat'] ? 'Yes' : 'No' }]),
      ...(bool(args['repliesToLeads']) === undefined
        ? []
        : [{ label: 'Respond', value: args['repliesToLeads'] ? 'On' : 'Off' }]),
      ...(bool(args['answersQuestions']) === undefined
        ? []
        : [{ label: 'Answers questions', value: args['answersQuestions'] ? 'Yes' : 'No' }]),
      ...(bool(args['handOffWhenUnsure']) === undefined
        ? []
        : [
            {
              label: 'When it isn’t sure',
              value: args['handOffWhenUnsure'] ? 'Hands it to a person' : 'Takes a message',
            },
          ]),
      ...(bool(args['booksVisits']) === undefined
        ? []
        : [{ label: 'Books visits', value: args['booksVisits'] ? 'Yes' : 'No' }]),
      ...(calendarNames
        ? [{ label: 'Books on', value: calendarNames.join(', ') || 'No calendars' }]
        : []),
      ...(bool(args['followsUp']) === undefined
        ? []
        : [{ label: 'Follows up', value: args['followsUp'] ? 'Yes' : 'No' }]),
      ...(num(args['followUpMonths']) === undefined
        ? []
        : [
            {
              label: 'Then monthly for',
              value: `${String(args['followUpMonths'])} ${args['followUpMonths'] === 1 ? 'month' : 'months'}`,
            },
          ]),
      ...(str(args['hoursMode'])
        ? [
            {
              label: 'Answers',
              value:
                args['hoursMode'] === 'always'
                  ? 'Any time'
                  : args['hoursMode'] === 'after_hours'
                    ? 'Outside your open hours'
                    : 'On its own hours',
            },
          ]
        : []),
    ];
    return {
      card: settingsCard(toolCallId, 'manage_ai_teammate', {
        title: creating
          ? 'Set up your AI teammate'
          : `Change ${teammate?.name ?? 'your AI teammate'}`,
        fields,
        confirmLabel: creating ? 'Set it up' : 'Save the change',
        warnings: [
          ...(creating
            ? [
                {
                  kind: 'note',
                  text: 'It starts off. Put it on training wheels first, so every message waits for you.',
                },
              ]
            : []),
          ...(respondNote ? [{ kind: 'note', text: respondNote }] : []),
        ],
      }),
      result: { waiting: true, creating },
    };
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/ai-team`;
    const { teammate } = await teammateOf(db, ctx);
    if (act === 'set_status') {
      await command(db, ctx, 'ai_teammate.set_status', {
        teammateId: teammate?.id,
        status: args['status'],
      });
      return {
        outcome: STATUS_WORDS[String(args['status'])] ?? 'Saved',
        href,
        command: 'ai_teammate.set_status',
      };
    }
    if (act === 'create' || !teammate) {
      await command(db, ctx, 'ai_teammate.create', {
        preset: str(args['preset']) ?? 'lead_responder',
        name: str(args['name']) ?? 'Ava',
        ...(str(args['disclosure']) ? { disclosure: str(args['disclosure']) } : {}),
      });
      // Anything beyond the name and how it introduces itself is a save on top of the preset.
      const patch = teammatePatch({ ...args, name: undefined, disclosure: undefined });
      if (Object.keys(patch).length) await saveTeammate(db, ctx, patch);
      return {
        outcome: `${str(args['name']) ?? 'Your AI teammate'} is set up, and off until you turn it on`,
        href,
        command: 'ai_teammate.create',
      };
    }
    await saveTeammate(db, ctx, teammatePatch(args));
    return { outcome: 'Saved', href, command: 'ai_teammate.save_config' };
  },
};

/** Read, patch, save on the revision it was read at — the same shape as a calendar's save. */
async function saveTeammate(
  db: Db,
  ctx: ToolContext,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  const { teammate } = await teammateOf(db, ctx);
  if (!teammate) return;
  await command(db, ctx, 'ai_teammate.save_config', {
    teammateId: teammate.id,
    baseRevision: teammate.revision,
    config: applyTeammatePatch(teammate.config, patch),
  });
}

export const settingsMoneyConfirmTools: Record<string, SettingsConfirmTool> = {
  update_money_settings: updateMoneySettings,
  manage_product: manageProduct,
  manage_payment_account: managePaymentAccount,
  update_action_center_settings: updateActionCenterSettings,
  manage_ai_teammate: manageAiTeammate,
};
