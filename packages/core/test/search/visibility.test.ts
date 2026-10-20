/**
 * Who sees what in a search (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Who can see what"), on the local database:
 *
 *   - A staff view-as: nobody holds a permission there, so the gates are skipped and row security alone decides;
 *     the bin needs Delete for good in the database too, so it comes back empty, and private mail stays hidden.
 *   - A teammate view: the teammate's own permissions, Only mine is theirs, and their own mail stays hidden.
 *   - A person's own mailbox: found by them, marked "My mail", and by nobody else, an owner included.
 *   - A money member finds only the bills of jobs they're on, by number and by amount.
 *   - A private deal, and its tasks, notes, files and portal thread, are found by its team and nobody else.
 *   - Other mail is badged, calls in it too; a cancelled held text, an unanswered bridge call and an internal
 *     meeting's AI summary are never found.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand, executeQuery } from '../../src/kernel/execute';
import type { RequestMeta } from '../../src/kernel/types';
import {
  callSuggestionRecord,
  permissionSetMember,
  platformViewAsEnd,
  platformViewAsStart,
  searchEverything,
  searchKind,
  teammateViewEnd,
  teammateViewStart,
} from '../../src/server';
import { installRealestate } from '../addons/realestate-fixture';
import { human } from '../calendar-helpers';
import {
  admin,
  allTitles,
  everything,
  groupOf,
  moreOfTheBoards,
  oneKind,
  run,
  runSystem,
  searchWorld,
  titles,
  type World,
} from './helpers';

let w: World;
let m: Record<string, string>;
/** Mike's own mailbox thread: his alone (M19). */
let myMail: string;

const one = async (query: ReturnType<typeof sql>): Promise<string> =>
  (await rows<{ id: string }>(admin(), query))[0]!.id;

beforeAll(async () => {
  w = await searchWorld('search-seen');
  m = await moreOfTheBoards(w);
  myMail = await one(
    sql`insert into app.conversations (workspace_id, channel, counterpart, last_message_at, private_to)
        values (${w.wsId}, 'email', 'orders@parts-supply.example', now(), ${w.member.id}) returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, subject, body_text)
        values (${w.wsId}, ${myMail}, 'email', 'inbound', 'received', 'Your order',
          'Mymailword: your valves ship Friday')`,
  );
});
afterAll(closeTestDbs);

const meta = (viewAs?: string): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'test',
  ...(viewAs ? { viewAs } : {}),
});

describe('a staff view-as', () => {
  let staff: TestUser;
  beforeAll(async () => {
    staff = await createTestUser('search-seen-staff');
    await rows(
      admin(),
      sql`insert into platform.staff (user_id, role) values (${staff.id}, 'agent')
          on conflict (user_id) do update set role = 'agent', status = 'active'`,
    );
    await executeCommand(
      testDbs().api.db,
      platformViewAsStart,
      { workspaceId: w.wsId, reason: 'Checking why search finds nothing for them', minutes: 15 },
      human(staff),
      meta(),
    );
  });
  afterAll(async () => {
    await executeCommand(testDbs().api.db, platformViewAsEnd, {}, human(staff), meta());
  });

  it('skips the gates, so row security alone decides, and the bin comes back empty', async () => {
    const ask = (q: string) =>
      executeQuery(
        testDbs().api.db,
        searchEverything,
        { workspaceId: w.wsId, q },
        human(staff),
        meta(),
      );
    const a = await ask('smith');
    expect(titles(groupOf(a, 'contacts')).length).toBeGreaterThan(0);
    expect(titles(groupOf(a, 'record.pets'))).toEqual(['Rex Smith']);
    expect(a.bin).toBeNull();
    expect(groupOf(await ask('leaking'), 'messages')).toBeDefined();
    expect(groupOf(await ask('gate code'), 'notes')).toBeDefined();
    // Someone's own mail is theirs alone, through any view.
    expect(allTitles(await ask('mymailword'))).toEqual([]);
    const bin = await executeQuery(
      testDbs().api.db,
      searchKind,
      { workspaceId: w.wsId, q: 'smith', kind: 'bin' },
      human(staff),
      meta(),
    );
    expect(bin.group.items).toEqual([]);
  });
});

describe('a teammate view', () => {
  it('searches with the teammate’s own permissions, and Only mine is theirs', async () => {
    await run(
      permissionSetMember,
      { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: false },
      w.owner,
    );
    const { view } = await run(
      teammateViewStart,
      { workspaceId: w.wsId, userId: w.member.id },
      w.owner,
    );
    try {
      const asMember = (q: string, more: Record<string, unknown> = {}) =>
        executeQuery(
          testDbs().api.db,
          searchEverything,
          { workspaceId: w.wsId, q, ...more },
          human(w.owner),
          meta(view.id),
        );
      expect(groupOf(await asMember('LS-0042'), 'money')).toBeUndefined();
      expect(groupOf(await everything(w, w.owner, 'LS-0042'), 'money')).toBeDefined();
      const mine = await asMember('smith', { onlyMine: true });
      expect(titles(groupOf(mine, 'contacts'))).toEqual(['Dana Smith']);
      // The teammate's own mail stays theirs, even to the owner viewing as them.
      expect(allTitles(await asMember('mymailword'))).toEqual([]);
    } finally {
      await run(teammateViewEnd, { viewId: view.id }, w.owner);
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: null },
        w.owner,
      );
    }
  });
});

describe('a person’s own mailbox', () => {
  it('is found by them, marked My mail, and by nobody else', async () => {
    const mine = groupOf(await everything(w, w.member, 'mymailword'), 'messages')!;
    expect(mine.items[0]).toMatchObject({
      id: myMail,
      title: 'Email · orders@parts-supply.example',
    });
    expect(mine.items[0]!.badges).toContain('my_mail');
    for (const u of [w.owner, w.marco])
      expect(allTitles(await everything(w, u, 'mymailword'))).toEqual([]);
  });
});

describe('the inbox’s own rules', () => {
  it('badges Other mail, a call in it too', async () => {
    await rows(
      admin(),
      sql`insert into app.calls (workspace_id, conversation_id, direction, from_e164, to_e164, status, transcript)
          values (${w.wsId}, ${m.kimMail}, 'inbound', '+15045550142', '+15045550000', 'completed',
            'Othermailcall about the certificate')`,
    );
    const call = groupOf(await everything(w, w.owner, 'othermailcall'), 'messages')!;
    expect(call.items[0]).toMatchObject({ id: m.kimMail, why: { field: 'call' } });
    expect(call.items[0]!.badges).toContain('other_mail');
  });

  it('never finds a cancelled held text or an unanswered bridge call', async () => {
    for (const q of ['heldback', 'unansweredbridge']) {
      expect(allTitles(await everything(w, w.owner, q)), q).toEqual([]);
      expect(titles((await oneKind(w, w.owner, q, 'messages')).group), q).toEqual([]);
    }
  });

  it('never finds an internal meeting’s AI summary: with no customer it makes no note', async () => {
    const meeting = await one(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
          values (${w.wsId}, ${m.calendar}, 1, 'Team huddle', now() - interval '2 hours', now() - interval '1 hour')
          returning id`,
    );
    const transcript = await one(
      sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
          values (${w.wsId}, ${meeting}, 'zoom', ${randomUUID()}, 'Dale: payroll is late') returning id`,
    );
    const done = await runSystem(
      callSuggestionRecord,
      {
        workspaceId: w.wsId,
        appointmentId: meeting,
        transcriptId: transcript,
        review: { summary: 'Huddleword: payroll goes out Monday.' },
      },
      w.scope,
    );
    expect(done.noted).toBe(false);
    for (const u of [w.owner, w.member])
      expect(allTitles(await everything(w, u, 'huddleword'))).toEqual([]);
  });
});

describe('a money member', () => {
  it('finds only the bills of jobs they’re on, by number and by amount', async () => {
    // The member is Dana's owner, so Dana's bills are theirs; Marcus's aren't.
    expect(groupOf(await everything(w, w.member, '2026-1042'), 'money')).toBeUndefined();
    expect(groupOf(await everything(w, w.member, '$1,280'), 'money')).toBeUndefined();
    expect(titles(groupOf(await everything(w, w.member, 'LS-0042'), 'money'))).toEqual([
      'Estimate #LS-0042',
    ]);
    expect(titles(groupOf(await everything(w, w.member, '$999'), 'money'))).toEqual([
      'Estimate #LS-0042',
    ]);
    expect(titles(groupOf(await everything(w, w.owner, '2026-1042'), 'money'))[0]).toBe(
      'Invoice #2026-1042',
    );
    // A member who isn't on any of these jobs finds no money at all.
    expect(groupOf(await everything(w, w.marco, 'smith'), 'money')).toBeUndefined();
  });
});

describe('a private deal', () => {
  it('is found by its team, and by nobody off it', async () => {
    await installRealestate(w.wsId);
    await rows(
      admin(),
      sql`insert into app.custom_records (workspace_id, type_id, name, kept_to_team, owner_user_id, team_user_ids)
          select ${w.wsId}, t.id, 'Pelican Court purchase', true, ${w.priya.id}, array[${w.marco.id}]::uuid[]
          from app.custom_record_types t where t.workspace_id = ${w.wsId} and t.key = 'realestate_deal'`,
    );
    // Real Estate answers for its deals (Search 4b), for its team only; core's group steps aside.
    for (const u of [w.priya, w.marco]) {
      const a = await everything(w, u, 'pelican');
      expect(titles(groupOf(a, 'realestate.deals'))).toEqual(['Pelican Court purchase']);
      expect(groupOf(a, 'record.realestate_deal')).toBeUndefined();
    }
    expect((await everything(w, w.member, 'pelican')).groups).toEqual([]);
    expect(titles(groupOf(await everything(w, w.member, 'pelcian'), 'close'))).toEqual([]);
  });

  it('keeps what hangs off it to its team: tasks, notes, files and its portal thread', async () => {
    const [deal] = await rows<{ id: string }>(
      admin(),
      sql`select r.id from app.custom_records r where r.workspace_id = ${w.wsId} and r.name = 'Pelican Court purchase'`,
    );
    const on = deal!.id;
    await rows(
      admin(),
      sql`insert into app.tasks (workspace_id, title, custom_record_id, created_by)
          values (${w.wsId}, 'Pelicantask order the appraisal', ${on}, ${w.priya.id})`,
    );
    await rows(
      admin(),
      sql`insert into app.activities (workspace_id, kind, body, custom_record_id, actor_type)
          values (${w.wsId}, 'note', 'Pelicannote seller is flexible', ${on}, 'human')`,
    );
    await rows(
      admin(),
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status)
          values (${w.wsId}, 'custom_record', ${on}, ${`${w.wsId}/${randomUUID()}`}, 'Pelicanfile offer.pdf', 'ready')`,
    );
    const portal = await one(
      sql`insert into app.conversations (workspace_id, channel, counterpart, last_message_at, custom_record_id)
          values (${w.wsId}, 'portal', ${`portal:${randomUUID()}`}, now(), ${on}) returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          values (${w.wsId}, ${portal}, 'portal', 'inbound', 'received', 'Pelicanportal can we close early?')`,
    );
    const kinds = [
      ['pelicantask', 'tasks'],
      ['pelicannote', 'notes'],
      ['pelicanfile', 'files'],
      ['pelicanportal', 'messages'],
    ] as const;
    for (const [q, kind] of kinds) {
      expect(groupOf(await everything(w, w.priya, q), kind), q).toBeDefined();
      expect(allTitles(await everything(w, w.member, q)), q).toEqual([]);
      expect(titles((await oneKind(w, w.member, q, kind)).group), q).toEqual([]);
    }
  });
});
