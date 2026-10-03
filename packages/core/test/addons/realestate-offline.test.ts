/**
 * Real Estate Agent with no signal (round six, boards 76–93): the commands a phone may keep waiting, and each one
 * right when it arrives late.
 *
 * - **Anytime** changes count with the moment they were made on the phone: a duty marked done, a contingency resolved,
 *   a financing step's day.
 * - **What the phone makes keeps its id**: proof, a document, an inspection and its finding, a contingency, a client's
 *   task, a showing. Sent again, it's the same one; the id on something else can't be used.
 * - **What reaches a client or another agent** goes while fresh and asks "Still send?" after 30 minutes.
 * - **An exception needs signal** even inside a command that can wait: a contingency recorded without its form.
 * - **What someone said themselves** after the phone noted it stays: a buyer's agent's own feedback.
 * - The phone's list of commands (`PHONE_COMMANDS`) gives each Real Estate command the class the server does.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_COMMANDS } from '../../../../apps/mobile/src/changes/commands';
import { localDateOf } from '../../src/calendar/engine/zoned';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { HfosError } from '../../src/errors';
import type { RequestMeta } from '../../src/kernel/types';
import { FRESH_MINUTES } from '../../src/mobile';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  personCreate,
  registry,
  type CommandDef,
  type HumanActor,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const MIN = 60_000;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const ago = (ms: number) => new Date(Date.now() - ms);
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) => realestateAddonServer.commands!.find((x) => x.name === name)!;

/** A change made with signal, on the web. */
const web = (name: string, input: Record<string, unknown>, as: TestUser = agent): Promise<Any> =>
  executeCommand(api(), op(name) as CommandDef, { workspaceId: ws, ...input }, human(as), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);

interface PhoneOpts {
  readonly occurredAt?: Date;
  readonly confirmedAt?: Date | null;
  readonly as?: TestUser;
}
/** A change made on the phone and sent when it had signal: its own command id, and the moment it was made. */
const phone = (
  name: string,
  input: Record<string, unknown>,
  opts: PhoneOpts = {},
): Promise<Any> => {
  const meta: RequestMeta = {
    correlationId: randomUUID(),
    channel: 'mobile',
    commandId: randomUUID(),
    occurredAt: opts.occurredAt ?? new Date(),
    sentAt: new Date(),
    confirmedAt: opts.confirmedAt ?? null,
    appVersion: '1.0.0',
  };
  return executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(opts.as ?? agent),
    meta,
  ).then((r) => r.output);
};

/** A timestamp column read as its ISO text, named as itself. */
const iso = (column: string) => sql.raw(`to_json(${column}) #>> '{}' as ${column}`);
/** Whether a timestamp read from the database is this moment, to the millisecond. */
const same = (stored: string, at: Date) => new Date(stored).getTime() === at.getTime();

async function refused(p: Promise<unknown>): Promise<HfosError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let ws: string;
let timeZone: string;
let deal: string;
let other: string;
let listing: string;
let linh: string;

/** A photo on a deal, uploaded as the phone does it. */
async function photoOn(dealId: string, name: string): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType: 'image/jpeg',
      sizeBytes: 4096,
    },
    human(agent),
    { correlationId: randomUUID(), channel: 'test' },
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId;
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rof-owner'),
    createTestUser('rof-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Offline Realty');
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const [w] = await rows<{ timezone: string }>(
    admin(),
    sql`select timezone from app.workspaces where id = ${ws}`,
  );
  timeZone = w!.timezone;
  const person = async (firstName: string, lastName: string) =>
    (
      await executeCommand(
        api(),
        personCreate,
        {
          workspaceId: ws,
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
        },
        human(agent),
        { correlationId: randomUUID(), channel: 'test' },
      )
    ).output.personId;
  let maria: string;
  [linh, maria] = await Promise.all([person('Linh', 'Nguyen'), person('Maria', 'Alvarez')]);
  const buyer = (name: string) =>
    web('realestate.deal.open', {
      side: 'buyer',
      name,
      clientPersonId: linh,
      stage: 'under_contract',
    });
  deal = (await buyer('Nguyen purchase')).dealId;
  other = (await buyer('Nguyen second home')).dealId;
  listing = (
    await web('realestate.deal.open', {
      side: 'listing',
      name: 'Alvarez listing',
      stage: 'active',
      clientPersonId: maria,
      newPropertyAddress: '2207 Juniper Trail, Austin, TX 78704',
    })
  ).dealId;
}, 120_000);

afterAll(closeTestDbs);

describe('a duty done with no signal', () => {
  it('keeps the proof’s id, and counts as done when it was done on the phone', async () => {
    const { dutyId } = await web('realestate.duty.add', {
      dealId: deal,
      title: 'Get the insurance binder to the lender',
      proof: 'note',
    });
    const evidenceId = randomUUID();
    const proof = { dutyId, id: evidenceId, kind: 'note', body: 'Emailed it to Jo at 10:51' };
    const doneAt = ago(3 * 60 * MIN);
    const first = await phone('realestate.duty.add_evidence', proof, { occurredAt: doneAt });
    expect(first).toMatchObject({ evidenceId, missing: '' });
    // Sent again under another command id (its answer was lost): the same proof, not a second one.
    expect(await phone('realestate.duty.add_evidence', proof, { occurredAt: doneAt })).toEqual(
      first,
    );
    const kept = await rows<{ id: string; added_at: string }>(
      admin(),
      sql`select id, ${iso('added_at')} from addon_realestate.duty_evidence where duty_id = ${dutyId}`,
    );
    expect(kept.map((e) => e.id)).toEqual([evidenceId]);
    expect(same(kept[0]!.added_at, doneAt)).toBe(true);
    // The same id on another duty can't be used.
    const { dutyId: another } = await web('realestate.duty.add', {
      dealId: deal,
      title: 'Send the survey to title',
      proof: 'note',
    });
    expect(
      (await refused(phone('realestate.duty.add_evidence', { ...proof, dutyId: another }))).message,
    ).toContain('Discard it and add it again');

    // Marked done three hours ago, sent now: done at that moment, in its history too.
    expect(
      await phone('realestate.duty.complete', { dutyId }, { occurredAt: doneAt }),
    ).toMatchObject({ dutyId, status: 'completed' });
    const [d] = await rows<{ status: string; finished_at: string }>(
      admin(),
      sql`select status, ${iso('finished_at')} from addon_realestate.duties where id = ${dutyId}`,
    );
    expect(d).toMatchObject({ status: 'completed' });
    expect(same(d!.finished_at, doneAt)).toBe(true);
    const [line] = await rows<{ at: string }>(
      admin(),
      sql`select ${iso('at')} from addon_realestate.duty_log
          where duty_id = ${dutyId} and what = 'completed'`,
    );
    expect(same(line!.at, doneAt)).toBe(true);
    // Done again (from another phone, or sent twice): already done, nothing more.
    expect(await phone('realestate.duty.complete', { dutyId })).toMatchObject({
      status: 'completed',
    });
    const lines = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_realestate.duty_log
          where duty_id = ${dutyId} and what = 'completed'`,
    );
    expect(lines[0]!.n).toBe(1);
  });
});

describe('a contingency resolved with no signal', () => {
  it('waits beside the photo of its form, and counts from when it was resolved', async () => {
    const contingencyId = randomUUID();
    const add = {
      dealId: deal,
      id: contingencyId,
      kind: 'other',
      label: 'Sale of the buyers’ condo',
      endsOn: '2026-10-20',
    };
    expect(await phone('realestate.contingency.add', add)).toEqual({ dealId: deal, contingencyId });
    expect(await phone('realestate.contingency.add', add)).toEqual({ dealId: deal, contingencyId });
    expect(
      (await refused(phone('realestate.contingency.add', { ...add, dealId: other }))).message,
    ).toContain('Discard it and add it again');

    // The signed amendment, photographed with no signal: a document with the phone's id.
    const fileId = await photoOn(deal, 'amendment-signed.jpg');
    const documentId = randomUUID();
    const doc = { dealId: deal, id: documentId, fileId, kind: 'amendment', title: 'Amendment' };
    const made = await phone('realestate.document.add', doc);
    expect(made).toMatchObject({ documentId, version: 1 });
    expect(await phone('realestate.document.add', doc)).toEqual(made);

    const resolvedAt = ago(5 * 60 * MIN);
    await phone(
      'realestate.contingency.resolve',
      { contingencyId, how: 'satisfied', documentId },
      { occurredAt: resolvedAt },
    );
    const [c] = await rows<{ state: string; resolved_at: string; document_id: string }>(
      admin(),
      sql`select state, ${iso('resolved_at')}, document_id from addon_realestate.contingencies
          where id = ${contingencyId}`,
    );
    expect(c).toMatchObject({ state: 'satisfied', document_id: documentId });
    expect(same(c!.resolved_at, resolvedAt)).toBe(true);
  });

  it('needs signal to be recorded without its form, an owner’s exception', async () => {
    const { contingencyId } = await web('realestate.contingency.add', {
      dealId: deal,
      kind: 'other',
      label: 'HOA approval',
      endsOn: '2026-10-22',
    });
    const without = { contingencyId, how: 'waived', reason: 'The buyers waived it by email.' };
    const late = await refused(
      phone('realestate.contingency.resolve', without, { as: owner, occurredAt: ago(40 * MIN) }),
    );
    expect(late.rule).toBe('online_only');
    expect(late.disposition).toBe('final');
    expect(late.message).toContain(
      'Recording the HOA approval contingency without the signed form needs signal',
    );
    expect(late.message).toContain('Record it again with signal, or add the form and pick it.');
    // With signal, it's recorded.
    await phone('realestate.contingency.resolve', without, { as: owner });
    const [c] = await rows<{ state: string }>(
      admin(),
      sql`select state from addon_realestate.contingencies where id = ${contingencyId}`,
    );
    expect(c!.state).toBe('waived');
  });
});

describe('findings at the inspection', () => {
  it('keep the phone’s ids for the inspection and each finding', async () => {
    const inspectionId = randomUUID();
    const inspection = { dealId: deal, id: inspectionId, kind: 'general', inspector: 'Lone Star' };
    expect(await phone('realestate.inspection.add', inspection)).toEqual({ inspectionId });
    expect(await phone('realestate.inspection.add', inspection)).toEqual({ inspectionId });
    const findingId = randomUUID();
    const finding = {
      inspectionId,
      id: findingId,
      title: 'Garage door won’t close all the way',
      location: 'Garage',
      severity: 'repair',
    };
    expect(await phone('realestate.finding.add', finding)).toEqual({ findingId });
    expect(await phone('realestate.finding.add', finding)).toEqual({ findingId });
    const kept = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.inspection_findings where inspection_id = ${inspectionId}`,
    );
    expect(kept.map((f) => f.id)).toEqual([findingId]);
    // The finding's id on another inspection can't be used.
    const { inspectionId: second } = await web('realestate.inspection.add', {
      dealId: deal,
      kind: 'roof',
    });
    expect(
      (await refused(phone('realestate.finding.add', { ...finding, inspectionId: second })))
        .message,
    ).toContain('Discard it and add it again');
  });
});

describe('photos on a finding', () => {
  it('are photos on the deal, kept with the finding and replaced when changed', async () => {
    const { inspectionId } = await phone('realestate.inspection.add', {
      dealId: deal,
      id: randomUUID(),
      kind: 'general',
    });
    const [attic, closer] = [
      await photoOn(deal, 'attic-stain.jpg'),
      await photoOn(deal, 'attic-stain-close.jpg'),
    ];
    const findingId = randomUUID();
    const finding = {
      inspectionId,
      id: findingId,
      title: 'Stain on the attic decking',
      location: 'Attic',
      severity: 'repair',
      photoFileIds: [attic],
    };
    expect(await phone('realestate.finding.add', finding)).toEqual({ findingId });
    expect(await phone('realestate.finding.add', finding)).toEqual({ findingId });
    const kept = () =>
      rows<{ photo_file_ids: string[] }>(
        admin(),
        sql`select photo_file_ids from addon_realestate.inspection_findings where id = ${findingId}`,
      ).then((r) => r[0]!.photo_file_ids);
    expect(await kept()).toEqual([attic]);
    await phone('realestate.finding.update', { findingId, photoFileIds: [attic, closer] });
    expect(await kept()).toEqual([attic, closer]);
    // A change that leaves them out keeps them.
    await phone('realestate.finding.update', { findingId, note: 'Dry today.' });
    expect(await kept()).toEqual([attic, closer]);
    // A photo on another deal isn't one of this deal's.
    const elsewhere = await photoOn(other, 'other-attic.jpg');
    const wrong = await refused(
      phone('realestate.finding.update', { findingId, photoFileIds: [elsewhere] }),
    );
    expect(wrong.message).toBe(
      'That photo isn’t on Nguyen purchase anymore. Add it to the deal again, then save.',
    );
    const { inspections } = (await executeQuery(
      api(),
      registry.query('realestate.inspections')!,
      { workspaceId: ws, dealId: deal },
      human(agent),
      { correlationId: randomUUID(), channel: 'test' },
    )) as Any;
    const shown = (inspections as Any[])
      .flatMap((i) => i.findings)
      .find((f: Any) => f.id === findingId);
    expect(shown.photoFileIds).toEqual([attic, closer]);
  });
});

describe('an open house on the host’s phone', () => {
  let openHouseId: string;
  // It ran from three hours ago to two hours ago; sign-in closed an hour after.
  const startedAt = ago(3 * 60 * MIN);

  beforeAll(async () => {
    // The listing has open houses, so S-36 to S-39 are its duties.
    await web('realestate.deal.set_facts', { dealId: listing, facts: ['open_house'] });
    [{ id: openHouseId }] = (await rows<{ id: string }>(
      admin(),
      sql`insert into addon_realestate.open_houses (workspace_id, deal_record_id, starts_at, ends_at, host_user_id)
          values (${ws}, ${listing}, ${startedAt.toISOString()}, ${ago(2 * 60 * MIN).toISOString()}, ${agent.id})
          returning id`,
    )) as [{ id: string }];
  });

  it('signs a visitor in as the page does, at the moment they signed in with no signal', async () => {
    const id = randomUUID();
    const signedAt = ago(150 * MIN);
    const ann = {
      openHouseId,
      id,
      firstName: 'Ann',
      lastName: 'Webb',
      phone: '+15125550163',
      smsConsent: true,
    };
    const made = await phone('realestate.open_house.sign_in', ann, { occurredAt: signedAt });
    expect(made).toEqual({ visitorId: id, signedIn: true, firstName: 'Ann' });
    // Sent again under another command id (its answer was lost): the same visitor.
    expect(await phone('realestate.open_house.sign_in', ann, { occurredAt: signedAt })).toEqual(
      made,
    );
    const [v] = await rows<{ person_id: string; sms_consent: boolean; signed_in_at: string }>(
      admin(),
      sql`select person_id, sms_consent, ${iso('signed_in_at')}
          from addon_realestate.open_house_visitors where open_house_id = ${openHouseId}`,
    );
    expect(v).toMatchObject({ sms_consent: true });
    expect(same(v!.signed_in_at, signedAt)).toBe(true);
    // A customer, their yes to texts kept with where it came from, as on the page.
    const [person] = await rows<{ first_name: string; sms_consent: string; source: string }>(
      admin(),
      sql`select first_name, sms_consent::text as sms_consent, sms_consent_source as source
          from app.people where id = ${v!.person_id}`,
    );
    expect(person).toEqual({
      first_name: 'Ann',
      sms_consent: 'opted_in',
      source: 'Open house: 2207 Juniper Trail',
    });
    // S-38's proof.
    const proof = await rows<{ key: string }>(
      admin(),
      sql`select d.duty_key as key from addon_realestate.duty_evidence e
          join addon_realestate.duties d on d.id = e.duty_id
          where e.ref_kind = 'open_house' and e.ref_id = ${openHouseId}`,
    );
    expect(proof.map((p) => p.key)).toContain('S-38');
    // The visitor's id on another open house can't be used.
    const [{ id: another }] = (await rows<{ id: string }>(
      admin(),
      sql`insert into addon_realestate.open_houses (workspace_id, deal_record_id, starts_at, ends_at)
          values (${ws}, ${listing}, now() - interval '1 hour', now() + interval '1 hour') returning id`,
    )) as [{ id: string }];
    expect(
      (await refused(phone('realestate.open_house.sign_in', { ...ann, openHouseId: another })))
        .message,
    ).toContain('Discard it and add it again');
  });

  it('only records a visitor working with another agent', async () => {
    const id = randomUUID();
    await phone(
      'realestate.open_house.sign_in',
      {
        openHouseId,
        id,
        firstName: 'Tom',
        lastName: 'Ruiz',
        email: 'tom.ruiz@example.com',
        withAgent: true,
        agentName: 'Keller Williams',
        smsConsent: true,
      },
      { occurredAt: ago(140 * MIN) },
    );
    const [v] = await rows<{ person_id: string | null; sms_consent: boolean; agent_name: string }>(
      admin(),
      sql`select person_id, sms_consent, agent_name from addon_realestate.open_house_visitors where id = ${id}`,
    );
    expect(v).toEqual({ person_id: null, sms_consent: false, agent_name: 'Keller Williams' });
  });

  it('keeps the page’s rules: not after sign-in closed, and a way back is needed', async () => {
    const late = await refused(
      phone(
        'realestate.open_house.sign_in',
        { openHouseId, id: randomUUID(), firstName: 'Late', phone: '+15125550111' },
        { occurredAt: ago(30 * MIN) },
      ),
    );
    expect(late.rule).toBe('realestate_open_house_closed');
    expect(late.message).toBe(
      'Sign-in for this open house has closed. Ask the agent if you’d like to see the home.',
    );
    const early = await refused(
      phone(
        'realestate.open_house.sign_in',
        { openHouseId, id: randomUUID(), firstName: 'Early', phone: '+15125550112' },
        { occurredAt: ago(5 * 60 * MIN) },
      ),
    );
    expect(early.message).toMatch(/^Sign-in opens at .+\. Come back then\.$/);
    expect(
      (
        await refused(
          phone('realestate.open_house.sign_in', {
            openHouseId,
            id: randomUUID(),
            firstName: 'Nobody',
          }),
        )
      ).details,
    ).toEqual([
      expect.objectContaining({ path: 'email', message: 'Leave an email or a phone number.' }),
    ]);
  });
});

describe('a tour with no signal', () => {
  it('adds a home with the phone’s id, marks it seen when it was, and keeps what the client said themselves', async () => {
    const homeId = randomUUID();
    const home = { dealId: deal, id: homeId, address: '418 Maple Ave, Austin, TX 78704' };
    const added = await phone('realestate.home.add', home);
    expect(added).toMatchObject({ homeId });
    expect(await phone('realestate.home.add', home)).toEqual(added);
    expect(
      (await refused(phone('realestate.home.add', { ...home, dealId: other }))).message,
    ).toContain('Discard it and add it again');

    // A tour that began two hours ago, with that home on it.
    const tourId = randomUUID();
    const stopId = randomUUID();
    await rows(
      admin(),
      sql`insert into addon_realestate.tours (id, workspace_id, deal_record_id, starts_at, ends_at)
          values (${tourId}, ${ws}, ${deal}, now() - interval '2 hours', now() - interval '1 hour')`,
    );
    await rows(
      admin(),
      sql`insert into addon_realestate.tour_stops (id, workspace_id, deal_record_id, tour_id, home_id, position)
          values (${stopId}, ${ws}, ${deal}, ${tourId}, ${homeId}, 1)`,
    );
    const seenAt = ago(100 * MIN);
    expect(
      await phone(
        'realestate.tour.record_visit',
        { stopId, status: 'visited' },
        { occurredAt: seenAt },
      ),
    ).toMatchObject({ tourId, stopId, tourStatus: 'done' });
    const [stop] = await rows<{ visited_at: string }>(
      admin(),
      sql`select ${iso('visited_at')} from addon_realestate.tour_stops where id = ${stopId}`,
    );
    expect(same(stop!.visited_at, seenAt)).toBe(true);

    // Linh said what she thought in her portal a moment ago; what the agent heard at the stop doesn't replace it.
    await rows(
      admin(),
      sql`insert into addon_realestate.tour_feedback (workspace_id, deal_record_id, tour_id, stop_id, home_id,
            person_id, interest, words)
          values (${ws}, ${deal}, ${tourId}, ${stopId}, ${homeId}, ${linh}, 'love', 'The yard!')`,
    );
    const heard = {
      stopId,
      personId: linh,
      interest: 'maybe',
      words: 'Liked the yard, not the kitchen',
    };
    const theirs = await refused(
      phone('realestate.tour.feedback', heard, { occurredAt: ago(95 * MIN) }),
    );
    expect(theirs.rule).toBe('realestate_tour_feedback_theirs');
    expect(theirs.message).toContain(
      'Linh Nguyen sent their own feedback on 418 Maple Ave, Austin, TX 78704 from the portal',
    );
    expect(theirs.message).toContain('Add what you heard as a note on the home.');
    const [kept] = await rows<{ interest: string }>(
      admin(),
      sql`select interest from addon_realestate.tour_feedback where stop_id = ${stopId}`,
    );
    expect(kept!.interest).toBe('love');
  });
});

describe('a financing step ticked with no signal', () => {
  it('is done on the day it was ticked, not the day it arrived', async () => {
    const fileId = await photoOn(deal, 'loan-application.jpg');
    const { documentId } = await web('realestate.document.add', {
      dealId: deal,
      fileId,
      kind: 'loan_approval',
    });
    const at = ago(26 * 60 * MIN);
    await phone(
      'realestate.financing.mark_done',
      { dealId: deal, step: 'application', proof: { kind: 'document', id: documentId } },
      { occurredAt: at },
    );
    const [s] = await rows<{ done_on: string; done_at: string }>(
      admin(),
      sql`select done_on::text as done_on, ${iso('done_at')} from addon_realestate.financing_steps
          where deal_record_id = ${deal} and step = 'application'`,
    );
    expect(s!.done_on).toBe(localDateOf(at.getTime(), timeZone));
    expect(same(s!.done_at, at)).toBe(true);
  });
});

describe('what reaches a client', () => {
  it('goes while fresh, and asks “Still send?” after 30 minutes', async () => {
    const id = randomUUID();
    const task = { dealId: deal, id, kind: 'do', title: 'Book movers' };
    const writtenAt = ago(45 * MIN);
    const stale = await refused(
      phone('realestate.client_task.add', task, { occurredAt: writtenAt }),
    );
    expect({ rule: stale.rule, disposition: stale.disposition }).toEqual({
      rule: 'stale_action',
      disposition: 'ask',
    });
    expect(stale.message).toBe(
      'This was done 45 minutes ago, so it waits for your OK before it goes.',
    );
    const none = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_realestate.client_tasks where id = ${id}`,
    );
    expect(none).toEqual([]);
    // "Still send?" yes: it goes, with the phone's id.
    expect(
      await phone('realestate.client_task.add', task, {
        occurredAt: writtenAt,
        confirmedAt: new Date(),
      }),
    ).toEqual({ taskId: id });
    // Ten minutes old, it goes on its own; sent again, it's the same task.
    const fresh = { ...task, id: randomUUID(), title: 'Send the insurance binder' };
    const made = await phone('realestate.client_task.add', fresh, { occurredAt: ago(10 * MIN) });
    expect(made).toEqual({ taskId: fresh.id });
    expect(await phone('realestate.client_task.add', fresh, { occurredAt: ago(10 * MIN) })).toEqual(
      made,
    );
    const titles = await rows<{ title: string }>(
      admin(),
      sql`select title from addon_realestate.client_tasks
          where deal_record_id = ${deal} and id in (${id}, ${fresh.id}) order by title`,
    );
    expect(titles.map((t) => t.title)).toEqual(['Book movers', 'Send the insurance binder']);
  });
});

describe('a showing and its feedback', () => {
  it('keeps the phone’s id, and what the buyer’s agent said themselves after it was noted', async () => {
    const id = randomUUID();
    const startsAt = new Date(Date.now() + 2 * 24 * 60 * MIN).toISOString();
    const showing = { dealId: listing, id, startsAt, agentName: 'Lee Wong', brokerage: 'Compass' };
    const made = await phone('realestate.showing.add', showing, { occurredAt: ago(5 * MIN) });
    expect(made).toMatchObject({ showingId: id, state: 'confirmed' });
    expect(await phone('realestate.showing.add', showing)).toEqual(made);
    // It emails the buyer's agent, so after 30 minutes it asks first.
    expect(
      (
        await refused(
          phone(
            'realestate.showing.add',
            { ...showing, id: randomUUID() },
            { occurredAt: ago(31 * MIN) },
          ),
        )
      ).rule,
    ).toBe('stale_action');

    // Lee answered the feedback link at 3:10; what the agent noted on the phone an hour before doesn't replace it.
    await rows(
      admin(),
      sql`update addon_realestate.showings set feedback_source = 'page', feedback_at = now(),
            feedback = ${JSON.stringify({ interest: 4, liked: 'The oaks', pause: null, price: null })}::jsonb
          where id = ${id}`,
    );
    const theirs = await refused(
      phone(
        'realestate.showing.feedback',
        { showingId: id, interest: 2, liked: 'Nothing much' },
        { occurredAt: ago(60 * MIN) },
      ),
    );
    expect(theirs.rule).toBe('realestate_showing_feedback_theirs');
    expect(theirs.message).toContain('Lee Wong answered the feedback link');
    expect(theirs.message).toContain(
      'so theirs stays. Add what you heard as a note on the showing.',
    );
    // Noted after theirs, it's kept beside it.
    expect(
      await phone('realestate.showing.feedback', { showingId: id, pause: 'The kitchen size' }),
    ).toMatchObject({ showingId: id });
    const [s] = await rows<{ feedback: Record<string, unknown>; feedback_source: string }>(
      admin(),
      sql`select feedback, feedback_source from addon_realestate.showings where id = ${id}`,
    );
    expect(s).toMatchObject({
      feedback_source: 'agent',
      feedback: { interest: 4, liked: 'The oaks', pause: 'The kitchen size' },
    });
  });
});

describe('the phone’s list of Real Estate commands', () => {
  it('gives each the class the server does, and leaves none out that can wait', () => {
    const phoneList = Object.entries(PHONE_COMMANDS).filter(([name]) =>
      name.startsWith('realestate.'),
    );
    for (const [name, def] of phoneList)
      expect({ name, offline: registry.command(name)?.offline }).toEqual({
        name,
        offline: def.offline,
      });
    const queueable = registry.commands
      .filter((c) => c.name.startsWith('realestate.') && c.offline !== 'online')
      .map((c) => c.name)
      .sort();
    // Every one that can wait is on the phone; the phone also sends some online ones straight away, with signal.
    expect(
      phoneList
        .filter(([, d]) => d.offline !== 'online')
        .map(([name]) => name)
        .sort(),
    ).toEqual(queueable);
    // What reaches a client or another agent is fresh for Chris's 30 minutes.
    const fresh = phoneList.filter(([, d]) => typeof d.offline === 'object').map(([n]) => n);
    expect(fresh.sort()).toEqual([
      'realestate.client_task.add',
      'realestate.listing.price.propose',
      'realestate.match.send',
      'realestate.showing.add',
      'realestate.showing.decide',
      'realestate.status_email.send',
    ]);
    for (const [, d] of phoneList)
      if (typeof d.offline === 'object') expect(d.offline.freshMinutes).toBe(FRESH_MINUTES);
  });
});
