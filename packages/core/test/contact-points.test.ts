/**
 * More than one way to reach a customer (0100): other emails, numbers and addresses beside the main ones, tidied the
 * same way in TypeScript and in the database, merged newest-wins like every other detail, and found by every lookup
 * that finds a customer by a number or an email.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  otherAddressesOut,
  otherPhonesOut,
  rebaseList,
  tidyOtherAddresses,
  tidyOtherEmails,
  tidyOtherPhones,
} from '../src/crm/contact-points';
import { findMatches } from '../src/crm/matching';
import { executeCommand } from '../src/kernel/execute';
import { matchPersonByEmail } from '../src/messaging/email';
import { matchPersonByPhone } from '../src/messaging/store';
import {
  companyCreate,
  companyGet,
  companyUpdate,
  conversationLinkPerson,
  conversationOpen,
  personCreate,
  personGet,
  personList,
  personUpdate,
} from '../src/server';
import { admin, ask, expectHfos, human, run, setupTeam, type Team } from './calendar-helpers';

let t: Team;
beforeAll(async () => {
  t = await setupTeam('contact-points');
});
afterAll(closeTestDbs);

const inWorker = <T>(fn: Parameters<typeof asWorker<T>>[2]) =>
  asWorker(testDbs().worker.db, t.scope, fn);

describe('tidying', () => {
  it('trims, lowercases, drops empties, repeats and the main one — as the database does', () => {
    expect(
      tidyOtherEmails(
        [
          { email: ' Dale@Work.com ', label: ' Work ' },
          { email: 'dale@work.com', label: 'again' },
          { email: 'DALE@home.com' },
          { email: '   ' },
          { email: 'main@x.com', label: '' },
        ],
        'Main@X.com',
      ),
    ).toEqual([{ email: 'dale@work.com', label: 'Work' }, { email: 'dale@home.com' }]);
    expect(
      tidyOtherPhones(
        [
          { phone: '+17135550100' },
          { phone: '+17135550111', label: '' },
          { phone: '+17135550111' },
        ],
        '+17135550100',
      ),
    ).toEqual([{ phone: '+17135550111' }]);
    expect(
      tidyOtherAddresses(
        [
          { line1: '1 main st', city: 'HOUSTON' },
          { label: 'Rental', line1: ' 12 Oak ', city: 'Katy', postalCode: '77494' },
          { label: 'Nowhere', state: 'TX' },
        ],
        { line1: '1 Main St', city: 'Houston' },
      ),
    ).toEqual([
      { label: 'Rental', line1: '12 Oak', city: 'Katy', postalCode: '77494', country: 'US' },
    ]);
  });

  it('rebases an edited list on what is there now, entry by entry', () => {
    const k = (e: { v: string }) => e.v;
    const base = [{ v: 'a' }, { v: 'b' }, { v: 'c', l: 'x' }];
    // Nothing changed since: the edit as it is, order and all.
    expect(rebaseList([{ v: 'c', l: 'x' }, { v: 'a' }], base, base, k)).toEqual([
      { v: 'c', l: 'x' },
      { v: 'a' },
    ]);
    // Somebody else added d and relabelled c since; the editor took b off and added e.
    const now = [{ v: 'a' }, { v: 'b' }, { v: 'c', l: 'y' }, { v: 'd' }];
    expect(rebaseList([{ v: 'a' }, { v: 'c', l: 'x' }, { v: 'e' }], base, now, k)).toEqual([
      { v: 'a' },
      { v: 'c', l: 'y' },
      { v: 'd' },
      { v: 'e' },
    ]);
    // The editor's own change to an entry wins over what was there.
    expect(rebaseList([{ v: 'a', l: 'z' }], [{ v: 'a' }], [{ v: 'a' }, { v: 'd' }], k)).toEqual([
      { v: 'a', l: 'z' },
      { v: 'd' },
    ]);
    // Taken off by somebody else: it stays off, unless the editor changed it, which brings it back.
    expect(rebaseList([{ v: 'a' }, { v: 'b' }], [{ v: 'a' }, { v: 'b' }], [{ v: 'a' }], k)).toEqual(
      [{ v: 'a' }],
    );
    expect(
      rebaseList([{ v: 'a' }, { v: 'b', l: 'new' }], [{ v: 'a' }, { v: 'b' }], [{ v: 'a' }], k),
    ).toEqual([{ v: 'a' }, { v: 'b', l: 'new' }]);
  });

  it('reads whatever a row or a phone holds without throwing', () => {
    expect(otherPhonesOut('[{"phone":"+17135550111","label":"Office"}]')).toEqual([
      { phone: '(713) 555-0111', phoneE164: '+17135550111', label: 'Office' },
    ]);
    expect(otherPhonesOut('not json')).toEqual([]);
    expect(otherAddressesOut([{ city: 'Katy' }, 'nonsense', null])).toEqual([
      {
        label: null,
        line1: null,
        line2: null,
        city: 'Katy',
        state: null,
        postalCode: null,
        country: 'US',
      },
    ]);
  });
});

describe('a person with more than one of each', () => {
  let personId: string;

  it('is created with their other emails, numbers and addresses, tidied', async () => {
    ({ personId } = await run(
      personCreate,
      {
        workspaceId: t.wsId,
        firstName: 'Dale',
        lastName: 'Harper',
        email: 'dale@harper.com',
        phone: '(713) 555-0100',
        address: { line1: '1 Main St', city: 'Houston', state: 'TX' },
        otherEmails: [
          { email: 'DALE@work.com', label: 'Work' },
          { email: 'dale@harper.com', label: 'repeats the main one' },
        ],
        otherPhones: [{ phone: '713 555 0111', label: 'Office' }],
        otherAddresses: [
          { label: 'Rental', line1: '12 Oak St', city: 'Katy', postalCode: '77494' },
        ],
      },
      t.member,
    ));
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.otherEmails).toEqual([{ email: 'dale@work.com', label: 'Work' }]);
    expect(person.otherPhones).toEqual([
      { phone: '(713) 555-0111', phoneE164: '+17135550111', label: 'Office' },
    ]);
    expect(person.otherAddresses).toEqual([
      {
        label: 'Rental',
        line1: '12 Oak St',
        line2: null,
        city: 'Katy',
        state: null,
        postalCode: '77494',
        country: 'US',
      },
    ]);
    // What older builds show as "Other phone".
    expect(person.phoneAlt).toBe('(713) 555-0111');
  });

  it('refuses a number or an email that is not one', async () => {
    await expectHfos(
      () =>
        run(
          personUpdate,
          { workspaceId: t.wsId, personId, otherPhones: [{ phone: 'call me maybe' }] },
          t.member,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          personUpdate,
          { workspaceId: t.wsId, personId, otherEmails: [{ email: 'nope' }] },
          t.member,
        ),
      'validation',
    );
  });

  it('is found by search, by their other number and by their other email', async () => {
    const { items } = await ask(personList, { workspaceId: t.wsId, q: '5550111' }, t.member);
    expect(items.map((p) => p.id)).toEqual([personId]);
    const byCity = await ask(personList, { workspaceId: t.wsId, q: 'katy' }, t.member);
    expect(byCity.items.map((p) => p.id)).toContain(personId);
    const byEmail = await ask(personList, { workspaceId: t.wsId, q: 'dale@work' }, t.member);
    expect(byEmail.items.map((p) => p.id)).toEqual([personId]);
    expect(await inWorker((tx) => matchPersonByPhone(tx, t.wsId, '+17135550111'))).toBe(personId);
    expect(await inWorker((tx) => matchPersonByEmail(tx, t.wsId, 'Dale@Work.com'))).toBe(personId);
    const matches = await inWorker((tx) =>
      findMatches(tx, t.wsId, 'person', { email: 'dale@work.com' }),
    );
    expect(matches[0]).toMatchObject({ id: personId, matchedOn: 'email' });
  });

  it('warns about a new customer whose number is on someone’s other list', async () => {
    const err = await expectHfos(
      () =>
        run(
          personCreate,
          { workspaceId: t.wsId, firstName: 'Office', phone: '+17135550111' },
          t.member,
        ),
      'duplicate',
    );
    expect(
      (err.details as { matches: { id: string; matchedOn: string }[] }).matches[0],
    ).toMatchObject({ id: personId, matchedOn: 'phone' });
  });

  it('prefers the customer whose main number it is when two have it', async () => {
    const other = await run(
      personCreate,
      {
        workspaceId: t.wsId,
        firstName: 'Shared',
        phone: '+17135550122',
        ignoreDuplicates: true,
      },
      t.member,
    );
    await run(
      personUpdate,
      { workspaceId: t.wsId, personId, otherPhones: [{ phone: '+17135550122', label: 'Shop' }] },
      t.member,
    );
    expect(await inWorker((tx) => matchPersonByPhone(tx, t.wsId, '+17135550122'))).toBe(
      other.personId,
    );
  });

  it('swaps the main number with another in one edit', async () => {
    const out = await run(
      personUpdate,
      {
        workspaceId: t.wsId,
        personId,
        phone: '+17135550111',
        otherPhones: [{ phone: '+17135550100', label: 'Old cell' }],
      },
      t.member,
    );
    expect(out.updated).toEqual(expect.arrayContaining(['phoneE164', 'otherPhones']));
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.phoneE164).toBe('+17135550111');
    expect(person.otherPhones.map((p) => p.phoneE164)).toEqual(['+17135550100']);
  });

  it('never keeps the main one in the list, whoever writes it', async () => {
    // A writer that only knows the main column (an import, say) sets the main number to one of the others.
    await rows(
      admin(),
      sql`update app.people set phone_e164 = '+17135550100' where id = ${personId}`,
    );
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.otherPhones).toEqual([]);
  });

  it('adds an older phone’s "other phone" to the others instead of replacing them', async () => {
    await run(
      personUpdate,
      { workspaceId: t.wsId, personId, otherPhones: [{ phone: '+17135550133', label: 'Work' }] },
      t.member,
    );
    await run(personUpdate, { workspaceId: t.wsId, personId, phoneAlt: '713-555-0144' }, t.member);
    // A number already on file keeps its label and its place.
    await run(personUpdate, { workspaceId: t.wsId, personId, phoneAlt: '713-555-0133' }, t.member);
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.otherPhones.map((p) => [p.phoneE164, p.label])).toEqual([
      ['+17135550133', 'Work'],
      ['+17135550144', 'Other'],
    ]);
    const [row] = await rows<{ phone_alt: string | null }>(
      admin(),
      sql`select phone_alt from app.people where id = ${personId}`,
    );
    expect(row!.phone_alt).toBeNull();
  });

  it('merges an offline edit into a list someone else changed since, entry by entry', async () => {
    const { person: before } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    const seen = before.otherEmails.map((e) => ({ email: e.email, label: e.label }));
    // Someone else changes the list now…
    await run(
      personUpdate,
      { workspaceId: t.wsId, personId, otherEmails: [{ email: 'dale@new.com' }] },
      t.priya,
    );
    // …and an edit a phone made a minute earlier, with no signal, arrives after it: the later change stays.
    const late = await executeCommand(
      testDbs().api.db,
      personUpdate,
      {
        workspaceId: t.wsId,
        personId,
        otherEmails: [{ email: 'dale@offline.com' }],
        base: { otherEmails: seen },
      },
      human(t.member),
      {
        correlationId: randomUUID(),
        channel: 'mobile',
        commandId: randomUUID(),
        occurredAt: new Date(Date.now() - 60_000),
      },
    );
    // Both stay: the later change's new email, and the one the phone added.
    expect(late.output.notApplied).toEqual([]);
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.otherEmails.map((e) => e.email)).toEqual(['dale@new.com', 'dale@offline.com']);
  });

  it('keeps both of two people’s additions when they edit the list at the same time', async () => {
    const { person: opened } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    const seen = opened.otherPhones.map((p) => ({ phone: p.phoneE164, label: p.label }));
    const add = (u: Team['owner'], phone: string, label: string) =>
      run(
        personUpdate,
        {
          workspaceId: t.wsId,
          personId,
          otherPhones: [...seen, { phone, label }],
          base: { otherPhones: seen },
        },
        u,
      );
    // Both dialogs opened on the same list; each adds a number and saves.
    await add(t.priya, '+17135550155', 'Office');
    await add(t.member, '+17135550166', 'Cell');
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.otherPhones.map((p) => p.phoneE164)).toEqual([
      ...seen.map((p) => p.phone),
      '+17135550155',
      '+17135550166',
    ]);
    // One of them takes a number off while the other relabels another: both land.
    const now = person.otherPhones.map((p) => ({ phone: p.phoneE164, label: p.label }));
    await run(
      personUpdate,
      {
        workspaceId: t.wsId,
        personId,
        otherPhones: now.filter((p) => p.phone !== '+17135550155'),
        base: { otherPhones: now },
      },
      t.priya,
    );
    await run(
      personUpdate,
      {
        workspaceId: t.wsId,
        personId,
        otherPhones: now.map((p) => (p.phone === '+17135550166' ? { ...p, label: 'Mobile' } : p)),
        base: { otherPhones: now },
      },
      t.member,
    );
    const { person: after } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(after.otherPhones.find((p) => p.phoneE164 === '+17135550155')).toBeUndefined();
    expect(after.otherPhones.find((p) => p.phoneE164 === '+17135550166')?.label).toBe('Mobile');
  });

  it('opens a thread on another number on file, and refuses one that is not', async () => {
    const { conversationId } = await run(
      conversationOpen,
      { workspaceId: t.wsId, personId, channel: 'sms', to: '(713) 555-0133' },
      t.member,
    );
    const [c] = await rows<{ counterpart: string; person_id: string }>(
      admin(),
      sql`select counterpart, person_id from app.conversations where id = ${conversationId}`,
    );
    expect(c).toEqual({ counterpart: '+17135550133', person_id: personId });
    await expectHfos(
      () =>
        run(
          conversationOpen,
          { workspaceId: t.wsId, personId, channel: 'sms', to: '+17135559999' },
          t.member,
        ),
      'not_their_number',
    );
    await expectHfos(
      () =>
        run(
          conversationOpen,
          { workspaceId: t.wsId, personId, channel: 'email', to: 'stranger@x.com' },
          t.member,
        ),
      'not_their_email',
    );
  });

  it('keeps a linked thread’s number on the customer who already has a main one', async () => {
    const [{ id: conversationId }] = (await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart)
          values (${t.wsId}, 'sms', '+17135550177') returning id`,
    )) as [{ id: string }];
    const out = await run(
      conversationLinkPerson,
      { workspaceId: t.wsId, conversationId, personId },
      t.member,
    );
    expect(out.phoneAdded).toBe(true);
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.member);
    expect(person.otherPhones.map((p) => p.phoneE164)).toContain('+17135550177');
  });
});

describe('a company with more than one of each', () => {
  it('keeps its other emails, numbers and addresses too', async () => {
    const { companyId } = await run(
      companyCreate,
      {
        workspaceId: t.wsId,
        name: 'Harper Rentals',
        email: 'office@harper.com',
        otherEmails: [{ email: 'billing@harper.com', label: 'Billing' }],
        otherPhones: [{ phone: '713-555-0199', label: 'Front desk' }],
      },
      t.member,
    );
    await run(
      companyUpdate,
      {
        workspaceId: t.wsId,
        companyId,
        otherAddresses: [{ label: 'Warehouse', line1: '9 Dock Rd', city: 'Pasadena' }],
      },
      t.member,
    );
    const { company } = await ask(companyGet, { workspaceId: t.wsId, companyId }, t.member);
    expect(company.otherEmails).toEqual([{ email: 'billing@harper.com', label: 'Billing' }]);
    expect(company.otherPhones.map((p) => p.phoneE164)).toEqual(['+17135550199']);
    expect(company.otherAddresses.map((a) => a.city)).toEqual(['Pasadena']);
  });
});
