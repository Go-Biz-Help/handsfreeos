/**
 * All green, or checked by HandsFreeOS (the owner, 2026-11-05), after two campaigns were turned down in a week.
 *
 * `registration.submit` sends only details the review step's checks found all green (written down by the worker as
 * `registration.record_check`) with every tick only the business can give, so the Assistant and a direct call are held
 * to it as the wizard's button is. Otherwise the business asks HandsFreeOS to check it: a ticket on the support desk,
 * which staff approve (and the worker sends it as it was left) or send back.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import { registrationFingerprint } from '../src/messaging/registration-fingerprint';
import {
  organizationCreate,
  registrationRecordCheck,
  registrationRequestReview,
  registrationReviewApprove,
  registrationReviewForStaff,
  registrationReviewGet,
  registrationReviewSendBack,
  registrationSendReviewed,
  registrationSubmit,
} from '../src/server';
import { BusinessProfile } from '../src/schemas/telephony';

const db = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(db(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());

async function expectRule(fn: () => Promise<unknown>, rule: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).rule ?? (e as HfosError).code).toBe(rule);
    return e as HfosError;
  }
  throw new Error(`expected ${rule}, but the call succeeded`);
}

const business = {
  legalName: 'Green Check HVAC LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://greencheck.example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'TX', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: [
    'Hi Mike, this is Green Check HVAC. Marco is on the way. Reply STOP to opt out.',
    'Hi Mike, your estimate is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers tick a box on the contact form at https://greencheck.example.com/contact to get texts.',
  optInPath: 'own_site',
  optInUrl: 'https://greencheck.example.com/contact',
  monthlyVolume: 'under_1000',
};
const allTicks = ['own_form_sends', 'only_these_ways'];

let owner: TestUser;
let staff: TestUser;
let outsider: TestUser;

async function freshBusiness(name: string) {
  const org = await run(organizationCreate, { businessName: name }, owner);
  return { wsId: org.workspaceId, orgId: org.organizationId };
}

/** What the worker writes after the review step's checks, for these details. */
async function recordCheck(
  scope: { wsId: string; orgId: string },
  details: unknown,
  notGreen: string[] = [],
) {
  const system: SystemActor = {
    type: 'system',
    workspaceId: scope.wsId,
    organizationId: scope.orgId,
  };
  await executeCommand(
    testDbs().worker.db,
    registrationRecordCheck,
    {
      workspaceId: scope.wsId,
      fingerprint: registrationFingerprint('a2p_10dlc', BusinessProfile.parse(details)),
      notGreen,
      checks: [],
    },
    system,
    meta(),
  );
}

beforeAll(async () => {
  [owner, staff, outsider] = await Promise.all([
    createTestUser('green-owner'),
    createTestUser('green-staff'),
    createTestUser('green-outsider'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'agent')
        on conflict (user_id) do update set role = 'agent', status = 'active'`,
  );
});
afterAll(closeTestDbs);

describe('Send goes only when everything is green', () => {
  it('refuses details nobody checked, details changed since, and details found not green', async () => {
    const scope = await freshBusiness('Green Check HVAC');
    const send = (details: object) =>
      run(
        registrationSubmit,
        {
          workspaceId: scope.wsId,
          kind: 'a2p_10dlc',
          business: { ...details, confirmed: allTicks },
        },
        owner,
      );
    // Never checked: whoever sends it (the Assistant, an old tab) is told to run the last step.
    const unchecked = await expectRule(() => send(business), 'registration_not_checked');
    expect(unchecked.message).toContain('Settings → Texting & calls');

    // Checked, then changed: a check is of exactly the details it looked at.
    await recordCheck(scope, business);
    await expectRule(
      () => send({ ...business, website: 'https://elsewhere.example.com' }),
      'registration_not_checked',
    );

    // Checked and not green: it says what, and where to ask HandsFreeOS.
    await recordCheck(scope, business, ['Your privacy policy covers texting: it doesn’t say …']);
    const red = await expectRule(() => send(business), 'registration_not_green');
    expect(red.message).toContain('privacy policy');
    expect(red.message).toContain('Ask HandsFreeOS to check it');

    // A day old: checked again first, so a site taken down since isn't vouched for.
    await recordCheck(scope, business);
    await admin().execute(
      sql`update app.registration_checks set checked_at = now() - interval '25 hours'
          where workspace_id = ${scope.wsId}`,
    );
    const stale = await expectRule(() => send(business), 'registration_not_checked');
    expect(stale.message).toContain('more than a day ago');
  });

  it('wants every tick only the business can give, then sends', async () => {
    const scope = await freshBusiness('Ticked HVAC');
    await recordCheck(scope, business);
    const unticked = await expectRule(
      () =>
        run(
          registrationSubmit,
          {
            workspaceId: scope.wsId,
            kind: 'a2p_10dlc',
            business: { ...business, confirmed: ['only_these_ways'] },
          },
          owner,
        ),
      'registration_not_green',
    );
    expect(unticked.message).toContain('greencheck.example.com/contact');

    // A legal name without LLC or Inc is a question only they can answer: a tick, not a fault.
    const plain = { ...business, legalName: 'Ticked Heating' };
    await recordCheck(scope, plain);
    const named = await expectRule(
      () =>
        run(
          registrationSubmit,
          {
            workspaceId: scope.wsId,
            kind: 'a2p_10dlc',
            business: { ...plain, confirmed: allTicks },
          },
          owner,
        ),
      'registration_not_green',
    );
    expect(named.message).toContain('“Ticked Heating” is exactly the name on our IRS letter');

    await recordCheck(scope, business);
    const sent = await run(
      registrationSubmit,
      {
        workspaceId: scope.wsId,
        kind: 'a2p_10dlc',
        business: { ...business, confirmed: allTicks },
      },
      owner,
    );
    expect(sent.registrationIds.length).toBeGreaterThan(0);
  });

  it('only the worker writes down what the checks found', async () => {
    const scope = await freshBusiness('Forged Check HVAC');
    await expect(
      run(
        registrationRecordCheck,
        { workspaceId: scope.wsId, fingerprint: 'a'.repeat(64), notGreen: [], checks: [] },
        owner,
      ),
    ).rejects.toBeInstanceOf(HfosError);
    const [row] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.registration_checks where workspace_id = ${scope.wsId}`,
    );
    expect(row?.n).toBe(0);
  });
});

describe('Ask HandsFreeOS to check it', () => {
  it('opens a ticket with what isn’t green; asking again replaces the one waiting', async () => {
    const scope = await freshBusiness('Asking HVAC');
    const askFor = (note?: string) =>
      run(
        registrationRequestReview,
        {
          workspaceId: scope.wsId,
          kind: 'a2p_10dlc',
          business,
          notGreen: ['Not ticked: “These are all the ways customers agree to get our texts.”'],
          ...(note ? { note } : {}),
        },
        owner,
      );
    const first = await askFor('Our form works; the checker can’t see past the cookie banner.');
    expect(first.ticketNumber).toEqual(expect.any(Number));
    const [ticket] = await rows<{ subject: string; body: string }>(
      admin(),
      sql`select t.subject, m.body_text as body from platform.tickets t
          join platform.ticket_messages m on m.ticket_id = t.id
          where t.number = ${first.ticketNumber}`,
    );
    expect(ticket?.subject).toBe('Check our texting registration: Green Check HVAC LLC');
    expect(ticket?.body).toContain('Not ticked');
    expect(ticket?.body).toContain('cookie banner');

    const shown = await ask(registrationReviewGet, { workspaceId: scope.wsId }, owner);
    expect(shown.review).toMatchObject({ status: 'waiting', ticketNumber: first.ticketNumber });

    const second = await askFor();
    const statuses = await rows<{ id: string; status: string }>(
      admin(),
      sql`select id, status::text as status from app.registration_reviews
          where workspace_id = ${scope.wsId} order by requested_at`,
    );
    expect(statuses).toEqual([
      { id: first.reviewId, status: 'withdrawn' },
      { id: second.reviewId, status: 'waiting' },
    ]);
  });

  it('is for people who manage the business’s texting, and staff only decide', async () => {
    const scope = await freshBusiness('Guarded HVAC');
    await expect(
      run(
        registrationRequestReview,
        { workspaceId: scope.wsId, kind: 'a2p_10dlc', business, notGreen: [] },
        outsider,
      ),
    ).rejects.toBeInstanceOf(HfosError);
    const asked = await run(
      registrationRequestReview,
      { workspaceId: scope.wsId, kind: 'a2p_10dlc', business, notGreen: [] },
      owner,
    );
    // The business can't approve its own.
    await expect(
      run(registrationReviewApprove, { reviewId: asked.reviewId }, owner),
    ).rejects.toBeInstanceOf(HfosError);
    await expect(
      ask(registrationReviewForStaff, { reviewId: asked.reviewId }, owner),
    ).rejects.toBeInstanceOf(HfosError);
  });

  it('sent back: says what to change, sends nothing, and can’t be decided twice', async () => {
    const scope = await freshBusiness('Sent Back HVAC');
    const asked = await run(
      registrationRequestReview,
      { workspaceId: scope.wsId, kind: 'a2p_10dlc', business, notGreen: ['A row'] },
      owner,
    );
    await expectRule(
      () => run(registrationReviewSendBack, { reviewId: asked.reviewId, note: ' ' }, staff),
      'validation',
    );
    const back = await run(
      registrationReviewSendBack,
      { reviewId: asked.reviewId, note: 'Add “Message frequency varies” beside the box.' },
      staff,
    );
    expect(back.status).toBe('sent_back');
    const shown = await ask(registrationReviewGet, { workspaceId: scope.wsId }, owner);
    expect(shown.review).toMatchObject({
      status: 'sent_back',
      decisionNote: 'Add “Message frequency varies” beside the box.',
    });
    await expectRule(
      () => run(registrationReviewApprove, { reviewId: asked.reviewId }, staff),
      'registration_review_decided',
    );
    const [regs] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.telephony_registrations where workspace_id = ${scope.wsId}`,
    );
    expect(regs?.n).toBe(0);
  });

  it('approved: staff see it by its ticket, and it’s sent exactly as the business left it', async () => {
    const scope = await freshBusiness('Approved HVAC');
    const asked = await run(
      registrationRequestReview,
      { workspaceId: scope.wsId, kind: 'a2p_10dlc', business, notGreen: ['A row'] },
      owner,
    );
    const [t] = await rows<{ id: string }>(
      admin(),
      sql`select ticket_id as id from app.registration_reviews where id = ${asked.reviewId}`,
    );
    const byTicket = await ask(registrationReviewForStaff, { ticketId: t!.id }, staff);
    expect(byTicket.review).toMatchObject({
      reviewId: asked.reviewId,
      status: 'waiting',
      businessName: 'Approved HVAC',
      notGreen: ['A row'],
    });
    expect(byTicket.review?.submission['legalName']).toBe('Green Check HVAC LLC');

    const ok = await run(registrationReviewApprove, { reviewId: asked.reviewId }, staff);
    expect(ok.status).toBe('approved');
    const [decided] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where entity_id = ${asked.reviewId}
          and event_type = 'platform.registration_review_decided'`,
    );
    expect(decided?.payload).toMatchObject({
      workspaceId: scope.wsId,
      organizationId: scope.orgId,
      status: 'approved',
    });

    // The worker sends it: no check of its own needed, since HandsFreeOS checked it.
    const system: SystemActor = {
      type: 'system',
      workspaceId: scope.wsId,
      organizationId: scope.orgId,
    };
    const sent = await executeCommand(
      testDbs().worker.db,
      registrationSendReviewed,
      { workspaceId: scope.wsId, reviewId: asked.reviewId },
      system,
      meta(),
    );
    expect(sent.output.sent).toBe(true);
    const [reg] = await rows<{ submission: Record<string, unknown> }>(
      admin(),
      sql`select submission from app.telephony_registrations where workspace_id = ${scope.wsId}
          order by created_at limit 1`,
    );
    expect(JSON.stringify(reg?.submission)).toContain('Green Check HVAC LLC');
    // Sent once, however often the event comes round.
    const again = await executeCommand(
      testDbs().worker.db,
      registrationSendReviewed,
      { workspaceId: scope.wsId, reviewId: asked.reviewId },
      system,
      meta(),
    );
    expect(again.output.sent).toBe(false);
    // Once it's gone, the wizard isn't greeted with the old decision.
    const shown = await ask(registrationReviewGet, { workspaceId: scope.wsId }, owner);
    expect(shown.review).toBeNull();
  });

  it('a ticket that isn’t a registration check has none', async () => {
    const got = await ask(registrationReviewForStaff, { ticketId: randomUUID() }, staff);
    expect(got.review).toBeNull();
  });
});
