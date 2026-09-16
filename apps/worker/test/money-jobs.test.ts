/**
 * The money jobs on the real database (M9 step 6), with the fake carrier, Mailpit and the stand-in provider:
 * the reminder ladder armed when an invoice goes out and stopped the moment it is paid, nothing sent while a
 * bank transfer settles, an invoice marked overdue at the right local moment and not a day early, a refunded
 * invoice left alone for good, an estimate expiring and its one nudge, a plan's cycle read back when no webhook
 * arrived, quiet hours holding a text, a retry sending once, and the hourly sweep putting back a job that was
 * lost.
 *
 * The provider's webhooks are pointed at nothing here on purpose: these tests are about what the worker does
 * on its own time, and money-webhooks.test.ts is about what it does when the provider speaks.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  executeCommand,
  invoiceRecordCashPayment,
  invoiceRecordPayment,
  localDateOf,
  moneySaveSettings,
  overdueFrom,
  paymentRefund,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  estimateExpireKey,
  estimateMessageKey,
  invoiceMessageKey,
  invoiceOverdueKey,
  moneySweepKey,
  subscriptionCycleKey,
  ESTIMATE_NUDGE_KEY,
  MONEY_JOBS,
} from '../src/money/jobs';
import { accountByExternalId } from '../src/payments/index';
import { FAKE_CARDS } from '../src/payments/fake';
import { systemActor } from '../src/services';
import {
  at,
  CHI,
  drain,
  hh,
  hourNow,
  jobRow,
  readyTexting,
  runDue,
  setQuietHours,
  textsTo,
  waitForMail,
} from './booking-world';
import { admin, moneyWorld, run, sentEstimate, sentInvoice, type MoneyWorld } from './money-world';

let w: MoneyWorld;
let customerEmail: string;

const DAY = 86_400_000;
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const scopeOf = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });
const today = () => localDateOf(Date.now(), CHI);
const texts = () => textsTo(w, w.person.phone).map((t) => t.body);

/** When the job with this key is waiting to run. */
const runAt = async (key: string): Promise<number> => {
  const job = await jobRow(key);
  expect(job, `no job waiting for ${key}`).toBeTruthy();
  return new Date(job!.run_at).getTime();
};

/** What each rung of an invoice's ladder has come to (`invoices.reminder_state`). */
async function rungs(
  invoiceId: string,
): Promise<Record<string, { status: string; channel: string | null; reason: string | null }>> {
  const [row] = await rows<{
    reminder_state: { reminders?: Record<string, never> } | null;
  }>(admin(), sql`select reminder_state from app.invoices where id = ${invoiceId}`);
  return (row?.reminder_state?.reminders ?? {}) as never;
}

const invoiceStatusOf = async (invoiceId: string): Promise<string> => {
  const [row] = await rows<{ status: string }>(
    admin(),
    sql`select status::text as status from app.invoices where id = ${invoiceId}`,
  );
  return row!.status;
};

const estimateStatusOf = async (estimateId: string): Promise<string> => {
  const [row] = await rows<{ status: string }>(
    admin(),
    sql`select status::text as status from app.estimates where id = ${estimateId}`,
  );
  return row!.status;
};

/** Puts a job back for now, the way the hourly sweep would, then runs the business's work. */
async function armAndRun(kind: string, dedupeKey: string, payload: object): Promise<void> {
  await rows(
    admin(),
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${w.organizationId}, ${w.workspaceId}, ${kind}, ${dedupeKey}, now(),
          ${JSON.stringify(payload)}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null
        do update set run_at = now()`,
  );
  await drain(w);
}

beforeAll(async () => {
  w = await moneyWorld('mjob');
  await readyTexting(w);
  await setQuietHours(w, null);
  // These tests are about the worker's own clock, never the provider's webhooks.
  w.s.payments.fake.setDeliver(async () => ({ ok: false }));
  const [person] = await rows<{ email: string }>(
    admin(),
    sql`select email::text as email from app.people where id = ${w.person.id}`,
  );
  customerEmail = person!.email;
  // One rung before the due day, one on it, one after, and a nudge two days after an estimate goes out.
  await run(w, moneySaveSettings, {
    workspaceId: w.workspaceId,
    settings: {
      terms: 'net_14',
      estimateGoodForDays: 30,
      reminders: {
        beforeDueDays: [3],
        onDue: true,
        afterDueDays: [7],
        estimateAfterDays: 2,
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

describe('an invoice and its reminder ladder', () => {
  it('goes out, arms every rung at nine in the morning, and stops the moment it is paid', async () => {
    const dueOn = addDays(today(), 10);
    const invoice = await sentInvoice(w, { dueOn });
    const keys = {
      sent: invoiceMessageKey(invoice.id, 'sent'),
      before: invoiceMessageKey(invoice.id, 'before_3'),
      on: invoiceMessageKey(invoice.id, 'on_due'),
      after: invoiceMessageKey(invoice.id, 'after_7'),
    };

    // The invoice's own message went at once, with the customer's own link on it.
    expect(texts().at(-1)).toContain(`Invoice ${invoice.number} for an AC tune-up is ready, $180.`);
    // Their own signed link, and the STOP wording because this is the first text to the number.
    expect(texts().at(-1)).toMatch(
      /Pay it here: http:\/\/localhost:3000\/i\/[0-9A-Za-z]{18} Reply STOP to opt out\.$/,
    );
    expect((await rungs(invoice.id))['sent']).toMatchObject({ status: 'sent', channel: 'sms' });

    // Every rung is waiting at nine where the business is, on its own day.
    expect(await runAt(keys.before)).toBe(at(7, '09:00'));
    expect(await runAt(keys.on)).toBe(at(10, '09:00'));
    expect(await runAt(keys.after)).toBe(at(17, '09:00'));

    // The one before the due day goes; the ones after it are still waiting.
    await runDue(w, [keys.before]);
    expect(texts().at(-1)).toContain(`A reminder that invoice ${invoice.number} for $180 is due `);
    expect((await rungs(invoice.id))['before_3']).toMatchObject({
      status: 'sent',
      channel: 'sms',
    });

    // Paid in full. The receipt goes, and every rung left records why it didn't.
    await run(w, invoiceRecordCashPayment, {
      workspaceId: w.workspaceId,
      invoiceId: invoice.id,
      amountCents: invoice.totalCents,
      method: 'cash',
    });
    await drain(w);
    expect(texts().at(-1)).toContain(
      `Thanks, Maria. We got your $180 payment for invoice ${invoice.number}.`,
    );
    const sent = texts().length;
    await runDue(w, [keys.on, keys.after]);
    expect(texts()).toHaveLength(sent);
    const state = await rungs(invoice.id);
    expect(state['on_due']).toMatchObject({ status: 'skipped', reason: 'paid' });
    expect(state['after_7']).toMatchObject({ status: 'skipped', reason: 'paid' });
  }, 120_000);

  it('sends one message however many times the same job runs', async () => {
    const invoice = await sentInvoice(w, { dueOn: addDays(today(), 10) });
    const key = invoiceMessageKey(invoice.id, 'sent');
    const sent = texts().length;
    // A retry: the job row again, twice, exactly as an exhausted worker would leave it.
    for (const _ of [1, 2])
      await armAndRun(MONEY_JOBS.invoiceMessage, key, { invoiceId: invoice.id, key: 'sent' });
    expect(texts()).toHaveLength(sent);
    // And again with the record lost, so only the message's own client id can stop it.
    await rows(
      admin(),
      sql`update app.invoices set reminder_state = '{}'::jsonb where id = ${invoice.id}`,
    );
    await armAndRun(MONEY_JOBS.invoiceMessage, key, { invoiceId: invoice.id, key: 'sent' });
    expect(texts()).toHaveLength(sent);
  }, 120_000);

  it('says nothing while a bank transfer is settling, and looks again tomorrow', async () => {
    // Due days ahead, and each job run as of its own moment: an invoice due today has its on-the-day rung sent
    // the moment it goes out whenever the test runs after nine, before the transfer is ever on its way.
    const dueOn = addDays(today(), 10);
    const invoice = await sentInvoice(w, { dueOn });
    await executeCommand(
      w.s.db,
      invoiceRecordPayment,
      {
        workspaceId: w.workspaceId,
        invoiceId: invoice.id,
        amountCents: invoice.totalCents,
        method: 'ach' as const,
        provider: 'stripe' as const,
        connectionId: w.stripe.connectionId,
        providerPaymentId: `pi_settling_${randomUUID().slice(0, 8)}`,
        status: 'processing' as const,
      },
      systemActor(scopeOf()),
      meta(),
    );
    await drain(w);

    const key = invoiceMessageKey(invoice.id, 'on_due');
    const sent = texts().length;
    await runDue(w, [key]);
    expect(texts()).toHaveLength(sent);
    expect((await rungs(invoice.id))['on_due']).toMatchObject({
      status: 'scheduled',
      reason: 'settling',
    });
    // It waits about a day rather than giving up: the transfer lands or comes back, and then it knows.
    expect(await runAt(key)).toBeGreaterThan(Date.now() + 20 * 3_600_000);

    // And it is not late either: an invoice being paid is not an invoice nobody paid.
    await runDue(w, [invoiceOverdueKey(invoice.id)]);
    expect(await invoiceStatusOf(invoice.id)).toBe('sent');
  }, 120_000);
});

describe('marking an invoice overdue', () => {
  it('waits for the due day to be over where the business is, and its grace day after that', async () => {
    const invoice = await sentInvoice(w, { dueOn: today() });
    const key = invoiceOverdueKey(invoice.id);
    // The end of the due day in Houston, plus the one day of grace the Action Center gives it.
    expect(await runAt(key)).toBe(overdueFrom(today(), CHI) + DAY);
    expect(await runAt(key)).toBe(at(2, '00:00'));

    // Run it now, as an impatient worker would: it only waits again, and the invoice is not late.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() where dedupe_key = ${key} and status = 'pending'`,
    );
    await drain(w);
    expect(await invoiceStatusOf(invoice.id)).toBe('sent');
    expect(await runAt(key)).toBe(at(2, '00:00'));
  }, 120_000);

  it('marks one whose day is long past as soon as it is armed', async () => {
    const invoice = await sentInvoice(w, { dueOn: addDays(today(), -5) });
    await drain(w);
    expect(await invoiceStatusOf(invoice.id)).toBe('overdue');
  }, 120_000);

  it('never arms rungs whose moment went by days ago', async () => {
    const invoice = await sentInvoice(w, { dueOn: addDays(today(), -5) });
    await drain(w);
    // Due five days ago: the before-due and on-the-day rungs are long gone and are left alone, and only the
    // one still ahead is waiting. Four texts in one second about one bill would be worse than none.
    expect(await jobRow(invoiceMessageKey(invoice.id, 'before_3'))).toBeUndefined();
    expect(await jobRow(invoiceMessageKey(invoice.id, 'on_due'))).toBeUndefined();
    expect(await runAt(invoiceMessageKey(invoice.id, 'after_7'))).toBe(at(2, '09:00'));
  }, 120_000);
});

describe('an invoice whose money went back', () => {
  /**
   * A refund gives money back and never puts it back on the bill. Before 0053 a refunded invoice reopened, and
   * every one of these jobs went after the customer for the money they had just been given back.
   */
  it('is never reminded, never marked late, and nothing is armed for it again', async () => {
    const invoice = await sentInvoice(w, { dueOn: addDays(today(), 10) });
    const paid = await run(w, invoiceRecordCashPayment, {
      workspaceId: w.workspaceId,
      invoiceId: invoice.id,
      amountCents: invoice.totalCents,
      method: 'cash',
    });
    await drain(w);
    await run(w, paymentRefund, {
      workspaceId: w.workspaceId,
      paymentId: paid.paymentId,
      reason: 'Job called off',
    });
    // Cash goes back by hand, so the worker settles the refund as soon as it is asked for.
    await drain(w);
    const [row] = await rows<{ status: string; balance: number; refunded: number }>(
      admin(),
      sql`select status::text as status, balance_cents::float8 as balance,
            amount_refunded_cents::float8 as refunded
          from app.invoices where id = ${invoice.id}`,
    );
    expect(row).toEqual({ status: 'paid', balance: 0, refunded: invoice.totalCents });

    // Weeks later, as far as the due day is concerned, and every job it ever had put back for now.
    await rows(
      admin(),
      sql`update app.invoices set due_on = ${addDays(today(), -10)}::date where id = ${invoice.id}`,
    );
    const sent = texts().length;
    for (const key of ['before_3', 'on_due', 'after_7'])
      await armAndRun(MONEY_JOBS.invoiceMessage, invoiceMessageKey(invoice.id, key), {
        invoiceId: invoice.id,
        key,
      });
    expect(texts()).toHaveLength(sent);
    const state = await rungs(invoice.id);
    for (const key of ['before_3', 'on_due', 'after_7'])
      expect(state[key], key).toMatchObject({ status: 'skipped', reason: 'paid' });

    await armAndRun(MONEY_JOBS.invoiceOverdue, invoiceOverdueKey(invoice.id), {
      invoiceId: invoice.id,
    });
    expect(await invoiceStatusOf(invoice.id)).toBe('paid');

    // And the hourly sweep, which re-arms whatever should be waiting, finds nothing to wait for.
    await armAndRun(MONEY_JOBS.sweep, moneySweepKey(w.workspaceId), {});
    const waiting = await rows<{ kind: string }>(
      admin(),
      sql`select kind from app.scheduled_jobs
          where workspace_id = ${w.workspaceId} and status = 'pending'
            and payload ->> 'invoiceId' = ${invoice.id}`,
    );
    expect(waiting).toEqual([]);
  }, 120_000);
});

describe('an estimate', () => {
  it('nudges once, two days later, and never again', async () => {
    const estimate = await sentEstimate(w);
    const key = estimateMessageKey(estimate.id, ESTIMATE_NUDGE_KEY);
    expect(texts().at(-1)).toContain('Your estimate for an AC tune-up is ready, $180.');
    expect(await runAt(key)).toBe(at(2, '09:00'));

    await runDue(w, [key]);
    expect(texts().at(-1)).toContain(
      'Just checking you saw your estimate for an AC tune-up, $180.',
    );
    const sent = texts().length;
    // One nudge per estimate: the record of it is what stops a second being armed or sent.
    const [nudged] = await rows(
      admin(),
      sql`select 1 from app.events where entity_type = 'estimate' and entity_id = ${estimate.id}
          and event_type = 'estimate.nudged'`,
    );
    expect(nudged).toBeTruthy();
    await armAndRun(MONEY_JOBS.estimateMessage, key, {
      estimateId: estimate.id,
      key: ESTIMATE_NUDGE_KEY,
    });
    expect(texts()).toHaveLength(sent);
  }, 120_000);

  it('stops being good on its own day, and is never chased after that', async () => {
    const estimate = await sentEstimate(w, { expiresOn: addDays(today(), 3) });
    expect(await runAt(estimateExpireKey(estimate.id))).toBe(at(4, '00:00'));

    // Its day passed while nobody answered.
    await rows(
      admin(),
      sql`update app.estimates set expires_on = ${addDays(today(), -1)}::date where id = ${estimate.id}`,
    );
    await runDue(w, [estimateExpireKey(estimate.id)]);
    expect(await estimateStatusOf(estimate.id)).toBe('expired');

    // An expired estimate gets no nudge: a business reissues it rather than chasing it.
    const sent = texts().length;
    await armAndRun(
      MONEY_JOBS.estimateMessage,
      estimateMessageKey(estimate.id, ESTIMATE_NUDGE_KEY),
      {
        estimateId: estimate.id,
        key: ESTIMATE_NUDGE_KEY,
      },
    );
    expect(texts()).toHaveLength(sent);
  }, 120_000);
});

describe('a maintenance plan', () => {
  /** A plan billing at the stand-in, with our own mirror row beside it. */
  async function makePlan(card: string): Promise<{ id: string; providerId: string }> {
    const found = await accountByExternalId(
      w.s.db,
      scopeOf(),
      { provider: 'stripe', externalAccountId: w.stripe.accountId },
      w.s.sealer,
    );
    const p = w.s.payments.providers.stripe;
    const account = found!.account;
    const { customerRef } = await p.ensureCustomer(account, {
      customerRef: null,
      name: 'Maria Lopez',
      email: customerEmail,
      phone: null,
      idempotencyKey: randomUUID(),
    });
    const saved = await p.saveMethod(account, {
      customerRef,
      sourceToken: w.s.payments.fake.page.tokenise({ instrument: card, method: 'card' }),
      idempotencyKey: randomUUID(),
    });
    const plan = await p.subscriptions.create(account, {
      customerRef,
      methodToken: saved.token,
      amountCents: 2_900,
      interval: 'month',
      intervalCount: 1,
      name: 'Maintenance plan',
      startAt: null,
      idempotencyKey: randomUUID(),
      metadata: {},
    });
    const day = (iso: string | null) => (iso ?? new Date().toISOString()).slice(0, 10);
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.subscriptions (workspace_id, public_ref, plan_name, price_cents, person_id,
            connection_id, provider, external_subscription_id, status, started_on,
            current_period_start, current_period_end, next_billing_on)
          values (${w.workspaceId}, private.new_public_ref(), 'Maintenance plan', 2900,
            ${w.person.id}, ${w.stripe.connectionId}, 'stripe', ${plan.providerSubscriptionId},
            'active', ${day(plan.currentPeriodStart)}::date, ${day(plan.currentPeriodStart)}::date,
            ${day(plan.currentPeriodEnd)}::date, ${day(plan.currentPeriodEnd)}::date)
          returning id`,
    );
    return { id: row!.id, providerId: plan.providerSubscriptionId };
  }

  const planRow = async (id: string) => {
    const [row] = await rows<{
      status: string;
      failed_cycles: number;
      last_error: string | null;
      current_period_start: string | null;
      next_billing_on: string | null;
    }>(
      admin(),
      sql`select status::text as status, failed_cycles, last_error,
            current_period_start::text as current_period_start,
            next_billing_on::text as next_billing_on
          from app.subscriptions where id = ${id}`,
    );
    return row!;
  };

  it('records a cycle the provider billed when no webhook ever arrived', async () => {
    const plan = await makePlan(FAKE_CARDS.succeeds);
    const before = await planRow(plan.id);
    expect(await w.s.payments.fake.cycle(plan.providerId)).toMatchObject({ status: 'succeeded' });

    await armAndRun(MONEY_JOBS.subscriptionCycle, subscriptionCycleKey(plan.id), {
      subscriptionId: plan.id,
    });
    const after = await planRow(plan.id);
    expect(after.status).toBe('active');
    expect(after.current_period_start! > before.current_period_start!).toBe(true);
    expect(after.next_billing_on).not.toBe(before.next_billing_on);
    const [billed] = await rows(
      admin(),
      sql`select 1 from app.events where entity_type = 'subscription' and entity_id = ${plan.id}
          and event_type = 'subscription.billed'`,
    );
    expect(billed).toBeTruthy();
  }, 120_000);

  it('puts a plan past due when the card is refused, and says so in plain words', async () => {
    const plan = await makePlan(FAKE_CARDS.failsOffSession);
    expect(await w.s.payments.fake.cycle(plan.providerId)).toMatchObject({ status: 'failed' });

    await armAndRun(MONEY_JOBS.subscriptionCycle, subscriptionCycleKey(plan.id), {
      subscriptionId: plan.id,
    });
    const after = await planRow(plan.id);
    expect(after.status).toBe('past_due');
    expect(after.failed_cycles).toBe(1);
    expect(after.last_error).toBe('The card on this plan was refused when the provider billed it.');
  }, 120_000);
});

describe('quiet hours, and the hourly sweep behind everything', () => {
  it('holds a text until quiet hours end rather than sending it at one in the morning', async () => {
    const now = hourNow();
    await setQuietHours(w, { start: hh(now - 1), end: hh(now + 2) });
    try {
      const sent = texts().length;
      const invoice = await sentInvoice(w, { dueOn: addDays(today(), 10) });
      const key = invoiceMessageKey(invoice.id, 'sent');
      expect(texts()).toHaveLength(sent);
      expect((await rungs(invoice.id))['sent']).toMatchObject({
        status: 'scheduled',
        channel: 'sms',
        reason: 'quiet_hours',
      });
      // It waits for the end of quiet hours, and goes then.
      expect(await runAt(key)).toBeGreaterThan(Date.now());
      await setQuietHours(w, null);
      await runDue(w, [key]);
      expect(texts().at(-1)).toContain(
        `Invoice ${invoice.number} for an AC tune-up is ready, $180.`,
      );
    } finally {
      await setQuietHours(w, null);
    }
  }, 120_000);

  it('puts back a rung whose job was lost', async () => {
    const invoice = await sentInvoice(w, { dueOn: addDays(today(), 10) });
    const key = invoiceMessageKey(invoice.id, 'after_7');
    expect(await runAt(key)).toBe(at(17, '09:00'));
    await rows(admin(), sql`delete from app.scheduled_jobs where dedupe_key = ${key}`);
    expect(await jobRow(key)).toBeUndefined();

    await armAndRun(MONEY_JOBS.sweep, moneySweepKey(w.workspaceId), {});
    expect(await runAt(key)).toBe(at(17, '09:00'));
  }, 120_000);
});

describe('the team hears about it', () => {
  it('emails whoever can see the money when an invoice is settled', async () => {
    const invoice = await sentInvoice(w, { dueOn: today() });
    await run(w, invoiceRecordCashPayment, {
      workspaceId: w.workspaceId,
      invoiceId: invoice.id,
      amountCents: invoice.totalCents,
      method: 'check',
    });
    await drain(w);
    const mail = await waitForMail(w.owner.email, 'You’ve been paid: Maria Lopez');
    expect(mail.text).toContain(`Maria Lopez paid invoice ${invoice.number} — $180 by check.`);
    expect(mail.text).toContain('Open in HandsFreeOS:');
    // One per invoice, however many times the event is handled again.
    const [marker] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where entity_type = 'invoice'
          and entity_id = ${invoice.id} and event_type = 'invoice.team_emailed'`,
    );
    expect(marker!.n).toBe(1);
  }, 120_000);
});
