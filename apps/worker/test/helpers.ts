import { randomBytes } from 'node:crypto';
import { testDbs, testEnv } from '@hfos/db/testing';
import pino from 'pino';
import type { FakeCalendars } from '../src/calendar/fake';
import { fakeCalendarServices, type CalendarServices } from '../src/calendar/index';
import { createSealer } from '../src/crypto';
import { createLocalEmail, LOCAL_WEBHOOK_PASSWORD } from '../src/email/local';
import type { FakeMailboxes } from '../src/mailbox/fake';
import { fakeMailboxServices, type MailboxServices } from '../src/mailbox/index';
import { createSmtpMailer } from '../src/mailer';
import type { WorkerServices } from '../src/services';
import { createSupabaseStore } from '../src/storage';
import { createFakeTelephony, type FakeTelephony } from '../src/telephony/fake';

/** Signatures are computed against this base; tests call the server with inject(), never a real port. */
export const TEST_PUBLIC_URL = 'https://hooks.worker.test';

export type TestServices = WorkerServices & {
  readonly telephony: FakeTelephony;
  readonly mailboxes: MailboxServices & { readonly fake: FakeMailboxes };
  readonly calendars: CalendarServices & { readonly fake: FakeCalendars };
};

/** Worker services for tests: the real database, Mailpit and Storage, the fake carrier without callbacks. */
export function testServices(opts: { reminderOverrideMs?: number | null } = {}): TestServices {
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
  };
}
