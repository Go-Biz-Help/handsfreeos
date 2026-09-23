import { randomBytes } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
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
import type { FakePush } from '../src/push/fake';
import { fakePushServices, type PushServices } from '../src/push/index';
import { fakeReviewServices, type ReviewServices } from '../src/reviews/index';
import type { FakeReviews } from '../src/reviews/fake';
import type { SafeFetch } from '../src/http/safe-fetch';
import type { WorkerServices } from '../src/services';
import { createSupabaseStore, type ObjectStore } from '../src/storage';
import { createFakeHost } from '../src/hosting';
import { createFakeTelephony, type FakeTelephony } from '../src/telephony/fake';
import { roughDriveTimer } from '../src/geo/driving';
import { createFakeSpeech } from '../src/voice-agent/fake-speech';
import { createFakeGeocoder } from '../src/geo/geocoder';
import { createFakeTranscriber, type FakeTranscriber } from '../src/telephony/fake-transcriber';

/** Signatures are computed against this base; tests call the server with inject(), never a real port. */
export const TEST_PUBLIC_URL = 'https://hooks.worker.test';

export type TestServices = WorkerServices & {
  readonly reviews: ReviewServices & { readonly fake: FakeReviews };
  readonly telephony: FakeTelephony;
  readonly transcriber: FakeTranscriber;
  readonly mailboxes: MailboxServices & { readonly fake: FakeMailboxes };
  readonly calendars: CalendarServices & { readonly fake: FakeCalendars };
  readonly payments: PaymentServices & { readonly fake: FakePayments };
  readonly push: PushServices & { readonly fake: FakePush };
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
    // Shadow, so every worker test drives the capture path for real without it deciding anything. A test that
    // wants the warnings makes its own deps with mode 'on'.
    wallet: { db: testDbs().worker.db, log, mode: 'shadow' as const },
    webUrl: 'http://localhost:3000',
    publicUrl: TEST_PUBLIC_URL,
    telephony: createFakeTelephony({ approvalMs: 0, callbacks: false, log }),
    transcriber: createFakeTranscriber({ log }),
    geocoder: createFakeGeocoder(),
    driving: roughDriveTimer,
    speech: createFakeSpeech(),
    voiceAi: null,
    // The in-memory host: a branded domain can be driven end to end with no Vercel account (M17).
    siteHost: createFakeHost(),
    support: {
      mailDomain: 'handsfreeos.test',
      addresses: ['support', 'help'],
      fromName: 'HandsFreeOS Support',
      ownerEmails: [],
    },

    sealer: createSealer(randomBytes(32).toString('base64')),
    reminderOverrideMs: opts.reminderOverrideMs ?? null,
    registrationPollMs: 50,
    portPollMs: 50,
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
    // Reviews in memory; a place is asked again only when a test asks.
    reviews: fakeReviewServices(TEST_PUBLIC_URL, 60_000),
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
    // The push stand-in: what it was handed is `push.fake.sent`.
    push: fakePushServices(),
  };
}

/** One file as the old system would hand it over: the bytes, and what it says they are. */
export interface StandInFile {
  readonly bytes: Buffer;
  readonly contentType: string;
  /** What the server answers; anything but 200 exercises a path the copier has to handle. */
  readonly status?: number;
}

export interface StandInMedia {
  readonly store: ObjectStore;
  readonly fetchUrl: SafeFetch;
  /** Everything written, by `<bucket>/<path>`, so a test can say what really landed. */
  readonly uploads: Map<string, { contentType: string; bytes: Buffer }>;
  /** Every address asked for, in order, with the headers that went with it. */
  readonly asked: { url: string; headers: Readonly<Record<string, string>> }[];
}

/**
 * The two things outside the database that copying a file touches: where the bytes come from, and where they
 * go. Both stand in here, so a test can hand the migration a photo at a known address and then say exactly
 * what was stored and what the message ended up pointing at.
 */
export function standInMedia(files: Readonly<Record<string, StandInFile>> = {}): StandInMedia {
  const uploads = new Map<string, { contentType: string; bytes: Buffer }>();
  const asked: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const store: ObjectStore = {
    async upload(bucket, path, data, contentType) {
      uploads.set(`${bucket}/${path}`, { contentType, bytes: Buffer.from(data) });
    },
    async download(bucket, path) {
      const held = uploads.get(`${bucket}/${path}`);
      if (!held) throw new Error(`storage download failed: ${bucket}/${path} is not there`);
      return held.bytes;
    },
    async remove(bucket, path) {
      uploads.delete(`${bucket}/${path}`);
    },
    async exists(bucket, path) {
      return uploads.has(`${bucket}/${path}`);
    },
    async signedUrl(bucket, path) {
      return `https://storage.test/${bucket}/${path}`;
    },
    async check() {
      return { ok: true };
    },
  };
  const fetchUrl: SafeFetch = async (url, init) => {
    asked.push({ url, headers: init?.headers ?? {} });
    const file = files[url];
    const bytes = file?.bytes ?? Buffer.alloc(0);
    return {
      status: file ? (file.status ?? 200) : 404,
      headers: file ? ({ 'content-type': file.contentType } as Record<string, string>) : {},
      body: init?.binary ? '' : bytes.toString('utf8'),
      bytes,
      finalUrl: url,
      truncated: false,
    };
  };
  return { store, fetchUrl, uploads, asked };
}

/** How many rows one counting query found, read as the owner of the database. */
export async function countOf(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = await rows<{ count: number }>(testDbs().admin.db, query);
  return row?.count ?? 0;
}

/** Something a migration should have written here, and how to count it. */
export interface WrittenTarget {
  readonly what: string;
  /** The categories to put back in the queue when the count is short. */
  readonly categories: readonly string[];
  readonly expected: number;
  readonly count: () => Promise<number>;
}

/**
 * Drains a migration's queue until this code has actually written what the source holds.
 *
 * Every checkout on this machine shares one local database, and `claim_migration_jobs` claims globally, so
 * a dev worker running somewhere else — another checkout, another session's scratchpad — can take one of a
 * test's batches and finish it with whatever code it happens to be running. An older one stages the records,
 * writes a checkpoint and imports nothing, so neither a finished job nor a checkpoint is proof. The test
 * would then be asserting against an import that never happened, which reads exactly like a bug in the thing
 * being tested, and costs an hour to tell apart from one.
 *
 * The rows are the proof. Each target says what should be there and counts it; anything short puts its
 * categories back. Reading a page twice writes nothing twice, so a retry is cheap. Where one worker runs,
 * as in CI, the first pass is the only pass — and something this code genuinely fails to write fails here,
 * by name and by number, rather than passing quietly.
 */
export async function drainUntilWritten(input: {
  readonly migrationId: string;
  readonly drain: () => Promise<void>;
  readonly targets: readonly WrittenTarget[];
  readonly tries?: number;
}): Promise<void> {
  const { migrationId, drain, targets } = input;
  const tries = input.tries ?? 6;
  for (let attempt = 0; ; attempt++) {
    await drain();
    const counted = await Promise.all(targets.map((t) => t.count()));
    const short = targets.filter((t, i) => counted[i]! < t.expected);
    if (short.length === 0) return;
    if (attempt >= tries - 1)
      throw new Error(
        `this code never wrote: ${short
          .map((t) => `${t.what} (${counted[targets.indexOf(t)]} of ${t.expected})`)
          .join(', ')}`,
      );
    const list = `{${[...new Set(short.flatMap((t) => t.categories))].join(',')}}`;
    await testDbs().admin.db.execute(
      // `result` is left alone on purpose: only the engine writes what a batch did, and the guard on the
      // table says so. Putting the batch back is all a person may do, and all this needs.
      sql`update app.migration_jobs
             set state = 'pending', run_at = now(), attempts = 0,
                 finished_at = null, leased_by = null, leased_until = null
           where migration_id = ${migrationId} and kind = 'fetch'
             and category = any(${list}::text[])`,
    );
  }
}
