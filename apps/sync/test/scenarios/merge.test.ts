/**
 * Two people edit the same customer with no signal (the plan's "Merge, newest wins", verification step 6).
 *
 * Dale's phone runs an hour fast and Priya's three minutes slow. Dale changes Maria's number and email; a moment
 * later Priya changes her number too, and her city. Priya's signal comes back first, then Dale's:
 *   - different details both stay: Dale's email and Priya's city;
 *   - the same detail keeps the later change: Priya's number, even though Dale's phone clock said his came later,
 *     because the API moves each phone's times onto its own clock;
 *   - the customer's timeline says Dale's number wasn't applied, and both phones end up with the same customer.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningApi, startApi } from '../harness/api';
import { admin, type Business, customer, makeBusiness } from '../harness/business';
import { eventually, Phone, sleep } from '../harness/phone';

type PersonRow = {
  readonly first_name: string;
  readonly phone: string | null;
  readonly phone_e164: string | null;
  readonly email: string | null;
  readonly city: string | null;
};

let api: RunningApi;
let b: Business;
const phones: Phone[] = [];

beforeAll(async () => {
  api = await startApi();
  b = await makeBusiness(api, `merge-${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  for (const p of phones) await p.close();
  await api.close();
  await closeTestDbs();
});

describe('two people edit the same customer offline', () => {
  it('keeps different details from both, the later change to the same detail, and says what wasn’t applied', async () => {
    const mariaId = await customer(b, {
      phone: '(713) 555-0174',
      email: 'maria@example.com',
      address: { city: 'Houston' },
    });
    const dale = await Phone.open({ api, user: b.dale, label: 'dale', clockSkewMs: 60 * 60_000 });
    const priya = await Phone.open({
      api,
      user: b.priya,
      label: 'priya',
      clockSkewMs: -3 * 60_000,
    });
    phones.push(dale, priya);
    for (const p of [dale, priya]) {
      await p.keepOffline(b.workspaceId);
      await p.online();
      await p.synced();
      await eventually('Maria on the phone', () => p.row<PersonRow>('people', mariaId));
      await p.offline();
    }

    // Dale, in a basement: Maria's new number and her email, with what he saw of each.
    const seenByDale = (await dale.row<PersonRow>('people', mariaId))!;
    const daleEdit = await dale.change(
      'person.update',
      {
        workspaceId: b.workspaceId,
        personId: mariaId,
        phone: '(713) 555-0199',
        email: 'maria.lopez@example.com',
        base: { phone: seenByDale.phone_e164, email: seenByDale.email },
      },
      {
        optimistic: (tx) =>
          tx.execute('UPDATE people SET phone = ?, phone_e164 = ?, email = ? WHERE id = ?', [
            '(713) 555-0199',
            '+17135550199',
            'maria.lopez@example.com',
            mariaId,
          ]),
      },
    );
    await sleep(1500);
    // A moment later, Priya on a roof: another new number, and Maria's city.
    const seenByPriya = (await priya.row<PersonRow>('people', mariaId))!;
    const priyaEdit = await priya.change(
      'person.update',
      {
        workspaceId: b.workspaceId,
        personId: mariaId,
        phone: '(713) 555-0142',
        address: { city: 'Katy' },
        base: { phone: seenByPriya.phone_e164, address: { city: seenByPriya.city } },
      },
      {
        optimistic: (tx) =>
          tx.execute('UPDATE people SET phone = ?, phone_e164 = ?, city = ? WHERE id = ?', [
            '(713) 555-0142',
            '+17135550142',
            'Katy',
            mariaId,
          ]),
      },
    );
    // Offline, each phone shows its own edit.
    expect(await dale.row<PersonRow>('people', mariaId)).toMatchObject({
      phone_e164: '+17135550199',
    });
    expect(await priya.row<PersonRow>('people', mariaId)).toMatchObject({ city: 'Katy' });

    // Priya's signal comes back first, then Dale's.
    await priya.online();
    expect(JSON.parse((await priya.settled(priyaEdit, 'applied')).answer!)).toMatchObject({
      updated: expect.arrayContaining(['phoneE164', 'city']),
      notApplied: [],
    });
    await dale.online();
    expect(JSON.parse((await dale.settled(daleEdit, 'applied')).answer!)).toMatchObject({
      updated: ['email'],
      notApplied: ['phone'],
    });

    const [stored] = await rows<PersonRow>(
      admin(),
      sql`select first_name, phone, phone_e164, email::text as email, city from app.people where id = ${mariaId}`,
    );
    expect(stored).toMatchObject({
      phone_e164: '+17135550142',
      email: 'maria.lopez@example.com',
      city: 'Katy',
    });

    // Both phones end up with the same Maria, and her timeline says Dale's number wasn't applied.
    for (const p of [dale, priya]) {
      const settled = await eventually(`${p.options.label}: Maria settled`, async () => {
        const r = await p.row<PersonRow>('people', mariaId);
        return r?.phone_e164 === '+17135550142' &&
          r.email === 'maria.lopez@example.com' &&
          r.city === 'Katy'
          ? r
          : null;
      });
      const entry = await eventually(`${p.options.label}: the timeline entry`, () =>
        p.db.getOptional<{ body: string; meta: string }>(
          `SELECT body, meta FROM activities WHERE person_id = ? AND subtype = 'edit_not_applied'`,
          [mariaId],
        ),
      );
      expect(JSON.parse(entry.value.meta)).toMatchObject({
        field: 'phone',
        wanted: '(713) 555-0199',
        stays: '(713) 555-0142',
        keptBy: 'Priya Admin',
      });
      expect(entry.value.body).toContain('Priya Admin’s later change to “(713) 555-0142” was kept');
      console.log(
        `${p.options.label}: Maria settled ${settled.ms} ms after the last upload, timeline entry after ${entry.ms} ms`,
      );
    }
  });
});
