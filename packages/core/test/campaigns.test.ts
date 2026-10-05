/**
 * Automations' "Outreach campaigns" (stage 5) on the local database: who a campaign picks (a tag, or an open deal
 * in a stage) and who it leaves out (no agreement to texts, texted in the last 14 days, mid-conversation, booked in
 * the next 30 days); only owners and admins make one; drafts change only before it's approved; approving, pausing,
 * resuming and stopping move it along, and stopping leaves the rest unsent.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  campaignApprove,
  campaignCancel,
  campaignCreate,
  campaignGet,
  campaignList,
  campaignPause,
  campaignPreviewAudience,
  campaignRemoveRecipient,
  campaignResume,
  campaignSetPace,
  campaignUpdateDraft,
  leadCreate,
  pipelineList,
  secondsBetween,
  skipReasonOf,
  tagCreate,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  customer,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('who is left out, and the pace', () => {
  const none = {
    hasPhone: true,
    optedIn: true,
    optedOut: false,
    textedRecently: false,
    inConversation: false,
    bookedSoon: false,
  };
  it('gives the first reason that applies', () => {
    expect(skipReasonOf(none)).toBeNull();
    expect(skipReasonOf({ ...none, hasPhone: false, optedIn: false })).toBe('no_phone');
    expect(skipReasonOf({ ...none, optedIn: false })).toBe('not_opted_in');
    expect(skipReasonOf({ ...none, optedOut: true })).toBe('not_opted_in');
    expect(skipReasonOf({ ...none, textedRecently: true, bookedSoon: true })).toBe(
      'texted_recently',
    );
    expect(skipReasonOf({ ...none, inConversation: true })).toBe('in_conversation');
    expect(skipReasonOf({ ...none, bookedSoon: true })).toBe('booked_soon');
  });
  it('spaces texts evenly across the hour', () => {
    expect(secondsBetween(20)).toBe(180);
    expect(secondsBetween(200)).toBe(18);
    expect(secondsBetween(1)).toBe(3600);
  });
});

describe('campaigns', () => {
  let t: Team;
  let tagId: string;
  let stageId: string;
  const ids: Record<string, string> = {};
  const phones: Record<string, string> = {};

  const optIn = (personId: string) =>
    rows(
      admin(),
      sql`update app.people set sms_consent = 'opted_in'::app.sms_consent where id = ${personId}`,
    );
  const tag = (personId: string) =>
    rows(
      admin(),
      sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
          values (${t.wsId}, ${tagId}, 'person', ${personId})`,
    );

  beforeAll(async () => {
    t = await setupTeam('campaign');
    ({ tagId } = await run(tagCreate, { workspaceId: t.wsId, name: 'Past customers' }, t.owner));
    const { pipelines } = await ask(pipelineList, { workspaceId: t.wsId }, t.owner);
    stageId = pipelines[0]!.stages.find((s) => s.kind === 'open')!.id;

    for (const first of ['Ana', 'Bo', 'Cy', 'Di', 'Ed']) {
      phones[first] = nextPhone();
      ids[first] = await customer(t, first, phones[first]);
      await optIn(ids[first]!);
      await tag(ids[first]!);
    }
    // Fay has no tag, but an open deal in the stage.
    ids['Fay'] = await customer(t, 'Fay', nextPhone());
    await optIn(ids['Fay']!);
    await run(
      leadCreate,
      { workspaceId: t.wsId, title: 'New furnace', personId: ids['Fay'], stageId },
      t.owner,
    );
    // Gus is tagged but never agreed to texts.
    ids['Gus'] = await customer(t, 'Gus', nextPhone());
    await tag(ids['Gus']!);
    // Bo was texted a week ago.
    const [conv] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, person_id, channel, counterpart, status)
          select ${t.wsId}, id, 'sms', phone_e164, 'closed' from app.people where id = ${ids['Bo']}
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, body_text, status, occurred_at)
          values (${t.wsId}, ${conv!.id}, 'sms', 'outbound', 'See you soon', 'delivered', now() - interval '7 days')`,
    );
    // Cy has an open card on Home.
    await rows(
      admin(),
      sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, person_id, title,
            fingerprint, state)
          values (${t.wsId}, 'overdue_task', 'person', ${ids['Cy']}, ${ids['Cy']}, 'Cy', ${randomUUID()},
            'open')`,
    );
    // Di is booked next week.
    const cal = await makeCalendar(t, 'Visits', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    await bookOnline(t, cal.id, isoAt(nextWeekday(3), '10:00'), {
      customer: { firstName: 'Di', lastName: 'Customer', phone: phones['Di'] },
      smsConsent: true,
    });
  });
  afterAll(closeTestDbs);

  const audience = () => ({ tagIds: [tagId], stageIds: [stageId] });

  it('picks by tag or stage and says why the rest are left out', async () => {
    const p = await ask(
      campaignPreviewAudience,
      { workspaceId: t.wsId, audience: audience() },
      t.owner,
    );
    // Ana, Ed and Fay.
    expect(p.recipients).toBe(3);
    expect(p.skipped).toEqual({
      texted_recently: 1,
      in_conversation: 1,
      booked_soon: 1,
      not_opted_in: 1,
    });
  });

  it('only owners and admins make one, and not for nobody', async () => {
    await expectHfos(
      () =>
        run(
          campaignCreate,
          { workspaceId: t.wsId, name: 'X', goal: 'Y', audience: audience() },
          t.member,
        ),
      'forbidden',
    );
    const { tagId: empty } = await run(tagCreate, { workspaceId: t.wsId, name: 'Nobody' }, t.owner);
    await expectHfos(
      () =>
        run(
          campaignCreate,
          { workspaceId: t.wsId, name: 'X', goal: 'Y', audience: { tagIds: [empty] } },
          t.owner,
        ),
      'campaign_empty',
    );
  });

  it('takes exact words when it’s given them: everyone’s draft at once, and never for a call', async () => {
    const words = 'Just listed: 2207 Juniper Trail, $539,000. Photos: example.com/l/2207';
    const made = await run(
      campaignCreate,
      {
        workspaceId: t.wsId,
        name: 'Just listed: 2207 Juniper Trail',
        goal: 'Tell people about the new listing.',
        audience: audience(),
        words: { text: words },
      },
      t.owner,
    );
    const got = await rows<{ status: string; draft: string | null; skip_reason: string | null }>(
      admin(),
      sql`select status, draft, skip_reason from app.campaign_recipients
          where campaign_id = ${made.campaignId} order by status`,
    );
    // Ana, Ed and Fay have the words, ready for review; the rest are left out as before, with none.
    expect(got.filter((r) => r.status === 'ready').map((r) => r.draft)).toEqual([
      words,
      words,
      words,
    ]);
    expect(got.filter((r) => r.status === 'skipped').every((r) => r.draft === null)).toBe(true);
    expect(got.some((r) => r.status === 'drafting')).toBe(false);
    await expectHfos(
      () =>
        run(
          campaignCreate,
          {
            workspaceId: t.wsId,
            name: 'X',
            goal: 'Y',
            audience: audience(),
            words: { subject: 'Just listed' },
          },
          t.owner,
        ),
      'validation',
    );
    await expectHfos(
      () =>
        run(
          campaignCreate,
          {
            workspaceId: t.wsId,
            name: 'X',
            goal: 'Y',
            audience: audience(),
            channel: 'call',
            words: { text: words },
          },
          t.owner,
        ),
      'validation',
    );
    await run(campaignCancel, { workspaceId: t.wsId, campaignId: made.campaignId }, t.owner);
  });

  it('picks open deals only: a won or lost stage is refused, as the screen offers open ones', async () => {
    const { pipelines } = await ask(pipelineList, { workspaceId: t.wsId }, t.owner);
    for (const kind of ['won', 'lost'] as const) {
      const stage = pipelines[0]!.stages.find((s) => s.kind === kind)!;
      const err = await expectHfos(
        () =>
          run(
            campaignCreate,
            {
              workspaceId: t.wsId,
              name: 'Thanks',
              goal: 'Say thanks',
              audience: { tagIds: [tagId], stageIds: [stageId, stage.id] },
            },
            t.owner,
          ),
        'validation',
        400,
      );
      expect(err.message).toBe(
        `“${stage.name}” is a ${kind} stage. A campaign picks people with an open deal, so choose open stages.`,
      );
    }
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.campaigns where workspace_id = ${t.wsId} and name = 'Thanks'`,
    );
    expect(n!.n).toBe(0);
  });

  it('takes out only someone still set to get it, never someone already left out', async () => {
    const made = await run(
      campaignCreate,
      { workspaceId: t.wsId, name: 'Spring', goal: 'Spring check', audience: audience() },
      t.owner,
    );
    const got = await ask(
      campaignGet,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    const gus = got.recipients.find((r) => r.personId === ids['Gus'])!;
    expect(gus).toMatchObject({ status: 'skipped', skipReason: 'not_opted_in' });
    const err = await expectHfos(
      () => run(campaignRemoveRecipient, { workspaceId: t.wsId, recipientId: gus.id }, t.owner),
      'recipient_state',
      409,
    );
    expect(err.message).toBe('That person is already left out of this campaign.');
    const [row] = await rows<{ status: string; skip_reason: string }>(
      admin(),
      sql`select status::text as status, skip_reason from app.campaign_recipients where id = ${gus.id}`,
    );
    expect(row).toEqual({ status: 'skipped', skip_reason: 'not_opted_in' });

    // A ready one goes; taking them out twice is refused the same way.
    await rows(
      admin(),
      sql`update app.campaign_recipients set status = 'ready', draft = 'Hi there'
          where campaign_id = ${made.campaignId} and status = 'drafting'`,
    );
    await rows(
      admin(),
      sql`update app.campaigns set status = 'review' where id = ${made.campaignId}`,
    );
    const ana = got.recipients.find((r) => r.personId === ids['Ana'])!;
    expect(
      await run(campaignRemoveRecipient, { workspaceId: t.wsId, recipientId: ana.id }, t.owner),
    ).toEqual({ recipientId: ana.id, status: 'removed' });
    await expectHfos(
      () => run(campaignRemoveRecipient, { workspaceId: t.wsId, recipientId: ana.id }, t.owner),
      'recipient_state',
    );
    await run(campaignCancel, { workspaceId: t.wsId, campaignId: made.campaignId }, t.owner);
  });

  it('drafts change before approval only; approve, pause, resume and stop move it along', async () => {
    const made = await run(
      campaignCreate,
      { workspaceId: t.wsId, name: 'Fall', goal: 'Fall tune-up, $89', audience: audience() },
      t.owner,
    );
    expect(made).toMatchObject({ recipients: 3, skipped: 4 });
    const ref = { workspaceId: t.wsId, campaignId: made.campaignId };
    let got = await ask(campaignGet, ref, t.owner);
    expect(got.campaign).toMatchObject({ status: 'drafting', perHour: 20 });
    const ana = got.recipients.find((r) => r.personId === ids['Ana'])!;
    const ed = got.recipients.find((r) => r.personId === ids['Ed'])!;

    // Still drafting: approving is refused; a person can already write one themselves.
    await expectHfos(() => run(campaignApprove, ref, t.owner), 'campaign_state');
    await run(
      campaignUpdateDraft,
      { workspaceId: t.wsId, recipientId: ana.id, draft: 'Hi Ana, tune-up time!' },
      t.owner,
    );
    await run(campaignRemoveRecipient, { workspaceId: t.wsId, recipientId: ed.id }, t.owner);
    // The AI finishes (the worker's part): everyone else ready, then review.
    await rows(
      admin(),
      sql`update app.campaign_recipients set status = 'ready', draft = 'Hi there'
          where campaign_id = ${made.campaignId} and status = 'drafting'`,
    );
    await rows(
      admin(),
      sql`update app.campaigns set status = 'review' where id = ${made.campaignId}`,
    );

    await run(campaignSetPace, { ...ref, perHour: 40 }, t.owner);
    expect(await run(campaignApprove, ref, t.owner)).toMatchObject({ status: 'sending' });
    // Twice is once.
    expect(await run(campaignApprove, ref, t.owner)).toMatchObject({ status: 'sending' });
    got = await ask(campaignGet, ref, t.owner);
    expect(got.campaign.perHour).toBe(40);
    expect(got.campaign.counts).toMatchObject({ approved: 2, removed: 1, skipped: 4 });
    expect(got.recipients.find((r) => r.id === ana.id)).toMatchObject({
      status: 'approved',
      edited: true,
      draft: 'Hi Ana, tune-up time!',
    });
    // Approved: the words are fixed.
    await expectHfos(
      () =>
        run(
          campaignUpdateDraft,
          { workspaceId: t.wsId, recipientId: ana.id, draft: 'Changed' },
          t.owner,
        ),
      'campaign_state',
    );

    expect(await run(campaignPause, ref, t.owner)).toMatchObject({ status: 'paused' });
    expect(await run(campaignResume, ref, t.owner)).toMatchObject({ status: 'sending' });
    expect(await run(campaignCancel, ref, t.owner)).toMatchObject({ status: 'cancelled' });
    got = await ask(campaignGet, ref, t.owner);
    expect(got.campaign.counts).toMatchObject({ approved: 0, skipped: 6 });
    expect(got.recipients.find((r) => r.id === ana.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'not_sent',
    });

    // Everyone sees the list.
    const list = await ask(campaignList, { workspaceId: t.wsId }, t.member);
    expect(list.items.map((c) => c.id)).toContain(made.campaignId);
  });
});
