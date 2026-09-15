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

let owner: TestUser;
let member: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;

interface Customer {
  readonly personId: string | null;
  readonly companyId: string | null;
  readonly leadId: string;
}

type Actor = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('contact-owner'),
    createTestUser('contact-member'),
  ]);
  const a = await bootstrapOrganization(owner, 'Contact Org A', 'Contact A');
  A = { ws: a.wsId, org: a.orgId };
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: A.ws, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

async function freshBusiness(): Promise<Business> {
  const b = await bootstrapOrganization(owner, `Contact Org ${uniq()}`, `Contact ${uniq()}`);
  return { ws: b.wsId, org: b.orgId };
}

/** A lead the worker opens: for a new customer, an existing one, or a company; open unless told otherwise. */
function customer(
  b: Business,
  opts: { stage?: 'open' | 'won'; personId?: string; company?: boolean } = {},
): Promise<Customer> {
  return worker(b)(async (tx) => {
    let personId: string | null = opts.personId ?? null;
    let companyId: string | null = null;
    if (opts.company) {
      const [co] = await rows<{ id: string }>(
        tx,
        sql`insert into app.companies (workspace_id, name) values (${b.ws}, ${`Acme ${uniq()}`}) returning id`,
      );
      companyId = co!.id;
    } else if (!personId) {
      const [p] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${b.ws}, 'Maria') returning id`,
      );
      personId = p!.id;
    }
    const [stage] = await rows<{ id: string; pipeline_id: string }>(
      tx,
      sql`select id, pipeline_id from app.pipeline_stages
          where workspace_id = ${b.ws} and kind = ${opts.stage ?? 'open'}::app.stage_kind
          order by position limit 1`,
    );
    const [l] = await rows<{ id: string }>(
      tx,
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, company_id, title)
          values (${b.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${personId}, ${companyId}, 'AC replacement')
          returning id`,
    );
    return { personId, companyId, leadId: l!.id };
  });
}

/**
 * A timeline entry the worker records, `minutes` after `ofLead` was made (negative: before it), or from now
 * when there is no lead yet.
 */
function log(
  b: Business,
  entry: {
    kind: string;
    subtype?: string | null;
    minutes: number;
    ofLead?: string;
    personId?: string | null;
    companyId?: string | null;
    leadId?: string | null;
  },
): Promise<{ id: string }[]> {
  return worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.activities (workspace_id, kind, subtype, person_id, company_id, lead_id, occurred_at, actor_type)
          values (${b.ws}, ${entry.kind}::app.activity_kind, ${entry.subtype ?? null}, ${entry.personId ?? null},
            ${entry.companyId ?? null}, ${entry.leadId ?? null},
            coalesce((select created_at from app.leads where id = ${entry.ofLead ?? null}::uuid), now())
              + ${entry.minutes}::float8 * interval '1 minute',
            'system')
          returning id`,
    ),
  );
}

type Contact = { last: number | null; first: number | null };
/** A lead's last contact and first response, in minutes after the lead was made. */
const contactOf = (leadId: string) =>
  rows<Contact>(
    dbs.admin.db,
    sql`select extract(epoch from last_contact_at - created_at)::float8 / 60 as last,
          extract(epoch from first_response_at - created_at)::float8 / 60 as first
        from app.leads where id = ${leadId}`,
  ).then((r) => r[0]!);
const snapshot = (b: Business) =>
  rows<Contact & { id: string }>(
    dbs.admin.db,
    sql`select id, extract(epoch from last_contact_at - created_at)::float8 / 60 as last,
          extract(epoch from first_response_at - created_at)::float8 / 60 as first
        from app.leads where workspace_id = ${b.ws}`,
  ).then((r) => Object.fromEntries(r.map(({ id, ...c }) => [id, c])));

describe('what counts as contact', () => {
  it('texts, emails, chats, connected calls, voicemails and visits, either way; not missed calls, notes or system entries', async () => {
    const c = await customer(A);
    const on = { personId: c.personId, ofLead: c.leadId };
    await log(A, { kind: 'sms', subtype: 'inbound', minutes: 1, ...on });
    expect(await contactOf(c.leadId)).toEqual({ last: 1, first: null });
    for (const [kind, subtype, minutes] of [
      ['call', 'missed', 2],
      ['call', 'outbound_missed', 3],
      ['note', null, 4],
      ['system', 'lead_created', 5],
    ] as const)
      await log(A, { kind, subtype, minutes, ...on });
    expect(await contactOf(c.leadId)).toEqual({ last: 1, first: null });
    await log(A, { kind: 'email', subtype: 'outbound', minutes: 6, ...on });
    expect(await contactOf(c.leadId)).toEqual({ last: 6, first: 6 });
    // The first response is set once.
    await log(A, { kind: 'sms', subtype: 'outbound', minutes: 7, ...on });
    expect(await contactOf(c.leadId)).toEqual({ last: 7, first: 6 });
    await log(A, { kind: 'call', subtype: 'answered', minutes: 8, ...on });
    await log(A, { kind: 'chat', subtype: 'inbound', minutes: 9, ...on });
    await log(A, { kind: 'call', subtype: 'voicemail', minutes: 10, ...on });
    expect(await contactOf(c.leadId)).toEqual({ last: 10, first: 6 });
    // A visit someone logged on the lead.
    await as(member)((tx) =>
      tx.execute(sql`insert into app.activities (workspace_id, kind, lead_id, body, occurred_at, author_user_id, actor_type)
        values (${A.ws}, 'visit', ${c.leadId}, 'Measured the attic',
          (select created_at from app.leads where id = ${c.leadId}) + interval '11 minutes', ${member.id}, 'human')`),
    );
    expect(await contactOf(c.leadId)).toEqual({ last: 11, first: 6 });
    // Last contact only moves forward: an older entry recorded late changes nothing.
    await log(A, { kind: 'sms', subtype: 'inbound', minutes: -24 * 60, ...on });
    expect(await contactOf(c.leadId)).toEqual({ last: 11, first: 6 });
  });

  it('a first response is the first reach-out once the lead existed, never earlier than the lead', async () => {
    // A call already under way when someone made the lead counts, from the moment the lead was made.
    const during = await customer(A);
    await log(A, {
      kind: 'call',
      subtype: 'outbound',
      minutes: -3,
      personId: during.personId,
      ofLead: during.leadId,
    });
    expect(await contactOf(during.leadId)).toEqual({ last: -3, first: 0 });
    // A customer who called in and got an answer has had a response.
    const answered = await customer(A);
    await log(A, {
      kind: 'call',
      subtype: 'answered',
      minutes: 2,
      personId: answered.personId,
      ofLead: answered.leadId,
    });
    expect(await contactOf(answered.leadId)).toEqual({ last: 2, first: 2 });
    // A voicemail is the customer's contact, not a response. It may arrive after the call was logged as missed.
    const voicemail = await customer(A);
    const [missed] = await log(A, {
      kind: 'call',
      subtype: 'missed',
      minutes: 4,
      personId: voicemail.personId,
      ofLead: voicemail.leadId,
    });
    expect(await contactOf(voicemail.leadId)).toEqual({ last: null, first: null });
    await dbs.admin.db.execute(
      sql`update app.activities set subtype = 'voicemail' where id = ${missed!.id}`,
    );
    expect(await contactOf(voicemail.leadId)).toEqual({ last: 4, first: null });
  });

  it('an entry on a lead updates that lead; one on a customer or company updates their open leads', async () => {
    const open = await customer(A);
    const won = await customer(A, { stage: 'won', personId: open.personId! });
    const someoneElse = await customer(A);
    const company = await customer(A, { company: true });
    await log(A, {
      kind: 'sms',
      subtype: 'inbound',
      minutes: 5,
      personId: open.personId,
      ofLead: open.leadId,
    });
    expect(await contactOf(open.leadId)).toEqual({ last: 5, first: null });
    expect(await contactOf(won.leadId)).toEqual({ last: null, first: null });
    expect(await contactOf(someoneElse.leadId)).toEqual({ last: null, first: null });
    // An entry that names a lead goes to that lead alone, won or not.
    await log(A, {
      kind: 'email',
      subtype: 'outbound',
      minutes: 30,
      personId: open.personId,
      leadId: won.leadId,
      ofLead: won.leadId,
    });
    expect(await contactOf(won.leadId)).toEqual({ last: 30, first: 30 });
    expect(await contactOf(open.leadId)).toEqual({ last: 5, first: null });
    // A call someone logged against the company (no subtype) is the business reaching out.
    await log(A, {
      kind: 'call',
      minutes: 3,
      companyId: company.companyId,
      ofLead: company.leadId,
    });
    expect(await contactOf(company.leadId)).toEqual({ last: 3, first: 3 });
  });
});

describe('who writes it', () => {
  it('nobody writes last contact directly, the worker included; other edits go through', async () => {
    const c = await customer(A);
    const protectedContact = { code: '42501', detail: 'lead_contact_protected' };
    for (const actor of [as(member), worker(A)] as Actor[])
      for (const set of ['last_contact_at = now()', 'first_response_at = now()'])
        expect(
          await failure(() =>
            actor((tx) =>
              tx.execute(sql`update app.leads set ${sql.raw(set)} where id = ${c.leadId}`),
            ),
          ),
        ).toEqual(protectedContact);
    expect(
      await failure(() =>
        worker(A)((tx) =>
          tx.execute(sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, last_contact_at)
            select ${A.ws}, s.pipeline_id, s.id, ${c.personId}, 'Duct cleaning', now()
            from app.pipeline_stages s where s.workspace_id = ${A.ws} and s.kind = 'open' limit 1`),
        ),
      ),
    ).toEqual(protectedContact);
    await as(member)((tx) =>
      tx.execute(
        sql`update app.leads set title = 'AC replacement (2 units)' where id = ${c.leadId}`,
      ),
    );
  });
});

describe('the backfill', () => {
  it('gives existing leads what the trigger would have, and only the owner runs it', async () => {
    const b = await freshBusiness();
    // Texted before there was a lead: the customer's contact, but not this lead's.
    const [early] = await worker(b)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${b.ws}, 'Early') returning id`,
      ),
    );
    await log(b, { kind: 'sms', subtype: 'inbound', minutes: 0, personId: early!.id });
    const first = await customer(b, { personId: early!.id });
    await log(b, {
      kind: 'sms',
      subtype: 'outbound',
      minutes: 2,
      personId: early!.id,
      ofLead: first.leadId,
    });
    await log(b, {
      kind: 'sms',
      subtype: 'inbound',
      minutes: 5,
      personId: early!.id,
      ofLead: first.leadId,
    });
    // Won, then texted: a closed lead keeps the contact it had.
    const won = await customer(b, { stage: 'won' });
    await log(b, {
      kind: 'sms',
      subtype: 'inbound',
      minutes: 60,
      personId: won.personId,
      ofLead: won.leadId,
    });
    // A company's lead, with a call logged by hand.
    const company = await customer(b, { company: true });
    await log(b, {
      kind: 'call',
      minutes: 3,
      companyId: company.companyId,
      ofLead: company.leadId,
    });
    // A visit logged on the lead for before it was made, and a call under way when it was made.
    const visited = await customer(b);
    await log(b, { kind: 'visit', minutes: -10, leadId: visited.leadId, ofLead: visited.leadId });
    const called = await customer(b);
    await log(b, {
      kind: 'call',
      subtype: 'outbound',
      minutes: -3,
      personId: called.personId,
      ofLead: called.leadId,
    });
    // A voicemail that arrived after its call was logged as missed.
    const voicemail = await customer(b);
    const [missed] = await log(b, {
      kind: 'call',
      subtype: 'missed',
      minutes: 1,
      personId: voicemail.personId,
      ofLead: voicemail.leadId,
    });
    await dbs.admin.db.execute(
      sql`update app.activities set subtype = 'voicemail' where id = ${missed!.id}`,
    );
    // And a lead nobody has contacted.
    const quiet = await customer(b);

    const byTrigger = await snapshot(b);
    expect(byTrigger).toEqual({
      [first.leadId]: { last: 5, first: 2 },
      [won.leadId]: { last: null, first: null },
      [company.leadId]: { last: 3, first: 3 },
      [visited.leadId]: { last: -10, first: 0 },
      [called.leadId]: { last: -3, first: 0 },
      [voicemail.leadId]: { last: 1, first: null },
      [quiet.leadId]: { last: null, first: null },
    });

    // Forget it all, then backfill: the same answers, for this business only.
    await dbs.admin.db.execute(
      sql`update app.leads set last_contact_at = null, first_response_at = null where workspace_id = ${b.ws}`,
    );
    const backfill = () =>
      rows<{ updated: number }>(
        dbs.admin.db,
        sql`select private.backfill_lead_contact(${b.ws}::uuid) as updated`,
      ).then((r) => r[0]!.updated);
    expect(await backfill()).toBe(5);
    expect(await snapshot(b)).toEqual(byTrigger);
    expect(await backfill()).toBe(0);

    for (const actor of [as(owner), worker(b)] as Actor[])
      expect(
        await code(() =>
          actor((tx) => rows(tx, sql`select private.backfill_lead_contact(${b.ws}::uuid)`)),
        ),
      ).toBe('42501');
  });

  it('indexes a business’s leads by status and last contact', async () => {
    const [idx] = await rows<{ def: string }>(
      dbs.admin.db,
      sql`select indexdef as def from pg_indexes where schemaname = 'app' and indexname = 'leads_last_contact_idx'`,
    );
    expect(idx?.def).toContain('(workspace_id, status, last_contact_at)');
  });
});
