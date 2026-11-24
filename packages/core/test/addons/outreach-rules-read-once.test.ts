/**
 * Social Outreach's rules for who is left out (Don't pitch, Never contact, a partner, a client, a teammate's person)
 * are told to a statement two ways (../../src/addons/outreach/ops/common.ts): as lists read once for the request
 * (`ruledOut`), or looked up in the statement itself (`LOOKED_UP`). Both must say the same of everyone, whichever a
 * statement uses: this holds them to it, twins, other networks, other businesses and a profile that isn't there
 * included.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { as, closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOOKED_UP,
  contactable,
  isClient,
  notNever,
  notOthers,
  partnered,
  pitchable,
  ruledOut,
  ruledOutIn,
  rulesAtHand,
  rulesReadOnce,
  type Ctx,
  type RuledOut,
} from '../../src/addons/outreach/ops/common';
import { outreachBusiness } from './outreach-fixture';

const admin = () => testDbs().admin.db;
/** A name whose key depends on what the database counts as a space: only that the two ways agree is checked. */
const ODD = /\u2003|\n|^\t/;

type Said = {
  name: string;
  platform: string;
  reached: boolean | null;
  partner: boolean | null;
  pitched: boolean | null;
  contacted: boolean | null;
  client: boolean | null;
  free: boolean | null;
};

/** What the rules say of everyone in `ws`, told `how`. */
const saidOf = (tx: Tx, ws: string, me: string, how: RuledOut) =>
  rows<Said>(
    tx,
    sql`select p.name, p.platform, ${notNever(how, 'p')} as reached, ${partnered(how, 'p')} as partner,
          ${pitchable(how, 'p')} as pitched, ${contactable(how, 'p')} as contacted, ${isClient(how, 'p')} as client,
          ${notOthers(how, me, 'p')} as free
        from addon_outreach.profiles p where p.workspace_id = ${ws} order by p.platform, p.name, p.id`,
  );

/** The same of a profile that isn't there: the empty side of a left join. */
const saidOfNobody = (tx: Tx, me: string, how: RuledOut) =>
  rows<Omit<Said, 'name' | 'platform'>>(
    tx,
    sql`select ${notNever(how, 'p')} as reached, ${partnered(how, 'p')} as partner, ${pitchable(how, 'p')} as pitched,
          ${contactable(how, 'p')} as contacted, ${isClient(how, 'p')} as client, ${notOthers(how, me, 'p')} as free
        from (select 1) one left join addon_outreach.profiles p on false`,
  );

describe('the rules read once and the rules looked up', () => {
  let owner: TestUser;
  let ana: TestUser;
  let gus: TestUser;
  let ws: string;
  let other: string;
  let quiet: string;

  const person = async (workspace: string, first: string, tag?: string) => {
    const [made] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name) values (${workspace}, ${first}, 'Test')
          returning id`,
    );
    if (tag)
      await rows(
        admin(),
        sql`with t as (insert into app.tags (workspace_id, name) values (${workspace}, ${tag}) returning id)
            insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            select ${workspace}, t.id, 'person', ${made!.id} from t`,
      );
    return made!.id;
  };
  let n = 0;
  const profile = async (
    workspace: string,
    platform: string,
    name: string,
    marks: {
      person?: string;
      dontPitch?: boolean;
      neverContact?: boolean;
      partner?: boolean;
      owner?: string;
    } = {},
  ) => {
    n += 1;
    await rows(
      admin(),
      sql`insert into addon_outreach.profiles (workspace_id, platform, username, url, name, person_id, dont_pitch,
            never_contact, partner_found_at, owner_user_id)
          values (${workspace}, ${platform}, ${`rules-${n}`}, ${`https://example.com/rules-${n}`}, ${name},
            ${marks.person ?? null}, ${marks.dontPitch ?? false}, ${marks.neverContact ?? false},
            ${marks.partner ? sql`now()` : sql`null`}, ${marks.owner ?? null})`,
    );
  };

  beforeAll(async () => {
    [owner, ana, gus] = await Promise.all([
      createTestUser('outr-owner', { fullName: 'Pat Owner' }),
      createTestUser('outr-ana', { fullName: 'Ana Ortiz' }),
      createTestUser('outr-gus', { fullName: 'Gus Gone' }),
    ]);
    ws = await outreachBusiness(owner, 'Outreach Rules Co');
    other = await outreachBusiness(owner, 'Outreach Rules Other Co');
    quiet = await outreachBusiness(owner, 'Outreach Rules Quiet Co');
    // Ana uses Social Outreach here. Gus never joined: what he holds is nobody's.
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: ws, userId: ana.id, role: 'member' });

    const family = await person(ws, 'Fay', 'Friend or family');
    const customer = await person(ws, 'Carl');
    const off = await person(ws, 'Nora');
    const partner = await person(ws, 'Paula');
    const client = await person(ws, 'Cleo', 'client');

    await profile(ws, 'facebook', 'Pat Plain');
    // Don't pitch: the profile, and anyone kept under its name on its network, however it's spaced or capitalised.
    await profile(ws, 'facebook', 'Dana Dontpitch', { dontPitch: true });
    await profile(ws, 'facebook', '  dana   DONTPITCH ');
    await profile(ws, 'facebook', 'Dana\tDontpitch');
    // Names only some databases would call the same: the two ways must still agree on them.
    await profile(ws, 'facebook', 'Dana\u2003Dontpitch');
    await profile(ws, 'facebook', 'Dana Dontpitch\n');
    await profile(ws, 'facebook', '\tDana Dontpitch');
    await profile(ws, 'linkedin', 'Dana Dontpitch');
    // A customer tagged Friend or family: every profile on them, and those profiles' names.
    await profile(ws, 'facebook', 'Fay Family', { person: family });
    await profile(ws, 'facebook', 'fay family');
    await profile(ws, 'linkedin', 'Fay F', { person: family });
    // A customer with a profile on Don't pitch: their other profiles, but not those profiles' names.
    await profile(ws, 'facebook', 'Carl Customer', { person: customer, dontPitch: true });
    await profile(ws, 'linkedin', 'Carl C', { person: customer });
    await profile(ws, 'linkedin', 'carl c');
    // Never contact, the same way.
    await profile(ws, 'facebook', 'Nora Off', { person: off, neverContact: true });
    await profile(ws, 'facebook', 'NORA  OFF');
    await profile(ws, 'instagram', 'noraoff', { person: off });
    await profile(ws, 'instagram', 'NoraOff');
    // A partner, the same way.
    await profile(ws, 'facebook', 'Paula Partner', { person: partner, partner: true });
    await profile(ws, 'facebook', 'paula  partner');
    await profile(ws, 'linkedin', 'Paula P', { person: partner });
    await profile(ws, 'linkedin', 'paula p');
    await profile(ws, 'facebook', 'Bo Both', { dontPitch: true, partner: true });
    // A client: every profile on the customer, and anyone kept under any of their names on its network.
    await profile(ws, 'facebook', 'Cleo Client', { person: client });
    await profile(ws, 'facebook', 'CLEO CLIENT');
    await profile(ws, 'linkedin', 'Cleo C', { person: client });
    await profile(ws, 'linkedin', 'cleo c');
    // Whose they are.
    await profile(ws, 'facebook', 'Mia Mine', { owner: owner.id });
    await profile(ws, 'facebook', 'Tom Teammate', { owner: ana.id });
    await profile(ws, 'facebook', 'Gus Gone', { owner: gus.id });

    // Another business of the same owner's: its marks are its own.
    await profile(other, 'facebook', 'Pat Plain', { dontPitch: true });
    await profile(other, 'facebook', 'Dana Dontpitch');
    await profile(other, 'facebook', 'Cleo Client', { neverContact: true });
    // And one with nobody marked at all.
    await profile(quiet, 'facebook', 'Pat Plain');
  });
  afterAll(closeTestDbs);

  it('say the same of everyone, in each business', async () => {
    for (const workspace of [ws, other, quiet]) {
      const { lookedUp, read } = await as(owner)(async (tx) => ({
        lookedUp: await saidOf(tx, workspace, owner.id, LOOKED_UP),
        read: await saidOf(tx, workspace, owner.id, await ruledOutIn(tx, workspace)),
      }));
      expect(read.length).toBeGreaterThan(0);
      expect(read).toEqual(lookedUp);
    }
  });

  it('say the same of a profile that isn’t there', async () => {
    // Neither in nor out, by every rule but whose they are: nobody's.
    for (const workspace of [ws, quiet]) {
      const { lookedUp, read } = await as(owner)(async (tx) => ({
        lookedUp: await saidOfNobody(tx, owner.id, LOOKED_UP),
        read: await saidOfNobody(tx, owner.id, await ruledOutIn(tx, workspace)),
      }));
      expect(read).toEqual(lookedUp);
      expect(read).toEqual([
        { reached: null, partner: null, pitched: null, contacted: null, client: null, free: true },
      ]);
    }
  });

  it('leave out who the rules say, and nobody else', async () => {
    const read = await as(owner)(async (tx) => saidOf(tx, ws, owner.id, await ruledOutIn(tx, ws)));
    const of = (platform: string, name: string) => {
      const found = read.filter((r) => r.platform === platform && r.name === name);
      expect(found, `${platform} ${JSON.stringify(name)}`).toHaveLength(1);
      return found[0]!;
    };
    const names = (pick: (r: Said) => boolean | null) =>
      read
        .filter((r) => !ODD.test(r.name) && pick(r))
        .map((r) => `${r.platform}:${r.name}`)
        .sort();

    expect(names((r) => !r.reached)).toEqual(
      [
        'facebook:  dana   DONTPITCH ',
        'facebook:Bo Both',
        'facebook:Carl Customer',
        'facebook:Dana Dontpitch',
        'facebook:Dana\tDontpitch',
        'facebook:Fay Family',
        'facebook:NORA  OFF',
        'facebook:Nora Off',
        'facebook:fay family',
        'instagram:noraoff',
        'linkedin:Carl C',
        'linkedin:Fay F',
      ].sort(),
    );
    expect(names((r) => !r.contacted)).toEqual(
      ['facebook:NORA  OFF', 'facebook:Nora Off', 'instagram:noraoff'].sort(),
    );
    expect(names((r) => r.partner)).toEqual(
      [
        'facebook:Bo Both',
        'facebook:Paula Partner',
        'facebook:paula  partner',
        'linkedin:Paula P',
      ].sort(),
    );
    expect(names((r) => r.client)).toEqual(
      ['facebook:CLEO CLIENT', 'facebook:Cleo Client', 'linkedin:Cleo C', 'linkedin:cleo c'].sort(),
    );
    // Pitched: reached, and not a partner.
    for (const r of read) expect(r.pitched, r.name).toBe(!!r.reached && !r.partner);
    // Only a teammate who uses Social Outreach holds anyone.
    expect(names((r) => !r.free)).toEqual(['facebook:Tom Teammate']);
    expect(of('facebook', 'Gus Gone').free).toBe(true);
    expect(of('facebook', 'Mia Mine').free).toBe(true);
    // The same name on another network is someone else, and so is a name in another business.
    expect(of('linkedin', 'Dana Dontpitch').reached).toBe(true);
    expect(of('facebook', 'Pat Plain')).toMatchObject({
      reached: true,
      contacted: true,
      client: false,
    });
  });

  it('are read once by a query, and afresh each time by a command', async () => {
    await as(owner)(async (tx) => {
      const scope = { workspaceId: quiet };
      const query = { tx, scope } as unknown as Ctx;
      const command = { tx, scope, emit: () => undefined } as unknown as Ctx;

      // A query: nothing at hand until it reads them, then the same lists however often it asks.
      expect(await rulesAtHand(query)).toBe(LOOKED_UP);
      const first = await ruledOut(query);
      expect(await ruledOut(query)).toBe(first);
      expect(await rulesAtHand(query)).toBe(first);

      // A command: each read is as things stand now, and nothing is kept at hand...
      const before = await ruledOut(command);
      expect(await rulesAtHand(command)).toBe(LOOKED_UP);
      await tx.execute(
        sql`update addon_outreach.profiles set dont_pitch = true where workspace_id = ${quiet}`,
      );
      const after = await ruledOut(command);
      expect(after.never).not.toBe(before.never);
      // ...but while it only reads.
      await rulesReadOnce(command, async () => {
        const held = await ruledOut(command);
        expect(await ruledOut(command)).toBe(held);
        expect(await rulesAtHand(command)).toBe(held);
      });
      expect(await rulesAtHand(command)).toBe(LOOKED_UP);
      await tx.execute(
        sql`update addon_outreach.profiles set dont_pitch = false where workspace_id = ${quiet}`,
      );
    });
  });
});
