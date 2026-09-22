/**
 * M18 step 1 through the runtime: the teammate checks a ZIP code against the business's service areas, asks for
 * one before looking for times on a calendar that goes by ZIP, books repeat visits and puts a customer on a
 * waitlist — each held until its reply goes out, then carried out as one unit with it.
 */
import { localDateOf, territoryCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi, type TeammateRule } from '../src/ai/scripted';
import {
  admin,
  aiReplies,
  makeCalendar,
  newCustomer,
  replyNow,
  requestAbout,
  run,
  runsOf,
  saveTeammate,
  teammateWorld,
  textIn,
  toolCallsOf,
  useModel,
  type TeammateWorld,
} from './ai-team-world';
import { at, drain } from './booking-world';

const CHI = 'America/Chicago';
let w: TeammateWorld;
let lawn: { id: string; slug: string };
let byZip: { id: string; slug: string };

const calendarIdIn = (context: string, name: string) =>
  new RegExp(`${name}.{0,20}\\(calendar id ([0-9a-f-]{36})\\)`).exec(context)?.[1] ?? '';
const firstTime = (r: Record<string, unknown> | undefined) =>
  (r?.['times'] as { startsAt: string }[] | undefined)?.[0]?.startsAt;

/** What the stand-in does for each customer message these tests send. */
const RULES: TeammateRule[] = [
  {
    when: /every week/i,
    step: (t) => {
      const times = t.results['find_times']?.at(-1);
      if (!times)
        return {
          calls: [
            {
              name: 'find_times',
              arguments: {
                calendarId: calendarIdIn(t.context, 'Lawn care'),
                from: localDateOf(at(3, '00:00'), CHI),
              },
            },
          ],
        };
      if (!t.results['book_repeating'])
        return {
          calls: [
            {
              name: 'book_repeating',
              arguments: {
                calendarId: calendarIdIn(t.context, 'Lawn care'),
                startsAt: firstTime(times),
                every: 'week',
                times: 4,
              },
            },
          ],
        };
      return { calls: [{ name: 'reply', arguments: { message: 'Done, see you each week.' } }] };
    },
  },
  {
    when: /waitlist/i,
    step: (t) =>
      t.results['join_waitlist']
        ? { calls: [{ name: 'reply', arguments: { message: "You're on the waitlist." } }] }
        : {
            calls: [
              {
                name: 'join_waitlist',
                arguments: {
                  calendarId: calendarIdIn(t.context, 'Lawn care'),
                  from: localDateOf(at(5, '00:00'), CHI),
                },
              },
            ],
          },
  },
  {
    when: /zip is (\d{5})/i,
    step: (t) => {
      const zip = /zip is (\d{5})/i.exec(t.words)![1]!;
      const area = t.results['check_service_area']?.at(-1);
      if (!area) return { calls: [{ name: 'check_service_area', arguments: { postalCode: zip } }] };
      return {
        calls: [
          {
            name: 'reply',
            arguments: {
              message: area['served'] ? 'Yes, we come out there.' : 'Sorry, not there.',
            },
          },
        ],
      };
    },
  },
  {
    when: /new furnace/i,
    step: (t) =>
      !t.results['open_deal']
        ? { calls: [{ name: 'open_deal', arguments: { title: 'New furnace' } }] }
        : !t.results['set_deal_value']
          ? { calls: [{ name: 'set_deal_value', arguments: { dollars: 4800 } }] }
          : !t.results['close_deal']
            ? { calls: [{ name: 'close_deal', arguments: { outcome: 'won' } }] }
            : {
                calls: [{ name: 'reply', arguments: { message: 'Great, we’ll get it ordered.' } }],
              },
  },
  {
    when: /times near me/i,
    step: (t) =>
      t.results['find_times']
        ? { calls: [{ name: 'reply', arguments: { message: 'What’s your ZIP code?' } }] }
        : {
            calls: [
              {
                name: 'find_times',
                arguments: {
                  calendarId: calendarIdIn(t.context, 'Repairs'),
                  from: localDateOf(at(3, '00:00'), CHI),
                },
              },
            ],
          },
  },
];

beforeAll(async () => {
  w = await teammateWorld('ai-actions', { status: 'automatic', disclosure: 'when_asked' });
  lawn = await makeCalendar(w, 'Lawn care', {
    recurring: { customerSeries: true, maxOccurrences: 8 },
    waitlist: { enabled: true },
  });
  byZip = await makeCalendar(w, 'Repairs', {
    territory: { routing: 'zip' },
    locations: { options: [{ kind: 'customer_address' }] },
  });
  await run(w, territoryCreate, {
    workspaceId: w.workspaceId,
    name: 'Downtown',
    postalCodes: ['78701', '78702'],
  });
  await saveTeammate(w, {
    book: { enabled: true, calendarIds: [lawn.id, byZip.id], repeats: true },
  });
  useModel(w, scriptedAi([], { teammate: RULES }));
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

describe('what the teammate is told about its calendars', () => {
  it('names the waitlist, repeats and ZIP codes where each calendar has them', async () => {
    const c = await newCustomer(w, 'Ann');
    const m = await textIn(w, c.phone, 'My zip is 78701, do you come out there?');
    await replyNow(w, m.conversationId);
    const context = requestAbout(w, 'zip is 78701')!.context!;
    expect(context).toMatch(/Lawn care.*keeps a waitlist \(join_waitlist\)/);
    expect(context).toMatch(/Lawn care.*takes repeat visits, up to 8 \(book_repeating\)/);
    expect(context).toMatch(/Repairs.*goes by ZIP code/);
    expect(context).toContain('check it with check_service_area');
  });
});

describe('the service area', () => {
  it('says whether the business serves a ZIP code', async () => {
    for (const [zip, served, said] of [
      ['78702', true, 'Yes, we come out there.'],
      ['90210', false, 'Sorry, not there.'],
    ] as const) {
      const c = await newCustomer(w, `Zed${zip}`);
      const m = await textIn(w, c.phone, `My zip is ${zip}`);
      await replyNow(w, m.conversationId);
      await drain(w);
      const [r] = await runsOf(m.conversationId);
      const calls = await toolCallsOf(r!.id);
      const check = calls.find((x) => x.tool === 'check_service_area');
      expect(check).toMatchObject({ status: 'done' });
      expect((check!.result as { content: { served: boolean } }).content.served).toBe(served);
      expect((await aiReplies(m.conversationId)).map((x) => x.body_text)).toEqual([said]);
    }
  });

  it('asks for a ZIP code before looking for times on a calendar that goes by one', async () => {
    const c = await newCustomer(w, 'Bea');
    const m = await textIn(w, c.phone, 'Any times near me next week?');
    await replyNow(w, m.conversationId);
    const [r] = await runsOf(m.conversationId);
    const find = (await toolCallsOf(r!.id)).find((x) => x.tool === 'find_times');
    expect(find).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(find!.result)).toContain('offers times by ZIP code');
  });
});

describe('repeat visits and the waitlist, going out with the reply', () => {
  it('books every visit of a weekly series once its reply goes out', async () => {
    const c = await newCustomer(w, 'Cal');
    const m = await textIn(w, c.phone, 'Can you come every week to mow?');
    await replyNow(w, m.conversationId);
    await drain(w);
    expect((await aiReplies(m.conversationId)).map((x) => x.body_text)).toEqual([
      'Done, see you each week.',
    ]);
    const visits = await rows<{ series_id: string | null; source: string }>(
      admin(),
      sql`select a.series_id, a.source::text as source from app.appointment_attendees t
          join app.appointments a on a.id = t.appointment_id
          where t.person_id = ${c.id} and t.status = 'booked' order by a.starts_at`,
    );
    expect(visits).toHaveLength(4);
    expect(new Set(visits.map((v) => v.series_id)).size).toBe(1);
    expect(visits[0]!.series_id).not.toBeNull();
    expect(visits.every((v) => v.source === 'ai_teammate')).toBe(true);
  });

  it('puts the customer on the waitlist for the day they asked about', async () => {
    const c = await newCustomer(w, 'Dot');
    const m = await textIn(w, c.phone, 'Nothing works for me, can I get on the waitlist?');
    await replyNow(w, m.conversationId);
    await drain(w);
    expect((await aiReplies(m.conversationId)).map((x) => x.body_text)).toEqual([
      "You're on the waitlist.",
    ]);
    const places = await rows<{ source: string; wanted_from: Date; wanted_to: Date }>(
      admin(),
      sql`select source::text as source, wanted_from, wanted_to from app.waitlist_entries
          where person_id = ${c.id} and status = 'waiting'`,
    );
    expect(places).toHaveLength(1);
    expect(places[0]!.source).toBe('ai_teammate');
    expect(localDateOf(new Date(places[0]!.wanted_from).getTime(), CHI)).toBe(
      localDateOf(at(5, '00:00'), CHI),
    );
  });
});

describe('deals', () => {
  it('opens a lead, sets what it’s worth and marks it won, when the settings allow', async () => {
    await saveTeammate(w, { deals: { enabled: true } });
    const c = await newCustomer(w, 'Eve');
    const m = await textIn(w, c.phone, 'Yes, go ahead with the new furnace for $4,800.');
    await replyNow(w, m.conversationId);
    await drain(w);
    const [lead] = await rows<{
      title: string;
      status: string;
      value_cents: string;
      source: string;
    }>(
      admin(),
      sql`select title, status::text as status, value_cents::text as value_cents, source
          from app.leads where person_id = ${c.id}`,
    );
    expect(lead).toMatchObject({
      title: 'New furnace',
      status: 'won',
      value_cents: '480000',
      source: 'AI teammate',
    });
    const [r] = await runsOf(m.conversationId);
    expect((await toolCallsOf(r!.id)).map((x) => [x.tool, x.status])).toEqual([
      ['open_deal', 'done'],
      ['set_deal_value', 'done'],
      ['close_deal', 'done'],
      ['reply', 'done'],
    ]);
  });
});
