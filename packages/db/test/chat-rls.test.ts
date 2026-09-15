import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
/** Workspace A's admin. */
let admin: TestUser;
let member: TestUser;
/** Org B's owner. */
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;
let teammateA: string;
let teammateB: string;
/** Workspace A's widget, answered by its teammate. */
let widgetA: string;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const mismatch = { code: '23514', detail: 'record_workspace_mismatch' };
const origins = (list: string[]) =>
  sql`${`{${list.map((o) => JSON.stringify(o)).join(',')}}`}::text[]`;
/** A token or IP hash, as the worker stores them. */
const hash = () => sql`decode(${randomBytes(32).toString('hex')}, 'hex')`;

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('chat-owner'),
    createTestUser('chat-admin'),
    createTestUser('chat-member'),
    createTestUser('chat-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Chat Org A', 'Chat A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Chat Org B', 'Chat B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: wsA, userId: admin.id, role: 'admin' },
    { workspaceId: wsA, userId: member.id, role: 'member' },
  ]);
  const teammate = async (user: TestUser, ws: string) => {
    const [t] = await as(user)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.ai_teammates (workspace_id, name, status, created_by)
            values (${ws}, 'Ava', 'training', ${user.id}) returning id`,
      ),
    );
    return t!.id;
  };
  teammateA = await teammate(owner, wsA);
  teammateB = await teammate(outsider, wsB);
  const [w] = await as(admin)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.chat_widgets (workspace_id, allowed_origins, teammate_id, greeting, created_by)
          values (${wsA}, ${origins(['https://lonestarhvac.com', 'https://www.lonestarhvac.com'])}, ${teammateA},
            'Hi! Questions about a repair or a tune-up?', ${admin.id})
          returning id`,
    ),
  );
  widgetA = w!.id;
});
afterAll(closeAll);

const newWidget = (user: TestUser, ws: string, list = ['https://acme.com']) =>
  as(user)((tx) =>
    rows<{ id: string; public_key: string }>(
      tx,
      sql`insert into app.chat_widgets (workspace_id, allowed_origins, created_by)
          values (${ws}, ${origins(list)}, ${user.id}) returning id, public_key`,
    ),
  ).then((r) => r[0]!);

/** A visitor as the chat window's start route makes one. */
async function newVisitor(ws: string, org: string, widgetId: string): Promise<string> {
  const [v] = await worker(
    ws,
    org,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.chat_visitors
            (workspace_id, widget_id, token_hash, ip_hmac, name, phone_e164, email, last_page_path, last_seen_at)
          values (${ws}, ${widgetId}, ${hash()}, ${hash()}, 'Mike Alvarez', '+15125550199', 'mike@example.com',
            '/services/ac-repair', now())
          returning id`,
    ),
  );
  return v!.id;
}

/** The visitor's conversation, as chat.receive opens it on their first message. */
function chatConversation(ws: string, org: string, visitorId: string): Promise<string> {
  return worker(
    ws,
    org,
  )(async (tx) => {
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.conversations (workspace_id, channel, counterpart)
          values (${ws}, 'chat', ${`chat:${visitorId}`}) returning id`,
    );
    await tx.execute(
      sql`update app.chat_visitors set conversation_id = ${c!.id} where id = ${visitorId}`,
    );
    return c!.id;
  });
}

describe('chat widgets', () => {
  it('everyone reads a widget; owners and admins manage it; members cannot', async () => {
    const w = await newWidget(admin, wsA);
    expect(w.public_key).toMatch(/^wk_[A-Za-z0-9]{20}$/);
    expect(await code(() => newWidget(member, wsA))).toBe('42501');
    const restyle = (user: TestUser) =>
      as(user)((tx) =>
        rows(
          tx,
          sql`update app.chat_widgets set greeting = 'Hi! How can we help?', accent_color = '#0f766e', position = 'left'
              where id = ${w.id} returning id`,
        ),
      );
    expect(await restyle(member)).toHaveLength(0);
    expect(await restyle(admin)).toHaveLength(1);
    const sees = (user: TestUser) =>
      as(user)((tx) => rows(tx, sql`select id from app.chat_widgets where id = ${w.id}`)).then(
        (r) => r.length,
      );
    expect(await sees(member)).toBe(1);
    expect(await sees(outsider)).toBe(0);

    // Where it was last seen installed is the worker's to record.
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(sql`update app.chat_widgets set last_seen_at = now() where id = ${w.id}`),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(sql`insert into app.chat_widgets (workspace_id, allowed_origins, created_by, last_seen_at)
            values (${wsA}, ${origins(['https://acme.com'])}, ${admin.id}, now())`),
        ),
      ),
    ).toBe('42501');
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(sql`update app.chat_widgets set last_seen_origin = 'https://acme.com', last_seen_at = now()
        where id = ${w.id}`),
    );

    // Rotating the key retires every pasted snippet; keys stay unique and well formed.
    const [rotated] = await as(admin)((tx) =>
      rows<{ public_key: string }>(
        tx,
        sql`update app.chat_widgets set public_key = private.new_chat_widget_key() where id = ${w.id}
            returning public_key`,
      ),
    );
    expect(rotated!.public_key).toMatch(/^wk_[A-Za-z0-9]{20}$/);
    expect(rotated!.public_key).not.toBe(w.public_key);
    const other = await newWidget(admin, wsA);
    const rekey = (key: string) =>
      as(admin)((tx) =>
        tx.execute(sql`update app.chat_widgets set public_key = ${key} where id = ${other.id}`),
      );
    expect(await code(() => rekey(rotated!.public_key))).toBe('23505');
    expect(await code(() => rekey('wk_short'))).toBe('23514');
  });

  it('shows on 1 to 10 exact https sites, or a loopback http site for testing', async () => {
    const w = await newWidget(admin, wsA, [
      'https://acme.com',
      'https://www.acme.com',
      'https://shop.acme.co.uk:8443',
      'http://localhost:4191',
      'http://127.0.0.1:4192',
    ]);
    expect(w.public_key).toMatch(/^wk_/);
    const refused = [
      [],
      ['http://acme.com'],
      ['https://acme.com/'],
      ['https://acme.com/contact'],
      ['https://Acme.com'],
      ['acme.com'],
      ['https://acme.com', 'https://acme.com'],
      ['https://localhost'],
      ['https://*.acme.com'],
      ['http://localhost.evil.com:4191'],
      Array.from({ length: 11 }, (_, i) => `https://site${i}.acme.com`),
    ];
    for (const list of refused) expect(await code(() => newWidget(admin, wsA, list))).toBe('23514');
  });
});

describe('chat visitors and signals', () => {
  it('are the worker’s: the inbox reads what it shows and may block a visitor, and never sees a token hash', async () => {
    const visitorId = await newVisitor(wsA, orgA, widgetA);
    const conv = await chatConversation(wsA, orgA, visitorId);
    const [seen] = await as(member)((tx) =>
      rows(
        tx,
        sql`select name, phone_e164, email, last_page_path, conversation_id
            from app.chat_visitors where id = ${visitorId}`,
      ),
    );
    expect(seen).toEqual({
      name: 'Mike Alvarez',
      phone_e164: '+15125550199',
      email: 'mike@example.com',
      last_page_path: '/services/ac-repair',
      conversation_id: conv,
    });
    for (const column of ['token_hash', 'prev_token_hash', 'ip_hmac', 'turnstile_passed_at', '*'])
      expect(
        await code(() =>
          as(admin)((tx) =>
            tx.execute(
              sql`select ${sql.raw(column)} from app.chat_visitors where id = ${visitorId}`,
            ),
          ),
        ),
      ).toBe('42501');
    expect(
      await as(outsider)((tx) =>
        rows(tx, sql`select id from app.chat_visitors where id = ${visitorId}`),
      ),
    ).toHaveLength(0);

    // Only the worker makes or edits a visitor; the inbox blocks one, and can block its network too.
    expect(
      await code(() =>
        as(admin)((tx) =>
          tx.execute(sql`insert into app.chat_visitors (workspace_id, widget_id, token_hash)
            values (${wsA}, ${widgetA}, ${hash()})`),
        ),
      ),
    ).toBe('42501');
    expect(
      await code(() =>
        as(member)((tx) =>
          tx.execute(
            sql`update app.chat_visitors set name = 'Someone else' where id = ${visitorId}`,
          ),
        ),
      ),
    ).toBe('42501');
    const blocked = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.chat_visitors set blocked_at = now(), network_blocked_until = now() + interval '7 days'
            where id = ${visitorId} returning id`,
      ),
    );
    expect(blocked).toHaveLength(1);

    // "Typing" is the worker's alone, one row per chat, refreshed in place.
    const typing = () =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows(
          tx,
          sql`insert into app.chat_signals (workspace_id, conversation_id) values (${wsA}, ${conv})
              on conflict (conversation_id, kind) do update
                set signaled_at = now(), expires_at = now() + interval '8 seconds'
              returning kind`,
        ),
      );
    expect(await typing()).toEqual([{ kind: 'typing' }]);
    expect(await typing()).toEqual([{ kind: 'typing' }]);
    for (const statement of [
      sql`select * from app.chat_signals where conversation_id = ${conv}`,
      sql`insert into app.chat_signals (workspace_id, conversation_id) values (${wsA}, ${conv})`,
    ])
      expect(await code(() => as(admin)((tx) => tx.execute(statement)))).toBe('42501');
  });

  it('names a chat conversation chat:<visitor id>, and ties a visitor to its own chat only', async () => {
    const open = (counterpart: string, channel = 'chat') =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.conversations (workspace_id, channel, counterpart)
              values (${wsA}, ${channel}::app.channel, ${counterpart}) returning id`,
        ),
      ).then((r) => r[0]!.id);
    for (const counterpart of [
      'chat:short',
      'chat:has spaces!',
      `chat:${'x'.repeat(81)}`,
      '+15125550100',
      'visitor:12345678',
    ])
      expect(await code(() => open(counterpart))).toBe('23514');

    const visitorId = await newVisitor(wsA, orgA, widgetA);
    const someoneElse = await newVisitor(wsA, orgA, widgetA);
    const theirChat = await open(`chat:${someoneElse}`);
    const text = await open('+15125550123', 'sms');
    const link = (conversationId: string) =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        tx.execute(
          sql`update app.chat_visitors set conversation_id = ${conversationId} where id = ${visitorId}`,
        ),
      );
    for (const conversationId of [theirChat, text])
      expect(await failure(() => link(conversationId))).toEqual({
        code: '23514',
        detail: 'chat_conversation_mismatch',
      });
    const own = await open(`chat:${visitorId}`);
    await link(own);
    await worker(
      wsA,
      orgA,
    )((tx) =>
      tx.execute(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
        values (${wsA}, ${own}, 'chat', 'inbound', 'received', 'Do you service Lennox units?')`),
    );
  });
});

describe('the live feed', () => {
  it('gives the worker, and only the worker, new chat messages and typing, with who wrote them', async () => {
    const visitorId = await newVisitor(wsA, orgA, widgetA);
    const conv = await chatConversation(wsA, orgA, visitorId);
    // Raw rows carry timestamps as text; the feed takes them back cast.
    const [{ since, minuteAgo }] = (await rows<{ since: string; minuteAgo: string }>(
      dbs.admin.db,
      sql`select (now() - interval '1 second')::text as since, (now() - interval '61 seconds')::text as "minuteAgo"`,
    )) as [{ since: string; minuteAgo: string }];
    const say = (statement: ReturnType<typeof sql>) =>
      worker(wsA, orgA)((tx) => tx.execute(statement));
    await say(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
      values (${wsA}, ${conv}, 'chat', 'inbound', 'received', 'Is anyone there?')`);
    await say(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by_teammate_id)
      values (${wsA}, ${conv}, 'chat', 'outbound', 'sent', 'Hi! I am Ava, an AI assistant. How can I help?', ${teammateA})`);
    // A failed message never shows.
    await say(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by_teammate_id)
      values (${wsA}, ${conv}, 'chat', 'outbound', 'failed', 'Never delivered', ${teammateA})`);
    await as(member)((tx) =>
      tx.execute(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, sent_by)
        values (${wsA}, ${conv}, 'chat', 'outbound', 'queued', 'Sam here, I can help with that.', ${member.id})`),
    );
    await say(
      sql`insert into app.chat_signals (workspace_id, conversation_id) values (${wsA}, ${conv})`,
    );

    const feed = (from: string) =>
      asService({})((tx) =>
        rows<{ kind: string; body: string | null; sender: string; sender_name: string | null }>(
          tx,
          sql`select kind, body, sender, sender_name from private.chat_feed(${from}::timestamptz)
              where conversation_id = ${conv} order by occurred_at`,
        ),
      );
    expect(await feed(since)).toEqual([
      { kind: 'message', body: 'Is anyone there?', sender: 'visitor', sender_name: null },
      {
        kind: 'message',
        body: 'Hi! I am Ava, an AI assistant. How can I help?',
        sender: 'teammate',
        sender_name: 'Ava',
      },
      {
        kind: 'message',
        body: 'Sam here, I can help with that.',
        sender: 'person',
        sender_name: 'Test',
      },
      { kind: 'typing', body: null, sender: 'teammate', sender_name: null },
    ]);
    expect(
      await code(() =>
        as(member)((tx) => tx.execute(sql`select * from private.chat_feed(${since}::timestamptz)`)),
      ),
    ).toBe('42501');

    // Typing that has run out is gone.
    await say(sql`update app.chat_signals
      set signaled_at = now() - interval '20 seconds', expires_at = now() - interval '12 seconds'
      where conversation_id = ${conv}`);
    expect((await feed(minuteAgo)).map((r) => r.kind)).toEqual(['message', 'message', 'message']);
  });
});

describe('finding a widget by its key', () => {
  it('tells the worker, and only the worker, whose widget a key is and whether it’s paused', async () => {
    const widget = await newWidget(admin, wsA, ['https://lookup-test.com']);
    const lookup = (key: string) =>
      asService({})((tx) =>
        rows<{ widget_id: string; workspace_id: string; organization_id: string; paused: boolean }>(
          tx,
          sql`select * from private.chat_widget_lookup(${key})`,
        ),
      );
    expect(await lookup(widget.public_key)).toEqual([
      { widget_id: widget.id, workspace_id: wsA, organization_id: orgA, paused: false },
    ]);
    await as(admin)((tx) =>
      tx.execute(sql`update app.chat_widgets set paused_at = now() where id = ${widget.id}`),
    );
    expect(await lookup(widget.public_key)).toMatchObject([{ widget_id: widget.id, paused: true }]);
    // Anything that isn't a key, or a key nobody has, finds nothing.
    for (const key of [
      'wk_AAAAAAAAAAAAAAAAAAAA',
      widget.public_key.replace(/^wk_/, 'WK_'),
      `${widget.public_key}x`,
      "wk_' or true --",
      '',
    ])
      expect(await lookup(key)).toEqual([]);
    // A new key retires the old one.
    const [rotated] = await as(admin)((tx) =>
      rows<{ public_key: string }>(
        tx,
        sql`update app.chat_widgets set public_key = private.new_chat_widget_key()
            where id = ${widget.id} returning public_key`,
      ),
    );
    expect(await lookup(widget.public_key)).toEqual([]);
    expect(await lookup(rotated!.public_key)).toMatchObject([{ widget_id: widget.id }]);
    // People can't ask, even about their own business's widget.
    for (const user of [owner, admin, member, outsider])
      expect(
        await code(() =>
          as(user)((tx) =>
            tx.execute(sql`select * from private.chat_widget_lookup(${rotated!.public_key})`),
          ),
        ),
      ).toBe('42501');
  });
});

describe('references stay inside the workspace', () => {
  it('keeps widgets, visitors and signals inside their business', async () => {
    // A widget answers with its own business's teammate.
    expect(
      await failure(() =>
        as(admin)((tx) =>
          tx.execute(
            sql`update app.chat_widgets set teammate_id = ${teammateB} where id = ${widgetA}`,
          ),
        ),
      ),
    ).toEqual(mismatch);
    // Another business's worker can neither see A's visitors nor add one to A's widget.
    const visitorA = await newVisitor(wsA, orgA, widgetA);
    expect(
      await worker(
        wsB,
        orgB,
      )((tx) => rows(tx, sql`select id from app.chat_visitors where id = ${visitorA}`)),
    ).toHaveLength(0);
    const [personA] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsA}, 'Mike') returning id`,
      ),
    );
    const widgetB = await newWidget(outsider, wsB);
    const convA = await chatConversation(wsA, orgA, visitorA);
    for (const statement of [
      sql`insert into app.chat_visitors (workspace_id, widget_id, token_hash) values (${wsB}, ${widgetA}, ${hash()})`,
      sql`insert into app.chat_visitors (workspace_id, widget_id, token_hash, person_id)
          values (${wsB}, ${widgetB.id}, ${hash()}, ${personA!.id})`,
      sql`insert into app.chat_signals (workspace_id, conversation_id) values (${wsB}, ${convA})`,
    ])
      expect(await failure(() => worker(wsB, orgB)((tx) => tx.execute(statement)))).toEqual(
        mismatch,
      );
    // Signals go only on chats.
    const [text] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart)
            values (${wsA}, 'sms', '+15125550188') returning id`,
      ),
    );
    expect(
      await failure(() =>
        worker(
          wsA,
          orgA,
        )((tx) =>
          tx.execute(
            sql`insert into app.chat_signals (workspace_id, conversation_id) values (${wsA}, ${text!.id})`,
          ),
        ),
      ),
    ).toEqual(mismatch);
  });
});
