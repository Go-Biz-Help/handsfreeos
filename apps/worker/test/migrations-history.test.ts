/**
 * The history, on the real database: conversations, messages, calls and voicemail (Phase 2 of the plan).
 *
 * The promise this suite exists to hold is the one a business actually cares about — that after the move,
 * opening a customer looks as though HandsFreeOS had been carrying their conversations all along:
 *
 *   - a text sent on a Tuesday afternoon in 2019 sits where a Tuesday afternoon in 2019 belongs;
 *   - two threads with the same customer on the same channel become one timeline, because that is what
 *     HandsFreeOS is, and the folding is said out loud rather than losing one of them;
 *   - a channel HandsFreeOS has no exact home for (WhatsApp) arrives readable, as a chat, and says so;
 *   - a message longer than the column holds keeps every character of itself;
 *   - a call keeps its length and its recording is copied here; a voicemail is marked as one;
 *   - the photo somebody texted in 2019 is held by this system, not linked to the old one, so the timeline
 *     still shows it after the old account is cancelled;
 *   - and the part that would be unforgivable to get wrong: **none of it is work.** No unread badge, no
 *     awaiting-reply clock, nothing queued to send, no AI teammate asked to answer five-year-old texts.
 *
 * The last spec takes it all back out again, because a business that changes its mind should not be left
 * paying to store the old system's photos for ever.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationRollback,
  migrationScan,
  migrationSelect,
  migrationStart,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createSealer } from '../src/crypto';
import {
  createMigrationAdapters,
  type MigrationAdapters,
} from '../src/migrations/adapters/registry';
import { activateConnection, sealTokens } from '../src/migrations/engine/connection';
import { processMigrationJobs } from '../src/migrations/engine/run';
import { standInMedia, type StandInMedia } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let organizationId: string;
let workspaceId: string;
let migrationId: string;
let adapters: MigrationAdapters;
let deps: Parameters<typeof processMigrationJobs>[0];
let media: StandInMedia;

/** A one-pixel JPEG and a second of silence: real bytes, small enough to keep in the test. */
const PHOTO = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/2gAMAwEAAhEDEQA/AP7+KKKKAP/Z',
  'base64',
);
const RECORDING = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000a recording', 'utf8');

const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actorOf(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actorOf(owner), meta()) as Promise<T>;

async function drain(limit = 400): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await admin().execute(
      sql`update app.migration_jobs set run_at = now()
          where migration_id = ${migrationId} and state in ('pending', 'retry') and run_at > now()`,
    );
    const [mine] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${migrationId} and state in ('leased', 'pending', 'retry')`,
    );
    if ((mine?.count ?? 0) === 0) return;
    await processMigrationJobs(deps);
  }
}

beforeAll(async () => {
  owner = await createTestUser('history-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  organizationId = output.organizationId;
  workspaceId = output.workspaceId;
  const sealer = createSealer(
    Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString(
      'base64',
    ),
  );
  adapters = createMigrationAdapters({
    live: false,
    goHighLevel: { clientId: '', clientSecret: '', configured: false },
  });
  media = standInMedia({
    'https://fake.invalid/media/msg_a1-unit.jpg': { bytes: PHOTO, contentType: 'image/jpeg' },
    // A second address, the same bytes: what the old system does when somebody sends a photo twice.
    'https://fake.invalid/media/msg_a4-unit.jpg': { bytes: PHOTO, contentType: 'image/jpeg' },
    'https://fake.invalid/recordings/cal_a1.mp3': {
      bytes: RECORDING,
      contentType: 'audio/mpeg',
    },
  });
  deps = {
    db: worker(),
    sealer,
    log: pino({ level: 'silent' }),
    adapters,
    store: media.store,
    fetchUrl: media.fetchUrl,
    workerId: `vitest-history-${process.pid}`,
    batchSize: 8,
  } as never;

  const connectionId = randomUUID();
  await asWorker(worker(), { organizationId }, async (tx) => {
    await tx.execute(sql`
      insert into app.migration_connections (id, organization_id, source_system, install_kind, status,
        token_enc, token_key_id, created_by)
      values (${connectionId}::uuid, ${organizationId}, 'gohighlevel', 'agency', 'pending',
        ${sealTokens(sealer, { accessToken: 'fake-not-a-real-token', refreshToken: null })},
        ${sealer.keyId}, ${owner.id}::uuid)`);
    await activateConnection(tx, {
      connectionId,
      organizationId,
      sourceSystem: 'gohighlevel',
      externalAccountId: 'fake-agency-history',
      displayName: 'Lone Star HVAC (agency)',
      installKind: 'agency',
      scopes: [
        'users.readonly',
        'tags.readonly',
        'customFields.readonly',
        'contacts.readonly',
        'opportunities.readonly',
        'products.readonly',
        'invoices.readonly',
        'payments/subscriptions.readonly',
        'calendars.readonly',
        'calendars/events.readonly',
        'conversations.readonly',
        'conversations/message.readonly',
      ],
      missingScopes: [],
      adapterVersion: 'fake-1',
    });
  });

  // Scan, put both sub-accounts in the one business, bring everything that can come.
  const created = await run<{ migrationId: string }>(migrationCreate, {
    organizationId,
    connectionId,
    name: 'Off GoHighLevel',
  });
  migrationId = created.migrationId;
  await run(migrationScan, { organizationId, migrationId });
  await drain();
  const scanned = await ask<{ scopes: { id: string }[] }>(migrationGet, {
    organizationId,
    migrationId,
  });
  await run(migrationMapScopes, {
    organizationId,
    migrationId,
    scopes: scanned.scopes.map((s) => ({ scopeId: s.id, workspaceId })),
  });
  await run(migrationSelect, {
    organizationId,
    migrationId,
    choices: [
      { category: 'contacts', selected: true },
      { category: 'tags', selected: true },
      { category: 'custom_fields', selected: true },
      { category: 'products', selected: true },
      { category: 'estimates', selected: true },
      { category: 'subscriptions', selected: true },
      { category: 'invoices', selected: true },
      { category: 'tasks', selected: true },
      { category: 'calendars', selected: true },
      { category: 'appointments', selected: true },
      { category: 'pipelines', selected: true },
      { category: 'opportunities', selected: true },
      { category: 'conversations', selected: true },
      { category: 'messages', selected: true },
      { category: 'calls', selected: true },
    ],
  });
  await run(migrationStart, { organizationId, migrationId, acknowledgedFindingIds: [] });
  await drain();
}, 180_000);

afterAll(async () => {
  await closeTestDbs();
});

const threads = () =>
  rows<{
    id: string;
    channel: string;
    counterpart: string;
    status: string;
    unread_count: number;
    last_message_at: Date | null;
    awaiting_reply_since: Date | null;
    handled_by: string;
    person_name: string | null;
  }>(
    admin(),
    sql`select c.id::text as id, c.channel::text as channel, c.counterpart, c.status::text as status,
          c.unread_count, c.last_message_at, c.awaiting_reply_since, c.handled_by::text as handled_by,
          p.first_name as person_name
        from app.conversations c left join app.people p on p.id = c.person_id
        where c.workspace_id = ${workspaceId}::uuid
        order by c.channel, c.counterpart`,
  );

describe('the history arrives as history', () => {
  it('brings every thread, on the channel it belongs to, attached to its customer', async () => {
    const list = await threads();
    expect(list.length).toBeGreaterThanOrEqual(4);
    const sms = list.filter((t) => t.channel === 'sms');
    const email = list.filter((t) => t.channel === 'email');
    const chat = list.filter((t) => t.channel === 'chat');
    expect(email.map((t) => t.counterpart)).toEqual([
      'dave.smith@example.com',
      'maria@example.com',
    ]);
    // A WhatsApp thread has no website visitor id, so it is addressed as one of its own rather than being
    // folded onto the customer's texts — where a reply would have gone out as a text they never asked for.
    // The Facebook message in Dave's mixed thread gets a chat thread of its own the same way.
    expect(chat).toHaveLength(2);
    expect(chat[0]!.counterpart).toMatch(/^chat:gohighlevel-cnv_a4/);
    expect(chat[1]!.counterpart).toMatch(/^chat:gohighlevel-cnv_a5-facebook/);
    // Every thread found the customer it belongs to rather than floating unattached.
    expect(list.every((t) => t.person_name !== null)).toBe(true);
    expect(sms.map((t) => t.counterpart)).toContain('+15125550101');
  }, 60_000);

  it('folds two threads with the same customer into one timeline, and says it did', async () => {
    const [dave] = await threads().then((l) =>
      l.filter((t) => t.counterpart === '+15125550101' && t.channel === 'sms'),
    );
    expect(dave).toBeTruthy();
    // Two source threads, five years apart, one thread here.
    const msgs = await rows<{ body_text: string; occurred_at: Date; direction: string }>(
      admin(),
      sql`select body_text, occurred_at, direction::text as direction from app.messages
          where conversation_id = ${dave!.id}::uuid order by occurred_at`,
    );
    expect(msgs.map((m) => m.body_text)).toEqual([
      'Our AC is making a grinding noise.',
      'We can be there Thursday at 9.',
      'Thursday works, thank you.',
      'Time for the annual service?',
      // From the third source thread, the mixed one: its text lands here with the others.
      'Can you send the invoice by email?',
    ]);
    // The dates are the old system's, not today's.
    expect(new Date(msgs[0]!.occurred_at).getUTCFullYear()).toBe(2019);
    expect(new Date(msgs[3]!.occurred_at).getUTCFullYear()).toBe(2024);
    // Inbound is what the customer said; the table's own rule is that those read as received.
    expect(msgs[0]!.direction).toBe('inbound');

    const got = await ask<{ findings: { code: string; whatChanges: string | null }[] }>(
      migrationGet,
      { organizationId, migrationId },
    );
    expect(got.findings.map((f) => f.code)).toContain('conversations.folded');
  }, 60_000);

  it('files each message of a mixed thread in the thread for its own channel', async () => {
    // GoHighLevel keeps one thread per customer with everything in it. Dave's has a text, an email, a
    // Facebook message and a dialer call: each has to land where it belongs, all of them on Dave.
    const list = await threads();
    const daves = list.filter((t) => t.person_name === 'Dave');
    const bodies = async (id: string) =>
      (
        await rows<{ body_text: string; subject: string | null }>(
          admin(),
          sql`select body_text, subject from app.messages where conversation_id = ${id}::uuid
              order by occurred_at`,
        )
      ).map((m) => [m.body_text, m.subject]);
    const email = daves.find((t) => t.channel === 'email')!;
    expect(email.counterpart).toBe('dave.smith@example.com');
    expect(await bodies(email.id)).toEqual([['Here is your invoice.', 'Your invoice']]);
    const facebook = daves.find((t) => t.counterpart.includes('cnv_a5-facebook'))!;
    expect(facebook.channel).toBe('chat');
    expect(await bodies(facebook.id)).toEqual([['Got it, thanks!', null]]);
    // The dialer call sits with his texts, on the number it was placed to.
    const [call] = await rows<{ counterpart: string; channel: string }>(
      admin(),
      sql`select c.counterpart, c.channel::text as channel from app.calls k
          join app.conversations c on c.id = k.conversation_id
          join app.migration_source_mappings m on m.target_id = k.id and m.source_object_id = 'cal_a3'`,
    );
    expect(call).toEqual({ counterpart: '+15125550101', channel: 'sms' });
  }, 60_000);

  it('keeps a channel it has no home for, and says what that means', async () => {
    const [whatsapp] = await threads().then((l) => l.filter((t) => t.channel === 'chat'));
    const msgs = await rows<{ body_text: string }>(
      admin(),
      sql`select body_text from app.messages where conversation_id = ${whatsapp!.id}::uuid`,
    );
    expect(msgs.map((m) => m.body_text)).toEqual(['Are you open Saturday?']);
    const got = await ask<{ findings: { code: string; summary: string }[] }>(migrationGet, {
      organizationId,
      migrationId,
    });
    const said = got.findings.find((f) => f.code === 'conversations.channel_narrowed');
    expect(said?.summary).toContain('whatsapp');
  }, 60_000);

  it('keeps every character of a message longer than a message here holds', async () => {
    const [long] = await rows<{ len: number; html_len: number }>(
      admin(),
      sql`select length(body_text) as len, length(body_html) as html_len from app.messages
          where workspace_id = ${workspaceId}::uuid and subject = 'Spring checklist'`,
    );
    expect(long!.len).toBe(10_000);
    // The whole thing is still there, in the body that has no limit.
    expect(long!.html_len).toBeGreaterThan(11_000);
  }, 60_000);

  it('brings calls with their length, and marks a voicemail as one', async () => {
    const list = await rows<{
      id: string;
      direction: string;
      duration_seconds: number | null;
      is_voicemail: boolean;
      transcript: string | null;
      provider_sid: string | null;
      started_at: Date;
    }>(
      admin(),
      sql`select id::text as id, direction::text as direction, duration_seconds, is_voicemail, transcript,
            provider_sid, started_at
          from app.calls where workspace_id = ${workspaceId}::uuid order by started_at`,
    );
    // Two from the phone system, and one placed from the dialer.
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({
      direction: 'outbound',
      duration_seconds: 214,
      is_voicemail: false,
    });
    expect(list[1]).toMatchObject({ direction: 'inbound', is_voicemail: true });
    expect(list[1]!.transcript).toContain('thermostat');
    expect(list[2]).toMatchObject({ direction: 'outbound', is_voicemail: false });
    // No carrier id: that column is unique across the whole database and holds a carrier's own id, so an
    // imported call leaves it empty and is traced through the migration's mapping instead.
    expect(list[0]!.provider_sid).toBeNull();
    expect(new Date(list[0]!.started_at).getUTCFullYear()).toBe(2019);

    // The recording was listed for copying while the old system's link still worked, and copied.
    const [recording] = await rows<{ state: string; object_path: string | null }>(
      admin(),
      sql`select state::text as state, object_path from app.migration_media
          where migration_id = ${migrationId}::uuid and source_object_type = 'call'`,
    );
    expect(recording!.state).toBe('stored');
    expect(recording!.object_path).toBe(`${workspaceId}/calls/${list[0]!.id}/recording.mp3`);
  }, 60_000);

  it('brings the board: the pipeline, its stages, and somewhere to win and lose', async () => {
    const stages = await rows<{ name: string; kind: string; position: number }>(
      admin(),
      sql`select s.name, s.kind::text as kind, s.position from app.pipeline_stages s
          join app.pipelines p on p.id = s.pipeline_id
          where p.workspace_id = ${workspaceId}::uuid and p.name like 'Sales (from%'
          order by s.position`,
    );
    // The three stages they had, in order, plus the two the old system kept on the deal instead.
    expect(stages.map((s) => s.name)).toEqual([
      'New enquiry',
      'Quote sent',
      'Scheduled',
      'Won',
      'Lost',
    ]);
    expect(stages.map((s) => s.kind)).toEqual(['open', 'open', 'open', 'won', 'lost']);
    const got = await ask<{ findings: { code: string; summary: string }[] }>(migrationGet, {
      organizationId,
      migrationId,
    });
    expect(got.findings.map((f) => f.code)).toContain('pipelines.stage_added');
    // The business already had an empty "Sales", so theirs came across beside it rather than into it.
    expect(got.findings.map((f) => f.code)).toContain('pipelines.named_beside');
  }, 60_000);

  it('brings the deals where they stood, worth what they were worth, won when they were won', async () => {
    const leads = await rows<{
      title: string;
      // `bigint` comes back as a string, which is right: cents can outgrow a float.
      value_cents: string;
      status: string;
      stage: string;
      won_at: Date | null;
      lost_at: Date | null;
      lost_reason: string | null;
      person: string | null;
      created_at: Date;
    }>(
      admin(),
      sql`select l.title, l.value_cents, l.status::text as status, s.name as stage, l.won_at, l.lost_at,
            l.lost_reason, p.first_name as person, l.created_at
          from app.leads l
          join app.pipeline_stages s on s.id = l.stage_id
          left join app.people p on p.id = l.person_id
          where l.workspace_id = ${workspaceId}::uuid order by l.created_at`,
    );
    expect(leads).toHaveLength(4);

    // Still open: the stage it was really in.
    const open = leads.find((l) => l.title === 'AC replacement')!;
    expect(open).toMatchObject({ status: 'open', stage: 'Quote sent' });
    expect(Number(open.value_cents)).toBe(420_000);
    expect(open.person).toBe('Dave');

    // Money crosses as whole cents, including the halves.
    const won = leads.find((l) => l.title === 'Annual plan')!;
    expect(Number(won.value_cents)).toBe(34_950);
    expect(won.status).toBe('won');
    // The day it was really won, not the day of the import. This is what the trigger change exists for.
    expect(new Date(won.won_at!).getUTCFullYear()).toBe(2021);

    const lost = leads.find((l) => l.title === 'Ducting quote')!;
    expect(lost.status).toBe('lost');
    expect(lost.lost_reason).toBe('Went with a cheaper quote');
    expect(new Date(lost.lost_at!).getUTCFullYear()).toBe(2022);

    // Abandoned over there is lost here, and says why rather than pretending somebody decided.
    const abandoned = leads.find((l) => l.title === 'Thermostat upgrade')!;
    expect(abandoned.status).toBe('lost');
    expect(abandoned.lost_reason).toContain('Abandoned in the old system');
  }, 60_000);

  it('brings the diary, with the calendar switched off until its hours are set', async () => {
    const [cal] = await rows<{
      name: string;
      status: string;
      is_public: boolean;
      config: Record<string, unknown>;
    }>(
      admin(),
      sql`select name, status::text as status, public as is_public, config from app.calendars
          where workspace_id = ${workspaceId}::uuid and name = 'Service visits'`,
    );
    expect(cal).toMatchObject({ status: 'draft', is_public: false });
    expect((cal!.config as { visit?: { minutes?: number } }).visit?.minutes).toBe(90);
    const got = await ask<{ findings: { code: string; recommendedAction: string | null }[] }>(
      migrationGet,
      { organizationId, migrationId },
    );
    const said = got.findings.find((f) => f.code === 'calendars.hours_not_brought');
    expect(said?.recommendedAction).toContain('set your hours');

    const visits = await rows<{
      title: string;
      status: string;
      starts_at: Date;
      minutes: number;
      attendee: string | null;
      notes: string | null;
    }>(
      admin(),
      sql`select a.title, a.status::text as status, a.starts_at,
            extract(epoch from (a.ends_at - a.starts_at))::int / 60 as minutes,
            p.first_name as attendee, a.notes
          from app.appointments a
          left join app.appointment_attendees at on at.appointment_id = a.id
          left join app.people p on p.id = at.person_id
          where a.workspace_id = ${workspaceId}::uuid order by a.starts_at`,
    );
    expect(visits).toHaveLength(4);
    // What happened, what nobody came to, what was called off — each kept as what it was.
    expect(visits.map((v) => v.status)).toEqual(['completed', 'no_show', 'cancelled', 'scheduled']);
    expect(new Date(visits[0]!.starts_at).getUTCFullYear()).toBe(2019);
    expect(visits[0]!.minutes).toBe(90);
    expect(visits[0]!.attendee).toBe('Dave');
    expect(visits[0]!.notes).toContain('Gate code');
    // And the one still ahead of them is in the diary, which is the point of bringing the future too.
    expect(new Date(visits[3]!.starts_at).getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it('brings what people wrote down, and what is still to do', async () => {
    const tasks = await rows<{
      title: string;
      notes: string | null;
      due_at: Date | null;
      done_at: Date | null;
      all_day: boolean;
      person: string | null;
    }>(
      admin(),
      sql`select t.title, t.notes, t.due_at, t.done_at, t.all_day, p.first_name as person
          from app.tasks t left join app.people p on p.id = t.person_id
          where t.workspace_id = ${workspaceId}::uuid order by t.created_at`,
    );
    expect(tasks.map((t) => t.title)).toEqual([
      'Send the renewal paperwork',
      'Order the replacement coil',
    ]);
    // The one that was finished is finished; the one that is not carries its due date and its detail.
    expect(tasks[0]!.done_at).not.toBeNull();
    const open = tasks[1]!;
    expect(open.done_at).toBeNull();
    expect(open.person).toBe('Dave');
    expect(open.notes).toContain('Carrier');
    // A due date with a time of day is not an all-day task.
    expect(open.all_day).toBe(false);

    // Notes land on the customer's own timeline, each at the time it was written — four years apart here,
    // which is history rather than a wall of text in one field.
    const notes = await rows<{ body: string; occurred_at: Date; kind: string; actor: string }>(
      admin(),
      sql`select a.body, a.occurred_at, a.kind::text as kind, a.actor_type::text as actor
          from app.activities a join app.people p on p.id = a.person_id
          where a.workspace_id = ${workspaceId}::uuid and a.kind = 'note'
          order by a.occurred_at`,
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]!.body).toContain('Dog in the back garden');
    expect(new Date(notes[0]!.occurred_at).getUTCFullYear()).toBe(2019);
    expect(new Date(notes[1]!.occurred_at).getUTCFullYear()).toBe(2023);
    // Never recorded as a person here writing it: the person who wrote it may have no account at all.
    expect(notes.every((n) => n.actor === 'integration')).toBe(true);
  }, 60_000);

  it('brings what was billed and what was paid, without chasing anybody', async () => {
    const invoices = await rows<{
      number: string | null;
      status: string;
      total_cents: string;
      paid_cents: string;
      balance_cents: string;
      paid_at: Date | null;
      sent_at: Date | null;
      quiet: string | null;
      person: string | null;
      lines: number;
    }>(
      admin(),
      sql`select i.number, i.status::text as status, i.total_cents, i.amount_paid_cents as paid_cents,
            i.balance_cents, i.paid_at, i.sent_at, i.reminder_state ->> 'imported' as quiet,
            p.first_name as person,
            (select count(*)::int from app.invoice_lines l where l.invoice_id = i.id) as lines
          from app.invoices i left join app.people p on p.id = i.person_id
          where i.workspace_id = ${workspaceId}::uuid order by i.created_at`,
    );
    // Two of the three: the one in Canadian dollars is refused out loud rather than stored as dollars.
    expect(invoices.map((i) => i.number)).toEqual(['INV-1041', 'INV-1120']);

    // Paid in full years ago, and the roll-up agrees: nothing owing.
    const paid = invoices[0]!;
    expect(paid.status).toBe('paid');
    expect(Number(paid.total_cents)).toBe(12_900);
    expect(Number(paid.balance_cents)).toBe(0);
    expect(new Date(paid.paid_at!).getUTCFullYear()).toBe(2019);

    // Half paid: the balance is what is still owed, worked out by the same roll-up a real payment uses.
    const half = invoices[1]!;
    expect(half.status).toBe('partly_paid');
    expect(Number(half.total_cents)).toBe(42_050);
    expect(Number(half.paid_cents)).toBe(20_000);
    expect(Number(half.balance_cents)).toBe(22_050);
    expect(half.lines).toBe(2);
    expect(half.person).toBe('Maria');

    // Chris's call: imported bills are quiet, so nobody is chased twice while the old system still is.
    expect(invoices.every((i) => i.quiet === 'quiet')).toBe(true);

    // The money that was taken is recorded, and is not something anybody here could refund: no provider.
    const payments = await rows<{
      method: string;
      provider: string | null;
      status: string;
      cents: string;
    }>(
      admin(),
      sql`select method::text as method, provider::text as provider, status::text as status,
            amount_cents as cents
          from app.payments where workspace_id = ${workspaceId}::uuid order by amount_cents`,
    );
    expect(payments).toHaveLength(2);
    expect(payments.every((p) => p.method === 'other' && p.provider === null)).toBe(true);
    expect(payments.every((p) => p.status === 'succeeded')).toBe(true);

    // And what they sell came with it, priced in whole cents.
    const products = await rows<{ name: string; unit_price_cents: string }>(
      admin(),
      sql`select name, unit_price_cents from app.products
          where workspace_id = ${workspaceId}::uuid order by unit_price_cents`,
    );
    expect(products.map((p) => p.name)).toEqual(['Service call', 'Replacement coil']);
    expect(Number(products[0]!.unit_price_cents)).toBe(12_900);

    const got = await ask<{ findings: { code: string }[] }>(migrationGet, {
      organizationId,
      migrationId,
    });
    expect(got.findings.map((f) => f.code)).toContain('invoices.currency_unsupported');
  }, 60_000);

  it('brings quotes as they were answered, and plans it will never charge', async () => {
    const quotes = await rows<{
      number: string | null;
      status: string;
      total_cents: string;
      accepted_via: string | null;
      accepted_name: string | null;
      quiet: string | null;
      lines: number;
    }>(
      admin(),
      sql`select e.number, e.status::text as status, e.total_cents, e.accepted_via, e.accepted_name,
            e.reminder_state ->> 'imported' as quiet,
            (select count(*)::int from app.estimate_lines l where l.estimate_id = e.id) as lines
          from app.estimates e where e.workspace_id = ${workspaceId}::uuid order by e.created_at`,
    );
    expect(quotes.map((q) => q.number)).toEqual(['EST-204', 'EST-311']);
    const accepted = quotes[0]!;
    expect(accepted.status).toBe('accepted');
    expect(Number(accepted.total_cents)).toBe(85_000);
    expect(accepted.lines).toBe(1);
    // Recorded as a yes somebody took, not as an Accept button that was never pressed here.
    expect(accepted.accepted_via).toBe('staff');
    expect(accepted.accepted_name).toBe('Dave Smith');
    // The one still out is quiet, so it is never nudged from here while the old system still does.
    expect(quotes[1]!.status).toBe('sent');
    expect(quotes.every((q) => q.quiet === 'quiet')).toBe(true);

    const plans = await rows<{
      plan_name: string;
      status: string;
      price_cents: string;
      next_billing_on: string | null;
      external: string | null;
    }>(
      admin(),
      sql`select plan_name, status::text as status, price_cents, next_billing_on::text as next_billing_on,
            external_subscription_id as external
          from app.subscriptions where workspace_id = ${workspaceId}::uuid order by created_at`,
    );
    expect(plans.map((p) => p.plan_name)).toEqual(['Maintenance plan', 'Filter club']);
    // Still running over there: recorded as not managed here, which is what stops anything charging it.
    expect(plans[0]).toMatchObject({ status: 'unmanaged' });
    expect(Number(plans[0]!.price_cents)).toBe(2_900);
    expect(plans[0]!.external).toBe('sub_a1');
    expect(plans[1]!.status).toBe('cancelled');

    const got = await ask<{ findings: { code: string; recommendedAction: string | null }[] }>(
      migrationGet,
      { organizationId, migrationId },
    );
    const said = got.findings.find((f) => f.code === 'subscriptions.billed_elsewhere');
    expect(said?.recommendedAction).toContain('cancel it over there');
  }, 60_000);

  it('lists what nobody can move for them, found in their own data', async () => {
    const tasks = await rows<{
      kind: string;
      label: string;
      state: string;
      blocks: boolean;
      instructions: string;
      settings_path: string | null;
    }>(
      admin(),
      sql`select kind::text as kind, label, state::text as state, blocks_live_use as blocks,
            instructions, settings_path
          from app.migration_reconnect_tasks where migration_id = ${migrationId}::uuid
          order by kind, label`,
    );
    const byKind = (k: string) => tasks.filter((t) => t.kind === k);

    // The number they rang customers from, found on an outbound call rather than asked for: GoHighLevel will
    // not list a sub-account's own numbers at all.
    const number = byKind('messaging')[0]!;
    expect(number.label).toBe('+15125550000');
    expect(number.instructions).toContain('the carrier ports it');
    // Their number and their money are the two things that stop them working as they expect.
    expect(number.blocks).toBe(true);

    // The domain they sent email from, found on an outbound email.
    const dns = byKind('dns')[0]!;
    expect(dns.label).toBe('lonestarhvac.example');
    expect(dns.settings_path).toBe('/settings/email');
    expect(dns.blocks).toBe(false);

    // Money moved somewhere, so somewhere has to be connected here. No key ever came across.
    const payments = byKind('payments')[0]!;
    expect(payments.blocks).toBe(true);
    expect(payments.instructions).toContain('not charged twice');

    // The visits arrived without the diaries behind them.
    expect(byKind('calendar')[0]!.label).toContain('calendar');

    // The inbox, which is not the same job as the domain: DNS makes their mail look like them, and does
    // nothing about where a customer's reply lands.
    const mailbox = byKind('mailbox')[0]!;
    expect(mailbox.instructions).toContain('when a customer hits reply');
    expect(mailbox.settings_path).toBe('/settings/mailboxes');

    expect(tasks.every((t) => t.state === 'todo')).toBe(true);
  }, 60_000);

  it('never turns history into work', async () => {
    // Not one badge, not one waiting clock, and no AI teammate handed a five-year-old text.
    const list = await threads();
    expect(list.every((t) => t.unread_count === 0)).toBe(true);
    expect(list.every((t) => t.awaiting_reply_since === null)).toBe(true);
    expect(list.every((t) => t.handled_by === 'none')).toBe(true);
    // Nothing queued to go out: no message is sitting in a sendable state.
    // Not one reminder armed, for the visit still ahead of them least of all: the old system is the one
    // texting about it until they switch that off, and two texts about one visit is the worst outcome here.
    const [reminders] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.scheduled_jobs
          where workspace_id = ${workspaceId}::uuid and kind::text like 'appointment%'`,
    );
    expect(reminders!.count).toBe(0);
    const [queued] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.messages
          where workspace_id = ${workspaceId}::uuid and status in ('queued', 'sending')`,
    );
    expect(queued!.count).toBe(0);
    // And nothing is queued to chase a bill or nudge a quote either: the money jobs see them as quiet.
    const [moneyJobs] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.scheduled_jobs
          where workspace_id = ${workspaceId}::uuid
            and (kind::text like 'invoice%' or kind::text like 'estimate%'
                 or kind::text like 'subscription%')`,
    );
    expect(moneyJobs!.count).toBe(0);
    // And the thread's own summary follows its newest message, as it would have if it happened here.
    const [dave] = list.filter((t) => t.counterpart === '+15125550101');
    expect(new Date(dave!.last_message_at!).getUTCFullYear()).toBe(2024);
  }, 60_000);
});

/**
 * The files, which are the part of a move that quietly fails.
 *
 * Everything else can be copied as words in a database. A photo cannot: what the old system hands over is a
 * link to its own storage, which needs its own sign-in and dies with the account. A migration that keeps
 * those links looks perfect on the day and shows a page of broken pictures the week after the business
 * cancels — so the test is never "is there a link", it is "do we hold the bytes".
 */
describe('the files come too, and they are ours', () => {
  it('holds the photo somebody texted, instead of borrowing it from the old system', async () => {
    const [text] = await rows<{
      id: string;
      body_text: string | null;
      media: { bucket: string; objectPath: string; contentType: string; name: string }[];
    }>(
      admin(),
      sql`select id::text as id, body_text, media from app.messages
          where workspace_id = ${workspaceId}::uuid and body_text like 'Our AC%'`,
    );
    expect(text!.media).toHaveLength(1);
    const photo = text!.media[0]!;
    expect(photo.bucket).toBe('telephony');
    // Inside this business's own folder. Which message's folder is not fixed: the same photo arrived on two
    // of them, and one copy is kept for both, under whichever of them was copied first.
    expect(photo.objectPath.startsWith(`${workspaceId}/messages/`)).toBe(true);
    expect(photo.objectPath.endsWith('.jpg')).toBe(true);
    expect(photo.contentType).toBe('image/jpeg');
    expect(photo.name).toBe('photo.jpg');
    // Nothing anywhere in the timeline still points at the old system's storage.
    expect(JSON.stringify(text!.media)).not.toContain('fake.invalid');

    // And the bytes really are in our storage, the same ones the old system had.
    const held = await media.store.download(photo.bucket, photo.objectPath);
    expect(held.equals(PHOTO)).toBe(true);
  }, 60_000);

  it('asks the old system with the sign-in it wants, and only when it wants one', async () => {
    const recording = media.asked.find((a) => a.url.endsWith('cal_a1.mp3'));
    const photo = media.asked.find((a) => a.url.endsWith('msg_a1-unit.jpg'));
    expect(recording).toBeTruthy();
    expect(photo).toBeTruthy();
    // The stand-in source is not HighLevel, so neither needs a token; what matters is that the copier sends
    // whatever the adapter says and nothing it does not.
    expect(photo!.headers).toEqual({});
  }, 60_000);

  it('stores the same photo once, however many messages it arrived on', async () => {
    const both = await rows<{ id: string; media: { objectPath: string }[] }>(
      admin(),
      sql`select id::text as id, media from app.messages
          where workspace_id = ${workspaceId}::uuid and jsonb_array_length(media) > 0
          order by occurred_at`,
    );
    expect(both).toHaveLength(2);
    // Two messages, two references, one object.
    expect(both[0]!.media[0]!.objectPath).toBe(both[1]!.media[0]!.objectPath);
    const paths = [...media.uploads.keys()].filter((k) => k.endsWith('.jpg'));
    expect(paths).toHaveLength(1);
  }, 60_000);

  it('says how many files are here, and the checks agree', async () => {
    const files = await rows<{ state: string; count: number }>(
      admin(),
      sql`select state::text as state, count(*)::int as count from app.migration_media
          where migration_id = ${migrationId}::uuid group by state`,
    );
    // Three listed — two photos and a recording — and every one of them copied.
    expect(files).toEqual([{ state: 'stored', count: 3 }]);

    const [check] = await rows<{
      result: string;
      expected_count: number | null;
      actual_count: number | null;
      summary: string;
    }>(
      admin(),
      sql`select result::text as result, expected_count, actual_count, summary
          from app.migration_verifications
          where migration_id = ${migrationId}::uuid and kind = 'media'`,
    );
    expect(check!.result).toBe('passed');
    expect(Number(check!.expected_count)).toBe(3);
    expect(Number(check!.actual_count)).toBe(3);
    expect(check!.summary).toContain('kept here');
  }, 60_000);

  it('says plainly when the old system has lost a file, rather than showing a broken picture', async () => {
    // A file the old system listed and can no longer produce: the copier is told 404 and says so.
    const [thread] = await rows<{ id: string }>(
      admin(),
      sql`select id::text as id from app.messages
          where workspace_id = ${workspaceId}::uuid and body_text like 'Thursday works%'`,
    );
    const [where] = await rows<{ scope_id: string }>(
      admin(),
      sql`select scope_id::text as scope_id from app.migration_media
          where migration_id = ${migrationId}::uuid and source_object_type = 'message' limit 1`,
    );
    await asWorker(worker(), { workspaceId, organizationId }, (tx) =>
      tx.execute(sql`
        insert into app.migration_media (migration_id, organization_id, scope_id, workspace_id,
          source_object_type, source_object_id, source_locator, declared_mime, state)
        values (${migrationId}::uuid, ${organizationId}::uuid, ${where!.scope_id}::uuid,
          ${workspaceId}::uuid, 'message', 'msg_a3',
          'https://fake.invalid/media/gone.jpg', 'image/jpeg', 'pending')`),
    );
    await asWorker(worker(), { organizationId }, (tx) =>
      tx.execute(sql`
        insert into app.migration_jobs (migration_id, organization_id, scope_id, workspace_id, kind,
          category, pass, input)
        values (${migrationId}::uuid, ${organizationId}::uuid, ${where!.scope_id}::uuid,
          ${workspaceId}::uuid, 'media', 'media', 7, '{}'::jsonb)`),
    );
    await drain();

    const [gone] = await rows<{ state: string; last_error: string | null }>(
      admin(),
      sql`select state::text as state, last_error from app.migration_media
          where migration_id = ${migrationId}::uuid and source_object_id = 'msg_a3'`,
    );
    expect(gone!.state).toBe('missing');
    expect(gone!.last_error).toContain('no longer has this file');
    // And the message it belonged to shows no attachment at all, rather than one that will not load.
    const [message] = await rows<{ media: unknown[] }>(
      admin(),
      sql`select media from app.messages where id = ${thread!.id}::uuid`,
    );
    expect(message!.media).toEqual([]);
  }, 60_000);

  it('takes the history back out again, files and all', async () => {
    // Last in the file on purpose: this empties the inbox the tests above read. A rollback that left the
    // photos and recordings in storage would be paying for a business's old system for ever, and the bytes
    // are only removable while nothing here points at them — which, once the texts and calls have gone,
    // nothing does.
    expect(media.uploads.size).toBeGreaterThan(0);
    await run(migrationRollback, { organizationId, migrationId, confirm: true });
    await drain();

    const [left] = await rows<{ messages: number; calls: number; stored: number }>(
      admin(),
      sql`select
            (select count(*)::int from app.messages
              where workspace_id = ${workspaceId}::uuid) as messages,
            (select count(*)::int from app.calls
              where workspace_id = ${workspaceId}::uuid) as calls,
            (select count(*)::int from app.migration_media
              where migration_id = ${migrationId}::uuid and state = 'stored') as stored`,
    );
    expect(left).toEqual({ messages: 0, calls: 0, stored: 0 });
    expect([...media.uploads.keys()]).toEqual([]);
  }, 120_000);
});
