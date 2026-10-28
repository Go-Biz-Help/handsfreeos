/**
 * Social Outreach after a demo is booked through the person's link (docs/outreach.md, decision 106): a short reminder
 * in the chat the day before, on the business's calendar; and after a no-show, a message offering another time, with
 * the link, which always waits for the person's OK. Neither moves their conversation on.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_DEFAULTS } from '../../src/addons/outreach/automation';
import { demoRef } from '../../src/addons/outreach/demos';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import { PLAYBOOK_TEMPLATES } from '../../src/addons/outreach/playbooks';
import { goesAsItIs, REBOOK_NEEDS_YOU } from '../../src/addons/outreach/sends';
import { demoWhen, todayDraftPrompt, type TodayItem } from '../../src/addons/outreach/today';
import { addDays, localDateOf, localInstant } from '../../src/calendar/engine/zoned';
import {
  bookOnline,
  CHI,
  isoAt,
  makeCalendar,
  nextWeekday,
  setupTeam,
  type Team,
} from '../calendar-helpers';
import { getReady, runAs, runAsSystem, season } from './outreach-fixture';

const admin = () => testDbs().admin.db;
const DAY = 86_400_000;

afterAll(closeTestDbs);

describe('what a demo’s messages say', () => {
  it('says when it is on the business’s calendar, and gives the link to book again', () => {
    const when = demoWhen('2026-10-29T19:00:00Z', 'America/Chicago');
    expect(when).toBe('Thursday, October 29 at 2:00 PM CDT');
    expect(demoWhen('2026-10-29T19:00:00Z', 'Not/AZone')).toMatch(/7:00 PM UTC/);
    const base = {
      business: 'Cole Plumbing',
      name: 'Quinn Harper',
      facts: [],
      recent: [],
      playbook: {
        name: 'CRM demos',
        ...PLAYBOOK_TEMPLATES.crm_demos.details,
        link: 'https://example.com/book?ref=so-1',
      },
      demoWhen: when,
    };
    const reminder = todayDraftPrompt({ ...base, kind: 'demo_reminder' });
    expect(reminder).toContain('it’s tomorrow');
    expect(reminder).toContain('When the call is: Thursday, October 29 at 2:00 PM CDT');
    expect(reminder).not.toContain('Put this link in every draft');
    const rebook = todayDraftPrompt({ ...base, kind: 'rebook' });
    expect(rebook).toContain('didn’t make it');
    expect(rebook).toContain('When the call was: Thursday');
    expect(rebook).toContain(
      'Put this link in every draft, exactly as written: https://example.com/book?ref=so-1',
    );
  });

  it('waits for the person’s OK for another time, whatever Sending says', () => {
    const o = { replies: 'everything', wheels: false, simple: false, needsYou: null } as const;
    expect(goesAsItIs({ ...o, sending: 'everything', kind: 'demo_reminder' })).toBe(true);
    expect(goesAsItIs({ ...o, sending: 'everything', kind: 'rebook' })).toBe(false);
  });
});

describe('after a demo booked through the link', () => {
  let t: Team;
  let profileId: string;
  let appointmentId: string;
  const today = async () =>
    (await runAs(t.owner, t.wsId, 'outreach.today', { platform: 'facebook' })) as {
      items: TodayItem[];
      messages: string[];
    };
  const demoItem = async () =>
    (await today()).items.find((i) => i.kind === 'demo_reminder' || i.kind === 'rebook');
  /** Moves the booking to `day` days from today at noon, on Chicago's calendar. */
  const moveTo = async (day: number) => {
    const at = new Date(localInstant(addDays(localDateOf(Date.now(), CHI), day), '12:00', CHI));
    await rows(
      admin(),
      sql`update app.appointments set starts_at = ${at.toISOString()}::timestamptz,
            ends_at = ${new Date(at.getTime() + 30 * 60_000).toISOString()}::timestamptz
          where id = ${appointmentId}`,
    );
  };

  beforeAll(async () => {
    t = await setupTeam('outd-steps');
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${t.wsId}, 'outreach', 'enabled', ${outreachAddon.version})`,
    );
    await season(t.wsId, t.owner.id);
    await runAs(t.owner, t.wsId, 'outreach.playbook.save', {
      name: 'CRM demos',
      template: 'crm_demos',
      details: { ...PLAYBOOK_TEMPLATES.crm_demos.details, link: 'https://example.com/book' },
    });
    await getReady(t.wsId, [t.owner.id]);
    await runAs(t.owner, t.wsId, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'steps' },
    });
    // They chatted a few days ago, then booked through the person's link.
    await runAs(
      t.owner,
      t.wsId,
      'outreach.touch.save',
      {
        kind: 'message',
        profile: { id: null, username: 'quinn.h', url: 'https://www.facebook.com/quinn.h' },
        name: 'Quinn Harper',
      },
      new Date(Date.now() - 4 * DAY),
    );
    const [quinn] = await rows<{ id: string }>(
      admin(),
      sql`select id from addon_outreach.profiles where workspace_id = ${t.wsId} and username = 'quinn.h'`,
    );
    profileId = quinn!.id;
    const ref = demoRef(t.owner.id, profileId);
    const demos = await makeCalendar(t, 'Demos', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
    });
    const booked = await bookOnline(t, demos.id, isoAt(nextWeekday(3), '10:00'), {
      linkRef: ref,
    });
    appointmentId = booked.appointmentId;
    expect(
      await runAsSystem(t.wsId, 'outreach.demo.note', {
        ref,
        appointmentId,
        personId: booked.personId,
        at: new Date(Date.now() - 2 * DAY).toISOString(),
      }),
    ).toEqual({ counted: true });
  }, 90_000);

  it('lists nothing until the day before', async () => {
    expect((await today()).messages).toContain('demo_reminder');
    expect(await demoItem()).toBeUndefined();
  });

  it('reminds them the day before, as a message that leaves their conversation be', async () => {
    await moveTo(1);
    const item = await demoItem();
    expect(item).toMatchObject({ kind: 'demo_reminder', profileId, demoLink: null });
    expect(item!.why[0]).toMatch(/^Their demo is tomorrow, \w+day, \w+ \d+ at 12:00 PM C[DS]T$/);

    const queued = await runAs(t.owner, t.wsId, 'outreach.send.queue', {
      profileId,
      kind: 'demo_reminder',
      text: 'See you tomorrow at noon, Quinn!',
    });
    expect(queued).toMatchObject({ state: 'waiting', needsYou: null });
    await runAs(t.owner, t.wsId, 'outreach.send.approve', { sends: [{ sendId: queued.sendId }] });
    await runAs(t.owner, t.wsId, 'outreach.send.done', { sendId: queued.sendId, sent: true });
    const [follow] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.follow_ups where profile_id = ${profileId}`,
    );
    expect(follow!.n).toBe(0);
  });

  it('offers another time after a no-show, with the link, waiting for an OK of its own', async () => {
    await moveTo(-1);
    await rows(
      admin(),
      sql`update app.appointments set status = 'no_show' where id = ${appointmentId}`,
    );
    const item = await demoItem();
    expect(item).toMatchObject({ kind: 'rebook', profileId });
    expect(item!.why[0]).toMatch(/^Missed their demo, /);
    expect(item!.demoLink).toContain('https://example.com/book');

    await runAs(t.owner, t.wsId, 'outreach.automation.save', {
      settings: { ...AUTOMATION_DEFAULTS, sending: 'everything' },
    });
    const queued = await runAs(t.owner, t.wsId, 'outreach.send.queue', {
      profileId,
      kind: 'rebook',
      text: 'No worries, Quinn. Want to pick another time? https://example.com/book',
    });
    expect(queued).toMatchObject({ state: 'waiting', needsYou: REBOOK_NEEDS_YOU });
    expect((await demoItem())?.send).toMatchObject({ state: 'waiting' });

    // Skipped: not offered again.
    await runAs(t.owner, t.wsId, 'outreach.send.skip', { sendId: queued.sendId });
    expect(await demoItem()).toBeUndefined();
    const [skipped] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from addon_outreach.sends
          where profile_id = ${profileId} and kind = 'rebook' and state = 'skipped'`,
    );
    expect(skipped!.n).toBe(1);
  });

  it('reminds nobody the person wrote to since the day before', async () => {
    await rows(
      admin(),
      sql`update app.appointments set status = 'scheduled' where id = ${appointmentId}`,
    );
    await moveTo(1);
    expect(await demoItem()).toMatchObject({ kind: 'demo_reminder' });
    await runAs(t.owner, t.wsId, 'outreach.touch.save', {
      kind: 'message',
      profile: { id: null, username: 'quinn.h', url: 'https://www.facebook.com/quinn.h' },
      name: 'Quinn Harper',
    });
    expect(await demoItem()).toBeUndefined();
  });
});
