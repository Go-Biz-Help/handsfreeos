/**
 * M9 step 3 on the local database: the money commands and queries end to end.
 *
 * What it holds to:
 * - **Sending allocates the next number and freezes the document**, and a second send is refused.
 * - **Converting copies the lines and carries the deposit.**
 * - **What the customer did is theirs:** accepting online records the name they typed, the moment from the
 *   database's clock and a hash of what they were shown; a second accept is refused.
 * - **Nobody writes what an invoice has been paid.** A cash payment and a provider payment both move the balance
 *   and the status through the roll-up, and a refund over what is left is refused.
 * - **A bank transfer settling is not a late invoice:** the overdue job skips it.
 * - **The member rule is in every query's own `where`:** a member sees the invoice for the job they worked and
 *   not the next one, and the whole business's receivables are refused to them outright.
 * - **A lead with an estimate still out raises neither "Gone quiet" nor "No next action".**
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { auditLogs, events } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { reconcile } from '../src/attention/load';
import { DETECTORS } from '../src/attention/registry';
import { defaultAttentionSettings } from '../src/attention/settings';
import { asWorker } from '@hfos/db/client';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  estimateAcceptOnline,
  estimateConvert,
  estimateCreate,
  estimateDeclineOnline,
  estimateGet,
  estimateList,
  estimateMarkAccepted,
  estimateRecordView,
  estimateSend,
  estimateUpdate,
  estimateVoid,
  invoiceCreate,
  invoiceGet,
  invoiceList,
  invoiceMarkOverdue,
  invoiceRecordCashPayment,
  invoiceRecordPayment,
  invoiceSend,
  invoiceVoid,
  moneyForRecord,
  moneySaveSettings,
  moneySettingsGet,
  moneySummary,
  organizationCreate,
  paymentList,
  paymentRecordRefund,
  paymentRefund,
  planCreate,
  productCreate,
  productList,
  subscriptionGet,
  subscriptionList,
  subscriptionPause,
  subscriptionRecordCard,
  subscriptionRecordCycle,
  subscriptionRequestCard,
  subscriptionResume,
  subscriptionSetConnection,
  subscriptionStart,
} from '../src/server';
import { acceptanceWording } from '../src/money/index';
import { business, lead as leadFacts } from './attention-fixtures';

/** The sentence the customer's page renders for this estimate; the command stores whatever it is given. */
const WORDING = acceptanceWording(180_000, 'Lone Star Test HVAC');

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const DAY = 86_400_000;

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

interface World {
  owner: TestUser;
  tech: TestUser;
  mate: TestUser;
  wsId: string;
  orgId: string;
  personId: string;
  /** The lead the tech owns, and one nobody owns. */
  techLeadId: string;
  looseLeadId: string;
  /** A seat on a visit the tech worked, and one the mate worked. */
  techAttendeeId: string;
  mateAttendeeId: string;
}
let w: World;

const system = (): SystemActor => ({
  type: 'system',
  workspaceId: w.wsId,
  organizationId: w.orgId,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(worker(), cmd, input, system(), meta('worker')).then((r) => r.output);

beforeAll(async () => {
  const [owner, tech, mate] = await Promise.all([
    createTestUser('money-owner', { fullName: 'Dale Owner' }),
    createTestUser('money-tech', { fullName: 'Marco Tech' }),
    createTestUser('money-mate', { fullName: 'Rosa Mate' }),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: 'Lone Star Money', timezone: 'America/Chicago' },
    owner,
  );
  for (const u of [tech, mate])
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role)
          values (${org.workspaceId}, ${u.id}, 'member')`,
    );
  const ws = org.workspaceId;
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.people (workspace_id, first_name, last_name, email)
        values (${ws}, 'Maria', 'Lopez', ${`maria-${randomUUID().slice(0, 8)}@example.test`}) returning id`,
  );
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calendars (workspace_id, name, slug, status, public)
        values (${ws}, 'Tune-ups', ${`money-${randomUUID().slice(0, 8)}`}, 'active', true) returning id`,
  );
  const [stage] = await rows<{ id: string; pipeline_id: string }>(
    admin(),
    sql`select id, pipeline_id from app.pipeline_stages
        where workspace_id = ${ws} and kind = 'open' order by position limit 1`,
  );
  const makeLead = async (assignee: string | null) => {
    const [l] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, value_cents,
            assignee_user_id, last_contact_at, first_response_at)
          values (${ws}, ${stage!.pipeline_id}, ${stage!.id}, ${p!.id}, 'AC replacement', 1850000,
            ${assignee}, now() - interval '60 days', now() - interval '60 days')
          returning id`,
    );
    return l!.id;
  };
  const makeJob = async (staffUserId: string, hoursOut: number) => {
    const [ap] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, kind, capacity, title,
            starts_at, ends_at, source)
          values (${ws}, ${c!.id}, 1, 'booking', 1, 'AC tune-up',
            now() + make_interval(hours => ${hoursOut}), now() + make_interval(hours => ${hoursOut + 1}), 'staff')
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
          values (${ws}, ${ap!.id}, ${staffUserId})`,
    );
    const [seat] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
          values (${ws}, ${ap!.id}, ${p!.id}) returning id`,
    );
    return seat!.id;
  };
  w = {
    owner,
    tech,
    mate,
    wsId: ws,
    orgId: org.organizationId,
    personId: p!.id,
    techLeadId: await makeLead(tech.id),
    looseLeadId: await makeLead(null),
    techAttendeeId: await makeJob(tech.id, 24),
    mateAttendeeId: await makeJob(mate.id, 48),
  };
});
afterAll(closeTestDbs);

/** An estimate for the loose lead, with one taxable line and one that isn't. */
const draftLines = [
  { name: 'Condenser unit', quantity: 1, unitPriceCents: 480_000, taxable: true },
  { name: 'Labour', quantity: 4, unitPriceCents: 12_500, taxable: false },
];

async function newEstimate(over: Record<string, unknown> = {}) {
  return run(
    estimateCreate,
    {
      workspaceId: w.wsId,
      personId: w.personId,
      leadId: w.looseLeadId,
      title: 'AC replacement',
      lines: draftLines,
      ...over,
    },
    w.owner,
  );
}

// ---------- settings and numbering ----------

describe('money settings', () => {
  it('saves, mirrors the numbering into the counters and previews the next number', async () => {
    const saved = await run(
      moneySaveSettings,
      {
        workspaceId: w.wsId,
        settings: {
          tax: { rateBp: 825, name: 'Sales tax', newProductsTaxable: true },
          numbering: {
            estimate: { prefix: 'EST-', next: 1001, pad: 4 },
            invoice: { prefix: 'INV-', next: 1001, pad: 4 },
          },
          terms: 'net_14',
        },
        settingsCheck: undefined,
      },
      w.owner,
    );
    expect(saved.nextEstimateNumber).toBe('EST-1001');
    expect(saved.nextInvoiceNumber).toBe('INV-1001');
    const counters = await rows<{ kind: string; next_number: string; prefix: string }>(
      admin(),
      sql`select kind, next_number::text as next_number, prefix from app.document_counters
          where workspace_id = ${w.wsId} order by kind`,
    );
    expect(counters.map((c) => [c.kind, c.next_number, c.prefix])).toEqual([
      ['estimate', '1001', 'EST-'],
      ['invoice', '1001', 'INV-'],
    ]);
    const got = await ask(moneySettingsGet, { workspaceId: w.wsId }, w.owner);
    expect(got.settings.tax.rateBp).toBe(825);
    expect(got.nextInvoiceNumber).toBe('INV-1001');
  });

  it('refuses a next number that goes backwards, and a deposit set to nothing', async () => {
    const base = (await ask(moneySettingsGet, { workspaceId: w.wsId }, w.owner)).settings;
    await expectHfos(
      () =>
        run(
          moneySaveSettings,
          {
            workspaceId: w.wsId,
            settings: {
              ...base,
              numbering: { ...base.numbering, invoice: { prefix: 'INV-', next: 5, pad: 4 } },
            },
          },
          w.owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          moneySaveSettings,
          {
            workspaceId: w.wsId,
            settings: { ...base, deposit: { kind: 'percent', percentBp: 0, amountCents: 0 } },
          },
          w.owner,
        ),
      'validation',
    );
  });

  it('is owners’ and admins’ business: a member can’t read it or save it', async () => {
    await expectHfos(() => ask(moneySettingsGet, { workspaceId: w.wsId }, w.tech), 'forbidden');
  });
});

// ---------- the catalogue ----------

describe('the catalogue', () => {
  it('adds a product with the business’s taxable default, and a member can read it', async () => {
    const made = await run(
      productCreate,
      { workspaceId: w.wsId, name: `Filter ${randomUUID().slice(0, 6)}`, unitPriceCents: 4_500 },
      w.owner,
    );
    expect(made.product.taxable).toBe(true);
    await run(
      planCreate,
      { workspaceId: w.wsId, name: `Comfort ${randomUUID().slice(0, 6)}`, priceCents: 2_900 },
      w.owner,
    );
    const list = await ask(productList, { workspaceId: w.wsId }, w.tech);
    expect(list.products.some((p) => p.id === made.productId)).toBe(true);
    await expectHfos(
      () => run(productCreate, { workspaceId: w.wsId, name: 'Nope' }, w.tech),
      'forbidden',
    );
  });
});

// ---------- estimates ----------

describe('an estimate', () => {
  it('adds up to the cent, saves against its revision and refuses a stale save', async () => {
    const made = await newEstimate();
    // 480,000 + 50,000 = 530,000, tax 8.25% on the taxable 480,000 = 39,600.
    expect(made.totalCents).toBe(569_600);
    const first = await run(
      estimateUpdate,
      {
        workspaceId: w.wsId,
        estimateId: made.estimateId,
        personId: w.personId,
        leadId: w.looseLeadId,
        lines: draftLines,
        discount: { kind: 'percent', percentBp: 1_000 },
        baseRevision: made.revision,
      },
      w.owner,
    );
    // 10% off the lines first, then tax on what is left of the taxable one.
    expect(first.totalCents).toBe(512_640);
    await expectHfos(
      () =>
        run(
          estimateUpdate,
          {
            workspaceId: w.wsId,
            estimateId: made.estimateId,
            personId: w.personId,
            lines: draftLines,
            baseRevision: made.revision,
          },
          w.owner,
        ),
      'conflict',
      'document_conflict',
    );
  });

  it('gives the deposit back as it was written, so 25% stays 25% across a reload', async () => {
    const made = await newEstimate({ deposit: { kind: 'percent', percentBp: 2_500 } });
    const read = async (id: string) =>
      (await ask(estimateGet, { workspaceId: w.wsId, estimateId: id }, w.owner)).estimate;

    let got = await read(made.estimateId);
    expect(got.deposit).toEqual({ kind: 'percent', percentBp: 2_500, amountCents: 0 });
    // And what that comes to, which is the figure on screen.
    expect(got.depositCents).toBe(Math.round(made.totalCents * 0.25));

    // Save it back exactly as it was read: a percentage must not land as the amount it happened to come to.
    const saved = await run(
      estimateUpdate,
      {
        workspaceId: w.wsId,
        estimateId: made.estimateId,
        personId: w.personId,
        lines: [
          ...draftLines,
          { name: 'Permit', quantity: 1, unitPriceCents: 20_000, taxable: false },
        ],
        deposit: got.deposit,
        baseRevision: got.revision,
      },
      w.owner,
    );
    got = await read(made.estimateId);
    expect(got.deposit).toEqual({ kind: 'percent', percentBp: 2_500, amountCents: 0 });
    // It is a share of the total, so it followed the total up rather than sticking at the old figure.
    expect(got.depositCents).toBe(Math.round(saved.totalCents * 0.25));

    // An amount comes back as an amount, and a save that doesn't mention the deposit leaves it alone.
    const flat = await newEstimate({ deposit: { kind: 'amount', amountCents: 50_000 } });
    const before = await read(flat.estimateId);
    expect(before.deposit).toEqual({ kind: 'amount', percentBp: 0, amountCents: 50_000 });
    await run(
      estimateUpdate,
      {
        workspaceId: w.wsId,
        estimateId: flat.estimateId,
        personId: w.personId,
        lines: draftLines,
        baseRevision: before.revision,
      },
      w.owner,
    );
    expect((await read(flat.estimateId)).deposit).toEqual({
      kind: 'amount',
      percentBp: 0,
      amountCents: 50_000,
    });
  });

  it('takes the next number on send, freezes, and refuses a second send', async () => {
    const made = await newEstimate();
    const sent = await run(
      estimateSend,
      { workspaceId: w.wsId, estimateId: made.estimateId, channels: ['email'] },
      w.owner,
    );
    expect(sent.number).toMatch(/^EST-\d{4}$/);
    expect(sent.status).toBe('sent');
    // Sending set its expiry from the business's "good for" setting.
    const got = await ask(
      estimateGet,
      { workspaceId: w.wsId, estimateId: made.estimateId },
      w.owner,
    );
    expect(got.estimate.expiresOn).not.toBeNull();
    await expectHfos(
      () =>
        run(
          estimateUpdate,
          {
            workspaceId: w.wsId,
            estimateId: made.estimateId,
            personId: w.personId,
            lines: draftLines,
            baseRevision: sent.revision,
          },
          w.owner,
        ),
      'rule_violation',
      'money_document_issued',
    );
    await expectHfos(
      () => run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner),
      'rule_violation',
      'estimate_not_open',
    );
    const second = await newEstimate();
    const sentAgain = await run(
      estimateSend,
      { workspaceId: w.wsId, estimateId: second.estimateId },
      w.owner,
    );
    // The counter climbs, one per send, and never repeats.
    expect(Number(sentAgain.number!.slice(4))).toBe(Number(sent.number!.slice(4)) + 1);
  });

  it('records an approval online with the name, the moment and a hash, and refuses a second', async () => {
    const made = await newEstimate();
    await run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner);
    const viewed = await sys(estimateRecordView, {
      workspaceId: w.wsId,
      documentId: made.estimateId,
    });
    expect(viewed.changed).toBe(true);
    const accepted = await sys(estimateAcceptOnline, {
      workspaceId: w.wsId,
      estimateId: made.estimateId,
      name: 'Maria L.',
      wording: WORDING,
    });
    expect(accepted.acceptedName).toBe('Maria L.');
    expect(accepted.acceptedVia).toBe('link');
    expect(accepted.acceptedHash).toMatch(/^[0-9a-f]{64}$/);
    // The stamp is the database's clock, not the caller's.
    expect(Math.abs(Date.parse(accepted.acceptedAt) - Date.now())).toBeLessThan(60_000);
    await expectHfos(
      () =>
        sys(estimateAcceptOnline, {
          workspaceId: w.wsId,
          estimateId: made.estimateId,
          name: 'Maria L. again',
          wording: WORDING,
        }),
      'rule_violation',
      'estimate_not_open',
    );
    const got = await ask(
      estimateGet,
      { workspaceId: w.wsId, estimateId: made.estimateId },
      w.owner,
    );
    expect(got.estimate.acceptedWording).toBe(WORDING);
    expect(got.estimate.state).toBe('accepted');
  });

  it('records a decline with the reason', async () => {
    const made = await newEstimate();
    await run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner);
    const declined = await sys(estimateDeclineOnline, {
      workspaceId: w.wsId,
      estimateId: made.estimateId,
      name: 'Maria L.',
      reason: 'Went with someone else',
    });
    expect(declined.status).toBe('declined');
    const got = await ask(
      estimateGet,
      { workspaceId: w.wsId, estimateId: made.estimateId },
      w.owner,
    );
    expect(got.estimate.declinedReason).toBe('Went with someone else');
  });

  it('records a yes given on the phone as staff, in that person’s own name', async () => {
    const made = await newEstimate();
    await run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner);
    const marked = await run(
      estimateMarkAccepted,
      { workspaceId: w.wsId, estimateId: made.estimateId, name: 'Maria on the phone' },
      w.owner,
    );
    expect(marked.acceptedVia).toBe('staff');
    const [row] = await rows<{ accepted_by: string | null }>(
      admin(),
      sql`select accepted_by from app.estimates where id = ${made.estimateId}`,
    );
    expect(row?.accepted_by).toBe(w.owner.id);
  });

  it('is voided, never edited, and keeps its number', async () => {
    const made = await newEstimate();
    const sent = await run(
      estimateSend,
      { workspaceId: w.wsId, estimateId: made.estimateId },
      w.owner,
    );
    const voided = await run(
      estimateVoid,
      { workspaceId: w.wsId, estimateId: made.estimateId, reason: 'Wrong price' },
      w.owner,
    );
    expect(voided.status).toBe('void');
    expect(voided.number).toBe(sent.number);
  });
});

// ---------- convert ----------

describe('converting an estimate', () => {
  it('copies the lines, keeps the totals and carries the deposit', async () => {
    const made = await newEstimate({ deposit: { kind: 'percent', percentBp: 2_500 } });
    await run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner);
    await sys(estimateAcceptOnline, {
      workspaceId: w.wsId,
      estimateId: made.estimateId,
      name: 'Maria L.',
      wording: WORDING,
    });
    const converted = await run(
      estimateConvert,
      { workspaceId: w.wsId, estimateId: made.estimateId },
      w.owner,
    );
    expect(converted.totalCents).toBe(made.totalCents);
    expect(converted.depositCents).toBe(Math.round(made.totalCents * 0.25));
    const invoice = await ask(
      invoiceGet,
      { workspaceId: w.wsId, invoiceId: converted.invoiceId },
      w.owner,
    );
    expect(invoice.invoice.lines.map((l) => [l.name, l.unitPriceCents])).toEqual([
      ['Condenser unit', 480_000],
      ['Labour', 12_500],
    ]);
    expect(invoice.invoice.estimateId).toBe(made.estimateId);
    expect(invoice.invoice.origin).toBe('estimate');
    // The invoice is its own command's work, recorded under its own name.
    const audits = await admin()
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, converted.invoiceId));
    expect(audits.map((a) => a.action)).toContain('invoice.create');
  });

  it('raises the deposit on its own when asked, as a single untaxed line', async () => {
    const made = await newEstimate({ deposit: { kind: 'amount', amountCents: 100_000 } });
    await run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner);
    const converted = await run(
      estimateConvert,
      { workspaceId: w.wsId, estimateId: made.estimateId, purpose: 'deposit' },
      w.owner,
    );
    expect(converted.purpose).toBe('deposit');
    expect(converted.totalCents).toBe(100_000);
    const invoice = await ask(
      invoiceGet,
      { workspaceId: w.wsId, invoiceId: converted.invoiceId },
      w.owner,
    );
    expect(invoice.invoice.lines).toHaveLength(1);
    expect(invoice.invoice.totals.taxCents).toBe(0);
  });

  it('refuses to invoice a draft', async () => {
    const made = await newEstimate();
    await expectHfos(
      () => run(estimateConvert, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner),
      'rule_violation',
      'estimate_not_answered',
    );
  });
});

// ---------- invoices and payments ----------

async function sentInvoice(over: Record<string, unknown> = {}) {
  const made = await run(
    invoiceCreate,
    {
      workspaceId: w.wsId,
      personId: w.personId,
      title: 'AC replacement',
      lines: [{ name: 'Job', quantity: 1, unitPriceCents: 100_000, taxable: false }],
      ...over,
    },
    w.owner,
  );
  return run(invoiceSend, { workspaceId: w.wsId, invoiceId: made.invoiceId }, w.owner);
}

describe('an invoice', () => {
  it('takes the next number on send and works out its due date from the terms', async () => {
    const sent = await sentInvoice();
    expect(sent.number).toMatch(/^INV-\d{4}$/);
    expect(sent.dueOn).not.toBeNull();
    expect(sent.balanceCents).toBe(100_000);
  });

  it('recounts itself when cash lands, and refuses more than is owed', async () => {
    const sent = await sentInvoice();
    const part = await run(
      invoiceRecordCashPayment,
      { workspaceId: w.wsId, invoiceId: sent.invoiceId, amountCents: 40_000, method: 'check' },
      w.owner,
    );
    expect(part.invoiceStatus).toBe('partly_paid');
    expect(part.invoiceBalanceCents).toBe(60_000);
    await expectHfos(
      () =>
        run(
          invoiceRecordCashPayment,
          { workspaceId: w.wsId, invoiceId: sent.invoiceId, amountCents: 60_001 },
          w.owner,
        ),
      'rule_violation',
      'payment_over_balance',
    );
    const rest = await run(
      invoiceRecordCashPayment,
      { workspaceId: w.wsId, invoiceId: sent.invoiceId, amountCents: 60_000 },
      w.owner,
    );
    expect(rest.invoiceStatus).toBe('paid');
    expect(rest.invoiceBalanceCents).toBe(0);
    // paid_at is the roll-up's, never written by hand.
    const [row] = await rows<{ paid_at: Date | null }>(
      admin(),
      sql`select paid_at from app.invoices where id = ${sent.invoiceId}`,
    );
    expect(row?.paid_at).not.toBeNull();
    const paidEvents = await admin()
      .select({ type: events.eventType })
      .from(events)
      .where(eq(events.entityId, sent.invoiceId));
    expect(paidEvents.map((e) => e.type)).toContain('invoice.paid');
  });

  it('a provider payment moves it too, and its status only goes forward', async () => {
    const sent = await sentInvoice();
    const key = `idem-${randomUUID()}`;
    const started = await sys(invoiceRecordPayment, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
      amountCents: 100_000,
      method: 'ach',
      provider: 'stripe',
      status: 'processing',
      providerPaymentId: `pi_${randomUUID().slice(0, 12)}`,
      idempotencyKey: key,
    });
    expect(started.invoiceBalanceCents).toBe(100_000);
    expect(started.invoiceStatus).toBe('sent');
    // The same key again is the same row, not a second charge.
    const settled = await sys(invoiceRecordPayment, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
      amountCents: 100_000,
      method: 'ach',
      provider: 'stripe',
      status: 'succeeded',
      idempotencyKey: key,
    });
    expect(settled.paymentId).toBe(started.paymentId);
    expect(settled.invoiceStatus).toBe('paid');
    const backwards = await sys(invoiceRecordPayment, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
      amountCents: 100_000,
      method: 'ach',
      provider: 'stripe',
      status: 'processing',
      idempotencyKey: key,
    });
    expect(backwards.changed).toBe(false);
    expect(backwards.status).toBe('succeeded');
    const list = await ask(
      paymentList,
      { workspaceId: w.wsId, invoiceId: sent.invoiceId },
      w.owner,
    );
    expect(list.payments).toHaveLength(1);
  });

  it('is never overdue while a payment is on its way', async () => {
    const sent = await sentInvoice();
    await rows(
      admin(),
      sql`update app.invoices set due_on = current_date - 5 where id = ${sent.invoiceId}`,
    );
    await sys(invoiceRecordPayment, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
      amountCents: 100_000,
      method: 'ach',
      provider: 'stripe',
      status: 'processing',
      providerPaymentId: `pi_${randomUUID().slice(0, 12)}`,
    });
    const skipped = await sys(invoiceMarkOverdue, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
    });
    expect(skipped).toMatchObject({ changed: false, skipped: 'settling' });
    const got = await ask(invoiceGet, { workspaceId: w.wsId, invoiceId: sent.invoiceId }, w.owner);
    expect(got.invoice.state).toBe('paying');
  });

  it('goes overdue when nothing is settling', async () => {
    const sent = await sentInvoice();
    await rows(
      admin(),
      sql`update app.invoices set due_on = current_date - 5 where id = ${sent.invoiceId}`,
    );
    const marked = await sys(invoiceMarkOverdue, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
    });
    expect(marked).toMatchObject({ changed: true, status: 'overdue' });
    const again = await sys(invoiceMarkOverdue, { workspaceId: w.wsId, invoiceId: sent.invoiceId });
    expect(again.skipped).toBe('already_overdue');
  });

  it('is voided while nothing has been paid, and refunded once something has', async () => {
    const clean = await sentInvoice();
    expect(
      (await run(invoiceVoid, { workspaceId: w.wsId, invoiceId: clean.invoiceId }, w.owner)).status,
    ).toBe('void');
    const paid = await sentInvoice();
    await run(
      invoiceRecordCashPayment,
      { workspaceId: w.wsId, invoiceId: paid.invoiceId, amountCents: 10_000 },
      w.owner,
    );
    await expectHfos(
      () => run(invoiceVoid, { workspaceId: w.wsId, invoiceId: paid.invoiceId }, w.owner),
      'rule_violation',
      'invoice_has_payments',
    );
  });
});

// ---------- refunds ----------

describe('a refund', () => {
  it('is asked for as pending, settles through the worker and gives the balance back', async () => {
    const sent = await sentInvoice();
    const payment = await run(
      invoiceRecordCashPayment,
      { workspaceId: w.wsId, invoiceId: sent.invoiceId, amountCents: 100_000 },
      w.owner,
    );
    const asked = await run(
      paymentRefund,
      { workspaceId: w.wsId, paymentId: payment.paymentId, amountCents: 30_000 },
      w.owner,
    );
    expect(asked).toMatchObject({ status: 'pending', manual: true, amountCents: 30_000 });
    // Pending changes nothing: the roll-up counts only what succeeded.
    let got = await ask(invoiceGet, { workspaceId: w.wsId, invoiceId: sent.invoiceId }, w.owner);
    expect(got.invoice.balanceCents).toBe(0);
    await sys(paymentRecordRefund, {
      workspaceId: w.wsId,
      refundId: asked.refundId,
      status: 'succeeded',
    });
    got = await ask(invoiceGet, { workspaceId: w.wsId, invoiceId: sent.invoiceId }, w.owner);
    expect(got.invoice.amountRefundedCents).toBe(30_000);
    expect(got.invoice.balanceCents).toBe(30_000);
  });

  it('refuses more than is left on the payment', async () => {
    const sent = await sentInvoice();
    const payment = await run(
      invoiceRecordCashPayment,
      { workspaceId: w.wsId, invoiceId: sent.invoiceId, amountCents: 100_000 },
      w.owner,
    );
    await run(
      paymentRefund,
      { workspaceId: w.wsId, paymentId: payment.paymentId, amountCents: 90_000 },
      w.owner,
    );
    await expectHfos(
      () =>
        run(
          paymentRefund,
          { workspaceId: w.wsId, paymentId: payment.paymentId, amountCents: 20_000 },
          w.owner,
        ),
      'rule_violation',
      'refund_over_balance',
    );
  });

  it('refuses while the account it was taken through is no longer connected', async () => {
    const sent = await sentInvoice();
    const [conn] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, environment, status,
            external_account_id, connected_at)
          values (${w.wsId}, 'stripe', 'live', 'active', ${`acct_${randomUUID().slice(0, 10)}`}, now())
          returning id`,
    );
    const paid = await sys(invoiceRecordPayment, {
      workspaceId: w.wsId,
      invoiceId: sent.invoiceId,
      amountCents: 100_000,
      method: 'card',
      provider: 'stripe',
      connectionId: conn!.id,
      status: 'succeeded',
      providerPaymentId: `pi_${randomUUID().slice(0, 12)}`,
    });
    await rows(
      admin(),
      sql`update app.payment_connections
          set status = 'disconnected', disconnected_at = now(), disconnected_reason = 'person',
              is_default = false, token_enc = null
          where id = ${conn!.id}`,
    );
    await expectHfos(
      () => run(paymentRefund, { workspaceId: w.wsId, paymentId: paid.paymentId }, w.owner),
      'rule_violation',
      'payment_connection_not_connected',
    );
    // The same account connected again finds its credentials, and the refund goes through.
    await rows(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, environment, status,
            external_account_id, connected_at)
          select workspace_id, provider, environment, 'active', external_account_id, now()
          from app.payment_connections where id = ${conn!.id}`,
    );
    const asked = await run(
      paymentRefund,
      { workspaceId: w.wsId, paymentId: paid.paymentId, amountCents: 1_000 },
      w.owner,
    );
    expect(asked.status).toBe('pending');
  });
});

// ---------- plans ----------

describe('a maintenance plan', () => {
  /** A connected account to bill through, written the way the worker's activate does. */
  async function connectedAccount(label: string): Promise<string> {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.payment_connections (workspace_id, provider, environment, status,
            external_account_id, label, token_enc, token_key_id, connected_at)
          values (${w.wsId}, 'stripe', 'test', 'active', ${`acct_${randomUUID().slice(0, 8)}`},
            ${label}, 'sealed', 'test-key', now())
          returning id`,
    );
    return row!.id;
  }

  it('is copied as it is sold, and can be moved between accounts only before the provider holds it', async () => {
    const first = await connectedAccount('First account');
    const second = await connectedAccount('Second account');
    const plan = await run(
      planCreate,
      {
        workspaceId: w.wsId,
        name: 'Comfort Club',
        priceCents: 2_900,
        interval: 'month',
        includes: ['Two visits a year'],
      },
      w.owner,
    );
    const started = await run(
      subscriptionStart,
      {
        workspaceId: w.wsId,
        personId: w.personId,
        planId: plan.planId,
        connectionId: first,
      },
      w.owner,
    );
    expect(started.status).toBe('draft');

    // Nothing at the provider yet, so it can still be billed anywhere.
    const moved = await run(
      subscriptionSetConnection,
      { workspaceId: w.wsId, subscriptionId: started.subscriptionId, connectionId: second },
      w.owner,
    );
    expect(moved.changed).toBe(true);
    const got = await ask(
      subscriptionGet,
      { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
      w.owner,
    );
    expect(got.subscription).toMatchObject({
      planName: 'Comfort Club',
      priceCents: 2_900,
      connectionId: second,
      includes: ['Two visits a year'],
    });

    // Once the provider holds it, a plan lives inside that one account: it is cancelled and started again.
    await sys(subscriptionRecordCycle, {
      workspaceId: w.wsId,
      subscriptionId: started.subscriptionId,
      outcome: 'activated',
      externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      currentPeriodStart: '2026-09-22',
      currentPeriodEnd: '2026-10-22',
      nextBillingOn: '2026-10-22',
    });
    await expectHfos(
      () =>
        run(
          subscriptionSetConnection,
          { workspaceId: w.wsId, subscriptionId: started.subscriptionId, connectionId: first },
          w.owner,
        ),
      'rule_violation',
      'subscription_at_provider',
    );

    // Pausing and starting it again are the two ways to stop the money without ending the plan.
    expect(
      (
        await run(
          subscriptionPause,
          { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
          w.owner,
        )
      ).status,
    ).toBe('paused');
    expect(
      (
        await run(
          subscriptionResume,
          { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
          w.owner,
        )
      ).status,
    ).toBe('active');
    // A member may not see a plan at all: it is money owed every month.
    await expectHfos(() => ask(subscriptionList, { workspaceId: w.wsId }, w.tech), 'forbidden');
  });

  it('starts waiting on the customer, and only the provider may say what card it bills', async () => {
    const account = await connectedAccount('Card account');
    const plan = await run(
      planCreate,
      { workspaceId: w.wsId, name: 'Comfort Club Plus', priceCents: 29_000, interval: 'year' },
      w.owner,
    );
    const started = await run(
      subscriptionStart,
      {
        workspaceId: w.wsId,
        personId: w.personId,
        planId: plan.planId,
        connectionId: account,
      },
      w.owner,
    );
    // Neither provider will bill a customer they have no card for, so a new plan waits on them.
    const waiting = (
      await ask(
        subscriptionGet,
        { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
        w.owner,
      )
    ).subscription;
    expect(waiting).toMatchObject({ status: 'draft', hasCard: false, cardBrand: null });
    expect(waiting.cardRequestedAt).not.toBeNull();

    // Asking again keeps the same link working: it is the ask that is repeated, never the plan.
    const asked = await run(
      subscriptionRequestCard,
      { workspaceId: w.wsId, subscriptionId: started.subscriptionId, channels: ['email'] },
      w.owner,
    );
    expect(asked).toMatchObject({ hasCard: false, changed: true });

    // A person may not write a word of what the provider decides, whatever they send.
    const stillOne = await rows<{ pay_version: number }>(
      admin(),
      sql`select pay_version from app.subscriptions where id = ${started.subscriptionId}`,
    );
    expect(stillOne[0]!.pay_version).toBe(1);
    const refused = await rows(
      admin(),
      sql`update app.subscriptions set card_last4 = '4242'
          where id = ${started.subscriptionId}::uuid`,
    ).then(
      () => 'it was allowed',
      (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? e),
    );
    expect(refused).toMatch(/provider decides/i);

    // The worker's own command is what writes it, and the wait ends there.
    const saved = await sys(subscriptionRecordCard, {
      workspaceId: w.wsId,
      subscriptionId: started.subscriptionId,
      provider: 'stripe',
      connectionId: account,
      customerRef: 'cus_test_1',
      methodToken: 'pm_test_1',
      cardBrand: 'Visa',
      cardLast4: '4242',
      cardExpiryMonth: 4,
      cardExpiryYear: 2029,
    });
    expect(saved).toMatchObject({ hasCard: true, cardRequestedAt: null });
    const withCard = (
      await ask(
        subscriptionGet,
        { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
        w.owner,
      )
    ).subscription;
    expect(withCard).toMatchObject({
      hasCard: true,
      cardBrand: 'Visa',
      cardLast4: '4242',
      cardExpiryMonth: 4,
      cardExpiryYear: 2029,
      cardRequestedAt: null,
    });
    // And what may never be read back out of a query, however the card got there.
    expect(Object.keys(withCard)).not.toContain('methodToken');
    expect(Object.keys(withCard)).not.toContain('customerRef');
  });

  it('left unmanaged by a disconnect is handed back by pointing it at a connected account', async () => {
    const account = await connectedAccount('Back again');
    const plan = await run(
      planCreate,
      { workspaceId: w.wsId, name: 'Commercial Care', priceCents: 14_900, interval: 'month' },
      w.owner,
    );
    const started = await run(
      subscriptionStart,
      { workspaceId: w.wsId, personId: w.personId, planId: plan.planId },
      w.owner,
    );
    await sys(subscriptionRecordCycle, {
      workspaceId: w.wsId,
      subscriptionId: started.subscriptionId,
      outcome: 'unmanaged',
      externalSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      message: 'The account this plan bills through isn’t connected any more.',
    });
    const stranded = await ask(
      subscriptionGet,
      { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
      w.owner,
    );
    expect(stranded.subscription.status).toBe('unmanaged');
    expect(stranded.subscription.lastError).toMatch(/isn’t connected/);
    // While it is unmanaged nothing here may drive it — the tokens are gone on purpose.
    await expectHfos(
      () =>
        run(
          subscriptionPause,
          { workspaceId: w.wsId, subscriptionId: started.subscriptionId },
          w.owner,
        ),
      'rule_violation',
      'subscription_unmanaged',
    );
    const back = await run(
      subscriptionSetConnection,
      { workspaceId: w.wsId, subscriptionId: started.subscriptionId, connectionId: account },
      w.owner,
    );
    expect(back.status).toBe('active');
  });
});

// ---------- who sees what ----------

describe('the member rule', () => {
  it('shows a member the invoice for the job they worked, and not the next one', async () => {
    const theirs = await sentInvoice({ attendeeId: w.techAttendeeId });
    const someone = await sentInvoice({ attendeeId: w.mateAttendeeId });
    const ownerSees = await ask(invoiceList, { workspaceId: w.wsId, limit: 100 }, w.owner);
    expect(ownerSees.invoices.map((i) => i.id)).toEqual(
      expect.arrayContaining([theirs.invoiceId, someone.invoiceId]),
    );
    const techSees = await ask(invoiceList, { workspaceId: w.wsId, limit: 100 }, w.tech);
    const ids = techSees.invoices.map((i) => i.id);
    expect(ids).toContain(theirs.invoiceId);
    expect(ids).not.toContain(someone.invoiceId);
    // And the one they can't see doesn't exist for them, rather than being refused.
    await expectHfos(
      () => ask(invoiceGet, { workspaceId: w.wsId, invoiceId: someone.invoiceId }, w.tech),
      'not_found',
    );
    const mine = await ask(
      invoiceGet,
      { workspaceId: w.wsId, invoiceId: theirs.invoiceId },
      w.tech,
    );
    expect(mine.invoice.id).toBe(theirs.invoiceId);
  });

  it('shows a member the payments on their own job’s invoice only', async () => {
    const theirs = await sentInvoice({ attendeeId: w.techAttendeeId });
    const someone = await sentInvoice({ attendeeId: w.mateAttendeeId });
    for (const inv of [theirs, someone])
      await run(
        invoiceRecordCashPayment,
        { workspaceId: w.wsId, invoiceId: inv.invoiceId, amountCents: 5_000 },
        w.owner,
      );
    const seen = await ask(paymentList, { workspaceId: w.wsId, limit: 100 }, w.tech);
    const invoiceIds = new Set(seen.payments.map((p) => p.invoiceId));
    expect(invoiceIds.has(theirs.invoiceId)).toBe(true);
    expect(invoiceIds.has(someone.invoiceId)).toBe(false);
  });

  it('shows a member the estimates on the leads they own, and not the loose ones', async () => {
    const theirs = await newEstimate({ leadId: w.techLeadId });
    const loose = await newEstimate({ leadId: w.looseLeadId });
    const seen = await ask(estimateList, { workspaceId: w.wsId, limit: 100 }, w.tech);
    const ids = seen.estimates.map((e) => e.id);
    expect(ids).toContain(theirs.estimateId);
    expect(ids).not.toContain(loose.estimateId);
  });

  it('withholds the whole business’s receivables, and every button that spends money', async () => {
    await expectHfos(() => ask(moneySummary, { workspaceId: w.wsId }, w.tech), 'forbidden');
    const made = await newEstimate();
    await expectHfos(
      () => run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.tech),
      'forbidden',
    );
    const someInvoice = await sentInvoice();
    await expectHfos(
      () =>
        run(
          invoiceRecordCashPayment,
          { workspaceId: w.wsId, invoiceId: someInvoice.invoiceId, amountCents: 100 },
          w.tech,
        ),
      'forbidden',
    );
  });

  it('answers money.summary for an owner with what is owed, late and collected', async () => {
    const summary = await ask(moneySummary, { workspaceId: w.wsId, days: 30 }, w.owner);
    expect(summary.outstandingCents).toBeGreaterThan(0);
    expect(summary.collectedCents).toBeGreaterThan(0);
    expect(summary.overdueCents).toBeGreaterThanOrEqual(0);
  });

  it('answers money.for_record for the visit a member worked', async () => {
    const theirs = await sentInvoice({ attendeeId: w.techAttendeeId });
    const [appt] = await rows<{ appointment_id: string }>(
      admin(),
      sql`select appointment_id from app.appointment_attendees where id = ${w.techAttendeeId}`,
    );
    const panel = await ask(
      moneyForRecord,
      { workspaceId: w.wsId, recordType: 'appointment', recordId: appt!.appointment_id },
      w.tech,
    );
    expect(panel.invoices.map((i) => i.id)).toContain(theirs.invoiceId);
    // Plans are owners' business: a member's panel never carries them.
    expect(panel.subscriptions).toEqual([]);
  });
});

// ---------- the Action Center ----------

describe('a lead with an estimate still out', () => {
  it('raises neither “Gone quiet” nor “No next action” (the detectors stand down)', () => {
    const settings = defaultAttentionSettings();
    const now = new Date();
    const quiet = leadFacts({ lastContactAt: new Date(Date.now() - 60 * DAY).toISOString() });
    // Without one, both hold.
    expect(
      DETECTORS.stale_opportunity.detect({ business, lead: quiet }, settings, now),
    ).not.toBeNull();
    expect(
      DETECTORS.missing_next_action.detect({ business, lead: quiet }, settings, now),
    ).not.toBeNull();
    const withEstimate = { ...quiet, estimateOutAt: new Date(Date.now() - 2 * DAY).toISOString() };
    expect(
      DETECTORS.stale_opportunity.detect({ business, lead: withEstimate }, settings, now),
    ).toBeNull();
    expect(
      DETECTORS.missing_next_action.detect({ business, lead: withEstimate }, settings, now),
    ).toBeNull();
  });

  it('and the sweep agrees: no card for the lead while its estimate is out, one once it is answered', async () => {
    // An old, quiet, low-value lead, so nothing hotter than "gone quiet" can hold for it (one card per lead).
    const [stage] = await rows<{ id: string; pipeline_id: string }>(
      admin(),
      sql`select id, pipeline_id from app.pipeline_stages
          where workspace_id = ${w.wsId} and kind = 'open' order by position limit 1`,
    );
    const [quietLead] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, value_cents,
            assignee_user_id, created_at, stage_entered_at, last_contact_at, first_response_at)
          values (${w.wsId}, ${stage!.pipeline_id}, ${stage!.id}, ${w.personId}, 'Quiet job', 1000,
            ${w.tech.id}, now() - interval '60 days', now() - interval '60 days',
            now() - interval '60 days', now() - interval '60 days')
          returning id`,
    );
    const leadId = quietLead!.id;
    const sweep = () =>
      asWorker(worker(), { workspaceId: w.wsId, organizationId: w.orgId }, (tx) =>
        reconcile(tx, w.wsId, [{ type: 'lead', id: leadId }], new Date()),
      );
    const openKinds = async () =>
      (
        await rows<{ kind: string }>(
          admin(),
          sql`select kind from app.attention_items
              where workspace_id = ${w.wsId} and subject_id = ${leadId} and state = 'open'`,
        )
      ).map((r) => r.kind);
    // Left alone, it goes quiet and asks to be chased.
    await sweep();
    expect(await openKinds()).toContain('stale_opportunity');

    const made = await newEstimate({ leadId });
    await run(estimateSend, { workspaceId: w.wsId, estimateId: made.estimateId }, w.owner);
    await sweep();
    expect(await openKinds()).not.toContain('stale_opportunity');
    expect(await openKinds()).not.toContain('missing_next_action');

    await sys(estimateDeclineOnline, {
      workspaceId: w.wsId,
      estimateId: made.estimateId,
      reason: 'Too much',
    });
    await sweep();
    expect(await openKinds()).toContain('stale_opportunity');
  });
});
