/**
 * The two money cards on Home, on the real database (M9 step 12): an invoice past its due day opens one and the
 * money closes it, a part payment re-ranks it rather than leaving a stale figure, a bank transfer settling is
 * never late, and an estimate nobody answered opens after the days the business gave and clears when they
 * answer.
 *
 * All of it happens on the documents' own events — the invoice going out, a payment landing, an estimate being
 * approved. The hourly sweep is the safety net here, not the mechanism, and the one test that runs it checks it
 * writes nothing at all when nothing changed.
 *
 * Reminders are switched off in this business so that nothing is queued for the customer: what a business sends
 * about its own invoices is money-jobs.test.ts's, and a card must never add a message of its own.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  attentionAssign,
  attentionLetHandle,
  attentionPreviewHandle,
  commands,
  estimateMarkAccepted,
  executeCommand,
  executeQuery,
  invoiceRecordCashPayment,
  invoiceRecordPayment,
  localDateOf,
  walletSetAutoTopup,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTENTION_EVENTS } from '../src/attention/index';
import { systemActor } from '../src/services';
import { codes, itemEvents, itemOf, itemsOf, runSweep } from './attention-world';
import { CHI, drain, readyTexting, setQuietHours, textsTo, type World } from './booking-world';
import {
  admin,
  moneyWorld,
  patchMoneySettings,
  run,
  sentEstimate,
  sentInvoice,
  type MoneyWorld,
} from './money-world';

let w: MoneyWorld;
/** Marco, a member: someone to hand a card to. */
let member: TestUser;

const DAY = 86_400_000;
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
/** The world's owner, for the queries this test reads as a person. */
const owner = (): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});
const scopeOf = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });
/** A local day `n` days from today, where the business is. */
const day = (n: number) => addDays(localDateOf(Date.now(), CHI), n);

/** What a provider said about a payment (the worker's own command). */
const recordPayment = (input: Record<string, unknown>) =>
  executeCommand(
    w.s.db,
    invoiceRecordPayment,
    { workspaceId: w.workspaceId, ...input },
    systemActor(scopeOf()),
    meta(),
  ).then((r) => r.output as { paymentId: string; status: string });

/** Everything the Action Center could write for the business (its own sweep job's next run aside). */
async function footprint(x: World) {
  const [counts] = await rows<{ events: number; audits: number; outbox: number }>(
    admin(),
    sql`select
          (select count(*)::int from app.events where workspace_id = ${x.workspaceId}) as events,
          (select count(*)::int from app.audit_logs where workspace_id = ${x.workspaceId}) as audits,
          (select count(*)::int from app.outbox where workspace_id = ${x.workspaceId}) as outbox`,
  );
  const items = await rows(
    admin(),
    sql`select id, state::text as state, updated_at, fingerprint, value_cents::float8 as value_cents
        from app.attention_items where workspace_id = ${x.workspaceId} order by id`,
  );
  const jobs = await rows(
    admin(),
    sql`select id, kind, status::text as status, run_at from app.scheduled_jobs
        where workspace_id = ${x.workspaceId} and kind like 'attention.%'
          and kind <> 'attention.sweep' order by id`,
  );
  return { counts, items, jobs };
}

beforeAll(async () => {
  w = await moneyWorld('mattn');
  // A follow-up is a real text to a real number here, so the business can text and nothing is quiet.
  await readyTexting(w);
  await setQuietHours(w, null);
  member = await createTestUser('mattn-marco', { fullName: 'Marco Member' });
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  // Nothing goes to the customer in this test: the ladder a business agreed to has its own tests, and a card
  // must never duplicate one.
  await patchMoneySettings(w, {
    reminders: { beforeDueDays: [], onDue: false, afterDueDays: [], estimateAfterDays: null },
  });
  w.s.payments.fake.setDeliver(async () => ({ ok: false }));
  // A new business's $5 starting credit sits under the $10 floor, which a sweep reads as a balance running low:
  // the floor goes under it, so the sweep's only cards are the money's.
  await run(w, walletSetAutoTopup, { workspaceId: w.workspaceId, floorCents: 0 });
}, 180_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('the events the money cards listen to', () => {
  it('covers every estimate, invoice and payment event a command emits that can change one', () => {
    const about = /^(estimate|invoice)\.|^payment\.(recorded|updated|failed)$|^refund\.recorded$/;
    const emitted = new Set(commands.flatMap((c) => c.emits).filter((t) => about.test(t)));
    expect([...emitted].filter((t) => !ATTENTION_EVENTS.includes(t))).toEqual([]);
    expect(ATTENTION_EVENTS).toEqual(
      expect.arrayContaining([
        'estimate.sent',
        'estimate.viewed',
        'estimate.accepted',
        'estimate.declined',
        'estimate.expired',
        'estimate.voided',
        'invoice.sent',
        'invoice.paid',
        'invoice.overdue',
        'invoice.voided',
        'payment.recorded',
        'payment.updated',
        'payment.failed',
      ]),
    );
  });
});

describe('an invoice nobody paid', () => {
  it('opens from the invoice’s own events, and the money closes it, with no sweep', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-3), title: 'Ductwork repair' });
    await drain(w);

    const card = await itemOf(w, invoice.id, 'invoice_overdue');
    expect(card).toMatchObject({
      state: 'open',
      subjectType: 'invoice',
      personId: w.person.id,
      moneyKey: `invoice:${invoice.id}`,
      valueIsEstimate: false,
      urgentFrom: null,
    });
    expect(Number(card.valueCents)).toBe(invoice.totalCents);
    // The card says who it is about, what it is for and which invoice, and what the document says.
    expect(card.title).toBe(`Maria Lopez · Ductwork repair · ${invoice.number}`);
    expect(card.detail).toMatch(/^Sent \w{3}, \w{3} \d{1,2} · due \w{3}, \w{3} \d{1,2}$/);
    expect(codes(card)).toEqual(['amount', 'overdue', 'not_viewed']);
    // The document's own events opened it: nothing here has run a sweep.
    expect(await itemEvents(card.id)).toEqual(['opened']);

    // The money arrives. The invoice pays itself off and the card goes with it.
    await run(w, invoiceRecordCashPayment, {
      workspaceId: w.workspaceId,
      invoiceId: invoice.id,
      amountCents: invoice.totalCents,
      method: 'check' as const,
    });
    await drain(w);
    expect(await itemOf(w, invoice.id, 'invoice_overdue')).toMatchObject({
      state: 'resolved',
      resolution: 'paid',
    });
    expect(await itemEvents(card.id)).toEqual(['opened', 'resolved']);
  });

  it('re-ranks on a part payment instead of leaving a stale figure', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-2), title: 'Coil clean' });
    await drain(w);
    const before = await itemOf(w, invoice.id, 'invoice_overdue');
    expect(Number(before.valueCents)).toBe(invoice.totalCents);

    // Half of it lands. The card stays — there is still money owed — and says the smaller number.
    const half = Math.round(invoice.totalCents / 2);
    await run(w, invoiceRecordCashPayment, {
      workspaceId: w.workspaceId,
      invoiceId: invoice.id,
      amountCents: half,
      method: 'cash' as const,
    });
    await drain(w);
    const after = await itemOf(w, invoice.id, 'invoice_overdue');
    expect(after.state).toBe('open');
    expect(Number(after.valueCents)).toBe(invoice.totalCents - half);
    // New facts, so a card someone had dismissed would come back on its own.
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect((after.reasons as { label: string }[])[0]!.label).toContain('owed');
    // Re-ranking is a quiet refresh: nothing about it is worth an event.
    expect(await itemEvents(after.id)).toEqual(['opened']);
  });

  it('is never late while a bank transfer is settling, and comes back when it fails', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-4), title: 'Rooftop unit' });
    await drain(w);
    const card = await itemOf(w, invoice.id, 'invoice_overdue');
    expect(card.state).toBe('open');

    // A bank transfer is on its way: days in `processing`, and chasing someone who has paid is worse than
    // waiting.
    const payment = await recordPayment({
      invoiceId: invoice.id,
      amountCents: invoice.totalCents,
      method: 'ach',
      provider: 'stripe',
      connectionId: w.stripe.connectionId,
      providerPaymentId: `pi_settling_${randomUUID().slice(0, 8)}`,
      status: 'processing',
    });
    await drain(w);
    expect(await itemOf(w, invoice.id, 'invoice_overdue')).toMatchObject({
      state: 'resolved',
      resolution: 'settling',
    });

    // Their bank refuses it days later. Nothing was paid after all, so the card comes back.
    await recordPayment({
      invoiceId: invoice.id,
      paymentId: payment.paymentId,
      amountCents: invoice.totalCents,
      method: 'ach',
      provider: 'stripe',
      connectionId: w.stripe.connectionId,
      status: 'failed',
      failureCode: 'account_closed',
    });
    await drain(w);
    expect(await itemOf(w, invoice.id, 'invoice_overdue')).toMatchObject({ state: 'open' });
    expect(await itemEvents(card.id)).toEqual(['opened', 'reopened', 'resolved']);
  });

  it('keeps the card with whoever was given it, and leaves the invoice alone', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-2), title: 'Compressor swap' });
    await drain(w);
    const card = await itemOf(w, invoice.id, 'invoice_overdue');
    // It starts with whoever the invoice is for; Marco is asked to chase this one.
    expect(card.assigneeUserId).toBe(w.owner.id);
    const out = await run(w, attentionAssign, {
      workspaceId: w.workspaceId,
      itemId: card.id,
      assigneeUserId: member.id,
    });
    // Assigning a money card moves who follows it up, and nothing about the document itself.
    expect(out).toMatchObject({ passedTo: null, assigneeUserId: member.id });
    await drain(w);
    await runSweep(w);
    expect((await itemOf(w, invoice.id, 'invoice_overdue')).assigneeUserId).toBe(member.id);
    const [row] = await rows<{ assignee_user_id: string | null }>(
      admin(),
      sql`select assignee_user_id from app.invoices where id = ${invoice.id}`,
    );
    expect(row!.assignee_user_id).toBe(w.owner.id);
  });

  it('leaves the Action Center alone when the sweep finds nothing new', async () => {
    const before = await footprint(w);
    await runSweep(w, Date.now() + 60_000);
    expect(await footprint(w)).toEqual(before);
  });
});

/**
 * Handling one: HandsFreeOS writes the follow-up from the document's own figures and a person sends it. The
 * guard that matters is the business's own reminder ladder — it is already writing to this customer about this
 * invoice, and two messages an hour apart about the same bill is what makes a business look broken.
 */
describe('following a money card up', () => {
  /** Puts an invoice's own send back in time, rung and all, the way a week-old invoice really reads. */
  const sentDaysAgo = (invoiceId: string, days: number) =>
    rows(
      admin(),
      sql`update app.invoices
          set sent_at = now() - ${`${days} days`}::interval,
            reminder_state = ${JSON.stringify({
              reminders: {
                sent: {
                  status: 'sent',
                  channel: 'email',
                  at: new Date(Date.now() - days * DAY).toISOString(),
                },
              },
            })}::jsonb
          where id = ${invoiceId}`,
    );

  const previewOf = (itemId: string) =>
    executeQuery(
      w.s.db,
      attentionPreviewHandle,
      { workspaceId: w.workspaceId, itemId },
      owner(),
      meta(),
    ) as Promise<{
      mode: string;
      options: {
        action: string;
        available: boolean;
        channel: string | null;
        reason: string | null;
        note: string | null;
        draft: { body: string; subject: string | null } | null;
      }[];
    }>;

  it('writes the message itself, and offers nothing but sending it', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-5), title: 'Ductwork repair' });
    await drain(w);
    const card = await itemOf(w, invoice.id, 'invoice_overdue');

    // The invoice itself went out moments ago in this test, and that counts: writing to someone an hour after
    // their invoice landed is the same mistake as two reminders an hour apart.
    const fresh = (await previewOf(card.id)).options[0]!;
    expect(fresh.available).toBe(false);
    expect(fresh.reason).toMatch(/^The invoice itself went out by (text|email) just now\./);
    expect(fresh.reason).toContain('two messages about the same bill');

    // As it would really stand: sent over a week ago, due five days back, nothing since.
    await sentDaysAgo(invoice.id, 8);

    const preview = await previewOf(card.id);
    expect(preview.mode).toBe('ask');
    // One choice, and the AI teammate is not among them: an AI that talks to a customer about a bill is a
    // different conversation.
    expect(preview.options.map((o) => o.action)).toEqual(['reply']);
    const reply = preview.options[0]!;
    expect(reply.available).toBe(true);
    expect(reply.channel).toBe('sms');
    expect(reply.draft?.body).toContain(`invoice ${invoice.number}`);
    expect(reply.draft?.body).toContain('$180');
    expect(reply.draft?.body).toContain("it's Dale at");
    expect(reply.draft?.body).toContain('The payment link we sent still works.');
    // It still says what the customer has already had about this invoice, so nobody writes over it blind.
    expect(reply.note).toMatch(/^The invoice itself went out by email on \w{3}, \w{3} \d{1,2}\.$/);
  });

  it('holds the send for a day after the business’s own reminder, and says so', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-9), title: 'Compressor swap' });
    await drain(w);
    const card = await itemOf(w, invoice.id, 'invoice_overdue');
    // The ladder texted them three hours ago, exactly as `recordRung` writes it.
    await rows(
      admin(),
      sql`update app.invoices set reminder_state = ${JSON.stringify({
        reminders: {
          after_3: {
            status: 'sent',
            channel: 'sms',
            at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          },
          after_7: { status: 'skipped', channel: null, at: new Date().toISOString() },
        },
      })}::jsonb where id = ${invoice.id}`,
    );

    const reply = (await previewOf(card.id)).options[0]!;
    expect(reply.available).toBe(false);
    expect(reply.reason).toContain('went out by text 3 hours ago');
    expect(reply.reason).toContain('Give it a day before you follow up');
    expect(reply.reason).toContain('two messages about the same bill');
  });

  it('sends as the person, marks the card handled, and brings it back in a week', async () => {
    const invoice = await sentInvoice(w, { dueOn: day(-6), title: 'Filter replacement' });
    await drain(w);
    await sentDaysAgo(invoice.id, 9);
    const card = await itemOf(w, invoice.id, 'invoice_overdue');
    const reply = (await previewOf(card.id)).options[0]!;
    expect(reply.available).toBe(true);

    await run(w, attentionLetHandle, {
      workspaceId: w.workspaceId,
      itemId: card.id,
      action: 'reply' as const,
      body: reply.draft!.body,
      channel: 'sms' as const,
    });
    await drain(w);
    // It went out in Dale's own name, to Maria's number.
    expect(textsTo(w, w.person.phone).map((t) => t.body)).toContainEqual(reply.draft!.body);

    // The invoice is still owed, so the card isn't resolved — it rests for a week and comes back if nobody
    // pays, or sooner if the figures move.
    const after = await itemOf(w, invoice.id, 'invoice_overdue');
    expect(after).toMatchObject({ state: 'handled', handledVia: 'let_handle' });
    expect(after.handledBy).toBe(w.owner.id);
    const days = (after.handledUntil!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

describe('an estimate nobody answered', () => {
  it('waits the days the business gave, then opens; their answer closes it', async () => {
    const estimate = await sentEstimate(w, { title: 'Building C rooftop units' });
    await drain(w);
    // Five days by default: HandsFreeOS has its own check-in before a person is ever asked.
    expect(await itemsOf(w, [estimate.id])).toEqual([]);

    // Six days on, nobody has answered.
    await runSweep(w, Date.now() + 6 * DAY);
    const card = await itemOf(w, estimate.id, 'estimate_waiting');
    expect(card).toMatchObject({
      state: 'open',
      subjectType: 'estimate',
      personId: w.person.id,
      moneyKey: `estimate:${estimate.id}`,
      // What was quoted isn't owed by anyone yet, so it stays out of "$ affected".
      valueIsEstimate: true,
      urgentFrom: null,
    });
    expect(Number(card.valueCents)).toBe(estimate.totalCents);
    expect(card.title).toBe(`Maria Lopez · Building C rooftop units · ${estimate.number}`);
    expect(card.detail).toMatch(/^Sent \w{3}, \w{3} \d{1,2} · good until \w{3}, \w{3} \d{1,2}$/);
    expect(codes(card)).toEqual(['amount', 'expires_in', 'not_viewed']);

    // Maria says yes on the phone, and the card clears itself as answered.
    await run(w, estimateMarkAccepted, {
      workspaceId: w.workspaceId,
      estimateId: estimate.id,
      name: 'Maria Lopez',
    });
    await drain(w);
    expect(await itemOf(w, estimate.id, 'estimate_waiting')).toMatchObject({
      state: 'resolved',
      resolution: 'answered',
    });
    expect(await itemEvents(card.id)).toEqual(['opened', 'resolved']);
  });
});
