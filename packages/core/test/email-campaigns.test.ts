/**
 * Email campaigns on the local database: an email campaign goes to anyone with an email who hasn't unsubscribed,
 * bounced or complained (Chris, 2026-09-23); it can't be made until the business has an address to show in every
 * email; its one email changes before approval (never a text's draft); and an unsubscribe is recorded once, by
 * the worker only.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessPostalAddress,
  campaignApprove,
  campaignCreate,
  campaignGet,
  campaignPreviewAudience,
  campaignUpdateDraft,
  campaignUpdateEmail,
  emailSkipReasonOf,
  emailUnsubscribeRecord,
  tagCreate,
} from '../src/server';
import {
  admin,
  ask,
  customer,
  expectHfos,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

describe('who an email campaign leaves out', () => {
  const none = { hasEmail: true, unsubscribed: false, stopped: false, emailedRecently: false };
  it('gives the first reason that applies', () => {
    expect(emailSkipReasonOf(none)).toBeNull();
    expect(emailSkipReasonOf({ ...none, hasEmail: false, unsubscribed: true })).toBe('no_email');
    expect(emailSkipReasonOf({ ...none, unsubscribed: true, stopped: true })).toBe('unsubscribed');
    expect(emailSkipReasonOf({ ...none, stopped: true })).toBe('email_stopped');
    expect(emailSkipReasonOf({ ...none, emailedRecently: true })).toBe('emailed_recently');
  });
});

describe('email campaigns', () => {
  let t: Team;
  let tagId: string;
  const ids: Record<string, string> = {};
  const address = (first: string) => `${first.toLowerCase()}.${t.wsId.slice(0, 8)}@example.com`;

  const setAddress = (text: string) =>
    rows(
      admin(),
      sql`update app.workspaces
          set settings = coalesce(settings, '{}'::jsonb)
            || jsonb_build_object('money', coalesce(settings -> 'money', '{}'::jsonb)
              || jsonb_build_object('businessAddress', ${text}::text))
          where id = ${t.wsId}`,
    );

  beforeAll(async () => {
    t = await setupTeam('email-campaign');
    ({ tagId } = await run(tagCreate, { workspaceId: t.wsId, name: 'Newsletter' }, t.owner));
    for (const first of ['Ana', 'Bo', 'Cy', 'Di']) {
      ids[first] = await customer(t, first);
      await rows(
        admin(),
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${t.wsId}, ${tagId}, 'person', ${ids[first]})`,
      );
      // Bo has no email.
      if (first !== 'Bo')
        await rows(
          admin(),
          sql`update app.people set email = ${address(first)} where id = ${ids[first]}`,
        );
    }
    // Cy unsubscribed before; Di's address bounced.
    await rows(
      admin(),
      sql`insert into app.email_unsubscribes (workspace_id, address, source)
          values (${t.wsId}, ${address('Cy')}, 'link')`,
    );
    await rows(
      admin(),
      sql`insert into app.email_suppressions (workspace_id, address, reason)
          values (${t.wsId}, ${address('Di')}, 'hard_bounce')`,
    );
  });
  afterAll(closeTestDbs);

  const input = () => ({
    workspaceId: t.wsId,
    name: 'Fall news',
    goal: 'Our fall tune-up is $89 this month',
    audience: { tagIds: [tagId], stageIds: [] },
    channel: 'email' as const,
  });

  it('emails anyone with an address who hasn’t unsubscribed, bounced or complained', async () => {
    const p = await ask(
      campaignPreviewAudience,
      { workspaceId: t.wsId, audience: input().audience, channel: 'email' },
      t.owner,
    );
    expect(p.recipients).toBe(1);
    expect(p.skipped).toEqual({ no_email: 1, unsubscribed: 1, email_stopped: 1 });
    expect(p.postalAddress).toBeNull();
    // The same people as texts: nobody agreed to texts.
    const texts = await ask(
      campaignPreviewAudience,
      { workspaceId: t.wsId, audience: input().audience },
      t.owner,
    );
    expect(texts.recipients).toBe(0);
    expect(texts.postalAddress).toBeNull();
  });

  it('needs the business’s address first, which every email shows', async () => {
    await expectHfos(() => run(campaignCreate, input(), t.owner), 'no_postal_address', 409);
    await setAddress('12 Main St\nHouston, TX 77002');
    expect(await businessPostalAddress(admin(), t.wsId)).toBe('12 Main St\nHouston, TX 77002');
  });

  it('keeps one email, changed before approval and never per person', async () => {
    const made = await run(campaignCreate, input(), t.owner);
    expect(made).toMatchObject({ recipients: 1, skipped: 3 });
    const got = await ask(
      campaignGet,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(got.campaign.channel).toBe('email');
    expect(got.campaign.email).toEqual({
      subject: null,
      body: null,
      edited: false,
      postalAddress: '12 Main St\nHouston, TX 77002',
    });
    const ana = got.recipients.find((r) => r.personId === ids['Ana'])!;
    expect(ana.email).toBe(address('Ana'));
    await expectHfos(
      () =>
        run(
          campaignUpdateDraft,
          { workspaceId: t.wsId, recipientId: ana.id, draft: 'Hi' },
          t.owner,
        ),
      'campaign_channel',
    );
    // A member can't change it.
    await expectHfos(
      () =>
        run(
          campaignUpdateEmail,
          { workspaceId: t.wsId, campaignId: made.campaignId, subject: 'S', body: 'B' },
          t.priya,
        ),
      'forbidden',
    );
    await run(
      campaignUpdateEmail,
      {
        workspaceId: t.wsId,
        campaignId: made.campaignId,
        subject: 'Fall tune-up, $89',
        body: 'Hi {first_name},\n\nOur fall tune-up is $89 this month.',
      },
      t.owner,
    );
    // What the worker does once it's written: everyone ready, waiting for review.
    await rows(
      admin(),
      sql`update app.campaign_recipients set status = 'ready'
          where campaign_id = ${made.campaignId} and status = 'drafting'`,
    );
    await rows(
      admin(),
      sql`update app.campaigns set status = 'review' where id = ${made.campaignId}`,
    );
    const after = await ask(
      campaignGet,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(after.campaign.email).toMatchObject({ subject: 'Fall tune-up, $89', edited: true });
    const approved = await run(
      campaignApprove,
      { workspaceId: t.wsId, campaignId: made.campaignId },
      t.owner,
    );
    expect(approved.status).toBe('sending');
    // Too late to change it now.
    await expectHfos(
      () =>
        run(
          campaignUpdateEmail,
          { workspaceId: t.wsId, campaignId: made.campaignId, subject: 'S', body: 'B' },
          t.owner,
        ),
      'campaign_state',
    );
  });

  it('won’t approve an email campaign with no email', async () => {
    const made = await run(campaignCreate, { ...input(), name: 'Empty' }, t.owner);
    await rows(
      admin(),
      sql`update app.campaign_recipients set status = 'ready' where campaign_id = ${made.campaignId}`,
    );
    await rows(
      admin(),
      sql`update app.campaigns set status = 'review' where id = ${made.campaignId}`,
    );
    await expectHfos(
      () => run(campaignApprove, { workspaceId: t.wsId, campaignId: made.campaignId }, t.owner),
      'campaign_no_email',
    );
  });

  it('records an unsubscribe once, and only the worker does', async () => {
    const one = {
      workspaceId: t.wsId,
      address: address('Ana').toUpperCase(),
      campaignId: null,
      source: 'one_click' as const,
    };
    await expectHfos(() => run(emailUnsubscribeRecord, one, t.owner), 'forbidden');
    expect(await runSystem(emailUnsubscribeRecord, one, t.scope)).toEqual({ created: true });
    expect(await runSystem(emailUnsubscribeRecord, one, t.scope)).toEqual({ created: false });
    const [row] = await rows<{ address: string }>(
      admin(),
      sql`select address from app.email_unsubscribes where workspace_id = ${t.wsId} and source = 'one_click'`,
    );
    expect(row?.address).toBe(address('Ana'));
    // Nobody else is left to email now.
    await expectHfos(
      () => run(campaignCreate, { ...input(), name: `Again ${randomUUID().slice(0, 4)}` }, t.owner),
      'campaign_empty',
    );
  });
});
