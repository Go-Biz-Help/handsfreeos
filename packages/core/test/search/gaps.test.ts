/**
 * The gaps row security leaves, and how search closes each (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Who can see
 * what"), on the local database as different people. One case per gap:
 *
 *   1. A permission the business takes away closes its kind, though row security alone would still show its rows:
 *      Money, the Deleted bin, and Messages and Spam without Use the inbox.
 *   2. A narrowed inbox: a word only in a thread the member isn't on is found neither in Messages nor in Notes.
 *   3. Timeline copies of texts, emails and calls never show in Notes; imported notes, logged calls and the AI's call
 *      summaries do.
 *   4. A form response in the Deleted bin takes its answers with it.
 *   5. Port papers are never found, by anyone.
 *   6. A turned-off add-on's kinds of records hide with it, and so does everything on its records: tasks, notes,
 *      files, appointments, threads and their calls; all come back when it's on.
 *   7. Customers in the bin, erased names and merged shells never show, nor lead anywhere; one found in the bin by
 *      name is listed there, with no close match over them.
 *   8. The AI's summary of a tour on a private deal is sealed with the deal, and so is a task approved from it: its
 *      people find them, nobody else does. A meeting on a record in the bin still keeps its summary and suggestions.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  binRestore,
  callSuggestionDecide,
  callSuggestionRecord,
  customRecordDelete,
  inboxSetVisibility,
  permissionSetMember,
  personDelete,
} from '../../src/server';
import { installRealestate } from '../addons/realestate-fixture';
import {
  admin,
  allTitles,
  everything,
  expectHfos,
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
beforeAll(async () => {
  w = await searchWorld('search-gaps');
  m = await moreOfTheBoards(w);
});

/** One row's id from an insert. */
const one = async (query: ReturnType<typeof sql>): Promise<string> =>
  (await rows<{ id: string }>(admin(), query))[0]!.id;
afterAll(closeTestDbs);

describe('1. a permission the business takes away', () => {
  it('closes its kind for that person, and search.kind refuses it with search_kind_not_allowed', async () => {
    expect(groupOf(await everything(w, w.member, 'LS-0042'), 'money')).toBeDefined();
    await run(
      permissionSetMember,
      { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: false },
      w.owner,
    );
    try {
      const a = await everything(w, w.member, 'smith');
      expect(groupOf(a, 'money')).toBeUndefined();
      expect(groupOf(a, 'contacts')).toBeDefined();
      const e = await expectHfos(
        () => oneKind(w, w.member, 'smith', 'money'),
        'search_kind_not_allowed',
        403,
      );
      expect(e.message).toMatch(
        /You need the “.+” permission for that\. An owner of this business can turn it on/,
      );
      // A chip asked for by name is still gated.
      expect((await everything(w, w.member, 'smith', { kinds: ['money'] })).groups).toEqual([]);
    } finally {
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission: 'money.read', allowed: null },
        w.owner,
      );
    }
  });
});

describe('1. Use the inbox taken away', () => {
  it('closes Messages and Spam for that person, and search.kind refuses them', async () => {
    expect(groupOf(await everything(w, w.member, 'leaking'), 'messages')).toBeDefined();
    await run(
      permissionSetMember,
      { workspaceId: w.wsId, userId: w.member.id, permission: 'inbox.use', allowed: false },
      w.owner,
    );
    try {
      for (const q of ['leaking', '(504) 555-0142', 'beatrice', 'pilot light'])
        expect(groupOf(await everything(w, w.member, q), 'messages'), q).toBeUndefined();
      expect((await everything(w, w.member, 'robocall', { kinds: ['spam'] })).groups).toEqual([]);
      for (const kind of ['messages', 'spam'])
        await expectHfos(
          () => oneKind(w, w.member, 'leaking', kind),
          'search_kind_not_allowed',
          403,
        );
    } finally {
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission: 'inbox.use', allowed: null },
        w.owner,
      );
    }
  });
});

describe('2. a narrowed inbox', () => {
  it('keeps a hidden thread’s words out of Messages and of Notes, and finds the member’s own', async () => {
    // Kim's email is Priya's to answer, and reached Kim's timeline as a copy, which the whole business reads (0083).
    await rows(
      admin(),
      sql`update app.conversations set assignee_user_id = ${w.priya.id} where id = ${m.kimMail}`,
    );
    await rows(
      admin(),
      sql`insert into app.activities (workspace_id, kind, subtype, body, person_id, actor_type)
          values (${w.wsId}, 'email', 'inbound', 'Attached is the backflow certificate for building 2.',
            ${w.ids.kim}, 'human')`,
    );
    await run(inboxSetVisibility, { workspaceId: w.wsId, perPerson: true }, w.owner);
    try {
      const hidden = await everything(w, w.member, 'certificate');
      expect(groupOf(hidden, 'messages')).toBeUndefined();
      expect(groupOf(hidden, 'notes')).toBeUndefined();
      // The member is on Dana's thread.
      expect(titles(groupOf(await everything(w, w.member, 'leaking'), 'messages'))).toEqual([
        'Text from Dana Smith',
      ]);
      // The owner sees the whole inbox.
      expect(groupOf(await everything(w, w.owner, 'certificate'), 'messages')).toBeDefined();
    } finally {
      await run(inboxSetVisibility, { workspaceId: w.wsId, perPerson: false }, w.owner);
    }
  });
});

describe('3. timeline copies', () => {
  it('never shows a text, email or call copy, a file added or an intake line in Notes', async () => {
    for (const q of ['smscopyword', 'callcopyword', 'fileaddedword', 'intakeword'])
      expect(allTitles(await everything(w, w.owner, q)), q).toEqual([]);
  });

  it('shows imported notes, logged calls and the AI’s call summaries', async () => {
    for (const [q, id] of [
      ['prefers morning', m.imported],
      ['furnace filter', m.loggedCall],
      ['duct quote', m.summary],
    ] as const)
      expect(groupOf(await everything(w, w.owner, q), 'notes')?.items[0]?.id, q).toBe(id);
  });
});

describe('4. a form response in the bin', () => {
  it('takes its answers with it, and Bring back brings them back', async () => {
    const person = await one(
      sql`insert into app.people (workspace_id, first_name, last_name)
          values (${w.wsId}, 'Wendell', 'Ashby') returning id`,
    );
    const [version] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.form_versions where form_id = ${m.form}`,
    );
    const response = await one(
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, person_id, completed_at)
          values (${w.wsId}, ${m.form}, ${version!.id}, 'completed', ${person}, now()) returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title,
            question_type, text_value)
          values (${w.wsId}, ${response}, ${m.form}, 'q_binned01', 'Anything else?', 'short_text',
            'Binnedanswerword please')`,
    );
    expect(titles(groupOf(await everything(w, w.owner, 'binnedanswerword'), 'forms'))).toEqual([
      'Water heater survey',
    ]);
    const { deleted } = await run(
      personDelete,
      { workspaceId: w.wsId, personIds: [person] },
      w.owner,
    );
    expect(groupOf(await everything(w, w.owner, 'binnedanswerword'), 'forms')).toBeUndefined();
    await run(binRestore, { workspaceId: w.wsId, binItemId: deleted[0]!.binItemId }, w.owner);
    expect(groupOf(await everything(w, w.owner, 'binnedanswerword'), 'forms')).toBeDefined();
  });
});

describe('5. port papers', () => {
  it('are never found by name, by a member or an owner', async () => {
    for (const u of [w.owner, w.member]) {
      expect(groupOf(await everything(w, u, 'loa signed'), 'files')).toBeUndefined();
      expect(titles((await oneKind(w, u, 'loa signed', 'files')).group)).toEqual([]);
    }
  });
});

describe('6. a turned-off add-on', () => {
  it('hides its kinds of records, and what hangs off them, and they come back when it’s on; nothing errors', async () => {
    await installRealestate(w.wsId);
    const record = (key: string, name: string) =>
      one(sql`insert into app.custom_records (workspace_id, type_id, name, kept_to_team, owner_user_id)
              select ${w.wsId}, t.id, ${name}, ${key === 'realestate_deal'},
                ${key === 'realestate_deal' ? w.owner.id : null}
              from app.custom_record_types t
              where t.workspace_id = ${w.wsId} and t.key = ${key}
              returning id`);
    const property = await record('realestate_property', '77 Bayou Road');
    const deal = await record('realestate_deal', 'Lafitte Street sale');
    // On the property: a task, a note and a file. On the deal: a tour and its portal thread, with a call in it.
    await rows(
      admin(),
      sql`insert into app.tasks (workspace_id, title, custom_record_id, created_by)
          values (${w.wsId}, 'Lockboxword for the front door', ${property}, ${w.owner.id})`,
    );
    await rows(
      admin(),
      sql`insert into app.activities (workspace_id, kind, body, custom_record_id, actor_type)
          values (${w.wsId}, 'note', 'Termiteword inspection passed', ${property}, 'human')`,
    );
    await rows(
      admin(),
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status)
          values (${w.wsId}, 'custom_record', ${property}, ${`${w.wsId}/${randomUUID()}`}, 'Surveyword.pdf', 'ready')`,
    );
    await rows(
      admin(),
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
            custom_record_id)
          values (${w.wsId}, ${m.calendar}, 1, 'Showingword tour', now() + interval '1 day',
            now() + interval '25 hours', ${deal})`,
    );
    const portal = await one(
      sql`insert into app.conversations (workspace_id, channel, counterpart, last_message_at, custom_record_id)
          values (${w.wsId}, 'portal', ${`portal:${randomUUID()}`}, now(), ${deal}) returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          values (${w.wsId}, ${portal}, 'portal', 'inbound', 'received', 'Closingword date moved')`,
    );
    await rows(
      admin(),
      sql`insert into app.calls (workspace_id, conversation_id, direction, from_e164, to_e164, status, transcript)
          values (${w.wsId}, ${portal}, 'inbound', '+15045550142', '+15045550000', 'completed',
            'Escrowword is ready')`,
    );
    const hanging = [
      ['lockboxword', 'tasks'],
      ['termiteword', 'notes'],
      ['surveyword', 'files'],
      ['showingword', 'calendar'],
      ['closingword', 'messages'],
      ['escrowword', 'messages'],
    ] as const;
    for (const [q, kind] of hanging)
      expect(groupOf(await everything(w, w.owner, q), kind), q).toBeDefined();
    // Real Estate answers for its own kinds of records while it's on (Search 4b), in place of core's group.
    const on = await everything(w, w.owner, 'bayou road');
    expect(titles(groupOf(on, 'realestate.properties'))).toEqual(['77 Bayou Road']);
    expect(groupOf(on, 'record.realestate_property')).toBeUndefined();
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${w.wsId} and addon_id = 'realestate'`,
    );
    try {
      // Neither core's group nor Real Estate's: its search isn't asked while it's off, and nothing says it failed.
      const off = await everything(w, w.owner, 'bayou road');
      expect(off.groups).toEqual([]);
      expect(allTitles(off)).toEqual([]);
      await expectHfos(
        () => oneKind(w, w.owner, 'bayou road', 'record.realestate_property'),
        'search_kind_gone',
        404,
      );
      // Not even a close match leads to it.
      expect(allTitles(await everything(w, w.owner, 'bayuo raod'))).toEqual([]);
      for (const [q, kind] of hanging) {
        expect(allTitles(await everything(w, w.owner, q)), q).toEqual([]);
        expect(titles((await oneKind(w, w.owner, q, kind)).group), q).toEqual([]);
      }
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${w.wsId} and addon_id = 'realestate'`,
      );
    }
    const back = await everything(w, w.owner, 'bayou road');
    expect(titles(groupOf(back, 'realestate.properties'))).toEqual(['77 Bayou Road']);
    for (const [q, kind] of hanging)
      expect(groupOf(await everything(w, w.owner, q), kind), q).toBeDefined();
  });
});

describe('7. customers in the bin, erased names and merged shells', () => {
  let binned: string;
  let merged: string;
  let erased: string;
  let invoice: string;

  beforeAll(async () => {
    const add = async (first: string, last: string, archived = false) => {
      const [p] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, company_id, archived_at)
            values (${w.wsId}, ${first}, ${last}, '+15045557777', ${w.ids.smithfield},
              ${archived ? sql`now()` : sql`null`}) returning id`,
      );
      return p!.id;
    };
    // Archived before it was deleted: in the bin, it's under neither.
    binned = await add('Quentin', 'Fairweather', true);
    merged = await add('Quentin', 'Mergedshell');
    erased = await add('Quentin', 'Erasedname');
    const [inv] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.invoices (workspace_id, person_id, title, total_cents, subtotal_cents, public_ref)
          values (${w.wsId}, ${binned}, 'Gutter cleaning', 30000, 30000,
            ${randomUUID().replace(/-/g, '').slice(0, 8)}) returning id`,
    );
    invoice = inv!.id;
    await run(personDelete, { workspaceId: w.wsId, personIds: [binned] }, w.owner);
    await rows(
      admin(),
      sql`update app.people set merged_into_id = ${w.ids.dana}, merged_at = now() where id = ${merged}`,
    );
    await rows(admin(), sql`update app.people set erased_at = now() where id = ${erased}`);
  });

  it('shows none of them in Contacts or Archived, by name or by phone', async () => {
    for (const u of [w.owner, w.member])
      for (const q of ['quentin', 'fairweather', 'mergedshell', 'erasedname', '(504) 555-7777']) {
        const a = await everything(w, u, q);
        expect(titles(groupOf(a, 'contacts')), q).toEqual([]);
        expect(titles(a.archived), q).toEqual([]);
        expect(titles((await oneKind(w, u, q, 'contacts')).group), q).toEqual([]);
        expect(titles((await oneKind(w, u, q, 'archived')).group), q).toEqual([]);
      }
  });

  it('gives no close match to a misspelt name of a customer in the bin', async () => {
    for (const u of [w.owner, w.member]) {
      const a = await everything(w, u, 'fiarweather');
      expect(titles(groupOf(a, 'close'))).toEqual([]);
    }
  });

  it('leaves them out of a company’s people count', async () => {
    const company = groupOf(await everything(w, w.owner, 'smithfield'), 'companies')!.items[0]!;
    expect(company.facts.people).toBe(1);
  });

  it('finds an invoice of a customer in the bin by the name it keeps, with no way to call or text them', async () => {
    const money = groupOf(await everything(w, w.owner, 'fairweather'), 'money')!;
    expect(money.items[0]).toMatchObject({
      id: invoice,
      facts: { customer: 'Quentin Fairweather' },
    });
    expect(money.items[0]!.contact).toBeNull();
  });

  it('lists a customer in the bin found by name with no close matches over them, and nobody active', async () => {
    const add = async (last: string) => {
      const [p] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.people (workspace_id, first_name, last_name)
            values (${w.wsId}, 'Ottoline', ${last}) returning id`,
      );
      return p!.id;
    };
    await add('Brackenbery');
    const gone = await add('Brackenbury');
    await run(personDelete, { workspaceId: w.wsId, personIds: [gone] }, w.owner);
    const owner = await everything(w, w.owner, 'ottoline brackenbury');
    expect(owner).toMatchObject({ close: false, noneActive: true, total: 0, groups: [] });
    expect(titles(owner.bin)).toEqual(['Ottoline Brackenbury']);
    // A member can't open the bin, so nothing matched for them, and the live near-namesake is the close match.
    const member = await everything(w, w.member, 'ottoline brackenbury');
    expect(member).toMatchObject({ close: true, noneActive: false, bin: null });
    expect(titles(groupOf(member, 'close'))).toEqual(['Ottoline Brackenbery']);
  });

  it('shows the Deleted bin, by name, to the owner, not a member, and to a member given Delete for good', async () => {
    const owner = await everything(w, w.owner, 'fairweather');
    expect(titles(owner.bin)).toEqual(['Quentin Fairweather']);
    expect(owner.bin!.items[0]!.href).toContain('/settings/deleted-bin?item=');
    expect((await everything(w, w.member, 'fairweather')).bin).toBeNull();
    await expectHfos(
      () => oneKind(w, w.member, 'fairweather', 'bin'),
      'search_kind_not_allowed',
      403,
    );
    // Delete for good takes Archive and restore with it.
    for (const permission of ['records.archive', 'records.delete'])
      await run(
        permissionSetMember,
        { workspaceId: w.wsId, userId: w.member.id, permission, allowed: true },
        w.owner,
      );
    try {
      expect(titles((await everything(w, w.member, 'fairweather')).bin)).toEqual([
        'Quentin Fairweather',
      ]);
      expect(titles((await oneKind(w, w.member, 'fairweather', 'bin')).group)).toEqual([
        'Quentin Fairweather',
      ]);
    } finally {
      for (const permission of ['records.delete', 'records.archive'])
        await run(
          permissionSetMember,
          { workspaceId: w.wsId, userId: w.member.id, permission, allowed: null },
          w.owner,
        );
    }
  });
});

describe('8. a meeting on a private deal', () => {
  it('leaves its summary sealed with the deal: found by its people and nobody else', async () => {
    const deal = await one(
      sql`insert into app.custom_records (workspace_id, type_id, name, kept_to_team, owner_user_id, team_user_ids)
          select ${w.wsId}, t.id, 'Heron Point purchase', true, ${w.priya.id}, array[${w.marco.id}]::uuid[]
          from app.custom_record_types t where t.workspace_id = ${w.wsId} and t.key = 'realestate_deal'
          returning id`,
    );
    const tour = await one(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
            custom_record_id)
          values (${w.wsId}, ${m.calendar}, 1, 'Heron Point tour', now() - interval '2 hours',
            now() - interval '1 hour', ${deal})
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, status)
          values (${w.wsId}, ${tour}, ${w.ids.jo}, 'booked')`,
    );
    // Hosted by Marco.
    await rows(
      admin(),
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
          values (${w.wsId}, ${tour}, ${w.marco.id})`,
    );
    const transcript = await one(
      sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
          values (${w.wsId}, ${tour}, 'zoom', ${randomUUID()}, 'Jo: we want a second look') returning id`,
    );
    const done = await runSystem(
      callSuggestionRecord,
      {
        workspaceId: w.wsId,
        appointmentId: tour,
        transcriptId: transcript,
        review: {
          summary: 'Secondlookword: the buyers want to see it again on Saturday.',
          tasks: [
            { title: 'Topofferword: draft the 410 offer', notes: 'They won’t go higher than 410.' },
          ],
        },
      },
      w.scope,
    );
    expect(done).toEqual({ noted: true, suggestions: 1 });
    for (const u of [w.priya, w.marco])
      expect(titles(groupOf(await everything(w, u, 'secondlookword'), 'notes'))).toEqual([
        'Call summary: Heron Point tour',
      ]);
    expect(allTitles(await everything(w, w.member, 'secondlookword'))).toEqual([]);
    expect(titles((await oneKind(w, w.member, 'secondlookword', 'notes')).group)).toEqual([]);

    // Marco comes off the deal; Priya approves the task it suggested: sealed with the deal, and left unassigned,
    // since its host is no longer on it.
    await rows(admin(), sql`update app.custom_records set team_user_ids = '{}' where id = ${deal}`);
    const [suggestion] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.call_suggestions where appointment_id = ${tour} and kind = 'task'`,
    );
    const approved = await run(
      callSuggestionDecide,
      { workspaceId: w.wsId, suggestionId: suggestion!.id, decision: 'approve' },
      w.priya,
    );
    const [task] = await rows<{
      custom_record_id: string;
      sealed: boolean;
      assignee_user_id: string | null;
    }>(
      admin(),
      sql`select custom_record_id, sealed, assignee_user_id from app.tasks where id = ${approved.taskId}`,
    );
    expect(task).toEqual({ custom_record_id: deal, sealed: true, assignee_user_id: null });
    expect(titles(groupOf(await everything(w, w.priya, 'topofferword'), 'tasks'))).toEqual([
      'Topofferword: draft the 410 offer',
    ]);
    for (const u of [w.marco, w.member])
      expect(allTitles(await everything(w, u, 'topofferword'))).toEqual([]);
  });

  it('still keeps the summary and suggestions of a meeting on a record in the bin, the note on its customer', async () => {
    const kind = await one(
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, position)
          values (${w.wsId}, 'boat', 'Boat', 'Boats', 40) returning id`,
    );
    const boat = await one(
      sql`insert into app.custom_records (workspace_id, type_id, name) values (${w.wsId}, ${kind}, 'Sea Ray 240')
          returning id`,
    );
    const survey = await one(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
            custom_record_id)
          values (${w.wsId}, ${m.calendar}, 1, 'Hull survey call', now() - interval '2 hours',
            now() - interval '1 hour', ${boat})
          returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, status)
          values (${w.wsId}, ${survey}, ${w.ids.jo}, 'booked')`,
    );
    const transcript = await one(
      sql`insert into app.appointment_transcripts (workspace_id, appointment_id, provider, external_id, body)
          values (${w.wsId}, ${survey}, 'zoom', ${randomUUID()}, 'Jo: the hull needs a look') returning id`,
    );
    await run(customRecordDelete, { workspaceId: w.wsId, customRecordIds: [boat] }, w.owner);
    const done = await runSystem(
      callSuggestionRecord,
      {
        workspaceId: w.wsId,
        appointmentId: survey,
        transcriptId: transcript,
        review: {
          summary: 'Hullword: Jo wants the hull checked before launch.',
          tasks: [{ title: 'Book the hull check' }],
        },
      },
      w.scope,
    );
    expect(done).toEqual({ noted: true, suggestions: 1 });
    const [kept] = await rows<{ summary: string }>(
      admin(),
      sql`select summary from app.appointment_transcripts where id = ${transcript}`,
    );
    expect(kept!.summary).toContain('Hullword');
    // Not a private record, so the note is anyone's, on Jo alone while the boat is in the bin.
    const found = groupOf(await everything(w, w.member, 'hullword'), 'notes')!;
    expect(found.items[0]).toMatchObject({
      title: 'Call summary: Hull survey call',
      facts: { on: 'Jo Smithers' },
    });
  });
});
