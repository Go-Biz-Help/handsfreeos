/**
 * Milestone 7 demo data for Lone Star (design/m7): its AI teammate "Ava", in training wheels at 17 of 20
 * approved (3 of them edited), and the inbox her training left behind. Everything goes through the commands and
 * the worker's own runtime, as it would for a business:
 * - Settings: Lone Star's open hours (the knowledge base's; the hand-off line says when someone will reply).
 * - Dale sets Ava up from the Appointment Coordinator preset (she says she's AI only when asked), then he and
 *   Priya save five more revisions: texts and the website chat, booking AC tune-ups, at any hour; four
 *   qualifying questions (the system, its age, owning the home, the ZIP) that move a qualified lead to Contacted
 *   and tell Dale, and up to two nudges; "Insurance claims" as a sensitive topic, with Dale and Priya told of
 *   hand-offs; the Install walkthrough calendar; and her hand-off line. She's turned on in training after the
 *   first of those.
 * - The website chat: a widget for the stand-in site (seed-knowledge's lonestarhvac.test) in Lone Star's red,
 *   answered by Ava and seen installed there.
 * - Customers text in (message.receive, as the carrier's webhook runs it) and a visitor chats (the chat
 *   commands, as the worker's chat routes run them). Each reply job runs now instead of after its wait, with the
 *   seed's scripted model (AVA_RULES) picking Ava's tools and words; Dale and Priya decide her drafts
 *   (ai_teammate.decide_draft: the only way the training counts move), and the worker sends each approved one.
 *   Nine texting customers answered, three of the replies edited first; Angela Brooks's chat, where she gives
 *   her name and answers the questions (her Attic insulation lead qualifies and moves to Contacted), then a roof
 *   question goes to a person until Dale joins; Tom Reyes's contract question waiting in "Needs a person" with
 *   Ava's note; and Kendra Lee's reply waiting for an OK.
 * - Afterwards each conversation's rows are set back to when it happened, over the last six hours, as the
 *   messaging seed does with its replies. Ava's revisions keep the seed's own time: they can't be edited.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  aiTeammateCreate,
  aiTeammateDecideDraft,
  aiTeammateGet,
  aiTeammateSaveConfig,
  aiTeammateSetStatus,
  applyTeammatePatch,
  chatIdentify,
  chatMarkRead,
  chatReceive,
  chatVisitorStart,
  chatWidgetCreate,
  chatWidgetRecordSeen,
  executeCommand,
  executeQuery,
  messageReceive,
  messageSend,
  messageUpdateStatus,
  parseTeammateConfig,
  plainSmsText,
  workspaceUpdate,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
  type TeammatePatch,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import {
  scriptedAi,
  type TeammateRule,
  type TeammateStep,
  type TeammateTurn,
} from '../src/ai/scripted';
import { TEAMMATE_JOBS } from '../src/ai-team/constants';
import { processJobs } from '../src/jobs';
import type { OutboxDeps } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { systemActor, workerMeta } from '../src/services';
import { LONE_STAR_WEBSITE, SEED_AI_RULES } from './seed-knowledge';
import { LONE_STAR_NUMBER, settle } from './seed-messaging';

export interface SeedAiTeamDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services; Ava gets the seed's own stand-in model on top of them. */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedAiTeamWorkspace {
  readonly id: string;
  readonly organizationId: string;
  readonly dale: TestUser;
  readonly priya: TestUser;
}

export interface SeededAiTeam {
  readonly name: string;
  readonly approved: number;
  readonly edited: number;
  readonly approvalsNeeded: number;
  /** Conversations with at least one of her replies sent. */
  readonly answered: number;
  readonly widgetKey: string;
  readonly site: string;
  readonly seconds: number;
}

type Who = 'dale' | 'priya';

/** One customer message and what Ava does with it. */
interface Turn {
  /** What the customer writes (straight apostrophes: a text in plain characters). */
  readonly says: string;
  /** Ava looks this up in the knowledge base first. */
  readonly search?: string;
  /** Qualifying answers she saves (lead.record_answers); once they qualify the lead she moves it on. */
  readonly answers?: readonly { readonly questionId: string; readonly answer: string }[];
  /** Her reply, which waits as a draft. Without `approve` it's still waiting when the seed ends. */
  readonly reply?: string;
  /** Who approves the draft, and their own version when they change it first. */
  readonly approve?: { readonly by: Who; readonly edit?: string };
  /** She hands the conversation to a person instead, with this note. */
  readonly handOff?: string;
  /** How long before the seed it happened, in minutes. */
  readonly ago: number;
}

interface Thread {
  readonly customer: string;
  /** A website chat visitor instead of a text: the details they give before `identifyBefore`. */
  readonly chat?: {
    readonly name: string;
    readonly phone: string;
    readonly page: string;
    readonly identifyBefore: number;
  };
  readonly turns: readonly Turn[];
}

/** Lone Star's qualifying questions: the system, its age, owning the home (renting rules them out), the ZIP. */
const QUESTIONS = [
  {
    id: 'system',
    question: 'What kind of system do you have?',
    kind: 'choice' as const,
    options: ['Central AC', 'Heat pump', 'Furnace', 'Mini split', 'Not sure'],
  },
  {
    id: 'age',
    question: 'About how old is it?',
    kind: 'choice' as const,
    options: ['Under 5 years', '5 to 10 years', 'Over 10 years', 'Not sure'],
  },
  {
    id: 'owner',
    question: 'Do you own the home or building?',
    kind: 'yes_no' as const,
    notAFitIf: { answers: ['no'] },
  },
  { id: 'zip', question: 'What ZIP code is it in?', kind: 'text' as const },
];

/** Ava's replies stay inside her safety check: no prices, links, other numbers or claims she can't back. */
const THREADS: readonly Thread[] = [
  {
    customer: 'Victor Hale',
    turns: [
      {
        says: 'How long does a roof replacement usually take? We have duct cleaning with you guys next week too.',
        search: 'how long does a roof replacement take',
        reply:
          'Most homes take one or two days, weather permitting. We protect the yard and haul everything away when we are done.',
        approve: { by: 'dale' },
        ago: 360,
      },
      {
        says: 'Good to know. Do you service Trane units?',
        search: 'do you service all brands',
        reply:
          'Yes. Our technicians work on every major brand of air conditioner, heat pump and furnace, Trane included.',
        approve: { by: 'dale' },
        ago: 348,
      },
    ],
  },
  {
    customer: 'Yusuf Ali',
    turns: [
      {
        says: 'How soon could a tech come out? The upstairs AC is blowing warm air.',
        search: 'how soon can a technician come out',
        reply:
          'Most repair calls are seen the same or next business day, and no cooling in this heat goes to the front of the line. Reply here with a good day and we will get you on the schedule.',
        approve: { by: 'dale' },
        ago: 335,
      },
    ],
  },
  {
    customer: 'Olivia Grant',
    turns: [
      {
        says: 'Are your technicians licensed? My HOA asks for proof before anyone works on the unit.',
        search: 'are your technicians licensed and insured',
        reply:
          'Yes. Our HVAC technicians are licensed by the Texas Department of Licensing and Regulation, and we carry full liability insurance. The office can send proof for your HOA.',
        approve: { by: 'priya' },
        ago: 310,
      },
      {
        says: 'Perfect. Do you also go out to Katy? My mom lives there.',
        search: 'service area',
        reply:
          'We do. Katy is in our service area, along with the rest of Houston, Sugar Land, Pearland, The Woodlands, Cypress and Spring.',
        approve: { by: 'priya' },
        ago: 296,
      },
    ],
  },
  {
    customer: 'Nathan Price',
    turns: [
      {
        says: 'Quick one: do you take credit cards, or is it check only?',
        search: 'payment',
        reply: 'We take all major cards, checks and cash. Payment is due when the work is done.',
        approve: { by: 'priya' },
        ago: 290,
      },
    ],
  },
  {
    customer: 'Greg Thompson',
    turns: [
      {
        says: 'Do you have emergency service? Our heat went out one night last winter and it was a long wait.',
        search: 'emergency service',
        reply:
          'Yes. Emergency heating and cooling calls are answered 24/7, day or night. After-hours visits have an extra trip charge.',
        approve: { by: 'dale' },
        ago: 270,
      },
      // Nothing to answer: her turn ends without a reply (no draft).
      { says: 'Thanks!', ago: 262 },
    ],
  },
  {
    customer: 'Carlos Mendoza',
    turns: [
      {
        says: 'Do you guys work on Lennox furnaces? Ours makes a clicking noise before it starts.',
        search: 'do you service all brands',
        reply:
          'Yes. Our technicians repair and maintain every major brand, Lennox included. A click before it starts is worth having a technician check.',
        approve: {
          by: 'dale',
          edit: 'Hi Carlos, yes, we work on Lennox all the time. A click before it starts is worth a look, and your furnace tune-up is a good time for it.',
        },
        ago: 240,
      },
      {
        says: "Good to know. What's your warranty on repairs?",
        search: 'warranty on repairs',
        reply:
          'Repairs carry a 1-year labor warranty, and new systems carry a 10-year parts warranty once they are registered.',
        approve: { by: 'dale' },
        ago: 228,
      },
    ],
  },
  {
    customer: "Kevin O'Brien",
    turns: [
      {
        says: 'What does your maintenance plan include?',
        search: 'maintenance plan',
        reply:
          'Two tune-ups a year (the AC in spring and the furnace or heat pump in fall), priority scheduling when it gets busy, and no trip charge on repair visits during business hours.',
        approve: { by: 'priya' },
        ago: 205,
      },
    ],
  },
  {
    customer: 'Jasmine Carter',
    turns: [
      {
        says: 'Our AC is 20 years old and keeps breaking down. Is it worth repairing again or should we replace it?',
        search: 'should I repair or replace my AC',
        reply:
          'At 20 years old, replacing it usually costs less over time than more repairs. Your install walkthrough coming up is a good time to go over the options.',
        approve: {
          by: 'dale',
          edit: 'Hi Jasmine, at 20 years a new system usually saves you money over more repairs. Marco and I will go over the options with you at the walkthrough.',
        },
        ago: 180,
      },
      {
        says: 'Makes sense. Do you install heat pumps too?',
        search: 'do you install heat pumps',
        reply:
          'Yes. We install and service heat pumps, and we can tell you at the walkthrough whether one suits your home.',
        approve: { by: 'dale' },
        ago: 164,
      },
    ],
  },
  {
    customer: 'Hannah Nguyen',
    turns: [
      {
        says: "Hi, do you do AC tune-ups? What does one include? Ours hasn't been checked in two years.",
        search: "what's included in a tune-up",
        reply:
          'Hi Hannah, yes we do. A tune-up covers cleaning the coils, checking the refrigerant and electrical parts, testing the thermostat, a standard filter and clearing the drain line. Want us to find you a time?',
        approve: {
          by: 'priya',
          edit: 'Hi Hannah, yes we do! We clean the coils, check the refrigerant and electrical parts, test the thermostat, change a standard filter and clear the drain line. Want us to find you a time?',
        },
        ago: 130,
      },
      {
        says: 'Maybe later this month. How often should we be doing this?',
        search: 'how often should my AC be serviced',
        reply:
          'Twice a year is best: the AC in spring and the furnace or heat pump in fall. Our maintenance plan covers both visits. Just text us when you are ready to book.',
        approve: { by: 'dale' },
        ago: 118,
      },
    ],
  },
  {
    customer: 'Angela Brooks',
    chat: {
      name: 'Angela Brooks',
      phone: '(832) 555-0134',
      page: '/services',
      identifyBefore: 1,
    },
    turns: [
      {
        says: 'Hi! Our upstairs never cools down in the afternoon. Would attic insulation help, or is it the AC?',
        search: 'attic insulation upstairs not cooling',
        reply:
          'Sorry the upstairs is so warm! It could be either one, so a few quick questions help us send the right person. What kind of system do you have, and about how old is it?',
        approve: { by: 'dale' },
        ago: 9,
      },
      {
        says: "It's central AC, about 12 years old. I'm Angela Brooks, by the way.",
        answers: [
          { questionId: 'system', answer: 'Central AC' },
          { questionId: 'age', answer: 'About 12 years' },
        ],
        reply: 'Thanks, Angela. Two more: do you own the home, and what ZIP code is it in?',
        approve: { by: 'dale' },
        ago: 7,
      },
      {
        says: "Yes, we own it. We're in 77008.",
        answers: [
          { questionId: 'owner', answer: 'Yes' },
          { questionId: 'zip', answer: '77008' },
        ],
        reply:
          "That's everything I need. I've noted it all for the team, and someone will reach out about the insulation and the AC.",
        approve: { by: 'dale' },
        ago: 5,
      },
      {
        says: "One more thing, there's a small leak in the garage roof. Could the tech look at that too?",
        search: 'garage roof leak repair',
        handOff:
          "Angela asked about a small leak in her garage roof. Roof repairs aren't in your Knowledge, so I told her someone would reply here in the chat.",
        ago: 4,
      },
    ],
  },
  {
    customer: 'Tom Reyes',
    turns: [
      {
        says: 'Hi, this is Tom with Greenway Property Management. We have 12 buildings on Westheimer that need a yearly maintenance contract. What would that run?',
        search: 'maintenance contract for several buildings',
        handOff:
          "Tom manages 12 buildings for Greenway on Westheimer and wants a price for a yearly maintenance contract. Contract prices aren't in your Knowledge, so I told him someone from the team will reply.",
        ago: 25,
      },
    ],
  },
  {
    customer: 'Kendra Lee',
    turns: [
      {
        says: 'Hi, does your tune-up include a new filter? And do you work on Carrier?',
        search: "what's included in a tune-up",
        reply:
          'Hi Kendra, yes to both. A tune-up includes a standard filter, and our technicians work on every major brand, Carrier included. Would you like us to find you a time?',
        ago: 14,
      },
    ],
  },
];

/** Dale joins Angela's chat once Ava hands it over. */
const DALE_JOINS = {
  body: "Hi Angela, Dale here. We can have someone look at the garage roof when we're out for the AC. I'll text you to set a time.",
  ago: 2,
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const call = (name: string, args: Record<string, unknown>): TeammateStep => ({
  calls: [{ name, arguments: args }],
});

/**
 * What Ava does with one message: look it up, save qualifying answers (and move the lead once they qualify it),
 * then reply, hand off, or end her turn when there's nothing to answer. Her reply goes through the runtime's
 * safety check like any other.
 */
function avaStep(turn: Turn) {
  return (t: TeammateTurn): TeammateStep => {
    if (turn.search && t.tools.has('search_knowledge') && !t.results['search_knowledge'])
      return call('search_knowledge', { query: turn.search });
    if (turn.answers && t.tools.has('record_answers') && !t.results['record_answers'])
      return call('record_answers', { answers: turn.answers });
    const next = t.results['record_answers']?.at(-1)?.['next'];
    const stageId = /stage id ([0-9a-f-]{36})/.exec(typeof next === 'string' ? next : '')?.[1];
    if (stageId && t.tools.has('move_stage') && !t.results['move_stage'])
      return call('move_stage', { stageId, reason: 'Every qualifying question is answered.' });
    if (turn.handOff) return call('hand_off', { reason: 'unsure', note: turn.handOff });
    if (turn.reply) return call('reply', { message: turn.reply });
    return call('no_reply', { reason: 'They said thanks; nothing needs an answer.' });
  };
}

/** The seed's stand-in model for Ava: each rule knows one of the customers' messages above. */
const AVA_RULES: readonly TeammateRule[] = THREADS.flatMap((th) =>
  th.turns.map((turn) => ({ when: new RegExp(escapeRe(turn.says)), step: avaStep(turn) })),
);

/** A stretch of one conversation's rows made in one round, and when it should read as having happened. */
interface Span {
  readonly conversationId: string;
  readonly from: string;
  readonly to: string;
  readonly ago: number;
}

/**
 * Sets each conversation's rows back to when its script says it happened: its messages and their timeline
 * entries, Ava's runs, tool calls and drafts, the lead the chat qualified, and the conversation's own times.
 */
async function backdate(
  admin: Db,
  workspaceId: string,
  anchor: string,
  spans: readonly Span[],
): Promise<void> {
  const anchorMs = Date.parse(anchor);
  const ids = [...new Set(spans.map((s) => s.conversationId))];
  const idList = sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  const plan = sql`with plan (cid, t0, t1, shift) as (values ${sql.join(
    spans.map(
      (s) =>
        sql`(${s.conversationId}::uuid, ${s.from}::timestamptz, ${s.to}::timestamptz,
            ${`${Math.round(Date.parse(s.from) - (anchorMs - s.ago * 60_000))} milliseconds`}::interval)`,
    ),
    sql`, `,
  )}) `;
  const statements = [
    sql`${plan} update app.messages m set occurred_at = m.occurred_at - p.shift, created_at = m.created_at - p.shift,
          sent_at = m.sent_at - p.shift, delivered_at = m.delivered_at - p.shift
        from plan p where m.conversation_id = p.cid and m.created_at >= p.t0 and m.created_at < p.t1`,
    // The customer's other timeline entries from then move too: answers recorded, the lead qualifying, its stage.
    sql`${plan} update app.activities a set occurred_at = a.occurred_at - p.shift
        from plan p join app.conversations c on c.id = p.cid
        where a.workspace_id = ${workspaceId} and a.person_id = c.person_id
          and a.created_at >= p.t0 and a.created_at < p.t1
          and not exists (select 1 from app.messages m where m.activity_id = a.id)`,
    sql`update app.activities a set occurred_at = m.occurred_at
        from app.messages m
        where m.activity_id = a.id and m.conversation_id = any(${idList})`,
    sql`${plan} update app.leads l set stage_entered_at = l.stage_entered_at - p.shift
        from plan p join app.conversations c on c.id = p.cid
        where l.person_id = c.person_id and l.stage_entered_at >= p.t0 and l.stage_entered_at < p.t1`,
    sql`${plan} update app.ai_teammate_tool_calls t set created_at = t.created_at - p.shift
        from plan p join app.ai_teammate_runs r on r.conversation_id = p.cid
        where t.run_id = r.id and t.created_at >= p.t0 and t.created_at < p.t1`,
    sql`${plan} update app.ai_teammate_runs r set started_at = r.started_at - p.shift,
          ended_at = r.ended_at - p.shift, created_at = r.created_at - p.shift
        from plan p where r.conversation_id = p.cid and r.started_at >= p.t0 and r.started_at < p.t1`,
    sql`${plan} update app.ai_teammate_drafts d set created_at = d.created_at - p.shift,
          decided_at = d.decided_at - p.shift, expires_at = d.expires_at - p.shift, sent_at = d.sent_at - p.shift
        from plan p where d.conversation_id = p.cid and d.created_at >= p.t0 and d.created_at < p.t1`,
    sql`${plan} update app.conversations c set needs_person_since = c.needs_person_since - p.shift
        from plan p where c.id = p.cid and c.needs_person_since >= p.t0 and c.needs_person_since < p.t1`,
    sql`${plan} update app.conversations c set awaiting_reply_since = c.awaiting_reply_since - p.shift
        from plan p where c.id = p.cid and c.awaiting_reply_since >= p.t0 and c.awaiting_reply_since < p.t1`,
    sql`update app.conversations c
        set last_message_at = t.last_at, last_inbound_at = t.last_in, last_outbound_at = t.last_out,
          ai_answered_through = case when c.ai_answered_through is null then null else t.last_in end,
          created_at = least(c.created_at, t.first_at)
        from (
          select conversation_id, max(occurred_at) as last_at, min(occurred_at) as first_at,
            max(occurred_at) filter (where direction = 'inbound') as last_in,
            max(occurred_at) filter (where direction = 'outbound') as last_out
          from app.messages where conversation_id = any(${idList}) group by conversation_id
        ) t
        where c.id = t.conversation_id`,
  ];
  // System timeline entries are immutable by trigger, for everyone; as in the CRM seed's ageing pass, the seed
  // is the one place that backdates them, so the trigger is paused for this pass only.
  await rows(admin, sql`alter table app.activities disable trigger activities_system_immutable`);
  try {
    for (const statement of statements) await rows(admin, statement);
  } finally {
    await rows(admin, sql`alter table app.activities enable trigger activities_system_immutable`);
  }

  // Qualifying answers keep their times inside the lead's qualification, moved with their own conversation.
  const leads = await rows<{
    id: string;
    conversation_id: string;
    qualification: Record<string, unknown>;
  }>(
    admin,
    sql`select distinct on (l.id) l.id, c.id as conversation_id, l.qualification from app.leads l
        join app.conversations c on c.person_id = l.person_id
        where c.id = any(${idList}) and l.qualification ->> 'updatedAt' is not null`,
  );
  for (const lead of leads) {
    const own = spans.filter((s) => s.conversationId === lead.conversation_id);
    const moved = (iso: unknown) => {
      if (typeof iso !== 'string') return iso;
      const at = Date.parse(iso);
      const s = own.find((x) => at >= Date.parse(x.from) && at < Date.parse(x.to));
      const shift = s ? Date.parse(s.from) - (anchorMs - s.ago * 60_000) : 0;
      return new Date(at - shift).toISOString();
    };
    const q = lead.qualification;
    const answers = (q['answers'] ?? {}) as Record<string, Record<string, unknown>>;
    const next = {
      ...q,
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, a]) => [
          id,
          { ...a, answeredAt: moved(a['answeredAt']) },
        ]),
      ),
      qualifiedAt: moved(q['qualifiedAt']),
      updatedAt: moved(q['updatedAt']),
    };
    await rows(
      admin,
      sql`update app.leads set qualification = ${JSON.stringify(next)}::jsonb where id = ${lead.id}`,
    );
  }
}

export async function seedAiTeam(
  d: SeedAiTeamDeps,
  ws: SeedAiTeamWorkspace,
): Promise<SeededAiTeam> {
  const started = Date.now();
  const workspaceId = ws.id;
  const team: Record<Who, TestUser> = { dale: ws.dale, priya: ws.priya };
  const as = <I extends z.ZodType, O extends z.ZodType>(
    who: Who,
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) => executeCommand(d.api, command, input, d.actor(team[who]), d.meta()).then((r) => r.output);
  const scope = { workspaceId, organizationId: ws.organizationId };
  const system = <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) =>
    executeCommand(d.worker.db, command, input, systemActor(scope), workerMeta()).then(
      (r) => r.output,
    );
  const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await rows<T>(d.admin, query))[0];
  const clock = async () =>
    (await one<{ at: string }>(
      sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,
    ))!.at;
  // The worker's loops, with the seed's stand-in model answering as Ava.
  const w = {
    ...d,
    worker: {
      ...d.worker,
      ai: { ...d.worker.ai, provider: scriptedAi(SEED_AI_RULES, { teammate: AVA_RULES }) },
    },
  };

  const calendarId = async (name: string) => {
    const c = await one<{ id: string }>(
      sql`select id from app.calendars where workspace_id = ${workspaceId} and name = ${name}`,
    );
    if (!c) throw new Error(`The calendar seed has no calendar ${name}.`);
    return c.id;
  };
  const tuneUp = await calendarId('AC tune-up');
  const walkthrough = await calendarId('Install walkthrough');
  const contacted = await one<{ id: string }>(
    sql`select s.id from app.pipeline_stages s join app.pipelines p on p.id = s.pipeline_id
        where s.workspace_id = ${workspaceId} and p.name = 'Sales' and s.name = 'Contacted'`,
  );
  if (!contacted) throw new Error('The CRM seed has no Sales pipeline with Contacted.');
  const people = await rows<{ id: string; name: string; phone: string | null }>(
    d.admin,
    sql`select id, btrim(first_name || ' ' || last_name) as name, phone_e164 as phone from app.people
        where workspace_id = ${workspaceId} and archived_at is null`,
  );
  const phoneOf = (name: string) => {
    const p = people.find((x) => x.name === name);
    if (!p?.phone) throw new Error(`The CRM seed has no customer ${name} with a phone.`);
    return p.phone;
  };

  d.step(
    'Lone Star: its open hours in Settings, which hand-offs quote (weekdays 7 to 6, Saturday 8 to noon)',
  );
  await as('dale', workspaceUpdate, {
    workspaceId,
    settings: {
      openHours: [
        ...[1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' })),
        { day: 6, start: '08:00', end: '12:00' },
      ],
    },
  });

  d.step(
    'Lone Star: Dale sets up "Ava" from the Appointment Coordinator preset; she says she’s AI when asked',
  );
  const { teammateId } = await as('dale', aiTeammateCreate, {
    workspaceId,
    preset: 'appointment_coordinator',
    name: 'Ava',
    disclosure: 'when_asked',
  });
  const got = await executeQuery(d.api, aiTeammateGet, { workspaceId }, d.actor(ws.dale), d.meta());
  if (!got.teammate) throw new Error('Ava was created, but ai_teammate.get finds no teammate.');
  let config = parseTeammateConfig(got.teammate.config);
  let revision = got.teammate.revision;
  const save = async (who: Who, patch: TeammatePatch) => {
    config = applyTeammatePatch(config, patch);
    ({ revision } = await as(who, aiTeammateSaveConfig, {
      workspaceId,
      teammateId,
      baseRevision: revision,
      config,
    }));
  };

  const site = new URL(LONE_STAR_WEBSITE).host.replace(/^www\./, '');
  d.step(
    `Lone Star: a website chat for ${site} (the stand-in site) in Lone Star’s red, answered by Ava`,
  );
  const widget = await as('dale', chatWidgetCreate, {
    workspaceId,
    allowedOrigins: [site],
    teammateId,
    greeting:
      'Hi, thanks for stopping by. Questions about heating, cooling or your roof? Ask here.',
    launcherLabel: 'Chat with us',
    accentColor: '#b42318',
    position: 'right',
    awayMessage:
      "Thanks for reaching out. We're not answering chats right now. Leave your details and we'll get back to you when we open.",
    askFor: { name: 'when_needed', phone: 'when_needed', email: 'never' },
    smsConsent: true,
    dailyCap: 200,
  });
  // The chat window opened on the site once: Settings shows it installed.
  await system(chatWidgetRecordSeen, {
    workspaceId,
    widgetId: widget.widgetId,
    origin: `https://${site}`,
  });

  d.step(
    'Lone Star: Dale puts Ava on texts and the website chat, booking AC tune-ups at any hour, with a day to OK each draft, and turns her on in training',
  );
  await save('dale', {
    identity: {
      toneNote: 'Friendly and short. Use first names. Say sorry once, not over and over.',
    },
    channels: { sms: true, email: false, chat: true, widgetId: widget.widgetId },
    book: { enabled: true, calendarIds: [tuneUp], reschedule: true, cancel: true },
    hours: { mode: 'always' },
    // A draft waits a day for an OK (the longest allowed) before a person gets the conversation, so Kendra's
    // reply below is still waiting in a demo later the same day.
    autonomy: { draftExpiresMinutes: 1440 },
  });
  await as('dale', aiTeammateSetStatus, { workspaceId, teammateId, status: 'training' });

  d.step(
    'Lone Star: Priya adds four qualifying questions and nudges, then "Insurance claims" and who hears of hand-offs',
  );
  await save('priya', {
    qualify: {
      enabled: true,
      questions: QUESTIONS,
      whenQualified: {
        stageId: contacted.id,
        notify: { kind: 'users', userIds: [ws.dale.id] },
        offerTimes: true,
      },
      whenNotAFit: { tellTeam: true },
    },
    followUp: { enabled: true, maxNudges: 2 },
  });
  await save('priya', {
    handOff: {
      sensitiveTopics: ['Insurance claims'],
      notify: { kind: 'users', userIds: [ws.dale.id, ws.priya.id] },
    },
  });

  d.step(
    'Lone Star: Dale adds the Install walkthrough to what Ava books, and rewords her hand-off line',
  );
  await save('dale', { book: { calendarIds: [tuneUp, walkthrough] } });
  await save('dale', {
    handOff: {
      tellCustomer:
        "Thanks for your patience. I've asked the team to take it from here, and {expectation}.",
    },
  });

  d.step(
    'Lone Star: customers text Ava and Angela Brooks chats on the site; Dale and Priya approve her drafts',
  );
  const anchor = await clock();
  const conversationOf = new Map<Thread, string>();
  const spans: Span[] = [];
  const chatThread = THREADS.find((th) => th.chat)!;
  const visitor = await system(chatVisitorStart, {
    workspaceId,
    widgetId: widget.widgetId,
    tokenHash: randomBytes(32).toString('hex'),
    pagePath: chatThread.chat!.page,
  });

  const pendingDrafts = async () =>
    new Map(
      (
        await rows<{ id: string; conversation_id: string; body: string | null }>(
          d.admin,
          sql`select id, conversation_id, preview #>> '{message,body}' as body from app.ai_teammate_drafts
              where workspace_id = ${workspaceId} and status = 'pending' and kind = 'reply'`,
        )
      ).map((r) => [r.conversation_id, r]),
    );
  const lastRun = async (conversationId: string) => {
    const r = await one<{
      status: string;
      outcome: string | null;
      summary: string | null;
      checks: string;
    }>(
      sql`select status, outcome, coalesce(error, summary) as summary, checks::text as checks
          from app.ai_teammate_runs where conversation_id = ${conversationId}
          order by started_at desc limit 1`,
    );
    return r ? `${r.status}/${r.outcome ?? '-'}: ${JSON.stringify(r)}` : 'no run';
  };

  const rounds = Math.max(...THREADS.map((th) => th.turns.length));
  for (let round = 0; round < rounds; round++) {
    const from = await clock();
    const active = THREADS.filter((th) => th.turns[round]);
    // The customers write, each in their own conversation.
    await Promise.all(
      active.map(async (th) => {
        const turn = th.turns[round]!;
        if (th.chat) {
          if (round === th.chat.identifyBefore)
            await system(chatIdentify, {
              workspaceId,
              visitorId: visitor.visitorId,
              name: th.chat.name,
              phone: th.chat.phone,
              smsConsent: true,
            });
          const said = await system(chatReceive, {
            workspaceId,
            visitorId: visitor.visitorId,
            body: turn.says,
            clientId: `seed-${randomUUID()}`,
            pagePath: th.chat.page,
          });
          conversationOf.set(th, said.conversationId);
        } else {
          const said = await system(messageReceive, {
            workspaceId,
            provider: 'fake' as const,
            providerMessageId: `SMseed${randomUUID().replace(/-/g, '')}`,
            from: phoneOf(th.customer),
            to: LONE_STAR_NUMBER,
            body: turn.says,
            occurredAt: new Date().toISOString(),
          });
          conversationOf.set(th, said.conversationId);
        }
      }),
    );
    // The messages land, and each conversation's reply waits out its debounce.
    await settle(w);
    // The replies run now instead, side by side, as the worker's machines would take them.
    const due = await rows<{ id: string }>(
      d.admin,
      sql`update app.scheduled_jobs set run_at = now(), locked_at = now(), locked_by = 'seed-ava:' || id::text
          where workspace_id = ${workspaceId} and kind = ${TEAMMATE_JOBS.reply} and status = 'pending'
          returning id`,
    );
    const ran = await Promise.all(
      due.map((job) =>
        processJobs({
          ...w.worker,
          jobs,
          workerId: `seed-ava:${job.id}`,
          batchSize: 1,
          reservedOnly: true,
        }),
      ),
    );
    if (ran.some((r) => r.retried + r.failed > 0))
      throw new Error('One of Ava’s replies failed (see last_error in app.scheduled_jobs).');
    await settle(w);

    const drafts = await pendingDrafts();
    await Promise.all(
      active.map(async (th) => {
        const turn = th.turns[round]!;
        const conversationId = conversationOf.get(th)!;
        const draft = drafts.get(conversationId);
        if (turn.reply) {
          const expected = th.chat ? turn.reply.trim() : plainSmsText(turn.reply);
          if (draft?.body !== expected)
            throw new Error(
              `Ava's draft for ${th.customer} should read "${expected}" but is ${JSON.stringify(draft?.body ?? null)}; ${await lastRun(conversationId)}`,
            );
          if (turn.approve)
            await as(turn.approve.by, aiTeammateDecideDraft, {
              workspaceId,
              draftId: draft.id,
              decision: 'approve',
              ...(turn.approve.edit ? { edits: { body: turn.approve.edit } } : {}),
            });
        } else if (draft)
          throw new Error(
            `Ava shouldn't have drafted for ${th.customer}; ${await lastRun(conversationId)}`,
          );
        if (turn.handOff) {
          const c = await one<{ note: string | null }>(
            sql`select handoff_note as note from app.conversations
              where id = ${conversationId} and needs_person_since is not null`,
          );
          if (c?.note !== turn.handOff)
            throw new Error(
              `Ava should have handed ${th.customer} to a person; ${await lastRun(conversationId)}`,
            );
        }
      }),
    );
    // Each approval goes out as Ava, with the approver's name on it.
    await settle(w);
    const [unsent] = await rows<{ n: number }>(
      d.admin,
      sql`select count(*)::int as n from app.ai_teammate_drafts d
          where d.workspace_id = ${workspaceId} and d.status = 'approved'
            and not exists (select 1 from app.messages m where m.ai_draft_id = d.id)`,
    );
    if (unsent?.n)
      throw new Error(
        `${unsent.n} approved draft(s) didn't go out (see the ai_teammate.send_draft jobs in app.scheduled_jobs).`,
      );
    const to = await clock();
    for (const th of active)
      spans.push({ conversationId: conversationOf.get(th)!, from, to, ago: th.turns[round]!.ago });
  }

  d.step('Lone Star: Dale joins Angela’s chat from “Needs a person”; she sees his reply');
  const chatId = conversationOf.get(chatThread)!;
  const joinedFrom = await clock();
  const joined = await as('dale', messageSend, {
    workspaceId,
    conversationId: chatId,
    channel: 'chat' as const,
    body: DALE_JOINS.body,
  });
  await settle(w);
  await system(chatMarkRead, {
    workspaceId,
    visitorId: visitor.visitorId,
    throughMessageId: joined.messageId,
  });
  // Nothing reports back from the stand-in carrier: Ava's texts are marked delivered, as the messaging seed does.
  const sending = await rows<{ id: string }>(
    d.admin,
    sql`select id from app.messages
        where workspace_id = ${workspaceId} and sent_by_teammate_id is not null and channel = 'sms'
          and status = 'sending'`,
  );
  await Promise.all(
    sending.map((m) =>
      system(messageUpdateStatus, { workspaceId, messageId: m.id, status: 'delivered' as const }),
    ),
  );
  await settle(w);
  spans.push({ conversationId: chatId, from: joinedFrom, to: await clock(), ago: DALE_JOINS.ago });

  d.step(
    'Lone Star: each of those conversations set back to when it happened, over the last six hours',
  );
  await backdate(d.admin, workspaceId, anchor, spans);

  const [ava] = await rows<{
    status: string;
    approved: number;
    edited: number;
    rejected: number;
    answered: number;
  }>(
    d.admin,
    sql`select t.status::text as status, t.approved_count as approved, t.edited_count as edited,
          t.rejected_count as rejected,
          (select count(distinct m.conversation_id)::int from app.messages m
            where m.sent_by_teammate_id = t.id and m.ai_draft_id is not null) as answered
        from app.ai_teammates t where t.id = ${teammateId}`,
  );
  const approvals = THREADS.flatMap((th) => th.turns.filter((t) => t.approve));
  const edits = approvals.filter((t) => t.approve?.edit).length;
  if (
    ava?.status !== 'training' ||
    ava.approved !== approvals.length ||
    ava.edited !== edits ||
    ava.rejected !== 0
  )
    throw new Error(
      `Ava should be in training at ${approvals.length} approved (${edits} edited): ${JSON.stringify(ava)}`,
    );
  return {
    name: config.identity.name,
    approved: ava.approved,
    edited: ava.edited,
    approvalsNeeded: config.autonomy.approvalsNeeded,
    answered: ava.answered,
    widgetKey: widget.publicKey,
    site,
    seconds: (Date.now() - started) / 1000,
  };
}
