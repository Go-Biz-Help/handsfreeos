/**
 * Times to meet, in the chat (docs/outreach.md, decision 149), against the stand-in model: when a playbook's link is
 * one of the business's own booking pages, Send the link offers three of the person's open times, in their time zone
 * when a "Lives in" shows it, with the link for any other; a reply where they took one and gave an email confirms it,
 * and once it's OK'd the time is booked through the person's demo link before it goes. A time taken meanwhile has the
 * reply written again with fresh times, back with the person; the web's Today books as the person copies it.
 */
import { randomUUID } from 'node:crypto';
import { DEMO_REF_PREFIX } from '@hfos/core/addons/outreach/demos';
import { TIME_WORDS, timeKey } from '@hfos/core/addons/outreach/meeting-times';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachAddon } from '../../../packages/core/src/addons/outreach/manifest';
import { PLAYBOOK_TEMPLATES } from '../../../packages/core/src/addons/outreach/playbooks';
import { fileChats, playbooks, profiles } from '../../../packages/core/src/addons/outreach/tables';
import { runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { scriptedAi } from '../src/ai/scripted';
import {
  admin,
  bookOnline,
  CHI,
  customer,
  drain,
  makeCalendar,
  makeWorld,
  type World,
} from './booking-world';

let w: World;
let calendar: { id: string; slug: string };

type Drafted = {
  kind: string;
  drafts: string[];
  simple: boolean;
  meeting: { offerId: string | null; offered: string[]; books: string | null } | null;
};

const action = async (name: string, input: Record<string, unknown>) =>
  w.app.inject({
    method: 'POST',
    url: `/v1/addons/outreach/actions/${name}`,
    headers: { authorization: `Bearer ${await signInTestUser(w.owner)}` },
    payload: { workspaceId: w.workspaceId, input },
  });

const draft = async (input: Record<string, unknown>): Promise<Drafted> => {
  const res = await action('outreach.today.draft', input);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Drafted;
};

/** Someone to write to, with a "Lives in" when given. */
async function person(name: string, intro: string[] = []): Promise<string> {
  const [p] = await admin()
    .insert(profiles)
    .values({
      workspaceId: w.workspaceId,
      platform: 'facebook',
      username: `${name.toLowerCase().replace(/\W+/g, '.')}.${randomUUID().slice(0, 6)}`,
      url: `https://www.facebook.com/${randomUUID().slice(0, 8)}`,
      name,
      intro,
    })
    .returning({ id: profiles.id });
  return p!.id;
}

/** Their chat with the owner, their last message `theirs`. */
async function chatWith(profileId: string, name: string, theirs: string): Promise<string> {
  const now = Date.now();
  const [c] = await admin()
    .insert(fileChats)
    .values({
      workspaceId: w.workspaceId,
      userId: w.owner.id,
      platform: 'facebook',
      profileId,
      name,
      nameKey: name.toLowerCase().replace(/\W+/g, ''),
      firstAt: new Date(now - 60_000),
      lastAt: new Date(now),
      messages: 2,
      lastFromMe: false,
      recent: [
        {
          fromMe: true,
          text: 'Would one of these work for a quick call?',
          at: new Date(now - 60_000).toISOString(),
        },
        { fromMe: false, text: theirs, at: new Date(now).toISOString() },
      ],
    })
    .returning({ id: fileChats.id });
  return c!.id;
}

type OfferRow = {
  id: string;
  state: string;
  zone: string;
  host_user_id: string | null;
  times: { at: string; says: string }[];
  booking: { at: string; says: string; email: string | null } | null;
  send_id: string | null;
  appointment_id: string | null;
};
const offer = async (id: string): Promise<OfferRow> => {
  const [o] = await rows<OfferRow>(
    admin(),
    sql`select id, state, zone, host_user_id, times, booking, send_id, appointment_id
        from addon_outreach.time_offers where id = ${id}`,
  );
  return o!;
};
const send = async (id: string) => {
  const [s] = await rows<{ state: string; text: string; needs_you: string | null }>(
    admin(),
    sql`select state, text, needs_you from addon_outreach.sends where id = ${id}`,
  );
  return s!;
};

/** Queues the draft the way the extension does, then OKs it as the person. */
async function queueAndOk(
  profileId: string,
  kind: string,
  text: string,
  chatId: string | null = null,
): Promise<string> {
  const queued = await runAs(w.owner, w.workspaceId, 'outreach.send.queue', {
    profileId,
    kind,
    chatId,
    text,
  });
  expect(queued.state).toBe('waiting');
  await runAs(w.owner, w.workspaceId, 'outreach.send.approve', {
    sends: [{ sendId: queued.sendId }],
  });
  return queued.sendId as string;
}

beforeAll(async () => {
  w = await makeWorld('outreach-times', { ai: { provider: scriptedAi() } });
  await admin().execute(
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${w.workspaceId}, 'outreach', 'enabled', ${outreachAddon.version})`,
  );
  calendar = await makeCalendar(w, 'Quick call');
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await admin()
    .insert(playbooks)
    .values({
      workspaceId: w.workspaceId,
      name: crm.name,
      details: {
        ...crm.details,
        link: `https://app.handsfreeos.test/book/${w.site}/${calendar.slug}`,
      },
    });
}, 120_000);
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('Send the link with times', () => {
  it('offers three of the person’s open times in their zone, with the link for any other', async () => {
    const dana = await person('Dana Reyes', [
      'Owner at Reyes Plumbing',
      'Lives in Denver, Colorado',
    ]);
    const out = await draft({ kind: 'pitch', profileId: dana });
    expect(out.kind).toBe('pitch');
    expect(out.meeting?.offered).toHaveLength(3);
    expect(out.meeting!.offered.every((t) => t.endsWith(' mt'))).toBe(true);
    expect(out.meeting!.books).toBeNull();
    const [first] = out.drafts;
    expect(first).toContain(out.meeting!.offered[0]);
    expect(first).toContain(`/book/${w.site}/${calendar.slug}`);
    expect(first).toContain(`ref=${DEMO_REF_PREFIX}`);
    const kept = await offer(out.meeting!.offerId!);
    expect(kept).toMatchObject({
      state: 'drafted',
      zone: 'America/Denver',
      host_user_id: w.owner.id,
    });
    expect(kept.times.map((t) => t.says)).toEqual(out.meeting!.offered);

    // OK'd, it waits off Today while its times are checked again, then goes.
    const sendId = await queueAndOk(dana, 'pitch', first!);
    expect(await offer(kept.id)).toMatchObject({ state: 'checking', send_id: sendId });
    await drain(w);
    expect((await offer(kept.id)).state).toBe('ready');
    expect((await send(sendId)).state).toBe('approved');
  });
});

describe('a reply where they took a time', () => {
  /** An open time `n` of the reply's, in Chicago, from a fresh pitch's offer. */
  const openKey = async (n: number): Promise<string> => {
    const out = await draft({ kind: 'pitch', profileId: await person(`Pick ${n}`) });
    const kept = await offer(out.meeting!.offerId!);
    return timeKey(Date.parse(kept.times[n]!.at), CHI);
  };

  it('asks for the email first, books nothing', async () => {
    const key = await openKey(0);
    const sam = await person('Sam Ortiz');
    const chatId = await chatWith(sam, 'Sam Ortiz', `That one works for me: ${key}`);
    const out = await draft({ kind: 'reply', profileId: sam, chatId });
    expect(out.kind).toBe('reply');
    expect(out.drafts[0]).toContain('best email');
    expect(out.meeting).toBeNull();
  });

  it('confirms it, and books it through the demo link once it’s OK’d', async () => {
    const key = await openKey(1);
    const jane = await person('Jane Doe');
    const email = `jane-${randomUUID().slice(0, 6)}@example.com`;
    const chatId = await chatWith(jane, 'Jane Doe', `That one works: ${key}, my email is ${email}`);
    const out = await draft({ kind: 'reply', profileId: jane, chatId });
    expect(out.kind).toBe('reply');
    expect(out.drafts[0]).toContain('all set');
    expect(out.meeting?.books).toMatch(/ ct$/);
    // A reply that books waits for the person unless every reply goes on its own.
    expect(out.simple).toBe(false);
    const kept = await offer(out.meeting!.offerId!);
    expect(kept.booking).toMatchObject({ email });

    const sendId = await queueAndOk(jane, 'reply', out.drafts[0]!, chatId);
    expect((await offer(kept.id)).state).toBe('checking');
    await drain(w);
    const done = await offer(kept.id);
    expect(done.state).toBe('booked');
    expect((await send(sendId)).state).toBe('approved');
    const [booked] = await rows<{ link_ref: string; contact_email: string; starts_at: Date }>(
      admin(),
      sql`select at.link_ref, at.contact_email, a.starts_at from app.appointment_attendees at
          join app.appointments a on a.id = at.appointment_id where a.id = ${done.appointment_id}`,
    );
    expect(booked!.link_ref.startsWith(DEMO_REF_PREFIX)).toBe(true);
    expect(booked!.contact_email).toBe(email);
    expect(new Date(booked!.starts_at).toISOString()).toBe(kept.booking!.at);
    // A check run again books nothing more.
    await drain(w);
    expect((await offer(kept.id)).appointment_id).toBe(done.appointment_id);
  });

  it('is written again with fresh times when the time was taken meanwhile, back with the person', async () => {
    const key = await openKey(2);
    const lee = await person('Lee Park');
    const email = `lee-${randomUUID().slice(0, 6)}@example.com`;
    const chatId = await chatWith(lee, 'Lee Park', `That one works: ${key}, ${email}`);
    const out = await draft({ kind: 'reply', profileId: lee, chatId });
    const kept = await offer(out.meeting!.offerId!);
    const sendId = await queueAndOk(lee, 'reply', out.drafts[0]!, chatId);
    // Someone else books the owner at that time on the booking page.
    await bookOnline(w, calendar.slug, Date.parse(kept.booking!.at), customer('Kim'));
    await drain(w);
    expect((await offer(kept.id)).state).toBe('taken');
    const again = await send(sendId);
    expect(again.state).toBe('waiting');
    expect(again.needs_you).toBe(TIME_WORDS.rewritten);
    expect(again.text).toContain('just got taken');
    const [next] = await rows<{ state: string; times: unknown[] }>(
      admin(),
      sql`select state, times from addon_outreach.time_offers where send_id = ${sendId}`,
    );
    expect(next).toMatchObject({ state: 'drafted' });
  });

  it('books as the person copies it on the web’s Today, once', async () => {
    const key = await openKey(0);
    const max = await person('Max Hale');
    const email = `max-${randomUUID().slice(0, 6)}@example.com`;
    const chatId = await chatWith(max, 'Max Hale', `Sounds like a plan: ${key} - ${email}`);
    const out = await draft({ kind: 'reply', profileId: max, chatId });
    expect(out.meeting?.books).toBeTruthy();
    const res = await action('outreach.times.book', { profileId: max, text: out.drafts[0] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ booked: out.meeting!.books });
    const kept = await offer(out.meeting!.offerId!);
    expect(kept.state).toBe('booked');
    const twice = await action('outreach.times.book', { profileId: max, text: out.drafts[0] });
    expect(twice.json()).toEqual({ booked: null });
    // Nothing to book in a draft that books nothing.
    const none = await action('outreach.times.book', { profileId: max, text: 'Thanks!' });
    expect(none.json()).toEqual({ booked: null });
  });
});

describe('any other link', () => {
  it('offers no times', async () => {
    await admin().execute(
      sql`update addon_outreach.playbooks set details = jsonb_set(details, '{link}', '"https://calendly.com/acme/demo"')
          where workspace_id = ${w.workspaceId}`,
    );
    const out = await draft({ kind: 'pitch', profileId: await person('Rae Lin') });
    expect(out.meeting).toBeNull();
    expect(out.drafts[0]).toContain('calendly.com/acme/demo');
  });
});
