import { randomBytes } from 'node:crypto';
import { testDbs, testEnv } from '@hfos/db/testing';
import pino from 'pino';
import { createBookingLinks } from '../src/booking/links';
import type { FakeCalendars } from '../src/calendar/fake';
import { fakeCalendarServices, type CalendarServices } from '../src/calendar/index';
import { createSealer } from '../src/crypto';
import { createLocalEmail, LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import { createSafeFetch } from '../src/http/safe-fetch';
import type { FakeMailboxes } from '../src/mailbox/fake';
import { fakeMailboxServices, type MailboxServices } from '../src/mailbox/index';
import { createSmtpMailer } from '../src/mailer';
import { createMoneyLinks } from '../src/money/links';
import type { FakePayments } from '../src/payments/fake';
import { fakePaymentServices, type PaymentServices } from '../src/payments/index';
import type { WorkerServices } from '../src/services';
import { createSupabaseStore } from '../src/storage';
import { createFakeTelephony, type FakeTelephony } from '../src/telephony/fake';

/** Signatures are computed against this base; tests call the server with inject(), never a real port. */
export const TEST_PUBLIC_URL = 'https://hooks.worker.test';

export type TestServices = WorkerServices & {
  readonly telephony: FakeTelephony;
  readonly mailboxes: MailboxServices & { readonly fake: FakeMailboxes };
  readonly calendars: CalendarServices & { readonly fake: FakeCalendars };
  readonly payments: PaymentServices & { readonly fake: FakePayments };
};

/**
 * The stand-in payment provider for tests. Its webhooks go nowhere by default, so no test resolves
 * TEST_PUBLIC_URL over the network; a test that wants them to arrive calls
 * `s.payments.fake.setDeliver(post => app.inject({ method: 'POST', url: new URL(post.url).pathname, … }))`
 * and gets the real signed bytes at the real route.
 */
function paymentsForTests(): PaymentServices & { readonly fake: FakePayments } {
  const services = fakePaymentServices(TEST_PUBLIC_URL, { settleMs: 0, refreshEveryMs: 60_000 });
  services.fake.setDeliver(async () => ({ ok: false }));
  return services;
}

/**
 * Worker services for tests: the real database, Mailpit and Storage, the fake carrier without callbacks.
 * `fetchOrigins` lets fetchUrl reach local fixture sites (`http://127.0.0.1:<port>`); everything else stays refused.
 */
export function testServices(
  opts: {
    reminderOverrideMs?: number | null;
    fetchOrigins?: readonly string[];
    /** The model for AI steps, the builder and the knowledge base (default: none). */
    ai?: WorkerServices['ai'];
  } = {},
): TestServices {
  const env = testEnv();
  const log = pino({ level: 'silent' });
  return {
    db: testDbs().worker.db,
    mailer: createSmtpMailer(
      process.env.SMTP_URL ?? 'smtp://127.0.0.1:54425',
      'HandsFreeOS <hello@handsfreeos.local>',
    ),
    store: createSupabaseStore(env.supabaseUrl, env.secretKey),
    log,
    webUrl: 'http://localhost:3000',
    publicUrl: TEST_PUBLIC_URL,
    telephony: createFakeTelephony({ approvalMs: 0, callbacks: false, log }),
    sealer: createSealer(randomBytes(32).toString('base64')),
    reminderOverrideMs: opts.reminderOverrideMs ?? null,
    registrationPollMs: 50,
    email: {
      ...createLocalEmail({
        smtpUrl: process.env.SMTP_URL ?? 'smtp://127.0.0.1:54425',
        eventsUrl: null,
        webhookUser: 'postmark',
        webhookPassword: LOCAL_WEBHOOK_PASSWORD,
        log,
      }),
      mailDomain: 'mail.handsfreeos.com',
      webhookUser: 'postmark',
      webhookPassword: LOCAL_WEBHOOK_PASSWORD,
    },
    // Syncs run when a test asks (the job's next run is a minute out).
    mailboxes: fakeMailboxServices(TEST_PUBLIC_URL, 60_000),
    // Refreshes run when a test asks (the job's next run is a minute out).
    calendars: fakeCalendarServices(TEST_PUBLIC_URL, 60_000),
    // The stand-in provider. A bank transfer settles only when a test asks (settleMs 0), and token refreshes
    // run when a test asks: the job's next run is a minute out.
    payments: paymentsForTests(),
    bookingLinks: createBookingLinks({
      webUrl: 'http://localhost:3000',
      key: randomBytes(32).toString('base64'),
    }),
    moneyLinks: createMoneyLinks({
      webUrl: 'http://localhost:3000',
      key: randomBytes(32).toString('base64'),
    }),
    fetchUrl: createSafeFetch({ testOrigins: opts.fetchOrigins ?? [] }),
    ai: opts.ai ?? { provider: null, dailyTokens: 2_000_000 },
  };
}
