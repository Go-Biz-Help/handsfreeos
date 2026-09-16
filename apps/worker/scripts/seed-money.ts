/**
 * Milestone 9 demo data for Lone Star (design/m9): the money a real HVAC business has on its books.
 *
 * Everything here is built the way the app builds it — the catalogue and the settings through their own
 * commands, the two payment accounts through the real sign-in routes against the stand-in provider, and every
 * document through `estimate.*` / `invoice.*`. Money that moved really moved: the customer paid on the
 * provider's own page, the worker read the answer back, and the receipt went out on the usual ladder.
 *
 * What Dale sees after `pnpm db:reset`:
 * - **A catalogue** of eight things Lone Star sells, one of them a permit fee that isn't taxable, and the
 *   **Comfort Club** at $29 a month.
 * - **Two connected accounts**: Stripe (the default, everything is paid into it) and Square beside it.
 * - **A paid invoice** — Linda Okafor's hail repair, paid by card on her own link, with the receipt sent.
 * - **An overdue one** — Mike Johnson's gutter guards, ten days past due.
 * - **An estimate waiting** on Maria Santos, opened and unanswered for six days; one more out and unopened;
 *   one Rachel Stein hasn't been sent yet; and one David Kim declined.
 * - **A deposit taken at booking** — Nina Alvarado paid a quarter of a duct clean to hold her time, and the
 *   invoice for the job credits it. Gerald Tran is on the payment page now, so his time reads **held**.
 * - **Two plans** — Laura Fischer's Comfort Club is live at the provider with a cycle already billed, and
 *   Sarah Alvarez's is **waiting on her to put a card on it** from her own page.
 *
 * The two money cards land on Home from the same sweep every other kind uses: the overdue invoice and the
 * estimate nobody has answered.
 *
 * **It holds at any hour.** Every date here is worked out from *now* in the business's own time zone —
 * `moneyMoments` below is the only place a day or a clock is decided, `checkMoneyMoments` says what must be
 * true of them, and the seed refuses to finish if any of it isn't. `test/seed-money-clock.test.ts` runs both
 * over all 336 half-hour slots of a week. Nothing reasons backwards from a fixed hour: that has broken this
 * milestone's CI three times.
 */
import { randomUUID } from 'node:crypto';
import {
  addDays,
  applyPatch,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  estimateCreate,
  estimateDeclineOnline,
  estimateRecordView,
  estimateSend,
  executeCommand,
  executeQuery,
  invoiceCreate,
  invoiceRecordView,
  invoiceSend,
  localDateOf,
  localInstant,
  moneySaveSettings,
  paymentConnectionActivate,
  paymentConnectionConnect,
  paymentConnectionSetDefault,
  phoneUpdateSettings,
  planCreate,
  productCreate,
  quietHoursState,
  subscriptionRequestCard,
  subscriptionStart,
  type CalendarConfig,
  type CommandDef,
  type ConfigPatch,
  type HumanActor,
  type QuietHoursWindow,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { processDeliveries } from '../src/deliveries';
import { buildHttpServer } from '../src/http/server';
import { fakePaymentCode } from '../src/payments/index';
import { processors } from '../src/processors/index';
import { nextRefreshAt } from '../src/payments/refresh';
import type { OutboxDeps } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { systemActor, workerMeta } from '../src/services';
import { settle } from './seed-messaging';

export interface SeedMoneyDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services and loop settings, as the seed built them. */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedMoneyWorkspace {
  readonly id: string;
  readonly organizationId: string;
  readonly dale: TestUser;
  readonly priya: TestUser;
  /** The booking site's link name, so a customer can really book and pay a deposit. */
  readonly site: string;
}

export interface SeededMoney {
  readonly products: number;
  readonly accounts: string;
  readonly paid: string;
  readonly overdue: string;
  readonly waiting: string;
  readonly fresh: string;
  readonly declined: string;
  readonly draft: string;
  readonly depositInvoice: string;
  readonly depositAmount: string;
  readonly jobInvoice: string;
  readonly heldFor: string;
  readonly planCycle: string;
  readonly planWaiting: string;
  readonly depositCalendar: string;
  readonly seconds: number;
}

const DAY = 86_400_000;
const CARD_OK = '4242424242424242';
/** What the deposit calendar asks for: a quarter of the price, the figure the canvas draws. */
const DEPOSIT_BP = 2_500;
/** What a whole-home duct clean costs, as the catalogue prices the bookable service. */
const DUCT_PRICE = 45_000;

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Every day and clock this seed decides
// ---------------------------------------------------------------------------

/**
 * The days and moments the story needs, all measured from *now* where the business is. Pure, so the clock
 * check can walk a whole week through it without a database.
 */
export interface MoneyMoments {
  /** Today where the business is. */
  readonly today: string;
  /** The overdue invoice: written on the business's own terms, and ten days past its due day. */
  readonly overdueDueOn: string;
  readonly overdueSentDaysAgo: number;
  /** The paid one: sent, opened, and paid before it was due. */
  readonly paidDueOn: string;
  readonly paidSentDaysAgo: number;
  readonly paidViewedDaysAgo: number;
  readonly paidPaidDaysAgo: number;
  /** The estimate waiting on an answer: out long enough for the Action Center to ask about it. */
  readonly waitingSentDaysAgo: number;
  readonly waitingViewedDaysAgo: number;
  readonly waitingExpiresOn: string;
  /** The one that went out yesterday and hasn't been opened. */
  readonly freshSentDaysAgo: number;
  readonly freshExpiresOn: string;
  /** The one the customer said no to. */
  readonly declinedSentDaysAgo: number;
  readonly declinedDaysAgo: number;
  readonly declinedExpiresOn: string;
  /** How far ahead a customer is offered a time on the deposit calendar. */
  readonly bookingWindowDays: number;
  /**
   * How far out the two bookings are taken. Comfortably past the Action Center's appointment window (48
   * hours), so a duct clean never turns into a "Not confirmed" card on Home the moment the seed runs — and
   * well inside the window customers are offered times in.
   */
  readonly bookAtLeastHours: number;
}

/** How long an estimate stays good here: long enough that "expires in N days" is never a rounding error. */
const GOOD_FOR_DAYS = 30;
/** The Action Center asks about an estimate after this many days (`money.estimateWaitingDays`). */
const ESTIMATE_WAITING_DAYS = 5;
/** And about an invoice this many days after its due day ends (`money.invoiceOverdueDays`). */
const INVOICE_GRACE_DAYS = 1;
/** A rung whose moment is further past than this is never armed (money/jobs.ts `TOO_LATE_MS`). */
const TOO_LATE_HOURS = 12;

export function moneyMoments(now: number, timeZone: string): MoneyMoments {
  const today = localDateOf(now, timeZone);
  return {
    today,
    // Net 14 written 24 days ago: due 10 days ago, whatever the hour it is now.
    overdueDueOn: addDays(today, -10),
    overdueSentDaysAgo: 24,
    paidDueOn: addDays(today, 5),
    paidSentDaysAgo: 9,
    paidViewedDaysAgo: 8,
    paidPaidDaysAgo: 7,
    waitingSentDaysAgo: 6,
    waitingViewedDaysAgo: 5,
    waitingExpiresOn: addDays(today, GOOD_FOR_DAYS - 6),
    freshSentDaysAgo: 1,
    freshExpiresOn: addDays(today, GOOD_FOR_DAYS - 1),
    declinedSentDaysAgo: 11,
    declinedDaysAgo: 8,
    declinedExpiresOn: addDays(today, GOOD_FOR_DAYS - 11),
    bookingWindowDays: 21,
    bookAtLeastHours: 72,
  };
}

/** The Action Center opens a "Not confirmed" card this many hours before a visit (`appointments.windowHours`). */
const APPOINTMENT_WINDOW_HOURS = 48;

/**
 * What must be true of those moments for the seed to tell its story — whatever hour, and whatever day of the
 * week, it is run. Answers the problems in plain words; an empty list is a good seed.
 *
 * The rules are the ones the engine itself applies, written once here so a change in the engine shows up as a
 * failing clock check rather than a demo that is quietly wrong between midnight and six.
 */
export function checkMoneyMoments(m: MoneyMoments, now: number, timeZone: string): string[] {
  const bad: string[] = [];
  /** Midnight at the end of a local day, as an instant: when "that day" is over where the business is. */
  const endOf = (date: string) => localInstant(addDays(date, 1), '00:00', timeZone);
  /** Nine in the morning on a local day: when every money message goes out (`MONEY_SEND_AT`). */
  const nine = (date: string) => localInstant(date, '09:00', timeZone);
  const daysAgo = (n: number) => now - n * DAY;

  if (localDateOf(now, timeZone) !== m.today)
    bad.push('“today” was worked out for a different day than the one it is.');

  // ---- the overdue invoice ----
  if (endOf(m.overdueDueOn) >= now)
    bad.push(`The overdue invoice's due day (${m.overdueDueOn}) has not ended yet.`);
  // The overdue mark, and the Action Center's card, both land at the end of the due day plus the grace.
  if (endOf(addDays(m.overdueDueOn, INVOICE_GRACE_DAYS)) >= now)
    bad.push('The overdue invoice would not be marked overdue yet, so nothing would be on Home.');
  if (daysAgo(m.overdueSentDaysAgo) >= endOf(m.overdueDueOn))
    bad.push('The overdue invoice would have been sent after it was already due.');
  // Every rung of the ladder up to the due day is long past, so none of them fires as the seed runs; the last
  // rung is still ahead, so the business has one reminder left to send and Home can still offer a follow-up.
  for (const [rung, at] of [
    ['3 days before the due day', nine(addDays(m.overdueDueOn, -3))],
    ['the due day', nine(m.overdueDueOn)],
    ['3 days after', nine(addDays(m.overdueDueOn, 3))],
    ['7 days after', nine(addDays(m.overdueDueOn, 7))],
  ] as const)
    if (at > now - TOO_LATE_HOURS * 3_600_000)
      bad.push(`The reminder ${rung} would go out as the seed runs.`);
  if (nine(addDays(m.overdueDueOn, 14)) <= now)
    bad.push(
      'The last reminder on the overdue invoice is already past, so the ladder is finished.',
    );

  // ---- the paid invoice ----
  if (endOf(m.paidDueOn) <= now) bad.push('The paid invoice was due before it was paid.');
  if (!(daysAgo(m.paidSentDaysAgo) < daysAgo(m.paidViewedDaysAgo)))
    bad.push('The paid invoice was opened before it was sent.');
  if (!(daysAgo(m.paidViewedDaysAgo) < daysAgo(m.paidPaidDaysAgo)))
    bad.push('The paid invoice was paid before it was opened.');
  if (daysAgo(m.paidPaidDaysAgo) >= now) bad.push('The paid invoice was paid in the future.');

  // ---- the estimates ----
  if (now - daysAgo(m.waitingSentDaysAgo) < ESTIMATE_WAITING_DAYS * DAY)
    bad.push('The waiting estimate has not been out long enough to reach Home.');
  const asks = daysAgo(m.waitingSentDaysAgo) + ESTIMATE_WAITING_DAYS * DAY;
  if (endOf(m.waitingExpiresOn) <= asks)
    bad.push('The waiting estimate stops being good before the Action Center would ask about it.');
  if (endOf(m.waitingExpiresOn) <= now) bad.push('The waiting estimate has already expired.');
  if (endOf(m.freshExpiresOn) <= now) bad.push('The new estimate has already expired.');
  if (now - daysAgo(m.freshSentDaysAgo) >= ESTIMATE_WAITING_DAYS * DAY)
    bad.push('The new estimate is already old enough to reach Home, so Home has two of them.');
  if (m.declinedDaysAgo >= m.declinedSentDaysAgo)
    bad.push('The declined estimate was declined before it was sent.');
  if (endOf(m.declinedExpiresOn) <= now)
    bad.push('The declined estimate expired, so it reads as expired rather than declined.');
  // The one nudge goes three days after an estimate goes out. Both of the ones still open are past that, so
  // nothing is sent as the seed runs; the declined one is closed and gets nothing either way.
  for (const [what, sent] of [
    ['waiting', m.waitingSentDaysAgo],
    ['unopened', m.freshSentDaysAgo],
  ] as const) {
    const at = nine(addDays(localDateOf(daysAgo(sent), timeZone), 3));
    if (at > now - TOO_LATE_HOURS * 3_600_000 && at <= now)
      bad.push(`The nudge on the ${what} estimate would go out as the seed runs.`);
  }

  // ---- the two bookings ----
  if (m.bookingWindowDays < 1 || m.bookingWindowDays > 31)
    bad.push(
      'The booking window must be between 1 and 31 days (the public slots route refuses more).',
    );
  if (m.bookAtLeastHours <= APPOINTMENT_WINDOW_HOURS)
    bad.push('A booked duct clean would be near enough to open a “Not confirmed” card on Home.');
  if (m.bookAtLeastHours >= m.bookingWindowDays * 24)
    bad.push('The bookings are further out than the times the calendar is offering.');
  return bad;
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

export async function seedMoney(d: SeedMoneyDeps, ws: SeedMoneyWorkspace): Promise<SeededMoney> {
  const started = Date.now();
  const workspaceId = ws.id;
  const scope = { workspaceId, organizationId: ws.organizationId };
  const w = { admin: d.admin, worker: d.worker, since: d.since };

  const as = async <I extends z.ZodType, O extends z.ZodType>(
    who: TestUser,
    command: CommandDef<I, O>,
    input: z.input<I>,
  ): Promise<z.infer<O>> =>
    (await executeCommand(d.api, command, input, d.actor(who), d.meta())).output;
  /** As HandsFreeOS itself, the way the worker's own routes run a command. */
  const system = async <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
    channel: RequestMeta['channel'] = 'api',
  ): Promise<z.infer<O>> =>
    (
      await executeCommand(d.worker.db, command, input, systemActor(scope), {
        ...workerMeta(),
        channel,
      })
    ).output;
  const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await rows<T>(d.admin, query))[0];

  /**
   * The outbox, the jobs **and the webhooks**, until none of them has anything left. A provider's webhook is
   * its own loop in the worker (`processDeliveries` in main.ts), not an outbox job, so `settle` alone would
   * leave a plan's cycle sitting in `app.webhook_deliveries` unread. Only rows this seed reserved are
   * claimed, the way `settle` does it, so a suite running against the same database keeps its own.
   */
  const drain = async (): Promise<void> => {
    for (let pass = 0; pass < 20; pass++) {
      await settle(w);
      await rows(
        d.admin,
        sql`update app.webhook_deliveries set locked_at = now(), locked_by = ${d.worker.workerId}
            where status = 'pending' and received_at >= ${d.since}::timestamptz`,
      );
      const stats = await processDeliveries({
        ...d.worker,
        processors,
        reservedOnly: true,
      });
      if (stats.retried > 0 || stats.failed > 0)
        throw new Error(
          `${stats.retried + stats.failed} webhook(s) from the stand-in provider failed ` +
            '(see last_error in app.webhook_deliveries).',
        );
      if (stats.claimed === 0) return;
    }
    throw new Error('The stand-in provider’s webhooks did not settle in twenty passes.');
  };

  const [business] = await rows<{ timezone: string }>(
    d.admin,
    sql`select timezone from app.workspaces where id = ${workspaceId}`,
  );
  const tz = business?.timezone ?? 'America/Chicago';
  const m = moneyMoments(Date.now(), tz);
  const wrong = checkMoneyMoments(m, Date.now(), tz);
  if (wrong.length)
    throw new Error(`The money seed's dates don't hold at this hour:\n  ${wrong.join('\n  ')}`);

  /** Puts a row back in time. The admin pool is not `authenticated`, so the money guards don't apply. */
  const backdate = async (
    table: 'estimates' | 'invoices' | 'payments' | 'subscriptions',
    id: string,
    fields: Record<string, number | null>,
  ): Promise<void> => {
    const sets = Object.entries(fields).map(([column, days]) =>
      days === null
        ? sql`${sql.raw(column)} = null`
        : sql`${sql.raw(column)} = now() - ${`${days} days`}::interval`,
    );
    await rows(
      d.admin,
      sql`update ${sql.raw(`app.${table}`)} set ${sql.join(sets, sql`, `)} where id = ${id}`,
    );
  };

  const personOf = async (name: string): Promise<string> => {
    const [first, ...last] = name.split(' ');
    const row = await one<{ id: string }>(
      sql`select id from app.people where workspace_id = ${workspaceId}
          and first_name = ${first} and last_name = ${last.join(' ')} and archived_at is null`,
    );
    if (!row) throw new Error(`The CRM seed has no customer ${name}.`);
    return row.id;
  };
  const leadOf = async (title: string): Promise<string | null> =>
    (
      await one<{ id: string }>(
        sql`select id from app.leads where workspace_id = ${workspaceId} and title = ${title}
            and archived_at is null order by created_at limit 1`,
      )
    )?.id ?? null;

  // ---------- the business's money settings ----------

  d.step('Lone Star: sales tax, EST-/INV- from 1001, Net 14 and the reminder ladder');
  await as(ws.dale, moneySaveSettings, {
    workspaceId,
    settings: {
      businessAddress: 'Lone Star HVAC & Roofing\n4410 Westpark Dr, Suite 120\nHouston, TX 77027',
      tax: { rateBp: 825, name: 'TX sales tax', newProductsTaxable: true },
      numbering: {
        estimate: { prefix: 'EST-', next: 1001, pad: 4 },
        invoice: { prefix: 'INV-', next: 1001, pad: 4 },
      },
      terms: 'net_14',
      notes: {
        estimate: 'Thanks for the opportunity. Call or text us with any questions.',
        invoice: 'Thank you for your business.',
      },
      estimateGoodForDays: GOOD_FOR_DAYS,
      deposit: { kind: 'percent', percentBp: DEPOSIT_BP, amountCents: 0 },
      bankTransfer: true,
      // The ladder as it ships: a nudge three days out, one on the day, then three, seven and fourteen after.
      reminders: {
        beforeDueDays: [3],
        onDue: true,
        afterDueDays: [3, 7, 14],
        estimateAfterDays: 3,
      },
    },
  });

  // ---------- the catalogue ----------

  d.step('Lone Star: what it sells — parts, labour, two fees (one of them not taxable) and a plan');
  const product = async (input: {
    name: string;
    kind: 'product' | 'service' | 'fee';
    unitPriceCents: number;
    unitLabel?: string;
    description?: string;
    sku?: string;
    taxable?: boolean;
    serviceId?: string | null;
  }) => (await as(ws.dale, productCreate, { workspaceId, ...input })).productId;

  // The one bookable service the catalogue prices: a product linked to a service is what the booking page,
  // the appointment sheet and the AI teammate all read the price of a visit from.
  const ductService = await one<{ id: string }>(
    sql`select id from app.services where workspace_id = ${workspaceId} and name = 'Duct cleaning'`,
  );
  const catalogue = {
    duct: await product({
      name: 'Duct cleaning · whole home',
      kind: 'service',
      unitPriceCents: DUCT_PRICE,
      description: 'Every supply and return duct, vacuumed and sanitized.',
      sku: 'SVC-DUCT',
      serviceId: ductService?.id ?? null,
    }),
    tuneup: await product({
      name: 'AC tune-up',
      kind: 'service',
      unitPriceCents: 18_900,
      description: 'Coils, drain line, refrigerant charge and a filter.',
      sku: 'SVC-TUNE',
    }),
    labour: await product({
      name: 'Service labour',
      kind: 'service',
      unitPriceCents: 12_500,
      unitLabel: 'hour',
      sku: 'LAB-STD',
    }),
    rooftop: await product({
      name: 'Rooftop unit · 5 ton',
      kind: 'product',
      unitPriceCents: 640_000,
      description: 'Packaged rooftop unit, supplied and set.',
      sku: 'RTU-5T',
    }),
    motor: await product({
      name: 'Condenser fan motor',
      kind: 'product',
      unitPriceCents: 28_500,
      sku: 'PRT-FANM',
    }),
    filter: await product({
      name: '16×25×1 pleated filter',
      kind: 'product',
      unitPriceCents: 1_800,
      sku: 'PRT-F1625',
    }),
    callout: await product({
      name: 'Diagnostic call-out',
      kind: 'fee',
      unitPriceCents: 8_900,
      description: 'Waived if you go ahead with the work the same day.',
      sku: 'FEE-DIAG',
    }),
    // A permit is collected for the city, not sold: nobody charges tax on it.
    permit: await product({
      name: 'City mechanical permit',
      kind: 'fee',
      unitPriceCents: 7_500,
      description: 'Paid straight to the City of Houston. No tax.',
      sku: 'FEE-PERMIT',
      taxable: false,
    }),
  };
  const comfortClub = (
    await as(ws.dale, planCreate, {
      workspaceId,
      name: 'Comfort Club',
      description: 'The maintenance plan: two visits a year and you go to the front of the queue.',
      priceCents: 2_900,
      interval: 'month',
      intervalCount: 1,
      taxable: false,
      includes: [
        'Two tune-ups a year, spring and fall',
        'Priority booking — same day where we can',
        '15% off parts and labour',
        'No call-out fee',
      ],
    })
  ).planId;

  // ---------- the accounts the money lands in ----------

  const app = await buildHttpServer({
    ...d.worker,
    httpDb: d.worker.db,
    verifyToken: null,
    webOrigins: [d.worker.webUrl],
    testRoutes: { jobs },
  });
  // Every webhook the stand-in posts comes back into this server, signed the way Stripe and Square sign
  // theirs, so a plan's cycle is recorded by the real verifier and the real processor.
  const fake = d.worker.payments.fake;
  fake?.setDeliver(async (post) => {
    const url = new URL(post.url);
    const res = await app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': 'application/json', ...post.headers },
      payload: post.body,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300 };
  });

  try {
    // A receipt and an invoice both reach for a text first, and after dark `deliver` would hold them until
    // morning — so the seed would tell a different story at 2 AM than at 2 PM. Texting hours are opened for
    // as long as the money goes out and put straight back, exactly as the Action Center's seed does.
    return await withTextingOpen(d, workspaceId, ws.dale, tz, withServer);
  } finally {
    await app.close();
  }

  // -------------------------------------------------------------------------

  async function withServer(): Promise<SeededMoney> {
    const inject = async (
      method: 'GET' | 'POST',
      url: string,
      payload?: Record<string, unknown>,
      form?: Record<string, string>,
    ) => {
      const res = await app.inject({
        method,
        url,
        ...(form
          ? {
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              payload: new URLSearchParams(form).toString(),
            }
          : payload
            ? { payload }
            : {}),
      });
      if (res.statusCode >= 400)
        throw new Error(`${method} ${url.split('?')[0]} answered ${res.statusCode}: ${res.body}`);
      return res;
    };
    const json = async <T>(
      method: 'GET' | 'POST',
      url: string,
      payload?: Record<string, unknown>,
    ): Promise<T> => JSON.parse((await inject(method, url, payload)).body) as T;

    /**
     * Signs an account in the way Settings → Payments does: the business asks for a one-time state, the
     * provider hands back a code, and the worker seals what it got. Straight through the commands rather
     * than the browser, because there is no browser here.
     */
    const connect = async (
      provider: 'stripe' | 'square',
      accountId: string,
      displayName: string,
      label: string,
    ): Promise<string> => {
      const { connectionId } = await as(ws.dale, paymentConnectionConnect, {
        workspaceId,
        provider,
        environment: 'test',
        label,
      });
      const api = d.worker.payments.providers[provider];
      const tokens = await api.exchangeCode({
        code: fakePaymentCode({ provider, accountId, displayName, partialScopes: false }),
        redirectUri: `${d.worker.publicUrl}/oauth/${provider}/callback`,
      });
      const account = await api.describe(tokens);
      await system(paymentConnectionActivate, {
        workspaceId,
        connectionId,
        externalAccountId: account.externalAccountId,
        locationId: account.locationId,
        displayName: account.displayName,
        scopes: tokens.scopes.slice(0, 50),
        capabilities: { ...account.capabilities },
        tokenEnc: d.worker.sealer.seal(JSON.stringify(tokens)),
        tokenKeyId: d.worker.sealer.keyId,
        tokenExpiresAt: tokens.expiresAt,
        nextRefreshAt:
          nextRefreshAt(
            tokens.expiresAt,
            d.worker.payments.refreshEveryMs,
            d.worker.payments.refreshAheadMs,
          )?.toISOString() ?? null,
      });
      return connectionId;
    };

    d.step('Lone Star: a Stripe account and a Square one, with Stripe the one money lands in');
    const stripe = await connect(
      'stripe',
      'acct_lonestar_hvac',
      'Lone Star HVAC & Roofing',
      'Main account',
    );
    // Beside it, so the seed shows what two accounts at once look like: a business can pick which one a
    // document is paid into, and Square's own 30-day sign-in shows on the card.
    await connect(
      'square',
      'merchant_lonestar_heights',
      'Lone Star HVAC — Heights shop',
      'Heights shop',
    );
    await as(ws.dale, paymentConnectionSetDefault, { workspaceId, connectionId: stripe });
    await drain();

    // ---------- the documents ----------

    const line = (
      productId: string,
      name: string,
      quantity: number,
      unitPriceCents: number,
      over: { unitLabel?: string; taxable?: boolean; description?: string } = {},
    ) => ({
      productId,
      name,
      quantity,
      unitPriceCents,
      unitLabel: over.unitLabel ?? 'each',
      taxable: over.taxable ?? true,
      description: over.description ?? null,
    });

    d.step('Lone Star: three estimates out, one declined and one Dale hasn’t sent yet');

    /** An estimate, written and sent, then put back to the day it really went. */
    const estimate = async (input: {
      person: string;
      lead: string | null;
      title: string;
      assignee: TestUser;
      lines: ReturnType<typeof line>[];
      expiresOn: string;
      sentDaysAgo: number;
      viewedDaysAgo?: number;
    }) => {
      const { estimateId } = await as(ws.dale, estimateCreate, {
        workspaceId,
        personId: await personOf(input.person),
        leadId: input.lead ? await leadOf(input.lead) : null,
        assigneeUserId: input.assignee.id,
        title: input.title,
        lines: input.lines,
        expiresOn: input.expiresOn,
      });
      const sent = await as(ws.dale, estimateSend, {
        workspaceId,
        estimateId,
        channels: ['email'],
      });
      if (input.viewedDaysAgo !== undefined)
        await system(estimateRecordView, { workspaceId, documentId: estimateId });
      await drain();
      await backdate('estimates', estimateId, {
        created_at: input.sentDaysAgo,
        sent_at: input.sentDaysAgo,
        ...(input.viewedDaysAgo === undefined
          ? {}
          : { first_viewed_at: input.viewedDaysAgo, last_viewed_at: input.viewedDaysAgo }),
      });
      // Its nudge was armed from the moment it was written, which is no longer when it went out. Three days
      // after the real day is long past, so the hourly sweep will not bring it back either.
      await rows(
        d.admin,
        sql`delete from app.scheduled_jobs
            where workspace_id = ${workspaceId} and status = 'pending'
              and dedupe_key = ${`money-estimate:${estimateId}:nudge`}`,
      );
      return { id: estimateId, number: sent.number ?? '', totalCents: sent.totalCents };
    };

    const waiting = await estimate({
      person: 'Maria Santos',
      lead: 'Building C rooftop units',
      title: 'Building C rooftop units',
      assignee: ws.dale,
      lines: [
        line(catalogue.rooftop, 'Rooftop unit · 5 ton', 3, 640_000),
        line(catalogue.labour, 'Service labour', 24, 12_500, { unitLabel: 'hour' }),
        line(catalogue.permit, 'City mechanical permit', 3, 7_500, { taxable: false }),
      ],
      expiresOn: m.waitingExpiresOn,
      sentDaysAgo: m.waitingSentDaysAgo,
      viewedDaysAgo: m.waitingViewedDaysAgo,
    });

    const fresh = await estimate({
      person: 'Mike Johnson',
      lead: 'Roof replacement',
      title: 'Roof replacement',
      assignee: ws.dale,
      lines: [
        line(catalogue.labour, 'Service labour', 60, 12_500, { unitLabel: 'hour' }),
        line(catalogue.labour, 'Architectural shingles · 32 squares', 32, 14_000, {
          unitLabel: 'square',
          description: 'Thirty-year architectural shingles, felt and ridge vent.',
        }),
      ],
      expiresOn: m.freshExpiresOn,
      sentDaysAgo: m.freshSentDaysAgo,
    });

    const declined = await estimate({
      person: 'David Kim',
      lead: 'Mini split · garage',
      title: 'Mini split · garage',
      assignee: ws.priya,
      lines: [
        line(catalogue.motor, 'Mini split · 12k BTU', 1, 285_000, {
          description: 'Wall unit, condenser and line set.',
        }),
        line(catalogue.labour, 'Service labour', 8, 12_500, { unitLabel: 'hour' }),
      ],
      expiresOn: m.declinedExpiresOn,
      sentDaysAgo: m.declinedSentDaysAgo,
      viewedDaysAgo: m.declinedSentDaysAgo,
    });
    await system(estimateDeclineOnline, {
      workspaceId,
      estimateId: declined.id,
      name: 'David Kim',
      reason: 'Went with another bidder on price. Thanks for coming out.',
    });
    await drain();
    await backdate('estimates', declined.id, { declined_at: m.declinedDaysAgo });

    const draft = await as(ws.dale, estimateCreate, {
      workspaceId,
      personId: await personOf('Rachel Stein'),
      leadId: await leadOf('Waiting room split system'),
      assigneeUserId: ws.dale.id,
      title: 'Waiting room split system',
      lines: [
        line(catalogue.motor, 'Ducted split system · 3 ton', 1, 520_000),
        line(catalogue.labour, 'Service labour', 12, 12_500, { unitLabel: 'hour' }),
        line(catalogue.permit, 'City mechanical permit', 1, 7_500, { taxable: false }),
      ],
    });
    await drain();

    d.step('Lone Star: an invoice paid by card with its receipt, and one ten days past due');

    /** An invoice, written and sent on the link the customer really gets. */
    const invoice = async (input: {
      person: string;
      lead: string | null;
      title: string;
      assignee: TestUser;
      lines: ReturnType<typeof line>[];
      dueOn: string;
      connectionId?: string;
    }) => {
      const { invoiceId } = await as(ws.dale, invoiceCreate, {
        workspaceId,
        personId: await personOf(input.person),
        leadId: input.lead ? await leadOf(input.lead) : null,
        assigneeUserId: input.assignee.id,
        title: input.title,
        lines: input.lines,
        dueOn: input.dueOn,
        connectionId: input.connectionId ?? null,
      });
      const sent = await as(ws.dale, invoiceSend, {
        workspaceId,
        invoiceId,
        channels: ['email'],
      });
      await drain();
      return { id: invoiceId, number: sent.number ?? '', totalCents: sent.totalCents };
    };

    const paid = await invoice({
      person: 'Linda Okafor',
      lead: 'Roof repair · hail',
      title: 'Roof repair · hail damage',
      assignee: ws.dale,
      lines: [
        line(catalogue.labour, 'Service labour', 24, 12_500, { unitLabel: 'hour' }),
        line(catalogue.callout, 'Diagnostic call-out', 1, 8_900),
        line(catalogue.permit, 'City mechanical permit', 1, 7_500, { taxable: false }),
      ],
      dueOn: m.paidDueOn,
    });

    // She opens it and pays on the provider's own page, exactly as a customer does: we hand the browser a
    // session, the provider takes the card, and the worker reads the answer back from the provider.
    const link = await json<{ token: string }>('POST', '/test/money/link', {
      workspaceId,
      invoiceId: paid.id,
    });
    await inject('POST', `/public/invoice/${link.token}/viewed`, {});
    const clientId = randomUUID();
    const prepared = await json<{
      payment: { hostedUrl: string | null; providerPaymentId: string | null };
    }>('POST', `/public/invoice/${link.token}/pay`, { clientId, method: 'card' });
    if (!prepared.payment.hostedUrl)
      throw new Error('The stand-in provider handed back no payment page for the invoice.');
    const page = new URL(prepared.payment.hostedUrl);
    await inject('GET', `${page.pathname}${page.search}`);
    const back = await inject('POST', '/payments/fake/pay', undefined, {
      provider: page.searchParams.get('provider')!,
      account: page.searchParams.get('account')!,
      amount: page.searchParams.get('amount')!,
      ...(page.searchParams.get('intent') ? { intent: page.searchParams.get('intent')! } : {}),
      ...(page.searchParams.get('return') ? { return: page.searchParams.get('return')! } : {}),
      instrument: CARD_OK,
      method: 'card',
      decision: 'pay',
    });
    const paidBack = new URL(String(back.headers.location));
    await inject('POST', `/public/invoice/${link.token}/pay`, {
      clientId,
      method: 'card',
      providerPaymentId: prepared.payment.providerPaymentId,
      ...(paidBack.searchParams.get('token')
        ? { sourceToken: paidBack.searchParams.get('token') }
        : {}),
    });
    await drain();
    const paidRow = await one<{ status: string; paid: number }>(
      sql`select status::text as status, amount_paid_cents::float8 as paid
          from app.invoices where id = ${paid.id}`,
    );
    if (paidRow?.status !== 'paid')
      throw new Error(
        `Linda Okafor's invoice should be paid and is ${paidRow?.status ?? 'missing'}.`,
      );
    await backdate('invoices', paid.id, {
      created_at: m.paidSentDaysAgo,
      sent_at: m.paidSentDaysAgo,
      first_viewed_at: m.paidViewedDaysAgo,
      last_viewed_at: m.paidViewedDaysAgo,
      paid_at: m.paidPaidDaysAgo,
    });
    await rows(
      d.admin,
      sql`update app.payments set created_at = now() - ${`${m.paidPaidDaysAgo} days`}::interval,
            received_at = now() - ${`${m.paidPaidDaysAgo} days`}::interval
          where invoice_id = ${paid.id}`,
    );

    const overdue = await invoice({
      person: 'Mike Johnson',
      lead: 'Gutter guards',
      title: 'Gutter guards · 186 ft',
      assignee: ws.priya,
      lines: [
        line(catalogue.labour, 'Service labour', 12, 12_500, { unitLabel: 'hour' }),
        line(catalogue.callout, 'Diagnostic call-out', 1, 8_900),
      ],
      dueOn: m.overdueDueOn,
    });
    await system(invoiceRecordView, { workspaceId, documentId: overdue.id });
    await drain();
    await backdate('invoices', overdue.id, {
      created_at: m.overdueSentDaysAgo,
      sent_at: m.overdueSentDaysAgo,
      first_viewed_at: m.overdueSentDaysAgo - 1,
      last_viewed_at: m.overdueSentDaysAgo - 1,
    });
    const overdueRow = await one<{ status: string }>(
      sql`select status::text as status from app.invoices where id = ${overdue.id}`,
    );
    if (overdueRow?.status !== 'overdue')
      throw new Error(
        `Mike Johnson's invoice should be overdue and is ${overdueRow?.status ?? 'missing'}, ` +
          'so nothing would be waiting on Home.',
      );

    // ---------- a deposit at booking ----------

    d.step('Lone Star: a Duct cleaning calendar that asks for a quarter up front');
    const created = await as(ws.dale, calendarCreate, {
      workspaceId,
      name: 'Duct cleaning',
      preset: 'dispatch',
      color: '#4d7c0f',
      description: 'Every duct in the house, vacuumed and sanitized. A quarter holds your time.',
      teammates: [ws.priya.id],
    });
    const { calendar: shell } = await executeQuery(
      d.api,
      calendarGet,
      { workspaceId, calendarId: created.calendarId },
      d.actor(ws.dale),
      d.meta(),
    );
    const patch: ConfigPatch = {
      services: ductService ? { mode: 'one', items: [{ serviceId: ductService.id }] } : {},
      locations: { options: [{ kind: 'customer_address' }] },
      // The dispatch preset routes by ZIP, which would put a postcode question in front of the deposit. This
      // one calendar goes straight to a time, so the pay step is the third thing a customer sees.
      territory: { routing: 'off' },
      payments: {
        mode: 'deposit',
        deposit: { kind: 'percent', percentBp: DEPOSIT_BP },
        connectionId: stripe,
      },
    };
    await as(ws.dale, calendarSave, {
      workspaceId,
      calendarId: created.calendarId,
      baseRevision: shell.revision,
      draft: applyPatch(shell.config as CalendarConfig, patch),
    });
    await as(ws.dale, calendarSetStatus, {
      workspaceId,
      calendarId: created.calendarId,
      status: 'active',
    });
    await drain();

    /**
     * A time this calendar is really offering, asked for exactly as the booking page asks — so the seed never
     * picks an hour out of the air, and works whatever day and hour it runs. The first one far enough out
     * that the visit is not already inside the Action Center's appointment window.
     */
    const nextOpenTime = async (): Promise<string> => {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + m.bookingWindowDays * DAY).toISOString();
      const out = await json<{ slots: { startsAt: string }[] }>(
        'GET',
        `/public/book/${ws.site}/${created.slug}/slots?from=${encodeURIComponent(
          from,
        )}&to=${encodeURIComponent(to)}`,
      );
      const earliest = Date.now() + m.bookAtLeastHours * 3_600_000;
      const slot = out.slots.find((s) => Date.parse(s.startsAt) >= earliest);
      if (!slot)
        throw new Error(
          `The Duct cleaning calendar is offering no time between ${m.bookAtLeastHours} hours and ` +
            `${m.bookingWindowDays} days from now, so nobody can book a deposit.`,
        );
      return slot.startsAt;
    };
    const book = async (customer: { name: string; phone: string; email: string }) => {
      const held = await json<{ holdToken: string; deposit: { amountCents: number } }>(
        'POST',
        `/public/book/${ws.site}/${created.slug}/bookings`,
        {
          clientId: randomUUID(),
          startsAt: await nextOpenTime(),
          partySize: 1,
          locationKind: 'customer_address',
          address: '2118 Ashland St, Houston, TX 77008',
          postalCode: '77008',
          smsConsent: true,
          ...customer,
        },
      );
      await drain();
      return held;
    };

    d.step('Lone Star: Nina Alvarado pays a deposit to hold her duct clean');
    const ninaHold = await book({
      name: 'Nina Alvarado',
      phone: '+17135550241',
      email: 'nina.alvarado@example.test',
    });
    const holdPay = await json<{
      payment: { hostedUrl: string | null; providerPaymentId: string | null };
    }>('POST', `/public/hold/${ninaHold.holdToken}/pay`, {
      clientId: randomUUID(),
      method: 'card',
    });
    if (!holdPay.payment.hostedUrl)
      throw new Error('The stand-in provider handed back no payment page for the deposit.');
    const depositPage = new URL(holdPay.payment.hostedUrl);
    await inject('GET', `${depositPage.pathname}${depositPage.search}`);
    const depositBack = await inject('POST', '/payments/fake/pay', undefined, {
      provider: depositPage.searchParams.get('provider')!,
      account: depositPage.searchParams.get('account')!,
      amount: depositPage.searchParams.get('amount')!,
      ...(depositPage.searchParams.get('intent')
        ? { intent: depositPage.searchParams.get('intent')! }
        : {}),
      ...(depositPage.searchParams.get('return')
        ? { return: depositPage.searchParams.get('return')! }
        : {}),
      instrument: CARD_OK,
      method: 'card',
      decision: 'pay',
    });
    const depositReturn = new URL(String(depositBack.headers.location));
    const holdClient = randomUUID();
    await inject('POST', `/public/hold/${ninaHold.holdToken}/pay`, {
      clientId: holdClient,
      method: 'card',
      providerPaymentId: holdPay.payment.providerPaymentId,
      ...(depositReturn.searchParams.get('token')
        ? { sourceToken: depositReturn.searchParams.get('token') }
        : {}),
    });
    await drain();

    const deposit = await one<{
      id: string;
      number: string | null;
      status: string;
      total: number;
      attendee_id: string;
      person_id: string;
    }>(
      sql`select id, number, status::text as status, total_cents::float8 as total, attendee_id, person_id
          from app.invoices
          where workspace_id = ${workspaceId} and origin = 'booking' and purpose = 'deposit'
          order by created_at desc limit 1`,
    );
    if (!deposit || deposit.status !== 'paid')
      throw new Error(
        `Nina Alvarado's deposit should be paid and is ${deposit?.status ?? 'missing'}.`,
      );

    // The invoice for the job itself, crediting what she already paid — what "Invoice this visit" raises.
    const balanceCents = DUCT_PRICE - Math.round(deposit.total);
    const jobInvoice = await as(ws.dale, invoiceCreate, {
      workspaceId,
      personId: deposit.person_id,
      attendeeId: deposit.attendee_id,
      purpose: 'balance',
      origin: 'booking',
      connectionId: stripe,
      title: 'Duct cleaning · whole home',
      dueOn: addDays(m.today, 14),
      lines: [
        line(catalogue.duct, 'Duct cleaning · whole home', 1, balanceCents, {
          description: `Less the ${money(deposit.total)} deposit already paid on ${deposit.number}.`,
        }),
      ],
    });
    const jobSent = await as(ws.dale, invoiceSend, {
      workspaceId,
      invoiceId: jobInvoice.invoiceId,
      channels: ['email'],
    });
    await drain();

    d.step('Lone Star: Gerald Tran is on the payment page now, so his time reads held');
    const geraldHold = await book({
      name: 'Gerald Tran',
      phone: '+17135550242',
      email: 'gerald.tran@example.test',
    });
    // He has opened the page and not paid. Asking for the session is exactly what his browser has done.
    await inject('POST', `/public/hold/${geraldHold.holdToken}/pay`, {
      clientId: randomUUID(),
      method: 'card',
    });
    await drain();

    // ---------- plans ----------

    d.step('Lone Star: Laura Fischer’s Comfort Club goes live and bills its first month');
    const laura = await as(ws.dale, subscriptionStart, {
      workspaceId,
      personId: await personOf('Laura Fischer'),
      planId: comfortClub,
      leadId: await leadOf('Fall maintenance plan'),
      connectionId: stripe,
    });
    const lauraLink = await json<{ token: string }>('POST', '/test/money/link', {
      workspaceId,
      subscriptionId: laura.subscriptionId,
    });
    const cardSession = await json<{ session: { hostedUrl: string | null } }>(
      'POST',
      `/public/plan/${lauraLink.token}/card`,
      { clientId: randomUUID() },
    );
    if (!cardSession.session.hostedUrl)
      throw new Error('The stand-in provider handed back no page for putting a card on a plan.');
    const cardPage = new URL(cardSession.session.hostedUrl);
    await inject('GET', `${cardPage.pathname}${cardPage.search}`);
    const cardBack = await inject('POST', '/payments/fake/pay', undefined, {
      provider: cardPage.searchParams.get('provider')!,
      account: cardPage.searchParams.get('account')!,
      amount: cardPage.searchParams.get('amount')!,
      ...(cardPage.searchParams.get('return')
        ? { return: cardPage.searchParams.get('return')! }
        : {}),
      instrument: CARD_OK,
      method: 'card',
      decision: 'pay',
    });
    const cardReturn = new URL(String(cardBack.headers.location));
    await inject('POST', `/public/plan/${lauraLink.token}/card`, {
      clientId: randomUUID(),
      sourceToken: cardReturn.searchParams.get('token'),
    });
    await drain();

    const live = await one<{ status: string; external: string | null }>(
      sql`select status::text as status, external_subscription_id as external
          from app.subscriptions where id = ${laura.subscriptionId}`,
    );
    if (!live?.external)
      throw new Error(
        `Laura Fischer's plan should be live at the provider and is ${live?.status ?? 'missing'}.`,
      );
    // A month goes by at the provider: it bills the cycle and tells us, and the cycle becomes an invoice and
    // a payment here, numbered and receipted like any other.
    const billed = await json<{ webhooks: { type: string; ok: boolean }[] }>(
      'POST',
      '/test/money/provider-event',
      { workspaceId, subscriptionId: live.external, event: 'cycle' },
    );
    if (!billed.webhooks.some((h) => h.ok))
      throw new Error(
        `The stand-in billed Laura Fischer's cycle but no webhook of ours took it (${JSON.stringify(
          billed.webhooks,
        )}).`,
      );
    await drain();
    const cycle = await one<{ number: string | null; status: string }>(
      sql`select number, status::text as status from app.invoices
          where workspace_id = ${workspaceId} and subscription_id = ${laura.subscriptionId}
          order by created_at desc limit 1`,
    );
    if (!cycle?.number)
      throw new Error('Laura Fischer’s plan billed a cycle that raised no invoice here.');
    if (cycle.status !== 'paid')
      throw new Error(`Laura Fischer’s billed cycle reads ${cycle.status} rather than paid.`);

    d.step('Lone Star: Sarah Alvarez’s plan waits on her to put a card on it');
    const sarah = await as(ws.dale, subscriptionStart, {
      workspaceId,
      personId: await personOf('Sarah Alvarez'),
      planId: comfortClub,
      leadId: await leadOf('Spring maintenance plan'),
      connectionId: stripe,
    });
    await as(ws.dale, subscriptionRequestCard, {
      workspaceId,
      subscriptionId: sarah.subscriptionId,
      channels: ['email'],
      message: null,
    });
    await drain();

    // ---------- what the seed leaves behind ----------

    const stillDue = await one<{ n: number }>(
      sql`select count(*)::int as n from app.scheduled_jobs
          where workspace_id = ${workspaceId} and status = 'pending' and run_at <= now() + interval '30 minutes'
            and (kind like 'invoice.%' or kind like 'estimate.%' or kind like 'payment.%'
                 or kind like 'subscription.%')`,
    );
    if (stillDue?.n)
      throw new Error(
        `${stillDue.n} money message(s) would go out within half an hour of the seed ` +
          '(app.scheduled_jobs).',
      );

    return {
      products: Object.keys(catalogue).length,
      accounts: 'Stripe (default) and Square',
      paid: `${paid.number} · Linda Okafor · ${money(paid.totalCents)}`,
      overdue: `${overdue.number} · Mike Johnson · ${money(overdue.totalCents)}`,
      waiting: `${waiting.number} · Maria Santos · ${money(waiting.totalCents)}`,
      fresh: `${fresh.number} · Mike Johnson · ${money(fresh.totalCents)}`,
      declined: `${declined.number} · David Kim`,
      draft: `Rachel Stein · ${money(draft.totalCents)}`,
      depositInvoice: deposit.number ?? '',
      depositAmount: money(deposit.total),
      jobInvoice: `${jobSent.number} · ${money(jobSent.totalCents)}`,
      heldFor: 'Gerald Tran',
      planCycle: `${cycle.number} · Laura Fischer · $29 a month`,
      planWaiting: 'Sarah Alvarez',
      depositCalendar: created.slug,
      seconds: (Date.now() - started) / 1000,
    };
  }
}

/**
 * Texting hours, opened for as long as the money messages go out and then put straight back — the same thing
 * the Action Center's seed does. A receipt and an invoice both reach for a text first, and at night `deliver`
 * would hold them until morning, so without this the seed would tell a different story after dark.
 */
export async function withTextingOpen<T>(
  d: Pick<SeedMoneyDeps, 'api' | 'admin' | 'actor' | 'meta' | 'step'>,
  workspaceId: string,
  dale: TestUser,
  timeZone: string,
  body: () => Promise<T>,
): Promise<T> {
  const [row] = await rows<{ timezone: string; quiet: QuietHoursWindow | null }>(
    d.admin,
    sql`select timezone, settings -> 'telephony' -> 'quietHours' as quiet
        from app.workspaces where id = ${workspaceId}`,
  );
  const window: QuietHoursWindow = row?.quiet ?? { enabled: true, start: '20:00', end: '08:00' };
  const quiet = quietHoursState(window, row?.timezone ?? timeZone);
  if (!quiet.quiet) return body();
  d.step(
    `It’s ${quiet.localTime} in Houston, in Lone Star’s quiet hours: texting hours open while the money goes out`,
  );
  const set = (w: QuietHoursWindow) =>
    executeCommand(
      d.api,
      phoneUpdateSettings,
      { workspaceId, quietHours: w },
      d.actor(dale),
      d.meta(),
    );
  await set({ ...window, enabled: false });
  try {
    return await body();
  } finally {
    await set(window);
    d.step('Lone Star: quiet hours back on');
  }
}
