/**
 * Promotions, without a database: an offer ending (Automations' "Offer ending") opens a card at the start of the day
 * three days before its last day, turns urgent on the last day, and goes when it's over, extended or archived.
 * On the database: the card opens from a real offer and closes once it's archived; a campaign can be about a running
 * offer, never an archived one.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attentionTargetOf, defaultAttentionSettings, DETECTORS } from '../src/attention/index';
import { reconcile } from '../src/attention/load';
import { addDays, localDateOf } from '../src/calendar/index';
import { campaignCreate, campaignGet, offerArchive, offerCreate, tagCreate } from '../src/server';
import { at, business, uid } from './attention-fixtures';
import {
  admin,
  ask,
  CHI,
  customer,
  expectHfos,
  nextPhone,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

const settings = defaultAttentionSettings();
const d = DETECTORS.offer_lapsing;
const offer = (over: Partial<{ endsOn: string | null; archived: boolean }> = {}) => ({
  business,
  offer: { id: uid(7), name: 'Fall tune-up $89', endsOn: '2026-09-30', archived: false, ...over },
});

describe('offer_lapsing', () => {
  it('waits until three days before the last day, then says when it ends', () => {
    expect(d.detect(offer(), settings, at('2026-09-26', '23:00'))).toBeNull();
    expect(d.wakeAt(offer(), settings, at('2026-09-26', '23:00'))).toBe(
      at('2026-09-27', '00:00').toISOString(),
    );
    const found = d.detect(offer(), settings, at('2026-09-27', '09:00'))!;
    expect(found.reasons.map((r) => r.label)).toEqual(['Fall tune-up $89 · ends Sep 30']);
    expect(found.urgentFrom).toBe(at('2026-09-30', '00:00').toISOString());
    expect(found.dueAt).toBe(at('2026-10-01', '00:00').toISOString());
  });

  it('holds all through the last day, and not after', () => {
    expect(d.detect(offer(), settings, at('2026-09-30', '23:30'))).not.toBeNull();
    expect(d.detect(offer(), settings, at('2026-10-01', '00:01'))).toBeNull();
  });

  it('leaves an offer with no end date, an archived one, and one extended past the window', () => {
    const now = at('2026-09-28', '09:00');
    expect(d.detect(offer({ endsOn: null }), settings, now)).toBeNull();
    expect(d.detect(offer({ archived: true }), settings, now)).toBeNull();
    expect(d.detect(offer({ endsOn: '2026-10-15' }), settings, now)).toBeNull();
  });

  it('a new end date is a new card', () => {
    const now = at('2026-09-28', '09:00');
    const a = d.detect(offer(), settings, now)!;
    const b = d.detect(offer({ endsOn: '2026-10-01' }), settings, now)!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('opens the offers page', () => {
    const target = attentionTargetOf(
      {
        kind: 'offer_lapsing',
        subject: { type: 'offer', id: uid(7) },
        personId: null,
        leadId: null,
        conversationId: null,
        appointmentId: null,
        reasons: [],
      },
      'ws',
    );
    expect(target).toEqual({ href: '/app/w/ws/knowledge/offers', label: 'Open the offers' });
  });
});

// ---------- on the local database ----------

describe('offers on the database', () => {
  let t: Team;
  beforeAll(async () => {
    t = await setupTeam('promo');
  });
  afterAll(closeTestDbs);

  const today = () => localDateOf(Date.now(), CHI);
  const sweep = () => asWorker(testDbs().worker.db, t.scope, (tx) => reconcile(tx, t.wsId, 'all'));
  const cardsFor = (offerId: string) =>
    rows<{ state: string; title: string }>(
      admin(),
      sql`select state::text as state, title from app.attention_items
          where workspace_id = ${t.wsId} and kind = 'offer_lapsing' and subject_id = ${offerId}`,
    );

  it('opens a card for an offer ending in two days, and closes it once archived', async () => {
    const { offerId } = await run(
      offerCreate,
      { workspaceId: t.wsId, name: 'Fall tune-up $89', endsOn: addDays(today(), 2) },
      t.owner,
    );
    const { offerId: later } = await run(
      offerCreate,
      { workspaceId: t.wsId, name: 'Winter check', endsOn: addDays(today(), 20) },
      t.owner,
    );
    await sweep();
    expect(await cardsFor(offerId)).toEqual([
      { state: 'open', title: 'Fall tune-up $89 is ending' },
    ]);
    expect(await cardsFor(later)).toEqual([]);

    await run(offerArchive, { workspaceId: t.wsId, offerId }, t.owner);
    await asWorker(testDbs().worker.db, t.scope, (tx) =>
      reconcile(tx, t.wsId, [{ type: 'offer', id: offerId }]),
    );
    expect((await cardsFor(offerId)).map((c) => c.state)).not.toContain('open');
  });

  it('a campaign can be about a running offer, never an archived one', async () => {
    const { offerId } = await run(
      offerCreate,
      { workspaceId: t.wsId, name: 'Duct cleaning $149', endsOn: addDays(today(), 10) },
      t.owner,
    );
    const { tagId } = await run(tagCreate, { workspaceId: t.wsId, name: 'Promo list' }, t.owner);
    const personId = await customer(t, 'Pat', nextPhone());
    await rows(
      admin(),
      sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${personId}`,
    );
    await rows(
      admin(),
      sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
          values (${t.wsId}, ${tagId}, 'person', ${personId})`,
    );
    const input = {
      workspaceId: t.wsId,
      name: 'Ducts',
      goal: 'Duct cleaning special',
      audience: { tagIds: [tagId] },
      offerId,
    };
    const made = await run(campaignCreate, input, t.owner);
    const got = await ask(
      campaignGet,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(got.campaign.offer).toEqual({ id: offerId, name: 'Duct cleaning $149' });

    await run(offerArchive, { workspaceId: t.wsId, offerId }, t.owner);
    await expectHfos(() => run(campaignCreate, input, t.owner), 'not_found');
  });
});
