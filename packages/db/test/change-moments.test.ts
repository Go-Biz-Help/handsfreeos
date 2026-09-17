/**
 * 0062 on the local database: the times the database stamps for a person's own act are the moment the change was
 * made. The kernel names that moment for a change from the phone (app.occurred_at, for the transaction); otherwise it
 * is now, and it is never later than now.
 * - A lead enters a stage, and is won or lost, at the change's moment. A move made before the lead's latest stage
 *   change counts from now, when it moved the lead.
 * - An attention item is snoozed, dismissed and handled, and its automatic message cancelled, at the change's moment.
 * - A staff confirmation is marked at the change's moment.
 * A time written into these columns is still replaced, and the worker's writes are unchanged.
 */
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
  uniq,
  type TestUser,
} from './harness';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
/** Raw rows give times as text. */
const iso = (d: string | null) => (d === null ? null : new Date(d).toISOString());

let owner: TestUser;
let member: TestUser;
let wsId: string;
let orgId: string;
let pipelineId: string;
/** The default pipeline's stages: New, Contacted and Estimate sent are open, then Won and Lost. */
const stage: Record<'new' | 'contacted' | 'estimate' | 'won' | 'lost', string> = {
  new: '',
  contacted: '',
  estimate: '',
  won: '',
  lost: '',
};

const worker = () => asService({ workspaceId: wsId, organizationId: orgId });

/** A person's statement inside a transaction the kernel told the moment (or none, as the web's). */
const asPerson =
  (user: TestUser, moment: Date | null) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    as(user)(async (tx) => {
      if (moment)
        await tx.execute(sql`select set_config('app.occurred_at', ${moment.toISOString()}, true)`);
      return fn(tx);
    });

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('moment-owner'),
    createTestUser('moment-member'),
  ]);
  const org = await bootstrapOrganization(owner, 'Moment Org', 'Moment HVAC');
  wsId = org.wsId;
  orgId = org.orgId;
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: wsId, userId: member.id, role: 'member' }]);
  const list = await rows<{ id: string; name: string; pipeline_id: string }>(
    dbs.admin.db,
    sql`select id, name, pipeline_id from app.pipeline_stages where workspace_id = ${wsId} order by position`,
  );
  pipelineId = list[0]!.pipeline_id;
  const byName = new Map(list.map((s) => [s.name, s.id]));
  stage.new = byName.get('New')!;
  stage.contacted = byName.get('Contacted')!;
  stage.estimate = byName.get('Estimate sent')!;
  stage.won = byName.get('Won')!;
  stage.lost = byName.get('Lost')!;
});
afterAll(closeAll);

describe('the change’s moment', () => {
  it('is the moment the kernel named, never later than now, and now when it named none', async () => {
    const twoHoursAgo = ago(2 * HOUR);
    const moment = (at: Date | null) =>
      asPerson(
        member,
        at,
      )((tx) =>
        rows<{ at: string; now: string }>(
          tx,
          sql`select private.change_moment() as at, now() as now`,
        ),
      ).then((r) => r[0]!);
    const past = await moment(twoHoursAgo);
    expect(iso(past.at)).toBe(twoHoursAgo.toISOString());
    const ahead = await moment(new Date(Date.now() + 2 * HOUR));
    expect(iso(ahead.at)).toBe(iso(ahead.now));
    const none = await moment(null);
    expect(iso(none.at)).toBe(iso(none.now));
    // The worker never names one.
    const [byWorker] = await worker()((tx) =>
      rows<{ same: boolean }>(tx, sql`select private.change_moment() = now() as same`),
    );
    expect(byWorker!.same).toBe(true);
  });
});

describe('a lead’s stage', () => {
  type LeadTimes = {
    id: string;
    status: string;
    stage_entered_at: string;
    won_at: string | null;
    lost_at: string | null;
    recent: boolean;
  };
  const returning = sql`returning id, status::text as status, stage_entered_at, won_at, lost_at,
    stage_entered_at > now() - interval '1 minute' as recent`;
  async function newLead(moment: Date | null, stageId = stage.new): Promise<LeadTimes> {
    const [p] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsId}, ${`Rita ${uniq()}`}) returning id`,
      ),
    );
    const [lead] = await asPerson(
      member,
      moment,
    )((tx) =>
      rows<LeadTimes>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, lost_reason, created_by,
              stage_entered_at)
            values (${wsId}, ${pipelineId}, ${stageId}, ${p!.id}, 'Heat pump', 'Went elsewhere', ${member.id},
              '2020-01-01')
            ${returning}`,
      ),
    );
    return lead!;
  }
  const move = (moment: Date | null, id: string, set: string) =>
    asPerson(
      member,
      moment,
    )((tx) =>
      rows<LeadTimes>(tx, sql`update app.leads set ${sql.raw(set)} where id = ${id} ${returning}`),
    ).then((r) => r[0]!);

  it('enters a stage, and is won or lost, when the person made the change', async () => {
    const madeAt = ago(3 * HOUR);
    const lead = await newLead(madeAt);
    // Made then: the '2020-01-01' written in is replaced.
    expect(iso(lead.stage_entered_at)).toBe(madeAt.toISOString());

    const contactedAt = ago(2 * HOUR);
    const contacted = await move(contactedAt, lead.id, `stage_id = '${stage.contacted}'`);
    expect(iso(contacted.stage_entered_at)).toBe(contactedAt.toISOString());

    const wonAt = ago(HOUR);
    const won = await move(
      wonAt,
      lead.id,
      `stage_id = '${stage.won}', stage_entered_at = '2020-01-01', won_at = '2020-01-01'`,
    );
    expect(won).toMatchObject({ status: 'won' });
    expect(iso(won.stage_entered_at)).toBe(wonAt.toISOString());
    expect(iso(won.won_at)).toBe(wonAt.toISOString());

    // Something else about a won lead changes nothing about when it was won.
    const retitled = await move(null, lead.id, `title = 'Heat pump and ducts'`);
    expect(iso(retitled.won_at)).toBe(wonAt.toISOString());
    expect(iso(retitled.stage_entered_at)).toBe(wonAt.toISOString());

    // Lost from the web: now.
    const lost = await move(null, lead.id, `stage_id = '${stage.lost}', lost_reason = 'Too far'`);
    expect(lost).toMatchObject({ status: 'lost', won_at: null, recent: true });
    expect(iso(lost.lost_at)).toBe(iso(lost.stage_entered_at));

    // A lead in a won stage from the start was won when it was made.
    const already = await newLead(madeAt, stage.won);
    expect(iso(already.won_at)).toBe(madeAt.toISOString());
  });

  it('counts from now a move made before the lead’s latest stage change', async () => {
    const lead = await newLead(ago(5 * HOUR));
    // Someone moved it an hour ago…
    const movedAt = ago(HOUR);
    await move(movedAt, lead.id, `stage_id = '${stage.contacted}'`);
    // …and a phone's move made two hours ago arrives now: it moved the lead out of Contacted just now.
    const late = await move(ago(2 * HOUR), lead.id, `stage_id = '${stage.estimate}'`);
    expect(late.recent).toBe(true);
    expect(Date.parse(late.stage_entered_at)).toBeGreaterThan(movedAt.getTime());
  });

  it('leaves the worker’s moves on the database’s clock', async () => {
    const lead = await newLead(ago(3 * HOUR));
    const [moved] = await worker()((tx) =>
      rows<LeadTimes>(
        tx,
        sql`update app.leads set stage_id = ${stage.won}, won_at = '2020-01-01' where id = ${lead.id} ${returning}`,
      ),
    );
    expect(moved).toMatchObject({ status: 'won', recent: true });
    expect(iso(moved!.won_at)).toBe(iso(moved!.stage_entered_at));
  });
});

describe('an attention item', () => {
  type Stamps = {
    snoozed_at: string | null;
    dismissed_at: string | null;
    handled_at: string | null;
    auto_done_at: string | null;
    dismissed_recently: boolean | null;
  };
  async function openItem(): Promise<string> {
    const [item] = await worker()(async (tx) => {
      const [p] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsId}, 'Maria') returning id`,
      );
      const [l] = await rows<{ id: string }>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title)
            values (${wsId}, ${pipelineId}, ${stage.new}, ${p!.id}, 'AC replacement') returning id`,
      );
      return rows<{ id: string }>(
        tx,
        sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, person_id, lead_id, title,
              fingerprint, since_at)
            values (${wsId}, 'stale_opportunity', 'lead', ${l!.id}, ${p!.id}, ${l!.id}, 'Maria · AC replacement',
              ${`fp-${uniq()}`}, now() - interval '9 days')
            returning id`,
      );
    });
    return item!.id;
  }
  const change = (moment: Date | null, id: string, set: string) =>
    asPerson(
      member,
      moment,
    )((tx) =>
      rows<Stamps>(
        tx,
        sql`update app.attention_items set ${sql.raw(set)} where id = ${id}
            returning snoozed_at, dismissed_at, handled_at, auto_done_at,
              dismissed_at > now() - interval '1 minute' as dismissed_recently`,
      ),
    ).then((r) => r[0]!);

  it('is snoozed, dismissed, handled and its automatic message cancelled at the change’s moment', async () => {
    const madeAt = ago(2 * HOUR);
    const snoozed = await openItem();
    const snooze = await change(
      madeAt,
      snoozed,
      `state = 'snoozed', snoozed_until = now() + interval '1 hour', snoozed_by = '${member.id}', snoozed_at = '2020-01-01'`,
    );
    expect(iso(snooze.snoozed_at)).toBe(madeAt.toISOString());

    const dismissed = await openItem();
    const dismiss = await change(
      madeAt,
      dismissed,
      `state = 'dismissed', dismissed_at = '2020-01-01', dismissed_by = '${member.id}'`,
    );
    expect(iso(dismiss.dismissed_at)).toBe(madeAt.toISOString());

    const handled = await openItem();
    const handle = await change(
      madeAt,
      handled,
      `state = 'handled', handled_at = '2020-01-01', handled_by = '${member.id}', handled_via = 'let_handle'`,
    );
    expect(iso(handle.handled_at)).toBe(madeAt.toISOString());

    const waiting = await openItem();
    await worker()((tx) =>
      tx.execute(
        sql`update app.attention_items set auto_state = 'scheduled', auto_scheduled_for = now() + interval '1 hour'
            where id = ${waiting}`,
      ),
    );
    const cancel = await change(
      madeAt,
      waiting,
      `auto_state = 'cancelled', auto_cancelled_by = '${member.id}', auto_done_at = '2020-01-01'`,
    );
    expect(iso(cancel.auto_done_at)).toBe(madeAt.toISOString());

    // From the web, the database's clock, as before.
    const web = await openItem();
    const fromWeb = await change(
      null,
      web,
      `state = 'dismissed', dismissed_at = '2020-01-01', dismissed_by = '${member.id}'`,
    );
    expect(fromWeb.dismissed_recently).toBe(true);
  });
});

describe('a staff confirmation', () => {
  it('is marked at the change’s moment, whatever time is written in', async () => {
    const seat = await worker()(async (tx) => {
      const [c] = await rows<{ id: string }>(
        tx,
        sql`insert into app.calendars (workspace_id, name, slug, status, public)
            values (${wsId}, 'Tune-ups', ${`moment-${uniq().toLowerCase()}`}, 'active', true) returning id`,
      );
      const [a] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, kind, capacity, title,
              starts_at, ends_at, source)
            values (${wsId}, ${c!.id}, 1, 'booking', 1, 'AC tune-up', now() + interval '1 day',
              now() + interval '1 day 1 hour', 'booking_page')
            returning id`,
      );
      const [p] = await rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name) values (${wsId}, 'Mike') returning id`,
      );
      const [s] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, contact_phone_e164, sms_ok,
              source)
            values (${wsId}, ${a!.id}, ${p!.id}, '+17375559001', true, 'booking_page') returning id`,
      );
      return s!.id;
    });
    const madeAt = ago(2 * HOUR);
    const [marked] = await asPerson(
      member,
      madeAt,
    )((tx) =>
      rows<{ confirmed_at: string }>(
        tx,
        sql`update app.appointment_attendees
            set confirmed_at = '2020-01-01', confirmed_via = 'staff', confirmed_by = ${member.id}
            where id = ${seat} returning confirmed_at`,
      ),
    );
    expect(iso(marked!.confirmed_at)).toBe(madeAt.toISOString());
  });
});
