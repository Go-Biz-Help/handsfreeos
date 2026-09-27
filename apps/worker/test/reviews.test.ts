/**
 * What customers said in public (M16), on the real database.
 *
 * The reviews a CRM shows are never the CRM's — they belong to Google and to Facebook — so the promise here
 * is not "we keep your reviews", it is "we read them from where they actually live, and leaving loses none
 * of them". The things worth holding:
 *
 *   - a sign-in that can speak for several places asks which one, and connects none of them until it knows;
 *   - a review arrives with its own date, so one written in 2019 sits in 2019;
 *   - Google's stars and Facebook's thumb stay apart: no made-up number beside a real one;
 *   - a reply somebody left on their phone is read back, so nothing shows as unanswered forever;
 *   - a reply written here is kept first and posted after, and reaches the place people read it;
 *   - and disconnecting forgets the sign-in without losing a word anybody said.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  organizationCreate,
  reviewConnectionConnect,
  reviewConnectionDisconnect,
  reviewConnectionSyncNow,
  reviewList,
  reviewReply,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { choosePlace, finishSignIn, testTokenVerifier, type Finished } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let workspaceId: string;
let s: TestServices;
let app: FastifyInstance;

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actor(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actor(owner), meta()) as Promise<T>;
const get = (url: string) => app.inject({ method: 'GET', url });

const runner = `vitest-reviews-${process.pid}`;

/**
 * Runs whatever this business has waiting, until the queue is quiet.
 *
 * Reserved to this runner first, and claimed `reservedOnly`: every checkout on this machine shares one
 * local database, so a dev worker running somewhere else would otherwise take these jobs and do them with
 * code of its own.
 */
async function drain(limit = 40): Promise<void> {
  for (let i = 0; i < limit; i++) {
    // The events first: "read them again" and "post this reply" arrive as events, and it is the handlers
    // that turn them into work.
    await admin().execute(
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and event_id in (select id from app.events
            where workspace_id = ${workspaceId}::uuid)`,
    );
    const events = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    await admin().execute(
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = ${runner}
          where workspace_id = ${workspaceId}::uuid and status = 'pending'`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 50,
      reservedOnly: true,
    });
    if (done.claimed === 0 && events.claimed === 0) return;
  }
}

/** "Read them again now", the way the Reviews screen's own button does it. */
async function syncNow(): Promise<void> {
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`select id::text as id from app.review_connections
        where workspace_id = ${workspaceId}::uuid and provider = 'google' and status = 'connected'`,
  );
  await run(reviewConnectionSyncNow, { workspaceId, connectionId: c!.id });
}

/** The whole sign-in, through the stand-in pages and the app finishing it, exactly as a browser walks it. */
async function connect(provider: 'google' | 'facebook'): Promise<
  Finished & {
    connectionId: string;
    state: string;
  }
> {
  const output = await run<{ connectionId: string; state: string }>(reviewConnectionConnect, {
    workspaceId,
    provider,
  });
  const start = await get(`/oauth/${provider}/start?state=${encodeURIComponent(output.state)}`);
  expect(start.statusCode).toBe(302);
  const authorize = new URL(String(start.headers.location));
  const challenge = authorize.searchParams.get('code_challenge')!;
  const page = await get(`${authorize.pathname}${authorize.search}`);
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('No real page or profile is touched');
  const approve = await get(
    `/oauth/fake/${provider}/approve?${new URLSearchParams({
      state: output.state,
      code_challenge: challenge,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      email: `reviews@${provider}.fake`,
      decision: 'allow',
    })}`,
  );
  const callback = new URL(String(approve.headers.location));
  const back = await finishSignIn(
    app,
    await get(`${callback.pathname}${callback.search}`),
    await signInTestUser(owner),
  );
  return { ...back, connectionId: output.connectionId, state: output.state };
}

beforeAll(async () => {
  owner = await createTestUser('reviews-dale', { fullName: 'Dale Owner' });
  const org = await run<{ workspaceId: string }>(organizationCreate, {
    businessName: 'Reviews HVAC',
    timezone: 'America/Chicago',
  });
  workspaceId = org.workspaceId;
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

describe('connecting the place the reviews live', () => {
  it('asks which one when the sign-in speaks for several, and connects none until it knows', async () => {
    s.reviews.fake.setPlaces('google', [
      { externalId: 'locations/austin', displayName: 'Lone Star HVAC — Austin', publicUrl: null },
      { externalId: 'locations/dallas', displayName: 'Lone Star HVAC — Dallas', publicUrl: null },
    ]);
    const signed = await connect('google');
    // A chooser, not a redirect: nothing is connected on a guess.
    expect(signed.location).toBeNull();
    expect(signed.places?.map((p) => p.name)).toContain('Lone Star HVAC — Dallas');
    const [waiting] = await rows<{ status: string; external_account_id: string | null }>(
      admin(),
      sql`select status::text as status, external_account_id from app.review_connections
          where id = ${signed.connectionId}::uuid`,
    );
    expect(waiting!.status).toBe('pending');
    expect(waiting!.external_account_id).toBeNull();

    // Answering it connects that one, and reads straight away.
    const chose = await choosePlace(
      app,
      signed.handoff!,
      'locations/dallas',
      await signInTestUser(owner),
    );
    expect(chose.status).toBe(302);
    expect(String(chose.location)).toContain('reviews=connected');
    const [connected] = await rows<{ status: string; display_name: string }>(
      admin(),
      sql`select status::text as status, display_name from app.review_connections
          where id = ${signed.connectionId}::uuid`,
    );
    expect(connected!.status).toBe('connected');
    expect(connected!.display_name).toContain('Dallas');
    // Cleaned up for the tests that follow: back to one place.
    s.reviews.fake.setPlaces('google', [
      { externalId: 'locations/austin', displayName: 'Lone Star HVAC', publicUrl: null },
    ]);
    await run(reviewConnectionDisconnect, { workspaceId, connectionId: signed.connectionId });
  }, 60_000);

  it('never lets the chooser be talked into a place the sign-in does not manage', async () => {
    s.reviews.fake.setPlaces('google', [
      { externalId: 'locations/austin', displayName: 'Lone Star HVAC — Austin', publicUrl: null },
      { externalId: 'locations/dallas', displayName: 'Lone Star HVAC — Dallas', publicUrl: null },
    ]);
    const signed = await connect('google');
    const sneaky = await choosePlace(
      app,
      signed.handoff!,
      'locations/somebody-else',
      await signInTestUser(owner),
    );
    // The answer is a parameter, and a parameter is a guess: it is checked against what the sign-in really has.
    expect(sneaky.location).toBeNull();
    expect(sneaky.body).toContain('expired');
    const [still] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.review_connections where id = ${signed.connectionId}::uuid`,
    );
    expect(still!.status).toBe('pending');
    s.reviews.fake.setPlaces('google', [
      { externalId: 'locations/austin', displayName: 'Lone Star HVAC', publicUrl: null },
    ]);
  }, 60_000);
});

describe('reading what people said', () => {
  it('brings them across with their own dates, and keeps stars and thumbs apart', async () => {
    s.reviews.fake.add('google', {
      author: 'Dave Smith',
      rating: 5,
      body: 'Came out the same afternoon.',
      postedAt: new Date('2019-07-02T15:00:00.000Z'),
    });
    s.reviews.fake.add('facebook', {
      author: 'Maria Alvarez',
      sentiment: 'positive',
      body: 'Recommend them.',
      postedAt: new Date('2022-03-11T10:00:00.000Z'),
    });
    await connect('google');
    await connect('facebook');
    await drain();

    const got = await ask<{
      reviews: {
        provider: string;
        authorName: string | null;
        rating: number | null;
        sentiment: string | null;
        postedAt: string;
        canReply: boolean;
      }[];
      summary: { total: number; averageRating: number | null; recommended: number };
    }>(reviewList, { workspaceId });

    const dave = got.reviews.find((r) => r.authorName === 'Dave Smith')!;
    expect(dave.rating).toBe(5);
    // Not a made-up thumb to go with the stars.
    expect(dave.sentiment).toBeNull();
    expect(new Date(dave.postedAt).getUTCFullYear()).toBe(2019);
    expect(dave.canReply).toBe(true);

    const maria = got.reviews.find((r) => r.authorName === 'Maria Alvarez')!;
    // Facebook has no stars, and is not given any.
    expect(maria.rating).toBeNull();
    expect(maria.sentiment).toBe('positive');
    // Facebook answers a recommendation as a comment on a story, which its API will not let an app post.
    expect(maria.canReply).toBe(false);

    expect(got.summary.total).toBe(2);
    // Averaged over the ones that have stars, not over everything.
    expect(got.summary.averageRating).toBe(5);
    expect(got.summary.recommended).toBe(1);
  }, 60_000);

  it('reads back a reply somebody left on their phone, so nothing waits forever', async () => {
    const id = s.reviews.fake.add('google', {
      author: 'Tom Nguyen',
      rating: 4,
      body: 'Good work.',
    });
    await drain();
    // Answered over there, not here.
    await s.reviews.fake.providers.google.reply!({
      accessToken: 'fake-review-access.x',
      place: 'locations/austin',
      reviewId: id,
      body: 'Thanks Tom!',
    });
    await syncNow();
    await drain();
    const got = await ask<{ reviews: { authorName: string | null; replyBody: string | null }[] }>(
      reviewList,
      { workspaceId },
    );
    expect(got.reviews.find((r) => r.authorName === 'Tom Nguyen')!.replyBody).toBe('Thanks Tom!');
  }, 60_000);
});

describe('answering', () => {
  it('keeps the words first and posts them where people read them', async () => {
    s.reviews.fake.add('google', { author: 'Priya Patel', rating: 2, body: 'Van was late.' });
    await syncNow();
    await drain();
    const before = await ask<{ reviews: { id: string; authorName: string | null }[] }>(reviewList, {
      workspaceId,
    });
    const priya = before.reviews.find((r) => r.authorName === 'Priya Patel')!;

    await run(reviewReply, {
      workspaceId,
      reviewId: priya.id,
      body: 'Sorry about that, Priya — we have changed how we schedule the last call of the day.',
    });
    // Kept here the moment it is written, before anybody has spoken to Google.
    const [saved] = await rows<{ reply_body: string | null }>(
      admin(),
      sql`select reply_body from app.reviews where id = ${priya.id}::uuid`,
    );
    expect(saved!.reply_body).toContain('Sorry about that');

    await drain();
    const posted = s.reviews.fake.replies();
    expect(posted.some((p) => p.body.includes('Sorry about that'))).toBe(true);

    // And a read that overtakes the post does not throw the answer away. Google has not been told yet, so
    // its copy of this review still has no reply on it; the words written here survive that.
    await syncNow();
    await drain();
    const [kept] = await rows<{ reply_body: string | null }>(
      admin(),
      sql`select reply_body from app.reviews where id = ${priya.id}::uuid`,
    );
    expect(kept!.reply_body).toContain('Sorry about that');
  }, 60_000);

  it('won’t keep an answer that can’t go up, so none sits here looking sent', async () => {
    const got = await ask<{ reviews: { id: string; authorName: string | null }[] }>(reviewList, {
      workspaceId,
    });
    // Facebook doesn't let apps answer.
    const maria = got.reviews.find((r) => r.authorName === 'Maria Alvarez')!;
    await expect(
      run(reviewReply, { workspaceId, reviewId: maria.id, body: 'Thank you, Maria!' }),
    ).rejects.toThrow(/answered on Facebook itself/);
    const [kept] = await rows<{ reply_body: string | null }>(
      admin(),
      sql`select reply_body from app.reviews where id = ${maria.id}::uuid`,
    );
    expect(kept!.reply_body).toBeNull();
  }, 60_000);
});

describe('leaving', () => {
  it('forgets the sign-in and loses not a word anybody said', async () => {
    const [before] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.reviews where workspace_id = ${workspaceId}::uuid`,
    );
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`select id::text as id from app.review_connections
          where workspace_id = ${workspaceId}::uuid and provider = 'google' and status = 'connected'`,
    );
    await run(reviewConnectionDisconnect, { workspaceId, connectionId: c!.id });
    const [after] = await rows<{
      token_enc: string | null;
      status: string;
      next_sync_at: Date | null;
    }>(
      admin(),
      sql`select token_enc, status::text as status, next_sync_at from app.review_connections
          where id = ${c!.id}::uuid`,
    );
    expect(after!.status).toBe('disconnected');
    // The sign-in is gone, and nothing will ask Google anything again.
    expect(after!.token_enc).toBeNull();
    expect(after!.next_sync_at).toBeNull();
    const [kept] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.reviews where workspace_id = ${workspaceId}::uuid`,
    );
    expect(kept!.count).toBe(before!.count);
  }, 60_000);
});
