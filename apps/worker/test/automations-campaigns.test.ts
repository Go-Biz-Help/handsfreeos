/**
 * Settings → Automations' "Outreach campaigns" (stage 5), on the real database with the fake carrier and the
 * scripted model:
 * - who it picks (a tag) and who it leaves out: no agreement to texts, mid-conversation;
 * - the AI writes each person's text from the goal, one it can't write is left out, then the owner reviews;
 * - approved, the texts go one at a time at the campaign's pace, the first carrying the STOP wording, an edited
 *   text as edited; someone who says STOP after the review is left out when their turn comes;
 * - a faster pace brings the next text forward; quiet hours hold it; people just texted aren't picked again;
 * - a campaign about an offer gets the offer's end date in its texts.
 */
import {
  campaignApprove,
  campaignCreate,
  campaignGet,
  campaignPreviewAudience,
  campaignSetPace,
  campaignUpdateDraft,
  offerCreate,
  tagCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMPAIGN_SEND_JOB, campaignSendKey } from '../src/automations/index';
import {
  admin,
  drain,
  hh,
  hourNow,
  jobRow,
  newCustomer,
  query,
  run,
  runNow,
  setQuietHours,
  teammateWorld,
  textIn,
  textsTo,
  type TeammateWorld,
} from './ai-team-world';

let w: TeammateWorld;
let tagId: string;

beforeAll(async () => {
  w = await teammateWorld('campaigns', { status: 'training' });
  // Open around the clock, so the test runs whatever the hour.
  await rows(
    admin(),
    sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || '{"openHours": []}'::jsonb
        where id = ${w.workspaceId}`,
  );
  ({ tagId } = await run(w, tagCreate, { workspaceId: w.workspaceId, name: 'Fall list' }));
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

async function listed(first: string, consent: 'opted_in' | 'unknown' = 'opted_in') {
  const c = await newCustomer(w, first);
  await rows(
    admin(),
    sql`update app.people set sms_consent = ${consent}::app.sms_consent where id = ${c.id}`,
  );
  await rows(
    admin(),
    sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
        values (${w.workspaceId}, ${tagId}, 'person', ${c.id})`,
  );
  return c;
}

const statusOf = (campaignId: string) =>
  query(w, campaignGet, { workspaceId: w.workspaceId, campaignId });

describe('outreach campaigns', () => {
  it('picks by tag, drafts, waits for review, then sends paced and re-checks each person', async () => {
    const ann = await listed('Ann');
    const ben = await listed('Ben');
    const eve = await listed('Eve');
    await listed('Cal', 'unknown');
    const dee = await listed('Dee');
    await listed('Nodraft');
    // Dee is waiting on the business: a text in, not answered.
    await textIn(w, dee.phone, 'Is anyone coming Thursday?');

    const audience = { tagIds: [tagId], stageIds: [] };
    const preview = await query(w, campaignPreviewAudience, {
      workspaceId: w.workspaceId,
      audience,
    });
    expect(preview.recipients).toBe(4);
    expect(preview.skipped).toEqual({ not_opted_in: 1, in_conversation: 1 });

    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Fall tune-up',
      goal: 'Our fall tune-up is $89 this month',
      audience,
    });
    expect(made).toMatchObject({ recipients: 4, skipped: 2 });
    await drain(w);

    let got = await statusOf(made.campaignId);
    expect(got.campaign.status).toBe('review');
    const by = (first: string) => got.recipients.find((r) => r.name.startsWith(first))!;
    expect(by('Ann').status).toBe('ready');
    expect(by('Ann').draft).toBe('Hi Ann, Our fall tune-up is $89 this month. Just reply here.');
    expect(by('Nodraft')).toMatchObject({ status: 'skipped', skipReason: 'no_draft' });
    expect(by('Cal')).toMatchObject({ status: 'skipped', skipReason: 'not_opted_in' });
    expect(by('Dee')).toMatchObject({ status: 'skipped', skipReason: 'in_conversation' });
    // Nothing goes before it's approved.
    expect(textsTo(w, ann.phone)).toHaveLength(0);

    await run(w, campaignUpdateDraft, {
      workspaceId: w.workspaceId,
      recipientId: by('Ben').id,
      draft: 'Ben, the tune-up special is back. Want a spot?',
    });
    await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
    await drain(w);

    // One text went; the next waits three minutes (20 an hour).
    const sentOnce = [ann, ben, eve].filter((c) => textsTo(w, c.phone).length === 1);
    expect(sentOnce).toHaveLength(1);
    expect(textsTo(w, sentOnce[0]!.phone)[0]!.body).toContain('STOP');
    const next = await jobRow(campaignSendKey(made.campaignId));
    expect(next?.status).toBe('pending');
    const wait = new Date(next!.run_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(150_000);
    expect(wait).toBeLessThan(200_000);

    // Faster: the next one is brought forward.
    await run(w, campaignSetPace, {
      workspaceId: w.workspaceId,
      campaignId: made.campaignId,
      perHour: 200,
    });
    await drain(w);
    const sooner = await jobRow(campaignSendKey(made.campaignId));
    expect(new Date(sooner!.run_at).getTime() - Date.now()).toBeLessThan(25_000);

    // Eve says STOP (if her text hasn't gone): her turn skips her.
    const eveFirst = textsTo(w, eve.phone).length === 1;
    if (!eveFirst)
      await rows(
        admin(),
        sql`update app.people set sms_consent = 'opted_out'::app.sms_consent where id = ${eve.id}`,
      );
    for (let i = 0; i < 5 && (await statusOf(made.campaignId)).campaign.status === 'sending'; i++)
      await runNow(w, [campaignSendKey(made.campaignId)]);

    got = await statusOf(made.campaignId);
    expect(got.campaign.status).toBe('done');
    expect(textsTo(w, ann.phone)).toHaveLength(1);
    expect(textsTo(w, ben.phone)).toHaveLength(1);
    expect(textsTo(w, ben.phone)[0]!.body).toContain('the tune-up special is back');
    if (!eveFirst) {
      expect(textsTo(w, eve.phone)).toHaveLength(0);
      expect(got.recipients.find((r) => r.name.startsWith('Eve'))).toMatchObject({
        status: 'skipped',
        skipReason: 'not_opted_in',
      });
    }
    expect(got.campaign.counts.sent).toBe(eveFirst ? 3 : 2);
    const [ev] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where entity_id = ${made.campaignId} and event_type = 'campaign.finished'`,
    );
    expect(ev?.n).toBe(1);
  });

  it('holds texts in quiet hours, and leaves out people it just texted', async () => {
    const fay = await listed('Fay');
    const audience = { tagIds: [tagId], stageIds: [] };
    const preview = await query(w, campaignPreviewAudience, {
      workspaceId: w.workspaceId,
      audience,
    });
    // Fay, and Nodraft again (never texted): everyone else was texted just now, or left out as before.
    expect(preview.recipients).toBe(2);
    expect(preview.skipped['texted_recently']).toBeGreaterThanOrEqual(2);

    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Second pass',
      goal: 'We have openings next week',
      audience,
    });
    await drain(w);
    await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
    const H = hourNow();
    await setQuietHours(w, { start: hh(H - 1), end: hh(H + 2) });
    try {
      await drain(w);
      expect(textsTo(w, fay.phone)).toHaveLength(0);
      const held = await jobRow(campaignSendKey(made.campaignId));
      expect(held?.status).toBe('pending');
      expect(new Date(held!.run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    } finally {
      await setQuietHours(w, null);
    }
    await runNow(w, [campaignSendKey(made.campaignId)]);
    expect(textsTo(w, fay.phone)).toHaveLength(1);
    const [j] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.scheduled_jobs
          where kind = ${CAMPAIGN_SEND_JOB} and dedupe_key = ${campaignSendKey(made.campaignId)}
            and status = 'pending'`,
    );
    expect(j?.n).toBe(1);
  });

  it('writes about the campaign’s offer, with its end date', async () => {
    const gil = await listed('Gil');
    const { offerId } = await run(w, offerCreate, {
      workspaceId: w.workspaceId,
      name: 'Fall tune-up',
      details: '$89 tune-up for past customers',
      endsOn: '2099-10-31',
    });
    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Tune-up offer',
      goal: 'Fall tune-up for $89',
      audience: { tagIds: [tagId], stageIds: [] },
      offerId,
    });
    await drain(w);
    const got = await statusOf(made.campaignId);
    expect(got.campaign.offer).toEqual({ id: offerId, name: 'Fall tune-up' });
    const gils = got.recipients.find((r) => r.personId === gil.id)!;
    expect(gils.draft).toBe('Hi Gil, Fall tune-up for $89. Ends October 31. Just reply here.');
  });
});
