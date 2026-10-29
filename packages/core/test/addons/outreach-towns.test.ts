/**
 * The towns near the person's own on Alignable (docs/outreach.md decision 115, the owner's pick 33a: "Towns within 25
 * miles, closest first."): worked out from where the US Census Bureau puts each town, the closest first, and each day
 * one of them to search in too, in turn from the closest. None for a town it doesn't know.
 */
import { sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { milesApart, townsNear } from '../../src/addons/outreach/ops/towns';
import {
  inTowns,
  NEAR_MILES,
  NEAR_TOWNS_MOST,
  townKey,
  townOrder,
} from '../../src/addons/outreach/towns';
import { US_TOWNS } from '../../src/addons/outreach/us-towns';
import { outreachBusiness, refused, runAs } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;

afterAll(closeTestDbs);

/** Where a town is, from the Census list, in degrees. */
function placeOf(town: string) {
  const state = town.slice(-2);
  const name = town.slice(0, -3);
  const entry = US_TOWNS[state]!.split('|').find((e) => e.startsWith(`${name} `))!;
  const [, lat, lon] = entry.split(' ');
  return { lat: Number(lat) / 100, lon: Number(lon) / 100 };
}

describe('a town however it’s written', () => {
  it('takes Saint and St, Fort and Ft, Mount and Mt, and dropped marks as one town', () => {
    expect(townKey('saint-louis-mo')).toBe(townKey('st-louis-mo'));
    expect(townKey('fort-worth-tx')).toBe(townKey('ft-worth-tx'));
    expect(townKey('mount-pleasant-sc')).toBe(townKey('mt-pleasant-sc'));
    expect(townKey('coeur-d-alene-id')).toBe(townKey('coeur-dalene-id'));
    expect(townKey('fortuna-ca')).not.toBe(townKey('ftuna-ca'));
    expect(townKey('austin-tx')).not.toBe(townKey('austin-mn'));
  });

  it('keeps a business in the person’s town or one near it, the closest first and others last', () => {
    const towns = ['austin-tx', 'round-rock-tx', 'pflugerville-tx'];
    expect(inTowns(towns, 'round-rock-tx')).toBe(true);
    expect(inTowns(towns, 'houston-tx')).toBe(false);
    expect(inTowns(towns, null)).toBe(false);
    expect(townOrder(towns, 'austin-tx')).toBe(0);
    expect(townOrder(towns, 'pflugerville-tx')).toBe(2);
    expect(townOrder(towns, 'houston-tx')).toBe(3);
    expect(townOrder(towns, null)).toBe(3);
  });
});

describe('the towns near theirs', () => {
  it('knows the US towns as Alignable writes them, consolidated cities by their own names', () => {
    expect(Object.keys(US_TOWNS)).toHaveLength(51);
    expect(US_TOWNS['pr']).toBeUndefined();
    for (const town of ['nashville-tn', 'louisville-ky', 'lexington-ky', 'honolulu-hi', 'boise-id'])
      expect(placeOf(town).lat).toBeGreaterThan(19);
    expect(milesApart(placeOf('austin-tx'), placeOf('houston-tx'))).toBeGreaterThan(140);
    expect(milesApart(placeOf('austin-tx'), placeOf('houston-tx'))).toBeLessThan(155);
  });

  it('gives those within 25 miles, the closest first, never the town itself', () => {
    const near = townsNear('austin-tx');
    expect(near).toEqual(
      expect.arrayContaining(['round-rock-tx', 'cedar-park-tx', 'pflugerville-tx']),
    );
    expect(near).not.toContain('austin-tx');
    expect(near).not.toContain('houston-tx');
    expect(near).not.toContain('san-antonio-tx');
    expect(near.length).toBeLessThanOrEqual(NEAR_TOWNS_MOST);
    const here = placeOf('austin-tx');
    const miles = near.map((t) => milesApart(here, placeOf(t)));
    expect(miles.every((m) => m <= NEAR_MILES)).toBe(true);
    expect(miles).toEqual([...miles].sort((a, b) => a - b));
    // However it's written.
    expect(townsNear('AUSTIN-TX')).toEqual(near);
    expect(townsNear('saint-louis-mo')).toEqual(townsNear('st-louis-mo'));
    expect(townsNear('st-louis-mo').length).toBeGreaterThan(10);
  });

  it('gives none for a town it doesn’t know', () => {
    expect(townsNear('nowhere-zz')).toEqual([]);
    expect(townsNear('toronto-on')).toEqual([]);
  });
});

describe('outreach.finds.towns', () => {
  let casey: TestUser;
  let ws: string;
  beforeAll(async () => {
    casey = await createTestUser('outtown-casey', { fullName: 'Casey Owner' });
    ws = await outreachBusiness(casey, 'Casey Roofing');
  });

  it('gives the towns near theirs and today’s, in turn from the closest from their first day on Alignable', async () => {
    // Their first day there was 90 days ago (the fixture's).
    const near = townsNear('austin-tx');
    const got = await runAs(casey, ws, 'outreach.finds.towns', { town: 'austin-tx' });
    expect(got).toEqual({ near, today: near[90 % near.length] });

    await admin().execute(sql`
      update addon_outreach.network_starts set first_at = ${new Date(Date.now() - 2 * DAY).toISOString()}
      where workspace_id = ${ws} and user_id = ${casey.id} and platform = 'alignable'`);
    const later = await runAs(casey, ws, 'outreach.finds.towns', { town: ' Austin-TX ' });
    expect(later.today).toBe(near[2]);
  });

  it('gives none near a town it doesn’t know, and refuses one not written as Alignable writes it', async () => {
    expect(await runAs(casey, ws, 'outreach.finds.towns', { town: 'toronto-on' })).toEqual({
      near: [],
      today: null,
    });
    expect(await refused(runAs(casey, ws, 'outreach.finds.towns', { town: 'Austin, TX' }))).toBe(
      'validation',
    );
  });
});
