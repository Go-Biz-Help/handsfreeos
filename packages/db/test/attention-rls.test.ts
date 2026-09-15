import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
/** Workspace A's admin. */
let admin: TestUser;
let member: TestUser;
/** Org B's owner. */
let outsider: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;

interface Customer {
  readonly personId: string;
  readonly leadId: string;
  readonly conversationId: string;
}

type Actor = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const mismatch = { code: '23514', detail: 'record_workspace_mismatch' };
const actorMismatch = { code: '42501', detail: 'attention_actor_mismatch' };
const transition = { code: '42501', detail: 'attention_state_transition' };
const autoProtected = { code: '42501', detail: 'attention_auto_protected' };

let phones = 0;
const nextPhone = () => `+1512555${String(1000 + ++phones)}`;

beforeAll(async () => {
  [owner, admin, member, outsider] = await Promise.all([
    createTestUser('attn-owner'),
    createTestUser('attn-admin'),
    createTestUser('attn-member'),
    createTestUser('attn-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Attention Org A', 'Attention A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Attention Org B', 'Attention B');
  B = { ws: b.wsId, org: b.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: admin.id, role: 'admin' },
    { workspaceId: A.ws, userId: member.id, role: 'member' },
  ]);
});
afterAll(closeAll);

/** A customer with an open lead and a text conversation, as the worker would find them. */
function customer(b: Business): Promise<Customer> {
  return worker(b)(async (tx) => {
    const [p] = await rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${b.ws}, 'Maria', 'Lopez') returning id`,
    );
    const [stage] = await rows<{ id: string; pipeline_id: string }>(
      tx,
      sql`select id, pipeline_id from app.pipeline_stages
          where workspace_id = ${b.ws} and kind = 'open' order by position limit 1`,
    );
    const [l] = await rows<{ id: string }>(
      tx,
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, value_cents)
          values (${b.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${p!.id}, 'AC replacement', 1850000) returning id`,
    );
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.conversations (workspace_id, channel, counterpart)
          values (${b.ws}, 'sms', ${nextPhone()}) returning id`,
    );
    return { personId: p!.id, leadId: l!.id, conversationId: c!.id };
  });
}

/** An item the worker opens about a customer's lead: a hot lead unless told otherwise. */
async function openItem(b: Business, c: Customer, kind = 'hot_lead'): Promise<string> {
  const reasons = JSON.stringify([{ label: '$18,500' }, { label: 'waiting 11 min' }]);
  const [row] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, person_id, lead_id,
            conversation_id, title, fingerprint, value_cents, probability, confidence, reasons, since_at)
          values (${b.ws}, ${kind}, 'lead', ${c.leadId}, ${c.personId}, ${c.leadId}, ${c.conversationId},
            'Maria Lopez · AC replacement', ${`fp-${uniq()}`}, 1850000, 0.6, 0.9, ${reasons}::jsonb,
            now() - interval '11 minutes')
          returning id`,
    ),
  );
  return row!.id;
}

/** A person's update, as their command would run it. */
const change = (user: TestUser, id: string, set: string) =>
  as(user)((tx) =>
    rows(tx, sql`update app.attention_items set ${sql.raw(set)} where id = ${id} returning id`),
  );
const byWorker = (b: Business, id: string, set: string) =>
  worker(b)((tx) =>
    tx.execute(sql`update app.attention_items set ${sql.raw(set)} where id = ${id}`),
  );

type Stamps = {
  state: string;
  assignee_user_id: string | null;
  snoozed_by: string | null;
  snoozed_recently: boolean | null;
  dismissed_by: string | null;
  dismiss_reason: string | null;
  dismissed_recently: boolean | null;
  handled_by: string | null;
  handled_via: string | null;
  handled_recently: boolean | null;
  auto_state: string | null;
  auto_cancelled_by: string | null;
  auto_done_recently: boolean | null;
};
/** "Recently" means stamped by the database just now, not whatever the caller sent. */
const stamps = (id: string) =>
  rows<Stamps>(
    dbs.admin.db,
    sql`select state::text as state, assignee_user_id,
          snoozed_by, snoozed_at > now() - interval '1 minute' as snoozed_recently,
          dismissed_by, dismiss_reason, dismissed_at > now() - interval '1 minute' as dismissed_recently,
          handled_by, handled_via, handled_at > now() - interval '1 minute' as handled_recently,
          auto_state, auto_cancelled_by, auto_done_at > now() - interval '1 minute' as auto_done_recently
        from app.attention_items where id = ${id}`,
  ).then((r) => r[0]!);

describe('who sees the list, and who writes it', () => {
  it('everyone in the business reads its items; outsiders and another business’s worker see none', async () => {
    const id = await openItem(A, await customer(A));
    const sees = (actor: Actor) =>
      actor((tx) => rows(tx, sql`select id from app.attention_items where id = ${id}`)).then(
        (r) => r.length,
      );
    expect(await sees(as(member))).toBe(1);
    expect(await sees(as(admin))).toBe(1);
    expect(await sees(as(owner))).toBe(1);
    expect(await sees(as(outsider))).toBe(0);
    expect(await sees(worker(B))).toBe(0);
    expect(await sees(asService({}))).toBe(0);
    // Nor can an outsider act on one: their update finds nothing.
    expect(await change(outsider, id, `assignee_user_id = '${outsider.id}'`)).toHaveLength(0);
  });

  it('only the worker adds and removes items, and only for the business it works for', async () => {
    const c = await customer(A);
    const insert = (actor: Actor) =>
      actor((tx) =>
        tx.execute(sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, lead_id, title, fingerprint)
          values (${A.ws}, 'stale_opportunity', 'lead', ${c.leadId}, ${c.leadId}, 'No contact in 9 days', 'fp')`),
      );
    for (const user of [owner, admin, member])
      expect(await code(() => insert(as(user)))).toBe('42501');
    expect(await code(() => insert(worker(B)))).toBe('42501');
    expect(await code(() => insert(asService({})))).toBe('42501');
    await insert(worker(A));
    const [row] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`select id from app.attention_items where lead_id = ${c.leadId} and kind = 'stale_opportunity'`,
    );
    const remove = (actor: Actor) =>
      actor((tx) =>
        rows(tx, sql`delete from app.attention_items where id = ${row!.id} returning id`),
      );
    for (const user of [owner, member]) expect(await code(() => remove(as(user)))).toBe('42501');
    expect(await remove(worker(B))).toHaveLength(0);
    expect(await remove(worker(A))).toHaveLength(1);
  });

  it('keeps one row per business, kind and subject, and only the eight kinds', async () => {
    const c = await customer(A);
    await openItem(A, c);
    expect(await code(() => openItem(A, c))).toBe('23505');
    // How the worker upserts: a second detection inserts nothing.
    const again = await worker(A)((tx) =>
      rows(
        tx,
        sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
            values (${A.ws}, 'hot_lead', 'lead', ${c.leadId}, 'Hot lead', 'fp-again')
            on conflict (workspace_id, kind, subject_type, subject_id) do nothing returning id`,
      ),
    );
    expect(again).toHaveLength(0);
    // The same lead may carry other kinds; core shows only the highest as a card.
    await openItem(A, c, 'unanswered_lead');
    for (const kind of ['overdue_invoice', 'HOT_LEAD', ''])
      expect(await code(() => openItem(A, c, kind))).toBe('23514');
  });
});

describe('what people change', () => {
  it('a member snoozes, dismisses, assigns and handles in their own name, on the database’s clock', async () => {
    const id = await openItem(A, await customer(A));
    // Snooze for an hour (a made-up "when" is replaced), then unsnooze.
    expect(
      await change(
        member,
        id,
        `state = 'snoozed', snoozed_until = now() + interval '1 hour', snoozed_by = '${member.id}', snoozed_at = '2020-01-01'`,
      ),
    ).toHaveLength(1);
    expect(await stamps(id)).toMatchObject({
      state: 'snoozed',
      snoozed_by: member.id,
      snoozed_recently: true,
    });
    await change(
      member,
      id,
      `state = 'open', snoozed_until = null, snoozed_at = null, snoozed_by = null`,
    );
    // Dismiss with a reason, then restore it (Undo).
    await change(
      member,
      id,
      `state = 'dismissed', dismissed_at = '2020-01-01', dismissed_by = '${member.id}', dismiss_reason = 'Already called her'`,
    );
    expect(await stamps(id)).toMatchObject({
      state: 'dismissed',
      dismissed_by: member.id,
      dismiss_reason: 'Already called her',
      dismissed_recently: true,
    });
    await change(
      member,
      id,
      `state = 'open', dismissed_at = null, dismissed_by = null, dismiss_reason = null`,
    );
    // Hand it to a teammate.
    await change(member, id, `assignee_user_id = '${admin.id}'`);
    // Handle it, Undo, then handle it through Let HandsFreeOS Handle.
    await change(
      member,
      id,
      `state = 'handled', handled_at = '2020-01-01', handled_by = '${member.id}', handled_via = 'person'`,
    );
    expect(await stamps(id)).toMatchObject({
      state: 'handled',
      handled_by: member.id,
      handled_via: 'person',
      handled_recently: true,
      assignee_user_id: admin.id,
    });
    await change(
      member,
      id,
      `state = 'open', handled_at = null, handled_by = null, handled_via = null`,
    );
    await change(
      admin,
      id,
      `state = 'handled', handled_at = now(), handled_by = '${admin.id}', handled_via = 'let_handle'`,
    );
    expect(await stamps(id)).toMatchObject({
      state: 'handled',
      handled_by: admin.id,
      handled_via: 'let_handle',
    });
  });

  it('cancels an automatic action while it waits, in their own name, and nothing more about it', async () => {
    const id = await openItem(A, await customer(A), 'stale_opportunity');
    await byWorker(
      A,
      id,
      "auto_state = 'scheduled', auto_scheduled_for = now() + interval '60 minutes'",
    );
    expect(
      await failure(() =>
        change(
          member,
          id,
          `auto_state = 'cancelled', auto_cancelled_by = '${admin.id}', auto_done_at = now()`,
        ),
      ),
    ).toEqual(autoProtected);
    expect(
      await failure(() => change(member, id, `auto_state = 'sent', auto_done_at = now()`)),
    ).toEqual(autoProtected);
    expect(
      await change(
        member,
        id,
        `auto_state = 'cancelled', auto_cancelled_by = '${member.id}', auto_done_at = '2020-01-01'`,
      ),
    ).toHaveLength(1);
    expect(await stamps(id)).toMatchObject({
      auto_state: 'cancelled',
      auto_cancelled_by: member.id,
      auto_done_recently: true,
    });
    // Done is done. (The worker locks the item before it sends, so a late Cancel finds it sent.)
    expect(
      await failure(() =>
        change(
          member,
          id,
          `auto_state = 'scheduled', auto_cancelled_by = null, auto_done_at = null`,
        ),
      ),
    ).toEqual(autoProtected);
    // With nothing waiting there is nothing to cancel, and people never schedule one.
    const other = await openItem(A, await customer(A), 'stale_opportunity');
    expect(
      await failure(() =>
        change(
          member,
          other,
          `auto_state = 'cancelled', auto_cancelled_by = '${member.id}', auto_done_at = now()`,
        ),
      ),
    ).toEqual(autoProtected);
    expect(await failure(() => change(member, other, `auto_state = 'scheduled'`))).toEqual(
      autoProtected,
    );
  });

  it('refuses what the worker owns, and anything done in someone else’s name', async () => {
    const id = await openItem(A, await customer(A));
    // The facts, the score, the fingerprint, the alert and the resolution aren't granted.
    for (const set of [
      "kind = 'overdue_task'",
      "title = 'Nothing to see'",
      "fingerprint = 'mine'",
      'value_cents = 0',
      'probability = 0',
      "reasons = '[]'",
      'due_at = null',
      'urgent_from = null',
      'opened_at = now()',
      "resolution = 'replied'",
      'alerted_at = now()',
      'handled_until = now()',
      "auto_skip_reason = 'opted_out'",
      'auto_scheduled_for = now()',
    ])
      expect(await code(() => change(member, id, set))).toBe('42501');
    expect(
      await failure(() =>
        change(
          member,
          id,
          `state = 'snoozed', snoozed_until = now() + interval '1 hour', snoozed_by = '${admin.id}', snoozed_at = now()`,
        ),
      ),
    ).toEqual(actorMismatch);
    expect(
      await failure(() =>
        change(
          member,
          id,
          `state = 'dismissed', dismissed_at = now(), dismissed_by = '${admin.id}'`,
        ),
      ),
    ).toEqual(actorMismatch);
    expect(
      await failure(() =>
        change(
          member,
          id,
          `state = 'handled', handled_at = now(), handled_by = '${admin.id}', handled_via = 'person'`,
        ),
      ),
    ).toEqual(actorMismatch);
    // A snooze runs to a time ahead, at most 30 days (31 with slack).
    for (const until of ["now() - interval '1 minute'", "now() + interval '40 days'"])
      expect(
        await failure(() =>
          change(
            member,
            id,
            `state = 'snoozed', snoozed_until = ${until}, snoozed_by = '${member.id}', snoozed_at = now()`,
          ),
        ),
      ).toEqual({ code: '22023', detail: 'attention_snooze_range' });
    // Never "handled by HandsFreeOS" by hand, with or without a name on it.
    for (const by of ['null', `'${member.id}'`])
      expect(
        await failure(() =>
          change(
            member,
            id,
            `state = 'handled', handled_at = now(), handled_by = ${by}, handled_via = 'auto'`,
          ),
        ),
      ).toEqual({ code: '42501', detail: 'attention_handled_via' });
    // Nobody resolves an item by hand.
    expect(await failure(() => change(member, id, `state = 'resolved'`))).toEqual(transition);
    // Nobody rewrites who handled one.
    await change(
      member,
      id,
      `state = 'handled', handled_at = now(), handled_by = '${member.id}', handled_via = 'person'`,
    );
    const rewrite = { code: '42501', detail: 'attention_handled_protected' };
    expect(await failure(() => change(admin, id, `handled_by = '${admin.id}'`))).toEqual(rewrite);
    expect(await failure(() => change(member, id, `handled_via = 'let_handle'`))).toEqual(rewrite);
  });

  it('leaves resolved items, and items HandsFreeOS handled on its own, to the worker', async () => {
    const id = await openItem(A, await customer(A), 'stale_opportunity');
    // HandsFreeOS sent the nudge: handled on its own for now.
    await byWorker(
      A,
      id,
      `state = 'handled', handled_at = now(), handled_via = 'auto', handled_until = now() + interval '3 days',
        auto_state = 'sent', auto_scheduled_for = now(), auto_done_at = now()`,
    );
    for (const set of [
      `state = 'open', handled_at = null, handled_via = null`,
      `state = 'dismissed', handled_at = null, handled_via = null, dismissed_at = now(), dismissed_by = '${member.id}'`,
    ])
      expect(await failure(() => change(member, id, set))).toEqual(transition);
    // Someone may still take it on.
    expect(await change(member, id, `assignee_user_id = '${member.id}'`)).toHaveLength(1);
    // Resolved: its facts stopped holding. Only the worker reopens it.
    await byWorker(
      A,
      id,
      `state = 'resolved', resolved_at = now(), resolution = 'replied', handled_at = null, handled_via = null,
        handled_until = null`,
    );
    expect(await failure(() => change(member, id, `state = 'open'`))).toEqual(transition);
    await byWorker(
      A,
      id,
      `state = 'open', resolved_at = null, resolution = null, opened_at = now()`,
    );
    expect((await stamps(id)).state).toBe('open');
  });
});

describe('the worker’s writes', () => {
  it('keeps each state’s fields with it, and an item’s kind and subject for life', async () => {
    const c = await customer(A);
    const id = await openItem(A, c, 'missing_next_action');
    for (const set of [
      "state = 'snoozed'",
      'snoozed_until = now()',
      "state = 'dismissed'",
      "dismiss_reason = 'Not a fit'",
      "state = 'handled', handled_at = now()",
      `state = 'handled', handled_at = now(), handled_via = 'auto', handled_by = '${member.id}'`,
      "state = 'resolved'",
      "resolution = 'replied'",
      "auto_state = 'scheduled'",
      "auto_state = 'sent'",
      "auto_skip_reason = 'opted_out'",
      `auto_cancelled_by = '${member.id}'`,
      "alert_fingerprint = 'fp'",
      'probability = 1.5',
      "reasons = '{}'",
      "title = ' '",
      "subject_type = 'Lead!'",
    ])
      expect(await code(() => byWorker(A, id, set))).toBe('23514');
    await byWorker(
      A,
      id,
      "auto_state = 'skipped', auto_done_at = now(), auto_skip_reason = 'opted_out'",
    );
    await byWorker(A, id, "alert_fingerprint = 'fp-1', alerted_at = now()");
    for (const set of [
      "kind = 'hot_lead'",
      `subject_id = '${c.personId}'`,
      "subject_type = 'person'",
    ])
      expect(await code(() => byWorker(A, id, set))).toBe('23514');
  });
});

describe('references stay inside the business', () => {
  it('refuses another business’s customer, lead, conversation or people, whoever writes', async () => {
    const a = await customer(A);
    const b = await customer(B);
    for (const [column, value] of [
      ['person_id', a.personId],
      ['lead_id', a.leadId],
      ['conversation_id', a.conversationId],
      ['assignee_user_id', member.id],
    ] as const)
      expect(
        await failure(() =>
          worker(B)((tx) =>
            tx.execute(sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, ${sql.raw(column)}, title, fingerprint)
              values (${B.ws}, 'hot_lead', 'lead', ${b.leadId}, ${value}, 'Hot lead', 'fp')`),
          ),
        ),
      ).toEqual(mismatch);

    const id = await openItem(A, a);
    expect(await failure(() => change(member, id, `assignee_user_id = '${outsider.id}'`))).toEqual(
      mismatch,
    );
    expect(await failure(() => byWorker(A, id, `lead_id = '${b.leadId}'`))).toEqual(mismatch);

    // Someone who leaves doesn't freeze the items they touched: only references that change are checked.
    const leaver = await createTestUser('attn-leaver');
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values([{ workspaceId: A.ws, userId: leaver.id, role: 'member' }]);
    await change(
      leaver,
      id,
      `state = 'dismissed', dismissed_at = now(), dismissed_by = '${leaver.id}'`,
    );
    await dbs.admin.db.execute(
      sql`delete from app.workspace_memberships where workspace_id = ${A.ws} and user_id = ${leaver.id}`,
    );
    await byWorker(
      A,
      id,
      `title = 'Maria Lopez · still waiting', assignee_user_id = '${admin.id}'`,
    );
    expect(await failure(() => change(member, id, `assignee_user_id = '${leaver.id}'`))).toEqual(
      mismatch,
    );
  });
});

describe('indexes', () => {
  it('indexes every foreign key the Action Center added, leading with its column', async () => {
    // A partial index counts only when it covers every row that has a key ("where <key> is not null").
    const keys = await rows<{ tbl: string; col: string; indexed: boolean }>(
      dbs.admin.db,
      sql`select cl.relname::text as tbl, a.attname::text as col,
            exists (
              select 1 from pg_index i
              where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
                and (i.indpred is null or pg_get_expr(i.indpred, i.indrelid) = '(' || a.attname || ' IS NOT NULL)')
            ) as indexed
          from pg_constraint c
          join pg_class cl on cl.oid = c.conrelid
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
          where c.contype = 'f' and c.connamespace = 'app'::regnamespace and cardinality(c.conkey) = 1`,
    );
    const ours = keys.filter(
      (k) =>
        k.tbl === 'attention_items' ||
        (k.tbl === 'appointment_attendees' && k.col === 'confirmed_by'),
    );
    expect(ours).toHaveLength(10);
    expect(ours.filter((k) => !k.indexed)).toEqual([]);
  });
});
