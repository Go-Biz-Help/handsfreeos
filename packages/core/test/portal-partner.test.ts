/**
 * A partner's own page in the business's portal (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2c): on Home and in
 * the menu only for a partner, and only while partners are on; their link only once they accept the business's latest
 * terms; what they earned as the business's own Partners page works it out; and the clients they sent by first name
 * and last initial, never more.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { outreachAddon } from '../src/addons/outreach/manifest';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CustomerActor, QueryDef, RequestMeta } from '../src/kernel/types';
import { clientShortName } from '../src/partners/words';
import {
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  partnerAdd,
  partnerCommissionNote,
  partnerGet,
  partnerReferralSet,
  partnersSaveSettings,
  partnerUpdate,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalHome,
  portalPartner,
  portalPartnerAcceptTerms,
  portalSendCode,
} from '../src/server';
import {
  admin,
  ask,
  expectHfos,
  makeCalendar,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let calendarId: string;
let partnerId: string;
let code: string;
let paula: CustomerActor;
let nina: CustomerActor;
const ws = () => ({ workspaceId: t.wsId });

const portal = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'portal' });
const asCustomer = <O extends z.ZodType>(
  q: QueryDef<z.ZodType, O>,
  who: CustomerActor,
): Promise<z.output<O>> => executeQuery(testDbs().worker.db, q, ws(), who, portal());
const accept = (who: CustomerActor, termsVersion: number) =>
  executeCommand(
    testDbs().worker.db,
    portalPartnerAcceptTerms,
    { ...ws(), termsVersion },
    who,
    portal(),
  ).then((r) => r.output);

async function contact(firstName: string, lastName: string): Promise<string> {
  const out = await run(
    personCreate,
    {
      ...ws(),
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
      ignoreDuplicates: true,
    },
    t.owner,
  );
  return out.personId;
}

/** A device signed in for this person: the way the worker does it. */
async function signIn(personId: string): Promise<CustomerActor> {
  const { accessId } = await run(portalAccessGive, { ...ws(), personId }, t.owner);
  const sent = await runSystem(portalSendCode, { ...ws(), accessId }, t.scope);
  const hit = await runSystem(
    portalCheckCode,
    {
      ...ws(),
      accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    },
    t.scope,
  );
  return { type: 'customer', ...t.scope, personId, sessionId: hit.sessionId! };
}

const saveTerms = (terms: string) =>
  run(
    partnersSaveSettings,
    { ...ws(), settings: { rateBp: 1_500, terms, smallestPayoutCents: 2_500, calendarId } },
    t.owner,
  );

beforeAll(async () => {
  t = await setupTeam('portal-partner');
  calendarId = (
    await makeCalendar(t, 'Tune-ups', {
      public: true,
      team: { members: [{ userId: t.owner.id }], assignment: 'round_robin' },
    })
  ).id;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
  );
  await saveTerms('Paid on the 1st, by bank transfer.');
  const paulaId = await contact('Paula', 'Partner');
  ({ partnerId, code } = await run(partnerAdd, { ...ws(), personId: paulaId }, t.owner));
  const maria = await contact('Maria', 'lopez');
  await run(partnerReferralSet, { ...ws(), personId: maria, partnerId }, t.owner);
  const made = await run(
    invoiceCreate,
    {
      ...ws(),
      personId: maria,
      title: 'Duct cleaning',
      lines: [{ name: 'Job', quantity: 1, unitPriceCents: 100_000, taxable: false }],
    },
    t.owner,
  );
  await run(invoiceSend, { ...ws(), invoiceId: made.invoiceId, channels: [] }, t.owner);
  const paid = await run(
    invoiceRecordCashPayment,
    { ...ws(), invoiceId: made.invoiceId, amountCents: 100_000 },
    t.owner,
  );
  await runSystem(partnerCommissionNote, { ...ws(), paymentId: paid.paymentId }, t.scope);
  paula = await signIn(paulaId);
  nina = await signIn(await contact('Nina', 'Client'));
});
afterAll(closeTestDbs);

describe('a partner’s own page', () => {
  it('names a client by first name and last initial only', () => {
    expect(clientShortName('Maria', 'l')).toBe('Maria L.');
    expect(clientShortName(' Maria ', null)).toBe('Maria');
    expect(clientShortName(null, 'L')).toBeNull();
  });

  it('is on Home only for a partner of the business', async () => {
    expect((await asCustomer(portalHome, paula)).partner).toBe(true);
    expect((await asCustomer(portalHome, nina)).partner).toBe(false);
    expect(await asCustomer(portalPartner, nina)).toEqual({ partner: null });
    await expectHfos(() => accept(nina, 1), 'not_found');
  });

  it('gives their link once they accept the business’s latest terms', async () => {
    let page = (await asCustomer(portalPartner, paula)).partner!;
    expect(page).toMatchObject({
      status: 'active',
      rateBp: 1_500,
      linkPath: null,
      terms: {
        text: 'Paid on the 1st, by bank transfer.',
        version: 1,
        accepted: false,
        acceptedAt: null,
      },
    });
    const changed = await expectHfos(() => accept(paula, 2), 'partner_terms_changed', 409);
    expect(changed.message).toBe(
      'The terms changed since you opened them. Read them again, then accept them.',
    );
    expect(await accept(paula, 1)).toEqual({ accepted: true });
    expect(await accept(paula, 1)).toEqual({ accepted: true });
    page = (await asCustomer(portalPartner, paula)).partner!;
    expect(page.linkPath).toBe(`/book/c/${calendarId}?ref=pa-${code}`);
    expect(page.terms).toMatchObject({ accepted: true, acceptedAt: expect.any(String) });
    expect((await ask(partnerGet, { ...ws(), partnerId }, t.owner)).partner.termsAccepted).toBe(
      true,
    );

    // New terms: accepted again before the link shows again.
    await saveTerms('Paid on the 15th, by bank transfer.');
    page = (await asCustomer(portalPartner, paula)).partner!;
    expect(page).toMatchObject({ linkPath: null, terms: { version: 2, accepted: false } });
    expect(page.terms.acceptedAt).not.toBeNull();
    await accept(paula, 2);
    expect((await asCustomer(portalPartner, paula)).partner!.linkPath).not.toBeNull();
    const [accepted] = await rows<{ n: number; actor: string }>(
      admin(),
      sql`select count(*)::int as n, min(actor_type::text) as actor from app.events
          where workspace_id = ${t.wsId} and event_type = 'partner.terms_accepted'`,
    );
    expect(accepted).toEqual({ n: 2, actor: 'customer' });
  });

  it('shows what they earned as the business sees it, and nobody’s full name', async () => {
    const page = await asCustomer(portalPartner, paula);
    const staff = await ask(partnerGet, { ...ws(), partnerId }, t.owner);
    expect(page.partner!.earnings).toEqual(staff.partner.earnings);
    expect(page.partner!.earnings.earnedCents).toBe(15_000);
    expect(page.partner!.clients).toEqual([
      {
        referralId: staff.clients[0]!.referralId,
        name: 'Maria L.',
        how: 'by_hand',
        referredAt: staff.clients[0]!.referredAt,
        firstPaidAt: staff.clients[0]!.firstPaidAt,
        monthsEndAt: staff.clients[0]!.monthsEndAt,
        earnedCents: 15_000,
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/lopez|@example/i);
  });

  it('has no link once they’ve ended, and isn’t there while partners are off', async () => {
    await run(partnerUpdate, { ...ws(), partnerId, status: 'ended' }, t.owner);
    expect((await asCustomer(portalPartner, paula)).partner).toMatchObject({
      status: 'ended',
      linkPath: null,
    });
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${t.wsId} and addon_id = 'outreach'`,
    );
    expect((await asCustomer(portalHome, paula)).partner).toBe(false);
    expect(await asCustomer(portalPartner, paula)).toEqual({ partner: null });
    await expectHfos(() => accept(paula, 2), 'not_found');
  });
});
