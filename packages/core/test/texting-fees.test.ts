/**
 * What registering for texting costs (0105): the rule the wizard shows and the command charges by, what a send
 * writes down, who sees it, and that what Stripe says is the worker's alone to write. Collecting it, the page and
 * the months run end to end in apps/worker/test/texting-fees.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { textingFees } from '@hfos/db/schema';
import {
  as,
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  organizationCreate,
  phoneSetupStatus,
  registrationSubmit,
  textingFeeLines,
  textingFeeTotal,
} from '../src/server';

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

const business = {
  legalName: 'Fees Core LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'tx', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: [
    'Hi Mike, this is Fees HVAC. Marco is on the way. Reply STOP to opt out.',
    'Hi Mike, your estimate is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

/** A random local number. Its area code never starts with 8, so it's never toll-free. */
const randomLocal = () =>
  `+1${2 + Math.floor(Math.random() * 6)}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let owner: TestUser;
let member: TestUser;

async function freshBusiness(name: string, numberType: 'local' | 'toll_free' = 'local') {
  const wsId = (await run(organizationCreate, { businessName: name }, owner)).workspaceId;
  const e164 =
    numberType === 'local'
      ? randomLocal()
      : `+1888${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  await rows(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
        values (${wsId}, ${e164}, ${numberType}, 'active')`,
  );
  return wsId;
}

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('fees-core-owner'),
    createTestUser('fees-core-member'),
  ]);
});
afterAll(closeTestDbs);

describe('what a registration costs', () => {
  it('charges the brand once, its vetting at 1,000 texts a month, and the campaign each time it goes', () => {
    const keys = (lines: { key: string }[]) => lines.map((l) => l.key);
    const nothing = {
      brandSent: false,
      brandPaid: false,
      vettingPaid: false,
      campaignCovered: false,
    };
    // A first registration.
    expect(keys(textingFeeLines({ ...nothing, monthlyVolume: 'under_1000' }))).toEqual([
      'brand',
      'campaign_vetting',
    ]);
    expect(textingFeeTotal(textingFeeLines({ ...nothing, monthlyVolume: '1000_10000' }))).toBe(
      6_100,
    );
    // The brand went; the campaign was turned down and goes again: its review again, nothing for the brand.
    expect(
      keys(textingFeeLines({ ...nothing, brandSent: true, monthlyVolume: '1000_10000' })),
    ).toEqual(['campaign_vetting']);
    // Paid, and not gone yet: nothing new — unless a bigger volume now needs the brand's vetting.
    const paid = { brandSent: false, brandPaid: true, vettingPaid: false, campaignCovered: true };
    expect(textingFeeLines({ ...paid, monthlyVolume: 'under_1000' })).toEqual([]);
    expect(keys(textingFeeLines({ ...paid, monthlyVolume: 'over_100000' }))).toEqual([
      'secondary_vetting',
    ]);
    // HandsFreeOS's own business pays nothing, whatever it sends.
    expect(textingFeeLines({ ...nothing, ours: true, monthlyVolume: 'over_100000' })).toEqual([]);
  });

  it('writes the fee with the registration, shows it to managers only, and nothing for toll-free', async () => {
    const wsId = await freshBusiness('Fees Core Co');
    await rows(
      admin(),
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
    );
    const sent = await run(
      registrationSubmit,
      { workspaceId: wsId, kind: 'a2p_10dlc', business },
      owner,
    );
    expect(sent.fee).toMatchObject({ amountCents: 1_950 });
    const [fee] = await admin().select().from(textingFees).where(eq(textingFees.workspaceId, wsId));
    expect(fee).toMatchObject({
      purpose: 'registration',
      status: 'pending',
      amountCents: 1_950,
      requestedBy: owner.id,
    });
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).textingFees).toMatchObject({
      due: { id: fee!.id, status: 'pending', amountCents: 1_950 },
      month: null,
      card: false,
      monthlyCents: null,
    });
    expect((await ask(phoneSetupStatus, { workspaceId: wsId }, member)).textingFees).toBeNull();

    // A bigger volume adds the brand's vetting: the old fee is put aside, the new one carries its lines.
    const bigger = await run(
      registrationSubmit,
      {
        workspaceId: wsId,
        kind: 'a2p_10dlc',
        business: { ...business, monthlyVolume: 'over_100000' },
      },
      owner,
    );
    expect(bigger.fee?.amountCents).toBe(6_100);
    const all = await admin().select().from(textingFees).where(eq(textingFees.workspaceId, wsId));
    expect(all.map((f) => f.status).sort()).toEqual(['cancelled', 'pending']);

    const tollFree = await freshBusiness('Fees Toll Free Co', 'toll_free');
    const free = await run(
      registrationSubmit,
      { workspaceId: tollFree, kind: 'toll_free_verification', business },
      owner,
    );
    expect(free.fee).toBeNull();
  });

  it('charges HandsFreeOS’s own business nothing, and puts aside a fee it was given before', async () => {
    const wsId = await freshBusiness('Fees Ours Co');
    // Sent before it was marked ours: it owes the fee like anyone.
    const before = await run(
      registrationSubmit,
      { workspaceId: wsId, kind: 'a2p_10dlc', business },
      owner,
    );
    expect(before.fee).toMatchObject({ amountCents: 1_950 });
    await rows(admin(), sql`update app.workspaces set is_platform = true where id = ${wsId}`);
    try {
      const status = (await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).textingFees;
      expect(status?.paidFor.ours).toBe(true);
      // Sent again: nothing to pay, and the old fee is put aside.
      const again = await run(
        registrationSubmit,
        { workspaceId: wsId, kind: 'a2p_10dlc', business },
        owner,
      );
      expect(again.fee).toBeNull();
      const all = await admin().select().from(textingFees).where(eq(textingFees.workspaceId, wsId));
      expect(all.map((f) => f.status)).toEqual(['cancelled']);
      expect(
        (await ask(phoneSetupStatus, { workspaceId: wsId }, owner)).textingFees?.due,
      ).toBeNull();
    } finally {
      await rows(admin(), sql`update app.workspaces set is_platform = false where id = ${wsId}`);
    }
  });

  it('keeps what Stripe says the worker’s: a person can only put an unpaid fee aside', async () => {
    const wsId = await freshBusiness('Fees Guard Co');
    await run(registrationSubmit, { workspaceId: wsId, kind: 'a2p_10dlc', business }, owner);
    const [fee] = await admin().select().from(textingFees).where(eq(textingFees.workspaceId, wsId));
    const paid = await expectPgError(() =>
      as(owner)((tx) =>
        tx
          .update(textingFees)
          .set({ status: 'paid', paidAt: new Date() })
          .where(eq(textingFees.id, fee!.id)),
      ),
    );
    expect(paid.detail).toBe('texting_fee_transition');
    const fields = await expectPgError(() =>
      as(owner)((tx) =>
        tx
          .update(textingFees)
          .set({ status: 'cancelled', amountCents: 1 })
          .where(eq(textingFees.id, fee!.id)),
      ),
    );
    expect(fields.detail).toBe('texting_fee_provider_fields');
    // A month's fee, or one that looks paid, is never a person's to write.
    await expectPgError(() =>
      as(owner)((tx) =>
        tx.insert(textingFees).values({
          workspaceId: wsId,
          purpose: 'month',
          lines: [],
          amountCents: 1_000,
          monthIndex: 0,
          periodStart: new Date(),
          requestedBy: owner.id,
        }),
      ),
    );
  });
});
