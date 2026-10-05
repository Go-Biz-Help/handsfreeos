/**
 * Email campaigns on the real database, the scripted model and the local mail server (Mailpit):
 * - the AI writes the one email; approved, it goes one at a time with the person's first name, a footer with
 *   the unsubscribe link and the business's address, and the List-Unsubscribe headers;
 * - a mail app's one-click unsubscribe (and the page's button) records it, and their turn then skips them;
 *   a link that isn't right does nothing;
 * - with no broadcast stream in Postmark, the campaign pauses instead of sending bulk mail on the one-to-one one;
 * - Postmark gets the broadcast stream and the headers.
 */
import {
  campaignApprove,
  campaignCreate,
  campaignGet,
  campaignPreviewAudience,
  tagCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testEnv } from '@hfos/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { campaignSendKey } from '../src/automations/index';
import { campaignFooter, cleanEmail, fillFirstName } from '../src/automations/campaigns';
import { createPostmark } from '../src/email/postmark';
import { unsubscribeToken, verifyUnsubscribeToken } from '../src/email/unsubscribe';
import {
  admin,
  drain,
  newCustomer,
  query,
  run,
  runNow,
  teammateWorld,
  type TeammateWorld,
} from './ai-team-world';

const env = testEnv();
let w: TeammateWorld;
let tagId: string;

beforeAll(async () => {
  w = await teammateWorld('emailcamp', { status: 'training' });
  // Open around the clock, and an address to show in every email.
  await rows(
    admin(),
    sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb)
          || '{"openHours": [], "money": {"businessAddress": "12 Main St\\nHouston, TX 77002"}}'::jsonb
        where id = ${w.workspaceId}`,
  );
  ({ tagId } = await run(w, tagCreate, { workspaceId: w.workspaceId, name: 'Newsletter' }));
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});
afterEach(() => vi.unstubAllGlobals());

async function listed(first: string, email?: string | null) {
  const c = await newCustomer(w, first, email === undefined ? {} : { email });
  await rows(
    admin(),
    sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
        values (${w.workspaceId}, ${tagId}, 'person', ${c.id})`,
  );
  return c;
}

interface Mail {
  ID: string;
  Subject: string;
  Text: string;
}
async function mailTo(to: string): Promise<Mail | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${env.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const hit = ((await res.json()) as { messages: { ID: string }[] }).messages[0];
    if (hit) {
      const m = (await (await fetch(`${env.mailpitUrl}/api/v1/message/${hit.ID}`)).json()) as Mail;
      return { ...m, Text: m.Text.replace(/\r\n/g, '\n') };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const headersOf = async (id: string) =>
  (await (await fetch(`${env.mailpitUrl}/api/v1/message/${id}/headers`)).json()) as Record<
    string,
    string[]
  >;

const statusOf = (campaignId: string) =>
  query(w, campaignGet, { workspaceId: w.workspaceId, campaignId });

describe('email campaigns', () => {
  it('writes one email, sends it with a footer and the unsubscribe headers, and honours an unsubscribe', async () => {
    const ann = await listed('Ann');
    const bob = await listed('Bob');
    await listed('Cid', null);
    const audience = { tagIds: [tagId], stageIds: [] };
    const preview = await query(w, campaignPreviewAudience, {
      workspaceId: w.workspaceId,
      audience,
      channel: 'email',
    });
    expect(preview).toMatchObject({
      recipients: 2,
      skipped: { no_email: 1 },
      postalAddress: '12 Main St\nHouston, TX 77002',
    });

    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Fall news',
      goal: 'Our fall tune-up is $89 this month',
      audience,
      channel: 'email',
    });
    await drain(w);
    let got = await statusOf(made.campaignId);
    expect(got.campaign.status).toBe('review');
    expect(got.campaign.email).toMatchObject({
      subject: 'Our fall tune-up is $89 this month',
      body: 'Hi {first_name},\n\nOur fall tune-up is $89 this month.\n\nJust reply to this email to book.',
      edited: false,
    });
    expect(got.recipients.filter((r) => r.status === 'ready')).toHaveLength(2);

    await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
    await drain(w);

    // One went: their name, the footer and the headers.
    const sentRow = (await statusOf(made.campaignId)).recipients.find((r) => r.status === 'sent')!;
    const [first, second] = sentRow.personId === ann.id ? [ann, bob] : [bob, ann];
    const firstName = first === ann ? 'Ann' : 'Bob';
    const mail = await mailTo(first.email!);
    expect(mail?.Subject).toBe('Our fall tune-up is $89 this month');
    expect(mail!.Text).toContain(`Hi ${firstName},`);
    expect(mail!.Text).toContain('12 Main St\nHouston, TX 77002');
    const page = /Unsubscribe: (\S+)/.exec(mail!.Text)?.[1];
    expect(page).toMatch(/^http:\/\/localhost:3000\/u\/[0-9a-f]{32}[0-9A-Za-z]{16}$/);
    const headers = await headersOf(mail!.ID);
    const token = page!.split('/u/')[1]!;
    expect(headers['List-Unsubscribe']).toEqual([
      `<https://hooks.worker.test/public/unsubscribe/${token}>`,
    ]);
    expect(headers['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click']);

    // The page shows whose email it is and changes nothing; a wrong link does nothing.
    const look = await w.app.inject({ method: 'GET', url: `/public/unsubscribe/${token}` });
    expect(look.statusCode).toBe(200);
    expect(look.json()).toMatchObject({
      unsubscribed: false,
      address: expect.stringMatching(
        new RegExp(`^${firstName[0]!.toLowerCase()}•••@example\\.com$`),
      ),
    });
    const wrong = await w.app.inject({
      method: 'POST',
      url: `/public/unsubscribe/${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`,
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(wrong.statusCode).toBe(404);

    // Their mail app's own button: one-click, twice is fine.
    for (let i = 0; i < 2; i++) {
      const res = await w.app.inject({
        method: 'POST',
        url: `/public/unsubscribe/${token}`,
        payload: 'List-Unsubscribe=One-Click',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ unsubscribed: true });
    }
    // The other presses the page's button before their turn: their turn skips them.
    const secondRow = got.recipients.find((r) => r.personId === second.id)!;
    const pressed = await w.app.inject({
      method: 'POST',
      url: `/public/unsubscribe/${unsubscribeToken(w.s.unsubscribeLinks, secondRow.id)}`,
      payload: {},
    });
    expect(pressed.statusCode).toBe(200);
    const stops = await rows<{ address: string; source: string }>(
      admin(),
      sql`select address, source from app.email_unsubscribes where workspace_id = ${w.workspaceId}
          order by source`,
    );
    expect(stops).toEqual([
      { address: second.email, source: 'link' },
      { address: first.email, source: 'one_click' },
    ]);

    for (let i = 0; i < 4 && (await statusOf(made.campaignId)).campaign.status === 'sending'; i++)
      await runNow(w, [campaignSendKey(made.campaignId)]);
    got = await statusOf(made.campaignId);
    expect(got.campaign.status).toBe('done');
    expect(got.recipients.find((r) => r.personId === second.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'unsubscribed',
    });

    // The email is in their conversation, marked as the campaign's.
    const [msg] = await rows<{ campaign_recipient_id: string | null }>(
      admin(),
      sql`select m.campaign_recipient_id from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.person_id = ${first.id} and m.channel = 'email'`,
    );
    expect(msg?.campaign_recipient_id).toBe(sentRow.id);
  }, 60_000);

  it('goes to review with the exact words it was given, asking the AI for nothing', async () => {
    // Someone not emailed this week.
    await listed('Dee');
    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Just listed',
      goal: 'Tell people about the new listing.',
      audience: { tagIds: [tagId], stageIds: [] },
      channel: 'email',
      words: { subject: 'Just listed: 2207 Juniper Trail', body: 'Four bedrooms in South Austin.' },
    });
    await drain(w);
    const got = await statusOf(made.campaignId);
    expect(got.campaign.status).toBe('review');
    expect(got.campaign.email).toMatchObject({
      subject: 'Just listed: 2207 Juniper Trail',
      body: 'Four bedrooms in South Austin.',
    });
    expect(got.recipients.some((r) => r.status === 'drafting')).toBe(false);
  });

  it('pauses rather than send bulk mail when Postmark has no broadcast stream', async () => {
    await listed('Dan');
    const made = await run(w, campaignCreate, {
      workspaceId: w.workspaceId,
      name: 'Winter news',
      goal: 'Winter check-ups are open',
      audience: { tagIds: [tagId], stageIds: [] },
      channel: 'email',
    });
    await drain(w);
    const before = w.s;
    Object.assign(w, { s: { ...w.s, email: { ...w.s.email, bulkReady: false } } });
    try {
      await run(w, campaignApprove, { workspaceId: w.workspaceId, campaignId: made.campaignId });
      await drain(w);
    } finally {
      Object.assign(w, { s: before });
    }
    const got = await statusOf(made.campaignId);
    expect(got.campaign).toMatchObject({
      status: 'paused',
      pausedReason: 'email_campaigns_not_ready',
    });
    expect(got.campaign.counts.sent).toBe(0);
  });
});

describe('the pieces', () => {
  it('fills the first name, or says "there"', () => {
    expect(fillFirstName('Hi {first_name}, {first_name}!', 'Ann')).toBe('Hi Ann, Ann!');
    expect(fillFirstName('Hi {first_name},', null)).toBe('Hi there,');
  });

  it('ends every email the same way', () => {
    expect(campaignFooter('Lone Star HVAC', '12 Main St\n Houston, TX', 'https://x/u/t')).toBe(
      '--\nYou’re getting this because you’re a customer of Lone Star HVAC.\nUnsubscribe: https://x/u/t\n\nLone Star HVAC\n12 Main St\nHouston, TX',
    );
  });

  it('keeps the AI’s email only when it fits', () => {
    expect(cleanEmail(' Fall  news ', 'Hi,\n\n\n\nThere.  \n')).toEqual({
      subject: 'Fall news',
      body: 'Hi,\n\nThere.',
    });
    expect(cleanEmail(null, 'Body')).toBeNull();
    expect(cleanEmail('S'.repeat(151), 'Body')).toBeNull();
  });

  it('signs links that can’t be changed', () => {
    const links = w.s.unsubscribeLinks;
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const token = unsubscribeToken(links, id);
    expect(verifyUnsubscribeToken(links, token)).toBe(id);
    expect(verifyUnsubscribeToken(links, `1${token.slice(1)}`)).toBeNull();
    expect(verifyUnsubscribeToken(links, 'nope')).toBeNull();
  });

  it('sends campaign email on the broadcast stream with its headers, and never on the one-to-one one', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ MessageID: 'pm-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const email = {
      from: { address: 'hello@mail.example', name: 'Lone Star HVAC' },
      to: ['ann@example.com'],
      cc: [],
      replyTo: null,
      subject: 'Fall news',
      text: 'Hi',
      html: '<p>Hi</p>',
      messageIdHeader: '<a@mail.example>',
      inReplyTo: null,
      references: [],
      attachments: [],
      metadata: {},
      bulk: true,
      headers: [{ name: 'List-Unsubscribe', value: '<https://w/public/unsubscribe/t>' }],
    };
    const on = createPostmark({
      serverToken: 'server-token-test',
      accountToken: null,
      stream: 'outbound',
      broadcastStream: 'broadcast',
    });
    await on.transport.send(email);
    expect(sent[0]).toMatchObject({ MessageStream: 'broadcast' });
    expect(sent[0]!['Headers']).toContainEqual({
      Name: 'List-Unsubscribe',
      Value: '<https://w/public/unsubscribe/t>',
    });
    await on.transport.send({ ...email, bulk: false, headers: [] });
    expect(sent[1]).toMatchObject({ MessageStream: 'outbound' });

    const off = createPostmark({
      serverToken: 'server-token-test',
      accountToken: null,
      stream: 'outbound',
    });
    await expect(off.transport.send(email)).rejects.toMatchObject({ code: 'broadcast_not_ready' });
    expect(sent).toHaveLength(2);
  });
});
