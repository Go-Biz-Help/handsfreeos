/**
 * M18 step 1 through the runtime: the teammate checks a ZIP code against the business's service areas, asks for
 * one before looking for times on a calendar that goes by ZIP, books repeat visits and puts a customer on a
 * waitlist — each held until its reply goes out, then carried out as one unit with it.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  invoiceCreate,
  invoiceSend,
  appointmentCreate,
  jobSetStatus,
  localDateOf,
  messageAttachMedia,
  offerCreate,
  pushDeviceRegister,
  territoryCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScriptRule } from '@hfos/ai';
import { scriptedAi, type TeammateRule } from '../src/ai/scripted';
import {
  admin,
  aiMessages,
  aiReplies,
  api,
  chatIn,
  decide,
  draftsOf,
  makeCalendar,
  newCustomer,
  replyNow,
  briefOf,
  requestAbout,
  run,
  runsOf,
  saveTeammate,
  teammateRequests,
  teammateWorld,
  textIn,
  toolCallsOf,
  useModel,
  type TeammateWorld,
} from './ai-team-world';
import { at, drain, textsTo } from './booking-world';

const CHI = 'America/Chicago';
let w: TeammateWorld;
let lawn: { id: string; slug: string };
let byZip: { id: string; slug: string };

const calendarIdIn = (context: string, name: string) =>
  new RegExp(`${name}.{0,20}\\(calendar id ([0-9a-f-]{36})\\)`).exec(context)?.[1] ?? '';
const firstTime = (r: Record<string, unknown> | undefined) =>
  (r?.['times'] as { startsAt: string }[] | undefined)?.[0]?.startsAt;

/** The translate job's request: each "[i] English" back as "ES: English". */
const TRANSLATE: ScriptRule = {
  when: /Translate each text into the language/,
  json: (q) => ({
    translations: [...q.matchAll(/^\[(\d+)\] (.+)$/gm)].map((m) => ({
      index: Number(m[1]),
      text: `ES: ${m[2]}`,
    })),
  }),
};

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
    when: /what do i owe/i,
    step: (t) => {
      const bills = t.results['my_bills']?.at(-1);
      if (!bills) return { calls: [{ name: 'my_bills', arguments: {} }] };
      const first = (bills['bills'] as { invoiceId: string }[])[0]!;
      if (!t.results['send_payment_link'])
        return {
          calls: [
            {
              name: 'send_payment_link',
              arguments: {
                invoiceId: first.invoiceId,
                message: 'Here’s the link to pay your bill:',
              },
            },
          ],
        };
      return {
        calls: [
          { name: 'reply', arguments: { message: 'I’ve asked the team to send your pay link.' } },
        ],
      };
    },
  },
  {
    when: /last out/i,
    step: (t) =>
      t.results['my_appointments']
        ? {
            calls: [
              { name: 'reply', arguments: { message: 'We were last out on your last visit.' } },
            ],
          }
        : { calls: [{ name: 'my_appointments', arguments: { when: 'past' } }] },
  },
  {
    when: /^hola/i,
    step: () => ({
      calls: [{ name: 'reply', arguments: { message: 'Hola, ¿en qué le ayudo?', language: 'es' } }],
    }),
  },
  {
    when: /hablar con alguien/i,
    step: () => ({
      calls: [
        {
          name: 'hand_off',
          arguments: {
            reason: 'other',
            note: 'Quiere hablar con alguien',
            language: 'es',
            translatedLine: 'Gracias por su paciencia. Le pasé esto a nuestro equipo.',
          },
        },
      ],
    }),
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
  {
    when: /book me a lawn visit/i,
    step: (t) => {
      const times = t.results['find_times']?.at(-1);
      if (!times)
        return {
          calls: [
            {
              name: 'find_times',
              arguments: {
                calendarId: calendarIdIn(t.context, 'Lawn care'),
                from: localDateOf(at(4, '00:00'), CHI),
              },
            },
          ],
        };
      if (!t.results['book'])
        return {
          calls: [
            {
              name: 'book',
              arguments: {
                calendarId: calendarIdIn(t.context, 'Lawn care'),
                startsAt: firstTime(times),
              },
            },
          ],
        };
      return { calls: [{ name: 'reply', arguments: { message: 'You’re booked.' } }] };
    },
  },
  {
    when: /gate code/i,
    step: (t) => {
      const mine = t.results['my_appointments']?.at(-1);
      if (!mine) return { calls: [{ name: 'my_appointments', arguments: {} }] };
      const visit = (mine['appointments'] as { appointmentId: string }[])[0]!;
      if (!t.results['add_to_appointment'])
        return {
          calls: [
            {
              name: 'add_to_appointment',
              arguments: { appointmentId: visit.appointmentId, note: 'The gate code is 4321' },
            },
          ],
        };
      return {
        calls: [{ name: 'reply', arguments: { message: 'Got it, I added that to your visit.' } }],
      };
    },
  },
  {
    when: /come to (.+) for a repair/i,
    step: (t) => {
      const address = /come to (.+) for a repair/i.exec(t.words)![1]!;
      if (!t.results['check_service_area'])
        return { calls: [{ name: 'check_service_area', arguments: { address } }] };
      if (t.results['check_service_area'].at(-1)!['served'] !== true)
        return { calls: [{ name: 'reply', arguments: { message: 'Sorry, we do not go there.' } }] };
      if (!t.results['find_times'])
        return {
          calls: [
            {
              name: 'find_times',
              arguments: {
                calendarId: calendarIdIn(t.context, 'Repairs'),
                from: localDateOf(at(3, '00:00'), CHI),
                address,
              },
            },
          ],
        };
      return { calls: [{ name: 'reply', arguments: { message: 'I have times for you.' } }] };
    },
  },
  {
    when: /photo of my unit/i,
    step: (t) =>
      t.images && !t.results['note_photos']
        ? {
            calls: [
              {
                name: 'note_photos',
                arguments: { shows: 'An outdoor AC unit, rusted at the base', fit: 'yes' },
              },
            ],
          }
        : {
            calls: [
              { name: 'reply', arguments: { message: 'Thanks, the team will take a look.' } },
            ],
          },
  },
  {
    when: /where is my tech/i,
    step: (t) =>
      !t.results['job_status']
        ? { calls: [{ name: 'job_status', arguments: {} }] }
        : { calls: [{ name: 'reply', arguments: { message: 'Your tech is on the way.' } }] },
  },
  {
    when: /next visit/i,
    step: (t) =>
      t.tools.has('send_verification_code') && !t.results['send_verification_code']
        ? { calls: [{ name: 'send_verification_code', arguments: {} }] }
        : {
            calls: [{ name: 'reply', arguments: { message: 'I sent you a code. Type it here.' } }],
          },
  },
  {
    when: /^\s*\d{6}\s*$/,
    step: (t) => {
      if (t.tools.has('check_verification_code'))
        return {
          calls: [{ name: 'check_verification_code', arguments: { code: t.words.trim() } }],
        };
      if (!t.results['my_appointments'])
        return { calls: [{ name: 'my_appointments', arguments: {} }] };
      return {
        calls: [{ name: 'reply', arguments: { message: 'Thanks! You have nothing booked yet.' } }],
      };
    },
  },
];

beforeAll(async () => {
  w = await teammateWorld('ai-actions', { status: 'automatic', disclosure: 'when_asked' });
  lawn = await makeCalendar(
    w,
    'Lawn care',
    {
      recurring: { customerSeries: true, maxOccurrences: 8 },
      waitlist: { enabled: true },
    },
    'Weekly mowing and edging.\nNot for tree work.',
  );
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
  useModel(w, scriptedAi([TRANSLATE], { teammate: RULES }));
}, 120_000);
afterAll(async () => {
  await w?.app.close();
});

describe('what the teammate is told about its calendars', () => {
  it('names the waitlist, repeats and ZIP codes where each calendar has them', async () => {
    const c = await newCustomer(w, 'Ann');
    const m = await textIn(w, c.phone, 'My zip is 78701, do you come out there?');
    await replyNow(w, m.conversationId);
    const context = briefOf(requestAbout(w, 'zip is 78701')!);
    expect(context).toMatch(/Lawn care.*keeps a waitlist \(join_waitlist\)/);
    expect(context).toMatch(/Lawn care.*takes repeat visits, up to 8 \(book_repeating\)/);
    expect(context).toMatch(/Repairs.*goes by ZIP code/);
    expect(context).toContain('check it with check_service_area');
  });

  it('says what each calendar is for, when the business has said', async () => {
    const c = await newCustomer(w, 'Bea');
    const m = await textIn(w, c.phone, 'My zip is 78702, can someone mow my lawn?');
    await replyNow(w, m.conversationId);
    const context = briefOf(requestAbout(w, 'mow my lawn')!);
    expect(context).toMatch(
      /Lawn care \(calendar id [0-9a-f-]{36}\), for “Weekly mowing and edging\. Not for tree work\.”/,
    );
    expect(context).toMatch(/Repairs \(calendar id [0-9a-f-]{36}\)(?!, for)/);
    expect(context).toContain('Book on the calendar that fits what they want');
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

describe('money', () => {
  it('asks an owner to send a bill’s pay link, and the link goes out once they approve', async () => {
    await saveTeammate(w, { money: { bills: true } });
    const c = await newCustomer(w, 'Fin');
    const bill = await run(w, invoiceCreate, {
      workspaceId: w.workspaceId,
      personId: c.id,
      title: 'Furnace repair',
      lines: [{ name: 'Repair', quantity: 1, unitPriceCents: 45_000 }],
    });
    await run(w, invoiceSend, {
      workspaceId: w.workspaceId,
      invoiceId: bill.invoiceId,
      channels: [],
    });
    const m = await textIn(w, c.phone, 'Hi, what do I owe you?');
    await replyNow(w, m.conversationId);
    await drain(w);
    // The reply goes out on its own; the link waits for an owner.
    expect((await aiReplies(m.conversationId)).map((x) => x.body_text)).toEqual([
      "I've asked the team to send your pay link.",
    ]);
    const drafts = await draftsOf(m.conversationId);
    const ask = drafts.find((d) => d.kind === 'approval')!;
    expect(ask).toMatchObject({ status: 'pending' });
    const preview = (
      await rows<{ preview: { message: { body: string }; actions: { kind: string }[] } }>(
        admin(),
        sql`select preview from app.ai_teammate_drafts where id = ${ask.id}`,
      )
    )[0]!.preview;
    expect(preview.actions.map((a) => a.kind)).toEqual(['share_link']);
    expect(preview.message.body).toMatch(/^Here's the link to pay your bill: http\S+\/i\/\S+$/);
    await decide(w, ask.id, 'approve');
    await drain(w);
    const sent = (await aiReplies(m.conversationId)).map((x) => x.body_text);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(preview.message.body);
  });
});

describe('hand-off alerts', () => {
  it('reach the team on their phones and by text to a verified cell, as the settings say', async () => {
    const cell = '+15125550188';
    await rows(
      admin(),
      sql`insert into app.user_phones (user_id, e164, verified_at) values (${w.owner.id}, ${cell}, now())
          on conflict (user_id, e164) do update set verified_at = now()`,
    );
    const token = `ExponentPushToken[alerts-${randomUUID().slice(0, 12)}]`;
    await executeCommand(
      api(),
      pushDeviceRegister,
      { platform: 'ios', token, appVersion: '1.0.0', deviceName: 'alerts' },
      { type: 'human', userId: w.owner.id, email: w.owner.email, claims: w.owner.claims },
      { correlationId: randomUUID(), channel: 'test' },
    );
    const pushed = (title: string) =>
      w.s.push.fake.sent.map((x) => x.message).filter((m) => m.to === token && m.title === title);
    const texted = () => w.s.telephony.sent.filter((m) => m.to === cell);

    const c = await newCustomer(w, 'Gil');
    const m = await textIn(w, c.phone, 'Can I speak to someone about a new system?');
    await replyNow(w, m.conversationId);
    await drain(w);
    expect(pushed('Needs a person · Gil Customer')).toHaveLength(1);
    expect(texted()).toHaveLength(1);
    expect(texted()[0]!.body).toContain(
      // Asking for a person hands off before the model runs, with that as the note.
      'Ava passed Gil Customer to the team: They asked for a person',
    );

    await saveTeammate(w, { handOff: { alerts: { push: false, text: false } } });
    const d = await newCustomer(w, 'Hal');
    const n = await textIn(w, d.phone, 'Please let me speak to someone.');
    await replyNow(w, n.conversationId);
    await drain(w);
    expect(pushed('Needs a person · Hal Customer')).toHaveLength(0);
    expect(texted()).toHaveLength(1);
    await saveTeammate(w, { handOff: { alerts: { push: true, text: true } } });
  });
});

describe('past visits', () => {
  it('knows their last visit, and lists the ones before it when asked', async () => {
    const c = await newCustomer(w, 'Ida');
    const m1 = await textIn(w, c.phone, 'Can you come every week to mow?');
    await replyNow(w, m1.conversationId);
    await drain(w);
    // The first of the series happened three days ago, and was marked done.
    const [first] = await rows<{ id: string }>(
      admin(),
      sql`select a.id from app.appointment_attendees t join app.appointments a on a.id = t.appointment_id
          where t.person_id = ${c.id} order by a.starts_at limit 1`,
    );
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '3 days',
            ends_at = now() - interval '3 days' + interval '1 hour', status = 'completed'
          where id = ${first!.id}`,
    );
    const m2 = await textIn(w, c.phone, 'When were you last out here?');
    await replyNow(w, m2.conversationId);
    await drain(w);
    expect(briefOf(requestAbout(w, 'last out here')!)).toMatch(/Last visit: .+ on /);
    const runs = await runsOf(m2.conversationId);
    const call = (await toolCallsOf(runs.at(-1)!.id)).find((x) => x.tool === 'my_appointments');
    const visits = (call!.result as { content: { visits: unknown[] } }).content.visits;
    expect(visits).toHaveLength(1);
  });
});

describe('offers', () => {
  it('tells the teammate about the offers running today, and no others', async () => {
    await run(w, offerCreate, {
      workspaceId: w.workspaceId,
      name: 'Fall tune-up special',
      details: '$50 off',
      endsOn: localDateOf(at(10, '12:00'), CHI),
    });
    await run(w, offerCreate, {
      workspaceId: w.workspaceId,
      name: 'Spring special',
      startsOn: localDateOf(at(40, '12:00'), CHI),
    });
    const c = await newCustomer(w, 'Joy');
    const m = await textIn(w, c.phone, 'My zip is 78701, any deals going?');
    await replyNow(w, m.conversationId);
    const context = briefOf(requestAbout(w, 'any deals going')!);
    expect(context).toContain('Current offers');
    expect(context).toContain('Fall tune-up special');
    expect(context).not.toContain('Spring special');
  });
});

describe('the customer’s language', () => {
  it('is kept on the conversation, and the fixed words follow it', async () => {
    const c = await newCustomer(w, 'Luz');
    const m = await textIn(w, c.phone, 'Hola, ¿hacen mantenimiento?');
    await replyNow(w, m.conversationId);
    await drain(w);
    const [conv] = await rows<{ language: string | null }>(
      admin(),
      sql`select language from app.conversations where id = ${m.conversationId}`,
    );
    expect(conv!.language).toBe('es');
    // The translate job kept Spanish for every emergency's steps.
    const [kept] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.fixed_text_translations where language = 'es'`,
    );
    expect(kept!.n).toBeGreaterThanOrEqual(5);

    // Its own hand-off: the line in their language, as it translated it.
    const n = await textIn(w, c.phone, 'Quiero hablar con alguien de la oficina');
    await replyNow(w, n.conversationId);
    await drain(w);
    const sent = (await aiMessages(n.conversationId)).map((x) => x.body_text);
    expect(sent.at(-1)).toBe('Gracias por su paciencia. Le pasé esto a nuestro equipo.');

    // An emergency: the kept translation of the steps, then the English.
    const d = await newCustomer(w, 'Sol');
    const first = await textIn(w, d.phone, 'Hola, una pregunta');
    await replyNow(w, first.conversationId);
    await drain(w);
    const e = await textIn(w, d.phone, 'I smell gas in the kitchen');
    await replyNow(w, e.conversationId);
    await drain(w);
    const last = (await aiMessages(e.conversationId)).at(-1)!.body_text!;
    expect(last.startsWith('ES: If you smell gas, leave the building now.')).toBe(true);
    expect(last.endsWith("We've alerted our team.")).toBe(true);
    expect(last).toContain(' If you smell gas, leave the building now.');
  });
});

describe('a website chat visitor proving who they are', () => {
  it('texts a code to the phone on file, and the right code opens the customer’s visits', async () => {
    await saveTeammate(w, { channels: { chat: true } });
    const c = await newCustomer(w, 'Remy');
    const first = await chatIn(w, c.id, 'When is my next visit?');
    await drain(w);
    const code = /code is (\d{6})/.exec(textsTo(w, c.phone).at(-1)?.body ?? '')?.[1];
    expect(code).toMatch(/^\d{6}$/);
    // The code reaches their phone only: not the tool result, not the chat.
    const [sent] = await rows<{ status: string; result: unknown }>(
      admin(),
      sql`select c.status, c.result from app.ai_teammate_tool_calls c
          join app.ai_teammate_runs r on r.id = c.run_id
          where r.conversation_id = ${first.conversationId} and c.tool = 'send_verification_code'`,
    );
    expect(sent).toMatchObject({ status: 'done' });
    expect(JSON.stringify(sent)).not.toContain(code);
    expect(JSON.stringify(sent)).toContain(`•••• ${c.phone.slice(-2)}`);
    expect(
      (await aiMessages(first.conversationId)).map((m) => m.body_text).join(' '),
    ).not.toContain(code);

    await chatIn(w, c.id, code!, { visitorId: first.visitorId });
    await drain(w);
    // It starts over as theirs: their visits on offer, and told why.
    const again = teammateRequests(w).filter((r) => JSON.stringify(r.messages[0]).includes(code!));
    expect(again.at(-1)!.tools!.map((t) => t.name)).toContain('my_appointments');
    expect(again.at(-1)!.context).toContain('They just typed back the right code');
    const replies = (await aiMessages(first.conversationId)).map((m) => m.body_text);
    expect(replies.at(-1)).toBe('Thanks! You have nothing booked yet.');
  });
});

describe('adding to a visit', () => {
  it('adds what the customer says to their booked visit, as its reply goes out', async () => {
    const c = await newCustomer(w, 'Gus');
    const first = await textIn(w, c.phone, 'Can you book me a lawn visit?');
    await replyNow(w, first.conversationId);
    await drain(w);
    const [visit] = await rows<{ id: string }>(
      admin(),
      sql`select a.id from app.appointments a join app.appointment_attendees t on t.appointment_id = a.id
          where t.person_id = ${c.id} and a.status = 'scheduled'`,
    );
    expect(visit).toBeDefined();
    const then = await textIn(w, c.phone, 'Oh and the gate code is 4321');
    await replyNow(w, then.conversationId);
    await drain(w);
    const [row] = await rows<{ notes: string | null }>(
      admin(),
      sql`select notes from app.appointments where id = ${visit!.id}`,
    );
    expect(row!.notes).toBe('From the customer, via Ava: The gate code is 4321');
    expect((await aiMessages(then.conversationId)).at(-1)!.body_text).toBe(
      'Got it, I added that to your visit.',
    );
  });
});

describe('jobs', () => {
  it('tells the customer where their job stands', async () => {
    const c = await newCustomer(w, 'Joy');
    const visit = await run(w, appointmentCreate, {
      workspaceId: w.workspaceId,
      calendarId: lawn.id,
      startsAt: new Date(at(3, '10:00')).toISOString(),
      personId: c.id,
      title: 'Lawn care',
      acknowledgeWarnings: true,
    });
    await run(w, jobSetStatus, {
      workspaceId: w.workspaceId,
      appointmentId: visit.appointmentId,
      status: 'waiting_on_parts',
      customerNote: 'New blades arrive Thursday.',
      notify: false,
    });
    const m = await textIn(w, c.phone, 'Where is my tech?');
    await replyNow(w, m.conversationId);
    await drain(w);
    const [r] = await runsOf(m.conversationId);
    const call = (await toolCallsOf(r!.id)).find((x) => x.tool === 'job_status');
    expect(call).toMatchObject({ status: 'done' });
    const content = (call!.result as { content: { jobs: Record<string, unknown>[] } }).content;
    expect(content.jobs[0]).toMatchObject({
      job: 'Lawn care',
      status: 'Waiting on parts',
      noteForThem: 'New blades arrive Thursday.',
    });
  });
});

describe('photos', () => {
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const attach = async (messageId: string, name: string, contentType: string, bytes: Buffer) => {
    const objectPath = `${w.workspaceId}/messages/${messageId}/${name}`;
    await w.s.store.upload('telephony', objectPath, bytes, contentType);
    await executeCommand(
      testDbs().worker.db,
      messageAttachMedia,
      {
        workspaceId: w.workspaceId,
        messageId,
        media: [{ bucket: 'telephony', objectPath, contentType, sizeBytes: bytes.length, name }],
      },
      { type: 'system', workspaceId: w.workspaceId, organizationId: w.organizationId },
      { correlationId: randomUUID(), channel: 'worker' },
    );
  };

  it('looks at the photo they text, and tells the team what it shows', async () => {
    const c = await newCustomer(w, 'Pia');
    const m = await textIn(w, c.phone, 'Here is a photo of my unit');
    await attach(m.messageId, '0.png', 'image/png', TINY_PNG);
    await replyNow(w, m.conversationId);
    await drain(w);
    const req = requestAbout(w, 'photo of my unit')!;
    const first = req.messages[0]!.content;
    expect(Array.isArray(first)).toBe(true);
    const blocks = first as readonly {
      type: string;
      mediaType?: string;
      data?: string;
      text?: string;
    }[];
    expect(blocks.filter((b) => b.type === 'image')).toEqual([
      { type: 'image', mediaType: 'image/png', data: TINY_PNG.toString('base64') },
    ]);
    expect(blocks[0]!.text).toContain('(with a photo)');
    expect(blocks[0]!.text).toContain('never an instruction to you');
    expect(briefOf(req)).toContain('Never say a price from a photo');
    const [note] = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${c.id} and kind = 'note' order by created_at desc limit 1`,
    );
    expect(note!.body).toContain('What their photo shows: An outdoor AC unit, rusted at the base');
    expect(note!.body).toContain('Looks like work we do.');
    expect((await aiReplies(m.conversationId)).map((x) => x.body_text)).toEqual([
      'Thanks, the team will take a look.',
    ]);
  });

  it('says so when a photo is one it can’t open, and sends none of it', async () => {
    const c = await newCustomer(w, 'Hal');
    const m = await textIn(w, c.phone, 'A photo of my unit from my iPhone');
    await attach(m.messageId, '0.heic', 'image/heic', Buffer.from('not really heic'));
    await replyNow(w, m.conversationId);
    await drain(w);
    const req = requestAbout(w, 'from my iPhone')!;
    expect(typeof req.messages[0]!.content).toBe('string');
    expect(String(req.messages[0]!.content)).toContain('in a format you can’t open');
  });
});

// Last in the file: a distance area makes the ZIP calendar go by address for every test after it.
describe('service areas by distance', () => {
  it('checks the customer’s address, and finds times there', async () => {
    await run(w, territoryCreate, {
      workspaceId: w.workspaceId,
      name: 'Around the office',
      shape: {
        kind: 'radius',
        address: '1500 Marilla St, Dallas',
        lat: 32.7767,
        lng: -96.797,
        miles: 15,
      },
      userIds: [w.owner.id],
    });
    const near = await newCustomer(w, 'Dot');
    const a = await textIn(w, near.phone, 'Can you come to 1500 Marilla St, Dallas for a repair?');
    await replyNow(w, a.conversationId);
    const [ra] = await runsOf(a.conversationId);
    const callsA = await toolCallsOf(ra!.id);
    expect(callsA.find((x) => x.tool === 'check_service_area')!.result).toMatchObject({
      content: { served: true },
    });
    const times = callsA.find((x) => x.tool === 'find_times');
    expect(times).toMatchObject({ status: 'done' });
    expect(
      (times!.result as { content: { times: unknown[] } }).content.times.length,
    ).toBeGreaterThan(0);
    const seen = briefOf(requestAbout(w, '1500 Marilla St')!);
    expect(seen).toContain('goes by where they are');

    const far = await newCustomer(w, 'Eli');
    const b = await textIn(
      w,
      far.phone,
      'Can you come to 1 Congress Ave, Austin @30.27,-97.74 for a repair?',
    );
    await replyNow(w, b.conversationId);
    await drain(w);
    expect((await aiReplies(b.conversationId)).map((x) => x.body_text)).toEqual([
      'Sorry, we do not go there.',
    ]);
  });
});
