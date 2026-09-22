/** Current offers (M18): owners and admins keep the list; everyone reads it, with where each stands today. */
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localDateOf } from '../src/calendar/engine/zoned';
import { offerState } from '../src/queries/offer';
import { offerArchive, offerCreate, offerList, offerUpdate } from '../src/server';
import { ask, CHI, expectHfos, run, setupTeam, type Team } from './calendar-helpers';

let t: Team;
const today = () => localDateOf(Date.now(), CHI);

beforeAll(async () => {
  t = await setupTeam('offers');
});
afterAll(closeTestDbs);

describe('offers', () => {
  it('know whether they run on a day', () => {
    const o = { startsOn: '2026-10-01', endsOn: '2026-10-31' };
    expect(offerState(o, '2026-09-30')).toBe('upcoming');
    expect(offerState(o, '2026-10-01')).toBe('live');
    expect(offerState(o, '2026-10-31')).toBe('live');
    expect(offerState(o, '2026-11-01')).toBe('ended');
    expect(offerState({ startsOn: null, endsOn: null }, '2030-01-01')).toBe('live');
  });

  it('are kept by owners and admins, read by everyone, and leave the list when removed', async () => {
    await expectHfos(
      () => run(offerCreate, { workspaceId: t.wsId, name: 'Nope' }, t.member),
      'forbidden',
    );
    const { offerId } = await run(
      offerCreate,
      {
        workspaceId: t.wsId,
        name: '$50 off a tune-up',
        details: 'New customers only.',
        endsOn: addDays(today(), 10),
      },
      t.owner,
    );
    await run(
      offerCreate,
      { workspaceId: t.wsId, name: 'Spring special', startsOn: addDays(today(), 30) },
      t.owner,
    );
    await expectHfos(
      () =>
        run(
          offerCreate,
          {
            workspaceId: t.wsId,
            name: 'Backwards',
            startsOn: today(),
            endsOn: addDays(today(), -1),
          },
          t.owner,
        ),
      'validation',
    );
    const seen = await ask(offerList, { workspaceId: t.wsId }, t.member);
    expect(seen.offers.map((o) => [o.name, o.state])).toEqual([
      ['Spring special', 'upcoming'],
      ['$50 off a tune-up', 'live'],
    ]);
    const changed = await run(
      offerUpdate,
      { workspaceId: t.wsId, offerId, details: 'Anyone.', endsOn: addDays(today(), -1) },
      t.owner,
    );
    expect(changed.updated.sort()).toEqual(['details', 'endsOn']);
    expect(
      (await ask(offerList, { workspaceId: t.wsId }, t.owner)).offers.find((o) => o.id === offerId),
    ).toMatchObject({ details: 'Anyone.', state: 'ended' });
    await run(offerArchive, { workspaceId: t.wsId, offerId }, t.owner);
    expect(
      (await ask(offerList, { workspaceId: t.wsId }, t.owner)).offers.map((o) => o.name),
    ).toEqual(['Spring special']);
    await expectHfos(
      () => run(offerUpdate, { workspaceId: t.wsId, offerId, name: 'Back' }, t.owner),
      'not_found',
    );
  });
});
