/**
 * Call campaigns on the local database (AI outbound calls, piece 4b): a call campaign goes only to people who
 * agreed to calls in writing (Chris, 2026-09-23), and leaves out anyone another campaign called lately; its one
 * opening line changes before approval (never a text's draft); and it can't be approved without that line.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callSkipReasonOf,
  campaignApprove,
  campaignCreate,
  campaignGet,
  campaignPreviewAudience,
  campaignUpdateCall,
  campaignUpdateDraft,
  campaignUpdateEmail,
  personSetCallConsent,
  tagCreate,
} from '../src/server';
import {
  admin,
  ask,
  customer,
  expectHfos,
  nextPhone,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('who a call campaign leaves out', () => {
  const none = {
    hasPhone: true,
    callConsent: true,
    calledRecently: false,
    inConversation: false,
    bookedSoon: false,
  };
  it('gives the first reason that applies', () => {
    expect(callSkipReasonOf(none)).toBeNull();
    expect(callSkipReasonOf({ ...none, hasPhone: false, callConsent: false })).toBe('no_phone');
    expect(callSkipReasonOf({ ...none, callConsent: false, calledRecently: true })).toBe(
      'no_call_consent',
    );
    expect(callSkipReasonOf({ ...none, calledRecently: true })).toBe('called_recently');
    expect(callSkipReasonOf({ ...none, inConversation: true })).toBe('in_conversation');
    expect(callSkipReasonOf({ ...none, bookedSoon: true })).toBe('booked_soon');
  });
});

describe('call campaigns', () => {
  let t: Team;
  let tagId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await setupTeam('call-campaign');
    ({ tagId } = await run(tagCreate, { workspaceId: t.wsId, name: 'Call list' }, t.owner));
    // Ana and Cy agreed to calls in writing; Bo didn't; Di has no phone.
    for (const first of ['Ana', 'Bo', 'Cy', 'Di']) {
      ids[first] = await customer(t, first, first === 'Di' ? null : nextPhone());
      await rows(
        admin(),
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${t.wsId}, ${tagId}, 'person', ${ids[first]})`,
      );
      if (first !== 'Bo')
        await run(
          personSetCallConsent,
          {
            workspaceId: t.wsId,
            personId: ids[first]!,
            consent: 'opted_in',
            source: 'Signed service agreement',
          },
          t.owner,
        );
    }
    // Another campaign called Cy last week.
    await rows(
      admin(),
      sql`insert into app.ai_calls (workspace_id, person_id, purpose, to_e164, goal, status, dedupe_key, created_at)
          select ${t.wsId}, id, 'campaign', phone_e164, 'about last week''s news.', 'done',
            ${`campaign:old:${ids['Cy']}`}, now() - interval '7 days'
          from app.people where id = ${ids['Cy']}`,
    );
  });
  afterAll(closeTestDbs);

  const input = () => ({
    workspaceId: t.wsId,
    name: 'Fall calls',
    goal: 'Our fall tune-up is $89 this month',
    audience: { tagIds: [tagId], stageIds: [] },
    channel: 'call' as const,
  });

  it('calls only people who agreed in writing and weren’t called lately', async () => {
    const preview = await ask(
      campaignPreviewAudience,
      { workspaceId: t.wsId, audience: input().audience, channel: 'call' },
      t.owner,
    );
    expect(preview).toMatchObject({
      recipients: 1,
      skipped: { no_call_consent: 1, called_recently: 1, no_phone: 1 },
      postalAddress: null,
    });
  });

  it('keeps one opening line, changed before approval and never per person', async () => {
    const made = await run(campaignCreate, input(), t.owner);
    expect(made).toMatchObject({ recipients: 1, skipped: 3 });
    // The worker writes the line; until it has, it can't be approved.
    await rows(
      admin(),
      sql`update app.campaigns set status = 'review' where id = ${made.campaignId}`,
    );
    await rows(
      admin(),
      sql`update app.campaign_recipients set status = 'ready'
          where campaign_id = ${made.campaignId} and status = 'drafting'`,
    );
    await expectHfos(
      () => run(campaignApprove, { workspaceId: t.wsId, campaignId: made.campaignId }, t.owner),
      'campaign_no_opening',
    );
    const got = await ask(
      campaignGet,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(got.campaign).toMatchObject({
      channel: 'call',
      email: null,
      call: { opening: null, edited: false },
    });
    const ana = got.recipients.find((r) => r.personId === ids['Ana'])!;
    expect(ana).toMatchObject({ status: 'ready', call: null });
    await expectHfos(
      () =>
        run(
          campaignUpdateDraft,
          { workspaceId: t.wsId, recipientId: ana.id, draft: 'Hi Ana' },
          t.owner,
        ),
      'campaign_channel',
    );
    await expectHfos(
      () =>
        run(
          campaignUpdateEmail,
          { workspaceId: t.wsId, campaignId: made.campaignId, subject: 'Hi', body: 'Hi' },
          t.owner,
        ),
      'campaign_channel',
    );

    await run(
      campaignUpdateCall,
      {
        workspaceId: t.wsId,
        campaignId: made.campaignId,
        opening: 'about our fall tune-up, which is $89 this month.',
      },
      t.owner,
    );
    const changed = await ask(
      campaignGet,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(changed.campaign.call).toEqual({
      opening: 'about our fall tune-up, which is $89 this month.',
      edited: true,
    });
    const approved = await run(
      campaignApprove,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(approved.status).toBe('sending');
    // Once it's going, the line stays as approved.
    await expectHfos(
      () =>
        run(
          campaignUpdateCall,
          { workspaceId: t.wsId, campaignId: made.campaignId, opening: 'about something else.' },
          t.owner,
        ),
      'campaign_state',
    );
  });
});
