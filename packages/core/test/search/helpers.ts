/**
 * A business to search, for the suites against the local database: Bayou Plumbing's owner and three members (from
 * the calendar suites' team), and the rows boards 1 to 4 search for, written straight into the tables.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { testDbs, type TestUser } from '@hfos/db/testing';
import { expect } from 'vitest';
import type { z } from 'zod';
import type { QueryContext, RequestMeta } from '../../src/kernel/types';
import { scopeCan } from '../../src/kernel/execute';
import {
  SearchEverythingInput,
  SearchKindInput,
  type SearchEverythingOutput,
  type SearchGroup,
  type SearchHit,
} from '../../src/schemas/search';
import { searchEverything, searchKind } from '../../src/server';
import type { RunOptions } from '../../src/search/server/run';
import { runSearch } from '../../src/search/server/run';
import { admin, ask, human, setupTeam, type Team } from '../calendar-helpers';

export { admin, ask, expectHfos, run, runSystem } from '../calendar-helpers';

/** Search everything as someone. */
export const everything = (
  t: { wsId: string },
  u: TestUser,
  q: string,
  more: Partial<z.input<typeof SearchEverythingInput>> = {},
) => ask(searchEverything, { workspaceId: t.wsId, q, ...more }, u);

/** One kind as someone. */
export const oneKind = (
  t: { wsId: string },
  u: TestUser,
  q: string,
  kind: string,
  more: Partial<z.input<typeof SearchKindInput>> = {},
) => ask(searchKind, { workspaceId: t.wsId, q, kind, ...more }, u);

/** A group of an answer by kind. */
export const groupOf = (a: SearchEverythingOutput, kind: string): SearchGroup | undefined =>
  a.groups.find((g) => g.kind === kind);

/** The titles in a group, in order. */
export const titles = (g: SearchGroup | null | undefined): string[] =>
  (g?.items ?? []).map((h: SearchHit) => h.title);

/** Every title in an answer, every group, Archived and the bin included. */
export const allTitles = (a: SearchEverythingOutput): string[] => [
  ...a.groups.flatMap((g) => titles(g)),
  ...titles(a.archived),
  ...titles(a.bin),
];

const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });

/**
 * Runs a search straight through `runSearch`, as the person under row security, with test-only searchers or a
 * budget: the query's own path, minus the kernel. Their permissions are what the business gives them.
 */
export async function runAs(
  t: { wsId: string; orgId: string },
  u: TestUser,
  input: z.input<typeof SearchEverythingInput> | z.input<typeof SearchKindInput>,
  opts: RunOptions = {},
) {
  return asUser(testDbs().api.db, u.claims, async (tx) => {
    const [row] = await rows<{ role: 'owner' | 'admin' | 'member'; permissions: string[] }>(
      tx,
      sql`select private.my_workspace_role(${t.wsId})::text as role,
                 private.my_permissions(${t.wsId}) as permissions`,
    );
    const ctx: QueryContext = {
      tx,
      actor: human(u),
      scope: {
        workspaceId: t.wsId,
        organizationId: t.orgId,
        workspaceRole: row!.role,
        workspacePermissions: row!.permissions,
        orgRole: null,
      },
      meta: meta(),
    };
    expect(scopeCan(ctx.scope, 'workspace.read')).toBe(true);
    const parsed =
      'kind' in input ? SearchKindInput.parse(input) : SearchEverythingInput.parse(input);
    return runSearch(ctx, parsed as never, opts) as Promise<unknown>;
  });
}

export interface World extends Team {
  readonly ids: Readonly<Record<string, string>>;
}

const one = async (query: ReturnType<typeof sql>): Promise<string> => {
  const [r] = await rows<{ id: string }>(admin(), query);
  return r!.id;
};

/** A stage of the business's first pipeline: its first open one, or its won one. */
async function stageOf(wsId: string, kind: 'open' | 'won') {
  const [s] = await rows<{ id: string; pipeline_id: string }>(
    admin(),
    sql`select id, pipeline_id from app.pipeline_stages
        where workspace_id = ${wsId} and kind = ${kind} order by position limit 1`,
  );
  return s!;
}

/** Bayou Plumbing and the rows the boards search for. */
export async function searchWorld(label: string): Promise<World> {
  const t = await setupTeam(label);
  const ws = t.wsId;
  const person = (f: Record<string, unknown>) =>
    one(sql`insert into app.people (workspace_id, first_name, last_name, email, phone_e164, address_line1, city,
              state, postal_code, company_id, other_phones, archived_at, owner_user_id)
            values (${ws}, ${f.first as string}, ${f.last as string}, ${(f.email as string) ?? null},
              ${(f.phone as string) ?? null}, ${(f.street as string) ?? null}, ${(f.city as string) ?? null},
              ${(f.state as string) ?? null}, ${(f.zip as string) ?? null}, ${(f.company as string) ?? null},
              ${JSON.stringify(f.otherPhones ?? [])}::jsonb, ${f.archived ? sql`now()` : sql`null`},
              ${(f.owner as string) ?? null})
            returning id`);
  const company = (name: string, f: Record<string, unknown> = {}) =>
    one(sql`insert into app.companies (workspace_id, name, website, phone_e164, owner_user_id)
            values (${ws}, ${name}, ${(f.website as string) ?? null}, ${(f.phone as string) ?? null},
              ${(f.owner as string) ?? null})
            returning id`);
  const smithfield = await company('Smithfield Property Mgmt', { phone: '+15045550900' });
  const gulf = await company('Gulf Coast Realty', { website: 'https://www.gulfcoastrealty.com/' });
  const dana = await person({
    first: 'Dana',
    last: 'Smith',
    email: 'dana.smith@gmail.com',
    phone: '+15045550142',
    street: '1042 Oak St',
    city: 'Metairie',
    state: 'LA',
    zip: '70001',
    owner: t.member.id,
  });
  const dana2 = await person({
    first: 'Dana',
    last: 'Smith',
    email: 'dsmith@yahoo.com',
    phone: '+15045550142',
    city: 'Kenner',
  });
  const marcus = await person({
    first: 'Marcus',
    last: 'Smith',
    phone: '+15045550199',
    otherPhones: [{ phone: '+15045550111', label: 'Work' }],
  });
  const jo = await person({ first: 'Jo', last: 'Smithers', email: 'jo@smithers.net' });
  const jose = await person({ first: 'José', last: 'García', city: 'Chalmette' });
  const kim = await person({
    first: 'Kim',
    last: 'Le',
    email: 'kim@gulfcoastrealty.com',
    company: smithfield,
  });
  const tom = await person({ first: 'Tom', last: 'Becnel', archived: true });

  const open = await stageOf(ws, 'open');
  const won = await stageOf(ws, 'won');
  const lead = (title: string, f: Record<string, unknown>) =>
    one(sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, company_id, title, value_cents,
              status, won_at, assignee_user_id)
            values (${ws}, ${open.pipeline_id}, ${f.won ? won.id : open.id}, ${(f.person as string) ?? null},
              ${(f.company as string) ?? null}, ${title}, ${(f.value as number) ?? 0},
              ${f.won ? 'won' : 'open'}::app.lead_status, ${f.won ? sql`now()` : sql`null`},
              ${(f.assignee as string) ?? null})
            returning id`);
  const backflow = await lead('Backflow test, 4 buildings', {
    company: smithfield,
    person: kim,
    value: 240_000,
  });
  const heater = await lead('Water heater install', {
    person: dana,
    value: 185_000,
    assignee: t.member.id,
  });
  const roof = await lead('Old roof repair', { person: marcus, won: true });

  const invoice = (f: Record<string, unknown>) =>
    one(sql`insert into app.invoices (workspace_id, person_id, number, sent_at, status, title, notes, total_cents,
              subtotal_cents, due_on, public_ref, assignee_user_id)
            values (${ws}, ${f.person as string}, ${(f.number as string) ?? null},
              ${f.number ? sql`now()` : sql`null`}, ${(f.status as string) ?? (f.number ? 'sent' : 'draft')}::app.invoice_status,
              ${(f.title as string) ?? null}, ${(f.notes as string) ?? null}, ${(f.total as number) ?? 0},
              ${(f.total as number) ?? 0}, ${(f.due as string) ?? null}::date,
              ${randomUUID().replace(/-/g, '').slice(0, 8)}, ${(f.assignee as string) ?? null})
            returning id`);
  const estimate = (f: Record<string, unknown>) =>
    one(sql`insert into app.estimates (workspace_id, person_id, number, sent_at, status, title, total_cents,
              subtotal_cents, public_ref)
            values (${ws}, ${f.person as string}, ${(f.number as string) ?? null},
              ${f.number ? sql`now()` : sql`null`}, ${f.number ? 'sent' : 'draft'}::app.estimate_status,
              ${(f.title as string) ?? null}, ${(f.total as number) ?? 0}, ${(f.total as number) ?? 0},
              ${randomUUID().replace(/-/g, '').slice(0, 8)})
            returning id`);
  const inv1042 = await invoice({
    person: marcus,
    number: '2026-1042',
    total: 128_000,
    title: 'Repipe',
  });
  const invOld = await invoice({
    person: jo,
    number: 'INV-001042',
    total: 5_000,
    due: '2026-10-14',
    status: 'overdue',
  });
  const invDraft = await invoice({
    person: dana,
    title: 'Water heater flush',
    total: 22_500,
    notes: 'Gate code 4471',
  });
  const est = await estimate({
    person: dana,
    number: 'LS-0042',
    total: 99_900,
    title: 'New water heater',
  });
  const estDraft = await estimate({ person: kim, title: 'Backflow retest', total: 15_000 });
  const cash = await one(
    sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
        values (${ws}, ${inv1042}, 128000, 'cash', 'succeeded', now() - interval '20 days') returning id`,
  );

  const knowledge = await one(
    sql`insert into app.knowledge_items (workspace_id, kind, title, body, status)
        values (${ws}, 'faq', 'Water heater maintenance', 'Flush the tank once a year so sediment never builds up.', 'published')
        returning id`,
  );
  const petType = await one(
    sql`insert into app.custom_record_types (workspace_id, key, singular, plural, icon)
        values (${ws}, 'pets', 'Pet', 'Pets', 'paw') returning id`,
  );
  const breed = await one(
    sql`insert into app.custom_fields (workspace_id, entity, key, label, type, record_type_id)
        values (${ws}, 'custom_record', 'breed', 'Breed', 'text', ${petType}) returning id`,
  );
  const rex = await one(
    sql`insert into app.custom_records (workspace_id, type_id, name, custom)
        values (${ws}, ${petType}, 'Rex Smith', ${JSON.stringify({ [breed]: 'Golden retriever' })}::jsonb)
        returning id`,
  );
  const gate = await one(
    sql`insert into app.custom_fields (workspace_id, entity, key, label, type)
        values (${ws}, 'person', 'gate', 'Gate code', 'text') returning id`,
  );
  await rows(
    admin(),
    sql`update app.people set custom = ${JSON.stringify({ [gate]: 'Gate 4471' })}::jsonb where id = ${jose}`,
  );
  return {
    ...t,
    ids: {
      smithfield,
      gulf,
      dana,
      dana2,
      marcus,
      jo,
      jose,
      kim,
      tom,
      backflow,
      heater,
      roof,
      inv1042,
      invOld,
      invDraft,
      est,
      estDraft,
      cash,
      knowledge,
      petType,
      rex,
    },
  };
}

/**
 * The rows Search 3's kinds find, added to Bayou Plumbing (boards 1 to 4): threads with their messages and calls,
 * a chat visitor and an Instagram handle, Other mail and Spam, the calendar, tasks, notes and the timeline lines that
 * aren't notes, files with port papers and a knowledge file beside them, and a form with its answers.
 */
export async function moreOfTheBoards(w: World): Promise<Record<string, string>> {
  const ws = w.wsId;
  const ago = (days: number) => sql`now() - make_interval(secs => ${Math.round(days * 86_400)})`;
  const thread = (f: Record<string, unknown>) =>
    one(sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, last_message_at,
              last_preview, folder, private_to, archived_at, assignee_user_id, custom_record_id, meta_account_id)
            values (${ws}, ${f.channel as string}::app.channel, ${f.counterpart as string},
              ${(f.person as string) ?? null}, ${ago((f.days as number) ?? 1)}, ${(f.preview as string) ?? null},
              ${(f.folder as string) ?? 'inbox'}::app.conversation_folder, ${(f.privateTo as string) ?? null},
              ${f.archived ? sql`now()` : sql`null`}, ${(f.assignee as string) ?? null},
              ${(f.record as string) ?? null}, ${(f.metaAccount as string) ?? null})
            returning id`);
  const message = (conversation: string, f: Record<string, unknown>) =>
    one(sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, subject, body_text,
              occurred_at, error_code)
            select ${ws}, c.id, c.channel, ${(f.direction as string) ?? 'inbound'}::app.direction,
              ${f.direction === 'outbound' ? 'sent' : 'received'}::app.message_status, ${(f.subject as string) ?? null},
              ${f.body as string}, ${ago((f.days as number) ?? 1)}, ${(f.error as string) ?? null}
            from app.conversations c where c.id = ${conversation}
            returning id`);
  const call = (f: Record<string, unknown>) =>
    one(sql`insert into app.calls (workspace_id, conversation_id, person_id, direction, from_e164, to_e164, status,
              started_at, transcript, is_voicemail, answered_via, answered_by_user_id)
            values (${ws}, ${(f.conversation as string) ?? null}, ${(f.person as string) ?? null}, 'inbound',
              ${(f.from as string) ?? '+15045550142'}, '+15045550000', 'completed', ${ago((f.days as number) ?? 1)},
              ${f.transcript as string}, ${!!f.voicemail}, ${(f.via as string) ?? null}::app.call_answered_via,
              ${(f.answeredBy as string) ?? null})
            returning id`);

  // Dana's texts: the water heater, and a call about its pilot light.
  const danaTexts = await thread({
    channel: 'sms',
    counterpart: '+15045550142',
    person: w.ids.dana,
    days: 2,
    preview: 'Sure, we can come Thursday',
    assignee: w.member.id,
  });
  const leak = await message(danaTexts, {
    body: 'The water heater is leaking near the gas valve again',
    days: 3,
  });
  await message(danaTexts, { body: 'Sure, we can come Thursday', direction: 'outbound', days: 2 });
  // A held text that was cancelled never went: it's in no search.
  await message(danaTexts, {
    body: 'Heldback reminder',
    direction: 'outbound',
    error: 'cancelled',
  });
  const pilotCall = await call({
    conversation: danaTexts,
    person: w.ids.dana,
    transcript: 'The pilot light on the water heater keeps going out',
    days: 2.5,
  });
  // Through someone's own cell and never picked up: not part of the thread, so not found.
  await call({
    conversation: danaTexts,
    person: w.ids.dana,
    transcript: 'Unansweredbridge call',
    via: 'bridge',
  });

  // Kim's email, in Other mail.
  const kimMail = await thread({
    channel: 'email',
    counterpart: 'kim@gulfcoastrealty.com',
    person: w.ids.kim,
    folder: 'other',
    days: 4,
    preview: 'Backflow certificate',
  });
  await message(kimMail, {
    subject: 'Backflow certificate',
    body: 'Attached is the backflow certificate for building 2.',
    days: 4,
  });

  // Spam, with a call in it.
  const spam = await thread({
    channel: 'email',
    counterpart: 'deals@cheap-tanks.example',
    folder: 'spam',
    days: 5,
  });
  await message(spam, { subject: 'Cheap tanks', body: 'Tankless heaters at half price', days: 5 });
  const spamCall = await call({ conversation: spam, transcript: 'Tankless heaters robocall' });

  // An archived thread: found under Archived by who it's with, never by its words without Include archived.
  const archivedThread = await thread({
    channel: 'sms',
    counterpart: '+15045553333',
    person: w.ids.jose,
    archived: true,
    days: 6,
  });
  await message(archivedThread, { body: 'Shelvedword quote for the gate', days: 6 });
  await call({ conversation: archivedThread, transcript: 'Shelvedcall about the gate' });

  // A voicemail with no thread, from Marcus: it opens his timeline.
  const voicemail = await call({
    person: w.ids.marcus,
    from: '+15045550199',
    transcript: 'Marcus here about the repipe estimate, call me back',
    voicemail: true,
  });

  // A website visitor and an Instagram customer, found by their names.
  const widget = await one(
    sql`insert into app.chat_widgets (workspace_id, allowed_origins)
        values (${ws}, '{https://bayouplumbing.example}') returning id`,
  );
  // A visitor's conversation is named for it.
  const visitor = randomUUID();
  const chat = await thread({ channel: 'chat', counterpart: `chat:${visitor}`, days: 1 });
  await rows(
    admin(),
    sql`insert into app.chat_visitors (id, workspace_id, widget_id, token_hash, conversation_id, name)
        values (${visitor}, ${ws}, ${widget}, ${Buffer.from(randomUUID())}, ${chat}, 'Beatrice Fontaine')`,
  );
  await message(chat, { body: 'Do you service tankless units?' });
  const igAccount = String(1_784_000_000_000 + Math.floor(Math.random() * 1e9));
  const metaAccount = await one(
    sql`insert into app.meta_accounts (workspace_id, platform, external_id, page_id, name)
        values (${ws}, 'instagram', ${igAccount}, ${igAccount}, 'Bayou Plumbing') returning id`,
  );
  const insta = await thread({
    channel: 'instagram',
    counterpart: `instagram:${igAccount}:IGSID4471`,
    metaAccount,
    days: 1,
  });
  await rows(
    admin(),
    sql`insert into app.meta_contacts (workspace_id, account_id, platform, scoped_id, name, username,
          conversation_id)
        values (${ws}, ${metaAccount}, 'instagram', 'IGSID4471', 'Theo Lavergne', 'nolaplumbfan', ${insta})`,
  );
  await message(insta, { body: 'Saw your post about water heaters' });

  // The calendar.
  const calendar = await one(
    sql`insert into app.calendars (workspace_id, name, slug)
        values (${ws}, 'Service calls', ${`service-${randomUUID().slice(0, 8)}`}) returning id`,
  );
  const visit = (f: Record<string, unknown>) =>
    one(sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
              location, notes, status, owner_user_id)
            values (${ws}, ${calendar}, 1, ${f.title as string}, ${ago(f.days as number)},
              ${ago((f.days as number) - 0.08)}, ${JSON.stringify(f.location ?? {})}::jsonb,
              ${(f.notes as string) ?? null}, ${(f.status as string) ?? 'scheduled'}::app.appointment_status,
              ${(f.owner as string) ?? null})
            returning id`);
  const tankSwap = await visit({
    title: 'Tank swap',
    days: -3,
    location: { kind: 'address', address: '77 Egret Ave, Metairie' },
    notes: 'Bring the 50 gallon tank',
    owner: w.member.id,
  });
  await rows(
    admin(),
    sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id, status, contact_phone_e164,
          contact_email)
        values (${ws}, ${tankSwap}, ${w.ids.jo}, 'booked', '+15045550177', 'jo@smithers.net')`,
  );
  const drain = await visit({ title: 'Drain cleaning', days: 1, status: 'cancelled' });

  // Tasks.
  const task = (f: Record<string, unknown>) =>
    one(sql`insert into app.tasks (workspace_id, title, notes, person_id, company_id, due_at, done_at,
              assignee_user_id, created_by)
            values (${ws}, ${f.title as string}, ${(f.notes as string) ?? null}, ${(f.person as string) ?? null},
              ${(f.company as string) ?? null}, ${f.due === undefined ? sql`null` : ago(f.due as number)},
              ${f.done ? sql`now()` : sql`null`}, ${(f.assignee as string) ?? null}, ${w.owner.id})
            returning id`);
  const callBack = await task({
    title: 'Call Dana back about the water heater',
    person: w.ids.dana,
    due: -1,
    assignee: w.member.id,
  });
  const parts = await task({
    title: 'Order backflow parts',
    notes: 'Smithfield needs four valves',
    company: w.ids.smithfield,
    done: true,
  });

  // The timeline: notes, and the lines that aren't.
  const line = (f: Record<string, unknown>) =>
    one(sql`insert into app.activities (workspace_id, kind, subtype, body, person_id, occurred_at, actor_type,
              author_user_id)
            values (${ws}, ${f.kind as string}::app.activity_kind, ${(f.subtype as string) ?? null},
              ${f.body as string}, ${(f.person as string) ?? w.ids.dana}, ${ago((f.days as number) ?? 2)},
              ${(f.actor as string) ?? 'human'}::app.actor_type, ${(f.author as string) ?? null})
            returning id`);
  const gateNote = await line({
    kind: 'note',
    body: 'Gate code 4471, dog in the yard',
    author: w.member.id,
  });
  const referred = await line({ kind: 'note', body: 'Referred by Jo Smithers', days: 1 });
  const imported = await line({
    kind: 'note',
    subtype: 'gohighlevel',
    actor: 'integration',
    body: 'Imported: prefers morning visits',
    person: w.ids.marcus,
  });
  const loggedCall = await line({
    kind: 'call',
    body: 'Called about the furnace filter',
    person: w.ids.jo,
  });
  const summary = await line({
    kind: 'note',
    actor: 'system',
    body: 'Call summary: Duct quote call\n\nThey want the duct quote by Friday.',
    person: w.ids.jo,
    days: 3,
  });
  await line({ kind: 'sms', subtype: 'inbound', body: 'Smscopyword about the leak' });
  await line({ kind: 'call', subtype: 'answered', body: 'Callcopyword transcript' });
  await line({ kind: 'system', subtype: 'file_added', body: 'Fileaddedword.pdf' });
  await line({ kind: 'system', subtype: 'intake', body: 'Intakeword answers' });

  // Files: one on Kim, port papers and a knowledge file beside it.
  const file = (f: Record<string, unknown>) =>
    one(sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status, created_by)
            values (${ws}, ${f.type as string}::app.record_type, ${f.record as string},
              ${`${ws}/${randomUUID()}`}, ${f.name as string}, 'ready', ${w.owner.id})
            returning id`);
  const report = await file({ type: 'person', record: w.ids.kim, name: 'Backflow report.pdf' });
  const port = await file({ type: 'port', record: randomUUID(), name: 'Backflow LOA signed.pdf' });
  const priceList = await file({ type: 'knowledge', record: ws, name: 'Backflow price list.pdf' });

  // A form, with Jo's answers, an anonymous one, and one still being filled in.
  const form = await one(
    sql`insert into app.forms (workspace_id, name, slug)
        values (${ws}, 'Water heater survey', ${`survey-${randomUUID().slice(0, 8)}`}) returning id`,
  );
  // Question ids are random, so these sort against the form's order: a response's first answer is the form's.
  const questions: Record<string, string> = {
    'What tank do you have?': 'q_tank0009',
    'Anything else?': 'q_else0005',
    Deposit: 'q_depo0001',
  };
  const definition = {
    pages: [{ id: 'p_survey01', questions: Object.values(questions).map((id) => ({ id })) }],
  };
  const version = await one(
    sql`insert into app.form_versions (workspace_id, form_id, version, definition, definition_version, revision)
        values (${ws}, ${form}, 1, ${JSON.stringify(definition)}::jsonb, 1, 1) returning id`,
  );
  const response = async (
    person: string | null,
    status: string,
    answers: Record<string, unknown>[],
  ) => {
    const id = await one(
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, person_id, completed_at)
          values (${ws}, ${form}, ${version}, ${status}::app.form_response_status, ${person},
            ${status === 'completed' ? sql`now()` : sql`null`})
          returning id`,
    );
    for (const a of answers)
      await rows(
        admin(),
        sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title,
              question_type, text_value, choice_labels, answered_at)
            values (${ws}, ${id}, ${form}, ${questions[a.question as string]!}, ${a.question as string},
              ${(a.type as string) ?? 'short_text'}, ${(a.text as string) ?? null},
              ${textArrayOf((a.choices as string[]) ?? [])}, now() - interval '1 day')`,
      );
    return id;
  };
  const joAnswers = await response(w.ids.jo!, 'completed', [
    { question: 'What tank do you have?', text: '50 gallon, gas' },
    { question: 'Anything else?', text: 'It smells like rotten eggs' },
    { question: 'Deposit', type: 'payment', text: 'Depositword paid' },
  ]);
  // A choice, as forms/submit.ts keeps one: its labels, and the same words in text_value.
  const anonymous = await response(null, 'completed', [
    { question: 'What tank do you have?', type: 'choice', choices: ['Tankless'], text: 'Tankless' },
  ]);
  await response(w.ids.dana!, 'in_progress', [{ question: 'Anything else?', text: 'Halfwayword' }]);

  return {
    calendar,
    danaTexts,
    leak,
    pilotCall,
    kimMail,
    spam,
    spamCall,
    archivedThread,
    voicemail,
    chat,
    insta,
    tankSwap,
    drain,
    callBack,
    parts,
    gateNote,
    referred,
    imported,
    loggedCall,
    summary,
    report,
    port,
    priceList,
    form,
    joAnswers,
    anonymous,
  };
}

/** A text[] parameter. */
const textArrayOf = (values: readonly string[]) =>
  values.length
    ? sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;
