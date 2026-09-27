import { randomUUID } from 'node:crypto';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  signInTestUser,
  testEnv,
  type TestUser,
} from './harness';

let member: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;
const clients: SupabaseClient[] = [];

const insertEvent = (u: TestUser, payload: Record<string, unknown> = {}) =>
  as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, entity_id, payload, correlation_id)
          values (${org}, ${ws}, 'person.created', 'human', ${u.id}, 'person', ${randomUUID()}, ${JSON.stringify(payload)}::jsonb, ${randomUUID()})
          returning id`,
    ).then((r) => r[0]!.id),
  );

beforeAll(async () => {
  [member, outsider] = await Promise.all([
    createTestUser('rt-member'),
    createTestUser('rt-outsider'),
  ]);
  const a = await bootstrapOrganization(member, 'Realtime Org', 'Realtime Workspace');
  ws = a.wsId;
  org = a.orgId;
  await bootstrapOrganization(outsider, 'Other Org', 'Other Workspace');
});
afterAll(async () => {
  for (const c of clients) {
    await c.removeAllChannels();
    c.realtime.disconnect();
  }
  await closeAll();
});

describe('live updates: broadcast from the database', () => {
  it('the policy on realtime.messages exists (a stack without Realtime would have skipped it)', async () => {
    const policies = await rows<{ policyname: string }>(
      dbs.admin.db,
      sql`select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'workspace_members_receive'`,
    );
    expect(policies).toHaveLength(1);
  });

  it('an event with a workspace lands on the workspace topic with ids only; _broadcast:false stays silent', async () => {
    const eventId = await insertEvent(member, { email: 'secret@example.com' });
    const messages = await rows<{ payload: Record<string, unknown> }>(
      dbs.admin.db,
      sql`select payload from realtime.messages where topic = ${'workspace:' + ws} and payload ->> 'id' = ${eventId}`,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.payload).toMatchObject({
      type: 'person.created',
      entityType: 'person',
      actorId: member.id,
    });
    expect(JSON.stringify(messages[0]!.payload)).not.toContain('secret@example.com');
    const quiet = await insertEvent(member, { _broadcast: false });
    const none = await rows(
      dbs.admin.db,
      sql`select 1 from realtime.messages where topic = ${'workspace:' + ws} and payload ->> 'id' = ${quiet}`,
    );
    expect(none).toHaveLength(0);
  });

  it('an inbox or money event says what happened, but not to which record or by whom', async () => {
    // Everyone in the business hears the topic, including a member narrowed to their own threads.
    const entityId = randomUUID();
    const [event] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, entity_id, payload, correlation_id)
            values (${org}, ${ws}, 'message.sent', 'human', ${member.id}, 'message', ${entityId}, '{}'::jsonb, ${randomUUID()})
            returning id`,
      ),
    );
    const messages = await rows<{ payload: Record<string, unknown> }>(
      dbs.admin.db,
      sql`select payload from realtime.messages where topic = ${'workspace:' + ws} and payload ->> 'id' = ${event!.id}`,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.payload).toMatchObject({
      type: 'message.sent',
      entityType: 'message',
      entityId: null,
      actorType: 'human',
      actorId: null,
    });
  });

  it('only members of the workspace may read its topic', async () => {
    await insertEvent(member);
    const forMember = await as(member)(async (tx) => {
      await tx.execute(sql`select set_config('realtime.topic', ${'workspace:' + ws}, true)`);
      return rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from realtime.messages where topic = ${'workspace:' + ws}`,
      );
    });
    expect(forMember[0]!.n).toBeGreaterThan(0);
    const forOutsider = await as(outsider)(async (tx) => {
      await tx.execute(sql`select set_config('realtime.topic', ${'workspace:' + ws}, true)`);
      return rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from realtime.messages where topic = ${'workspace:' + ws}`,
      );
    });
    expect(forOutsider[0]!.n).toBe(0);
  });

  it('a signed-in member receives a broadcast over a real subscription; an outsider cannot join', async () => {
    const env = testEnv;
    const subscribe = async (
      user: TestUser,
    ): Promise<{ channel: RealtimeChannel; status: string }> => {
      const token = await signInTestUser(user);
      const client = createClient(env.supabaseUrl, env.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      clients.push(client);
      await client.realtime.setAuth(token);
      const channel = client.channel('workspace:' + ws, { config: { private: true } });
      const status = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('TIMED_OUT'), 15_000);
        channel.subscribe((s) => {
          if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
            clearTimeout(timer);
            resolve(s);
          }
        });
      });
      return { channel, status };
    };

    const received: Record<string, unknown>[] = [];
    const memberSub = await subscribe(member);
    expect(memberSub.status).toBe('SUBSCRIBED');
    memberSub.channel.on('broadcast', { event: 'change' }, (msg) =>
      received.push(msg.payload as Record<string, unknown>),
    );
    // The first join of a tenant starts Realtime's replication stream a moment after SUBSCRIBED, so an
    // event written in that window is not delivered (the app refreshes on subscribe for the same reason).
    // Keep writing events until one arrives; each must show up within a second once the stream is up.
    const sent: string[] = [];
    for (
      let attempt = 0;
      attempt < 10 && !received.some((p) => sent.includes(String(p.id)));
      attempt++
    ) {
      sent.push(await insertEvent(member));
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && !received.some((p) => sent.includes(String(p.id)))) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(received.some((p) => sent.includes(String(p.id)))).toBe(true);
    expect(received[0]).toMatchObject({
      type: 'person.created',
      entityType: 'person',
      actorId: member.id,
    });

    const outsiderSub = await subscribe(outsider);
    expect(outsiderSub.status).not.toBe('SUBSCRIBED');
  }, 40_000);
});
