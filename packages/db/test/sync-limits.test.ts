/**
 * Against a real local PowerSync (`pnpm sync:start`): the two limits PowerSync puts on one person — 1,000 buckets and
 * 1,000 parameter query results — for the two people who stress them most:
 *   - an agency owner keeping all 12 of the agency's businesses offline (one subscription each), and
 *   - a member who may see 2,000 documents (1,200 through leads assigned to them, 800 through visits they're on).
 * Each opens a real sync stream as a signed-in person; the buckets come from the first checkpoint, and the parameter
 * results from the service's own checkpoint log line. The numbers are printed for the record.
 *
 * It needs Docker and the running service, so it is not part of the default suite:
 *   pnpm sync:start && HFOS_SYNC_TESTS=1 pnpm --filter @hfos/db exec vitest run test/sync-limits.test.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  signInTestUser,
  uniq,
  type TestUser,
} from './harness';

const SYNC_URL = process.env.HFOS_SYNC_URL ?? 'http://127.0.0.1:54430';
const SERVICE_CONTAINER = process.env.HFOS_SYNC_CONTAINER ?? 'hfos-sync';
const LIMIT = 1000;
const BUSINESSES = 12;
const LEAD_DOCUMENTS = 1200;
const VISIT_DOCUMENTS = 800;

const admin$ = dbs.admin.db;

interface SyncRun {
  readonly buckets: readonly { bucket: string; count: number }[];
  readonly paramResults: number;
  readonly logBuckets: number;
  readonly ops: number;
  readonly firstSyncMs: number;
}

function docker(args: string[]): string {
  const colima = `${homedir()}/.colima/default/docker.sock`;
  const env = { ...process.env };
  if (!env.DOCKER_HOST && existsSync(colima)) env.DOCKER_HOST = `unix://${colima}`;
  return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Opens a sync stream as the person, downloads everything to the first complete checkpoint, and reads the log. */
async function syncAs(
  user: TestUser,
  subscriptions: { stream: string; parameters: Record<string, string> | null }[],
): Promise<SyncRun> {
  const accessToken = await signInTestUser(user);
  const since = new Date(Date.now() - 1000).toISOString();
  const started = Date.now();
  const abort = new AbortController();
  const res = await fetch(`${SYNC_URL}/sync/stream`, {
    method: 'POST',
    signal: abort.signal,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      raw_data: true,
      include_checksum: true,
      streams: {
        include_defaults: true,
        subscriptions: subscriptions.map((s) => ({ ...s, override_priority: null })),
      },
    }),
  });
  if (!res.ok || !res.body)
    throw new Error(`sync stream refused: ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let buckets: { bucket: string; count: number }[] = [];
  let ops = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('sync stream ended before a complete checkpoint');
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        checkpoint?: { buckets: { bucket: string; count: number }[] };
        data?: { data: unknown[] };
        checkpoint_complete?: unknown;
        error?: unknown;
      };
      if (message.error) throw new Error(`sync stream error: ${JSON.stringify(message.error)}`);
      if (message.checkpoint) buckets = message.checkpoint.buckets;
      if (message.data) ops += message.data.data.length;
      if (message.checkpoint_complete) {
        const firstSyncMs = Date.now() - started;
        abort.abort();
        // The service logs each connection's checkpoint: "buckets: N | param_results: M … "user_id":"…"".
        let logged: RegExpExecArray | null = null;
        for (let i = 0; i < 20 && !logged; i++) {
          const log = docker(['logs', '--since', since, SERVICE_CONTAINER])
            .split('\n')
            .filter((l) => l.includes('New checkpoint') && l.includes(user.id));
          logged = /buckets: (\d+) \| param_results: (\d+)/.exec(log.at(-1) ?? '');
          if (!logged) await new Promise((r) => setTimeout(r, 250));
        }
        if (!logged) throw new Error(`no checkpoint log line for ${user.email}`);
        return {
          buckets,
          logBuckets: Number(logged[1]),
          paramResults: Number(logged[2]),
          ops,
          firstSyncMs,
        };
      }
    }
  }
}

/** Waits until PowerSync has replicated the member's documents (their own bucket holds them all). */
async function waitForBucket(user: TestUser, stream: string, atLeast: number) {
  const started = Date.now();
  for (;;) {
    const run = await syncAs(user, []);
    const bucket = run.buckets.find((b) => b.bucket.includes(`${stream}|`));
    if (bucket && bucket.count >= atLeast) return;
    if (Date.now() - started > 120_000)
      throw new Error(`${stream} had ${bucket?.count ?? 0} of ${atLeast} after 2 minutes`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

describe.skipIf(!process.env.HFOS_SYNC_TESTS)(
  'PowerSync’s per-person limits, against the running service',
  () => {
    let agencyOwner: TestUser;
    let member: TestUser;
    const businesses: string[] = [];

    beforeAll(async () => {
      [agencyOwner, member] = await Promise.all([
        createTestUser('limits-agency-owner'),
        createTestUser('limits-member'),
      ]);
      const first = await bootstrapOrganization(agencyOwner, 'Limits Agency', 'Limits Business 1');
      businesses.push(first.wsId);
      for (let n = 2; n <= BUSINESSES; n++) {
        const [ws] = await rows<{ id: string }>(
          admin$,
          sql`insert into app.workspaces (organization_id, name, slug) values (${first.orgId}, ${`Limits Business ${n}`}, ${`limits-${n}-${uniq()}`})
            returning id`,
        );
        businesses.push(ws!.id);
      }
      // A little of everything in every business, so each bucket has something in it.
      for (const ws of businesses)
        await rows(
          admin$,
          sql`with p as (
              insert into app.people (workspace_id, first_name, last_name, phone_e164)
              select ${ws}, 'Customer', g::text, '+1512555' || lpad(g::text, 4, '0') from generate_series(1, 25) g
              returning id)
            select count(*) from p`,
        );

      // The member: 2,000 documents in business 1 they may see, and 1,000 they may not.
      const ws = businesses[0]!;
      await admin$
        .insert(workspaceMemberships)
        .values({ workspaceId: ws, userId: member.id, role: 'member' });
      await rows(
        admin$,
        sql`insert into app.people (workspace_id, first_name, last_name) select ${ws}, 'Lead', g::text from generate_series(1, ${LEAD_DOCUMENTS + 1000}) g`,
      );
      await rows(
        admin$,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, assignee_user_id)
          select ${ws}, s.pipeline_id, s.id, p.id, 'Job ' || p.last_name,
            case when p.last_name::int <= ${LEAD_DOCUMENTS} then ${member.id}::uuid end
          from app.people p
          cross join lateral (select id, pipeline_id from app.pipeline_stages where workspace_id = ${ws} and kind = 'open' order by position limit 1) s
          where p.workspace_id = ${ws} and p.first_name = 'Lead'`,
      );
      await rows(
        admin$,
        sql`insert into app.invoices (workspace_id, person_id, lead_id, title, subtotal_cents, taxable_base_cents, total_cents)
          select l.workspace_id, l.person_id, l.id, l.title, 18000, 18000, 18000 from app.leads l where l.workspace_id = ${ws}`,
      );
      const [calendar] = await rows<{ id: string }>(
        admin$,
        sql`insert into app.calendars (workspace_id, name, slug, status) values (${ws}, 'Visits', ${`visits-${uniq().toLowerCase()}`}, 'active') returning id`,
      );
      await rows(
        admin$,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source, notes)
          select ${ws}, ${calendar!.id}, 1, 'Visit ' || g, now() + make_interval(hours => 2 * g), now() + make_interval(hours => 2 * g + 1), 'staff', 'limits'
          from generate_series(1, ${VISIT_DOCUMENTS}) g`,
      );
      await rows(
        admin$,
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
          select ${ws}, a.id, ${member.id} from app.appointments a where a.calendar_id = ${calendar!.id}`,
      );
      await rows(
        admin$,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
          select ${ws}, a.id, (select p.id from app.people p where p.workspace_id = ${ws} limit 1)
          from app.appointments a where a.calendar_id = ${calendar!.id}`,
      );
      await rows(
        admin$,
        sql`insert into app.invoices (workspace_id, person_id, attendee_id, title, subtotal_cents, taxable_base_cents, total_cents)
          select ${ws}, t.person_id, t.id, 'Visit', 12000, 12000, 12000
          from app.appointment_attendees t join app.appointments a on a.id = t.appointment_id where a.calendar_id = ${calendar!.id}`,
      );
      await rows(
        admin$,
        sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents)
          select i.workspace_id, i.id, 'Labour', 1, i.total_cents, i.total_cents from app.invoices i where i.workspace_id = ${ws}`,
      );
      const [visible] = await rows<{ n: number }>(
        admin$,
        sql`select count(*)::int as n from app.invoices where workspace_id = ${ws} and member_viewer_ids @> array[${member.id}::uuid]`,
      );
      expect(visible!.n).toBe(LEAD_DOCUMENTS + VISIT_DOCUMENTS);
      // Their own bucket: 2,000 invoices, 2,000 lines, and their access and profile.
      await waitForBucket(member, 'me_v1', 2 * (LEAD_DOCUMENTS + VISIT_DOCUMENTS) + 2);
    }, 300_000);

    afterAll(closeAll);

    it('an agency owner keeping 12 businesses offline stays far under both limits', async () => {
      const run = await syncAs(
        agencyOwner,
        businesses.map((id) => ({ stream: 'business_v1', parameters: { workspace_id: id } })),
      );
      console.log(
        `agency owner, ${BUSINESSES} businesses: ${run.buckets.length} buckets (log ${run.logBuckets}), ${run.paramResults} parameter results, ` +
          `${run.ops} operations in ${run.firstSyncMs} ms`,
      );
      // me_v1 1, then all five of business_v1's arms in each of the 12 — `access`, `managed` (an agency
      // owner is not a member), `inbox` (0083: they still see the whole one), and `reads_money` and
      // `inbox_drafts` (20261012060300: the catalogue and the AI's drafts) — and agency_v1 1.
      expect(run.buckets.length).toBe(1 + 5 * BUSINESSES + 1);
      expect(run.logBuckets).toBe(run.buckets.length);
      // One lookup per arm per business, and one for the agency. me_v1 needs none.
      expect(run.paramResults).toBe(5 * BUSINESSES + 1);
      expect(run.buckets.length).toBeLessThan(LIMIT);
      expect(run.paramResults).toBeLessThan(LIMIT);
    }, 120_000);

    it('a member who may see 2,000 documents gets them all in one bucket', async () => {
      const run = await syncAs(member, [
        { stream: 'business_v1', parameters: { workspace_id: businesses[0]! } },
      ]);
      console.log(
        `member, ${LEAD_DOCUMENTS + VISIT_DOCUMENTS} documents: ${run.buckets.length} buckets (log ${run.logBuckets}), ` +
          `${run.paramResults} parameter results, ${run.ops} operations in ${run.firstSyncMs} ms; ` +
          `buckets ${run.buckets.map((b) => `${b.bucket.replace(/^\d+#/, '').replace(/\[.*$/, '')}=${b.count}`).join(', ')}`,
      );
      // me_v1, and four of business_v1's five arms: a member matches `access`, `inbox`, `reads_money` and
      // `inbox_drafts` (money.read and inbox.use are a member's by default), never `managed`.
      expect(run.buckets.length).toBe(5);
      expect(run.paramResults).toBe(4);
      const own = run.buckets.find((b) => b.bucket.includes('me_v1|'))!;
      expect(own.count).toBeGreaterThanOrEqual(2 * (LEAD_DOCUMENTS + VISIT_DOCUMENTS));
      expect(run.buckets.length).toBeLessThan(LIMIT);
      expect(run.paramResults).toBeLessThan(LIMIT);
    }, 120_000);

    it('asking for a business the person can’t open gives nothing, and costs no parameter result', async () => {
      const run = await syncAs(member, [
        { stream: 'business_v1', parameters: { workspace_id: businesses[1]! } },
        { stream: 'business_v1', parameters: { workspace_id: 'not-a-business' } },
      ]);
      expect(run.buckets.map((b) => b.bucket.replace(/\[.*$/, '').replace(/^\d+#/, ''))).toEqual([
        'me_v1|0',
      ]);
      expect(run.paramResults).toBe(0);
    }, 60_000);
  },
);
