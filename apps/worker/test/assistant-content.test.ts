/**
 * The Assistant's content tools, against the real database: outreach campaigns, reviews, forms beyond building and
 * sending, the knowledge base (items, suggestions, the website scan, offers), workflows and their runs, and the AI
 * teammate's drafts.
 *
 * What it holds to, for every tool that changes something: the card says what will happen (and says so plainly when
 * it reaches customers or can't be undone), nothing changes until Confirm, and Confirm runs the screen's own command
 * as the person. Where the screen holds something back, the card has no Confirm and a line saying why. Look-ups run on
 * their own and draw cards that link only inside the app.
 */
import { randomUUID } from 'node:crypto';
import {
  AssistantCard,
  aiTeammateCreate,
  assistantToolByName,
  executeCommand,
  formCreate,
  formPublish,
  hasWorkspacePermission,
  knowledgeItemCreate,
  organizationCreate,
  personCreate,
  tagCreate,
  workflowCreate,
  workflowPublish,
  workflowSaveDraft,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import {
  contentAutoTools,
  contentConfirmTools,
  contentStepLabels,
} from '../src/assistant/tools-content';
import { createToolExecutor, executorFor } from '../src/assistant/tools-write';

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser = owner,
): Promise<z.output<O>> =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test',
    })
  ).output;

let owner: TestUser;
let member: TestUser;
let workspaceId: string;
let organizationId: string;

type Confirm = Extract<AssistantCard, { type: 'confirm' }>;
const ctx = (u: TestUser = owner): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tools = () => createToolExecutor(api());
const tool = (name: string) => assistantToolByName.get(name)!;
/** The arguments as the runtime hands them over: checked against the tool's input, defaults filled. */
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
const prepare = async (name: string, args: Record<string, unknown>, u: TestUser = owner) => {
  const out = await tools().prepare(tool(name), argsOf(name, args), ctx(u), randomUUID());
  expect(AssistantCard.safeParse(out.card).success, `${name} card`).toBe(true);
  return out as { card: Confirm; result: Record<string, unknown> };
};
const commit = (name: string, args: Record<string, unknown>, u: TestUser = owner) =>
  tools().commit(tool(name), argsOf(name, args), ctx(u), { toolCallId: randomUUID() });
const read = async (name: string, args: Record<string, unknown> = {}, u: TestUser = owner) => {
  const out = await tools().run(tool(name), argsOf(name, args), ctx(u));
  if (out.card) expect(AssistantCard.safeParse(out.card).success, `${name} card`).toBe(true);
  return out as { result: Record<string, unknown>; card?: AssistantCard | null };
};
const field = (card: Confirm, label: string) => card.fields.find((f) => f.label === label)?.value;
const blocked = (card: Confirm) => card.warnings.find((w) => w.kind === 'blocked')?.text;
const caution = (card: Confirm) => card.warnings.find((w) => w.kind === 'caution')?.text;
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), q))[0]!;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('acont-dale', { fullName: 'Dale Owner' }),
    createTestUser('acont-mo', { fullName: 'Mo Member' }),
  ]);
  const org = await run(organizationCreate, {
    businessName: `Content HVAC ${randomUUID().slice(0, 8)}`,
    timezone: CHI,
  });
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
}, 60_000);

afterAll(closeTestDbs);

describe('the content tools', () => {
  const READS = Object.keys(contentAutoTools);
  const WRITES = Object.keys(contentConfirmTools);

  it('are declared, run on their own only when they change nothing, and each has an executor and a label', () => {
    for (const name of READS) {
      expect(tool(name)?.autonomy, name).toBe('auto');
      expect(executorFor(name), name).toBeTruthy();
    }
    for (const name of WRITES) {
      expect(tool(name)?.autonomy, name).toBe('confirm');
      expect(executorFor(name), name).toBeTruthy();
    }
    for (const name of [...READS, ...WRITES]) expect(contentStepLabels[name], name).toBeTruthy();
  });

  it('are offered on the permission the screen’s buttons need: a member reads and decides drafts, and no more', () => {
    const offered = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    for (const name of READS) expect(offered, name).toContain(name);
    expect(offered).toContain('decide_teammate_draft');
    for (const name of WRITES.filter((n) => n !== 'decide_teammate_draft'))
      expect(offered, name).not.toContain(name);
  });
});

// ------------------------------------------------------------------------------------------------

describe('outreach campaigns', () => {
  let tagId: string;
  let campaignId: string;
  const people: Record<string, string> = {};

  beforeAll(async () => {
    tagId = (await run(tagCreate, { workspaceId, name: 'Fall list' })).tagId;
    for (const [first, phone, consent] of [
      ['Ann', '512-555-0101', 'opted_in'],
      ['Ben', '512-555-0102', 'opted_in'],
      ['Cal', '512-555-0103', 'unknown'],
    ] as const) {
      const { personId } = await run(personCreate, {
        workspaceId,
        firstName: first,
        lastName: 'Camp',
        phone,
      });
      people[first] = personId;
      await rows(
        admin(),
        sql`update app.people set sms_consent = ${consent}::app.sms_consent where id = ${personId}`,
      );
      await rows(
        admin(),
        sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
            values (${workspaceId}, ${tagId}, 'person', ${personId})`,
      );
    }
  });

  const campaign = () =>
    one<{ status: string; per_hour: number }>(
      sql`select status::text as status, per_hour from app.campaigns where id = ${campaignId}`,
    );

  it('starts one only on Confirm, after saying who it reaches and who it leaves out', async () => {
    const args = {
      name: 'Fall tune-up',
      goal: 'Our fall tune-up is $89 through October.',
      tagIds: [tagId],
    };
    const { card, result } = await prepare('start_campaign', args);
    expect(card.title).toBe('Start “Fall tune-up”: texts to 2 people?');
    expect(field(card, 'Reaches')).toBe('2 people');
    expect(field(card, 'Left out')).toBe('1 person: 1 hasn’t agreed to texts');
    expect(field(card, 'Who it picks')).toBe('Tagged Fall list');
    expect(card.confirmLabel).toBe('Write the texts');
    expect(card.warnings[0]!.text).toContain('Nothing goes out yet');
    expect(result['reaches']).toBe(2);
    const before = await one<{ n: number }>(
      sql`select count(*)::int as n from app.campaigns where workspace_id = ${workspaceId}`,
    );
    expect(before.n).toBe(0);

    const done = await commit('start_campaign', args);
    expect(done.command).toBe('campaign.create');
    const made = await one<{ id: string; status: string }>(
      sql`select id, status::text as status from app.campaigns where workspace_id = ${workspaceId}`,
    );
    campaignId = made.id;
    expect(made.status).toBe('drafting');
    expect(done.href).toBe(`/app/w/${workspaceId}/campaigns/${campaignId}`);
  });

  it('holds back an email campaign with no business address, and a stage that isn’t open', async () => {
    const { card } = await prepare('start_campaign', {
      channel: 'email',
      name: 'Newsletter',
      goal: 'News',
      tagIds: [tagId],
    });
    expect(card.confirmLabel).toBe('');
    expect(blocked(card)).toContain('business address');

    const won = await one<{ id: string }>(
      sql`select s.id from app.pipeline_stages s where s.workspace_id = ${workspaceId} and s.kind = 'won' limit 1`,
    );
    await expect(
      prepare('start_campaign', { name: 'Won deals', goal: 'Thanks', stageIds: [won.id] }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('won’t approve while the AI is still writing, then approves with how many it reaches', async () => {
    const early = await prepare('manage_campaign', { campaignId, action: 'approve_and_send' });
    expect(early.card.confirmLabel).toBe('');
    expect(blocked(early.card)).toContain('still being written');

    // What the worker does once it has written each text.
    await rows(admin(), sql`update app.campaigns set status = 'review' where id = ${campaignId}`);
    await rows(
      admin(),
      sql`update app.campaign_recipients set status = 'ready', draft = 'Hi ' || (
            select first_name from app.people p where p.id = person_id) || ', the fall tune-up is $89.'
          where campaign_id = ${campaignId} and status = 'drafting'`,
    );

    const { card, result } = await prepare('manage_campaign', {
      campaignId,
      action: 'approve_and_send',
    });
    expect(card.title).toBe('Send 2 people these texts?');
    expect(card.confirmLabel).toBe('Approve all and send');
    expect(caution(card)).toContain('This reaches 2 people');
    expect(card.body).toContain('Ann Camp: Hi Ann, the fall tune-up is $89.');
    expect(result['reaches']).toBe(2);
    expect((await campaign()).status).toBe('review');
  });

  it('changes one person’s text and takes someone out, only before it’s approved', async () => {
    const { card } = await prepare('edit_campaign', {
      campaignId,
      action: 'change_text',
      personId: people['Ben'],
      text: 'Ben, the tune-up special is back. Want a spot?',
    });
    expect(card.title).toBe('Change the text to Ben Camp?');
    expect(card.body).toBe('Ben, the tune-up special is back. Want a spot?');
    expect(field(card, 'Was')).toBe('Hi Ben, the fall tune-up is $89.');
    await commit('edit_campaign', {
      campaignId,
      action: 'change_text',
      personId: people['Ben'],
      text: 'Ben, the tune-up special is back. Want a spot?',
    });
    const ben = await one<{ draft: string; edited: boolean }>(
      sql`select draft, edited from app.campaign_recipients
          where campaign_id = ${campaignId} and person_id = ${people['Ben']}`,
    );
    expect(ben).toEqual({ draft: 'Ben, the tune-up special is back. Want a spot?', edited: true });

    const cal = await prepare('edit_campaign', {
      campaignId,
      action: 'remove_person',
      personId: people['Cal'],
    });
    expect(blocked(cal.card)).toContain('already left out (hasn’t agreed to texts)');

    const ann = await prepare('edit_campaign', {
      campaignId,
      action: 'remove_person',
      personId: people['Ann'],
    });
    expect(ann.card.title).toBe('Take Ann Camp out of “Fall tune-up”?');
    await commit('edit_campaign', { campaignId, action: 'remove_person', personId: people['Ann'] });
    const gone = await one<{ status: string }>(
      sql`select status::text as status from app.campaign_recipients
          where campaign_id = ${campaignId} and person_id = ${people['Ann']}`,
    );
    expect(gone.status).toBe('removed');

    await expect(
      prepare('edit_campaign', { campaignId, action: 'change_email', subject: 'Hi' }),
    ).resolves.toMatchObject({ card: { confirmLabel: '' } });
  });

  it('lists campaigns and reads one, with each person’s text and who was left out', async () => {
    const list = await read('list_campaigns');
    expect(JSON.stringify(list.result)).toContain('Fall tune-up');
    const one = await read('get_campaign', { campaignId });
    expect(one.result['whoItPicks']).toBe('Tagged Fall list');
    const people = one.result['people'] as { name: string; text?: string }[];
    expect(people.find((p) => p.name === 'Ben Camp')?.text).toBe(
      'Ben, the tune-up special is back. Want a spot?',
    );
    expect(one.result['leftOut']).toEqual({
      'hasn’t agreed to texts': 1,
      'taken out by hand': 1,
    });
  });

  it('approves and sends on Confirm, then re-paces, pauses, resumes and stops it', async () => {
    await commit('manage_campaign', { campaignId, action: 'approve_and_send' });
    expect((await campaign()).status).toBe('sending');

    const pace = await prepare('manage_campaign', {
      campaignId,
      action: 'change_pace',
      perHour: 40,
    });
    expect(field(pace.card, 'Now')).toBe('40 texts an hour');
    expect(field(pace.card, 'Was')).toBe('20 texts an hour');
    expect((await campaign()).per_hour).toBe(20);
    await commit('manage_campaign', { campaignId, action: 'change_pace', perHour: 40 });
    expect((await campaign()).per_hour).toBe(40);

    const resumeEarly = await prepare('manage_campaign', { campaignId, action: 'resume' });
    expect(blocked(resumeEarly.card)).toBe('It’s sending, not paused.');
    await prepare('manage_campaign', { campaignId, action: 'pause' });
    await commit('manage_campaign', { campaignId, action: 'pause' });
    expect((await campaign()).status).toBe('paused');
    await commit('manage_campaign', { campaignId, action: 'resume' });
    expect((await campaign()).status).toBe('sending');

    const stop = await prepare('manage_campaign', { campaignId, action: 'stop' });
    expect(stop.card.title).toBe('Stop “Fall tune-up” for good?');
    expect(caution(stop.card)).toContain('can’t be undone');
    expect((await campaign()).status).toBe('sending');
    await commit('manage_campaign', { campaignId, action: 'stop' });
    expect((await campaign()).status).toBe('cancelled');
  });
});

// ------------------------------------------------------------------------------------------------

describe('reviews', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const conn = async (provider: 'google' | 'facebook') =>
      (
        await one<{ id: string }>(
          sql`insert into app.review_connections (workspace_id, provider, status, external_account_id, display_name)
              values (${workspaceId}, ${provider}::app.review_provider, 'connected', ${`place-${provider}`}, 'Content HVAC')
              returning id`,
        )
      ).id;
    const google = await conn('google');
    const facebook = await conn('facebook');
    const review = async (
      key: string,
      o: {
        connection: string;
        provider: string;
        rating?: number;
        body: string;
        answered?: boolean;
      },
    ) => {
      ids[key] = (
        await one<{ id: string }>(
          sql`insert into app.reviews (workspace_id, connection_id, provider, external_id, author_name, rating,
                sentiment, body, posted_at, reply_body, reply_posted_at)
              values (${workspaceId}, ${o.connection}, ${o.provider}::app.review_provider, ${key}, ${`${key} Reviewer`},
                ${o.rating ?? null}, ${o.rating ? null : 'positive'}::app.review_sentiment, ${o.body},
                now() - interval '1 day', ${o.answered ? 'Thanks!' : null}, ${o.answered ? new Date().toISOString() : null})
              returning id`,
        )
      ).id;
    };
    await review('Gia', {
      connection: google,
      provider: 'google',
      rating: 5,
      body: 'Fixed our AC fast.',
    });
    await review('Fay', { connection: facebook, provider: 'facebook', body: 'Great crew.' });
    await review('Old', {
      connection: google,
      provider: 'google',
      rating: 4,
      body: 'Good.',
      answered: true,
    });
  });

  it('lists the unanswered first, with what they wrote marked as their words', async () => {
    const { result, card } = await read('list_reviews');
    const reviews = result['reviews'] as { id: string; wrote: unknown; canAnswerHere: boolean }[];
    expect(reviews.map((r) => r.id).slice(-1)).toEqual([ids['Old']]);
    expect(reviews.find((r) => r.id === ids['Gia'])).toMatchObject({
      wrote: { customer_wrote: 'Fixed our AC fast.' },
      canAnswerHere: true,
    });
    expect(reviews.find((r) => r.id === ids['Fay'])?.canAnswerHere).toBe(false);
    expect((result['summary'] as { unanswered: number }).unanswered).toBe(2);
    expect(card?.type).toBe('list');
  });

  it('answers a Google review in public only on Confirm, and holds back Facebook and answered ones', async () => {
    const args = { reviewId: ids['Gia'], answer: 'Thank you, Gia! Glad we could help.' };
    const { card } = await prepare('answer_review', args);
    expect(card.title).toBe('Answer Gia Reviewer’s review?');
    expect(card.body).toBe('Thank you, Gia! Glad we could help.');
    expect(caution(card)).toContain('Public');
    expect(field(card, 'Review')).toBe('5 stars on Google');
    const before = await one<{ reply_body: string | null }>(
      sql`select reply_body from app.reviews where id = ${ids['Gia']}`,
    );
    expect(before.reply_body).toBeNull();
    await commit('answer_review', args);
    const after = await one<{ reply_body: string | null }>(
      sql`select reply_body from app.reviews where id = ${ids['Gia']}`,
    );
    expect(after.reply_body).toBe('Thank you, Gia! Glad we could help.');

    const fb = await prepare('answer_review', { reviewId: ids['Fay'], answer: 'Thanks!' });
    expect(fb.card.confirmLabel).toBe('');
    expect(blocked(fb.card)).toContain('answered on Facebook');
    const old = await prepare('answer_review', { reviewId: ids['Old'], answer: 'Thanks again!' });
    expect(blocked(old.card)).toBe('It already has an answer.');
  });
});

// ------------------------------------------------------------------------------------------------

describe('forms', () => {
  let formId: string;
  let responseId: string;

  beforeAll(async () => {
    const created = await run(formCreate, { workspaceId, name: 'Enquiry', starter: 'enquiry' });
    formId = created.formId;
    await run(formPublish, { workspaceId, formId, baseRevision: created.revision });
    const version = await one<{ id: string }>(
      sql`select active_version_id as id from app.forms where id = ${formId}`,
    );
    const { personId } = await run(personCreate, {
      workspaceId,
      firstName: 'Rae',
      lastName: 'Form',
    });
    responseId = (
      await one<{ id: string }>(
        sql`insert into app.form_responses (workspace_id, form_id, version_id, status, person_id, completed_at)
            values (${workspaceId}, ${formId}, ${version.id}, 'completed', ${personId}, now())
            returning id`,
      )
    ).id;
  });

  const form = () =>
    one<{ name: string; status: string; slug: string }>(
      sql`select name, status::text as status, slug from app.forms where id = ${formId}`,
    );

  it('renames it and changes its link on Confirm', async () => {
    const rename = await prepare('manage_form', { formId, action: 'rename', name: 'Get a quote' });
    expect(field(rename.card, 'Now')).toBe('Get a quote');
    expect((await form()).name).toBe('Enquiry');
    await commit('manage_form', { formId, action: 'rename', name: 'Get a quote' });
    expect((await form()).name).toBe('Get a quote');

    const link = await prepare('manage_form', { formId, action: 'change_link', link: 'quote-me' });
    expect(field(link.card, 'New link')).toMatch(/\/quote-me$/);
    expect(link.card.warnings[0]!.text).toContain('old link keeps working');
    await commit('manage_form', { formId, action: 'change_link', link: 'quote-me' });
    expect((await form()).slug).toBe('quote-me');
  });

  it('copies it as an empty draft', async () => {
    const { card } = await prepare('manage_form', { formId, action: 'duplicate' });
    expect(field(card, 'The copy')).toBe('Get a quote copy');
    const done = await commit('manage_form', { formId, action: 'duplicate' });
    const copy = await one<{ status: string }>(
      sql`select status::text as status from app.forms where workspace_id = ${workspaceId} and name = 'Get a quote copy'`,
    );
    expect(copy.status).toBe('draft');
    expect(done.href).not.toBe(`/app/w/${workspaceId}/forms/${formId}`);
  });

  it('lists who answered and deletes one response, saying it can’t be undone', async () => {
    const { result } = await read('list_form_responses', { formId });
    const responses = result['responses'] as { responseId: string; who: string }[];
    expect(responses).toEqual([expect.objectContaining({ responseId, who: 'Rae Form' })]);

    const { card } = await prepare('manage_form', {
      formId,
      action: 'delete_response',
      responseId,
    });
    expect(card.title).toBe('Delete Rae Form’s answers to “Get a quote”?');
    expect(caution(card)).toContain('can’t be undone');
    const count = async () =>
      (
        await one<{ n: number }>(
          sql`select count(*)::int as n from app.form_responses where id = ${responseId}`,
        )
      ).n;
    expect(await count()).toBe(1);
    await commit('manage_form', { formId, action: 'delete_response', responseId });
    expect(await count()).toBe(0);
  });

  it('archives a live form with a warning, lists it as archived, and brings it back closed', async () => {
    const { card } = await prepare('manage_form', { formId, action: 'archive' });
    expect(caution(card)).toContain('taking answers now');
    expect((await form()).status).toBe('live');
    await commit('manage_form', { formId, action: 'archive' });
    expect((await form()).status).toBe('archived');

    const archived = await read('list_archived_forms');
    expect(archived.result['forms']).toEqual([
      expect.objectContaining({ formId, name: 'Get a quote', comesBackAs: 'closed' }),
    ]);
    const rename = await prepare('manage_form', { formId, action: 'rename', name: 'Nope' });
    expect(blocked(rename.card)).toContain('Bring it back first');

    const back = await prepare('manage_form', { formId, action: 'restore' });
    expect(field(back.card, 'Comes back')).toContain('Closed');
    await commit('manage_form', { formId, action: 'restore' });
    expect((await form()).status).toBe('closed');
  });
});

// ------------------------------------------------------------------------------------------------

describe('the knowledge base', () => {
  let itemId: string;

  beforeAll(async () => {
    itemId = (
      await run(knowledgeItemCreate, {
        workspaceId,
        status: 'draft',
        content: { kind: 'faq', question: 'Do you do ductwork?', answer: 'Yes.', tags: [] },
      })
    ).itemId;
  });
  const item = () =>
    one<{ body: string; status: string }>(
      sql`select body, status::text as status from app.knowledge_items where id = ${itemId}`,
    );

  it('finds drafts that search_knowledge can’t, and changes, publishes, archives and brings one back', async () => {
    const { result } = await read('list_knowledge_items', { query: 'ductwork' });
    expect(result['items']).toEqual([
      expect.objectContaining({ id: itemId, status: 'draft', title: 'Do you do ductwork?' }),
    ]);

    const change = await prepare('manage_knowledge_item', {
      itemId,
      action: 'change',
      body: 'Yes, repairs and new runs.',
    });
    expect(change.card.body).toBe('Yes, repairs and new runs.');
    expect((await item()).body).toBe('Yes.');
    await commit('manage_knowledge_item', {
      itemId,
      action: 'change',
      body: 'Yes, repairs and new runs.',
    });
    expect((await item()).body).toBe('Yes, repairs and new runs.');

    const back = await prepare('manage_knowledge_item', { itemId, action: 'bring_back' });
    expect(blocked(back.card)).toContain('Publish it instead');
    await commit('manage_knowledge_item', { itemId, action: 'publish' });
    expect((await item()).status).toBe('published');
    await commit('manage_knowledge_item', { itemId, action: 'archive' });
    expect((await item()).status).toBe('archived');
    const again = await prepare('manage_knowledge_item', { itemId, action: 'bring_back' });
    expect(again.card.confirmLabel).toBe('Bring it back');
    await commit('manage_knowledge_item', { itemId, action: 'bring_back' });
    expect((await item()).status).toBe('published');
  });

  it('answers a question customers asked, and rejects a website suggestion', async () => {
    const gap = (
      await one<{ id: string }>(
        sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason, source, group_key)
            values (${workspaceId}, 'faq', ${JSON.stringify({ title: 'Do you work weekends?', body: '', tags: [] })}::jsonb,
              'gap', ${JSON.stringify({ question: 'Do you work weekends?' })}::jsonb, 'weekends')
            returning id`,
      )
    ).id;
    const scan = (
      await one<{ id: string }>(
        sql`insert into app.knowledge_suggestions (workspace_id, kind, proposed, reason, source)
            values (${workspaceId}, 'fact', ${JSON.stringify({ title: 'Service area', body: 'Dallas and Fort Worth', tags: [] })}::jsonb,
              'scan', ${JSON.stringify({ url: 'https://example.com/about' })}::jsonb)
            returning id`,
      )
    ).id;

    const { result } = await read('list_knowledge_suggestions');
    const list = result['suggestions'] as { id: string; proposed: unknown }[];
    expect(list.find((s) => s.id === gap)?.proposed).toEqual({
      customers_asked: 'Do you work weekends?',
    });
    expect(list.find((s) => s.id === scan)?.proposed).toEqual({
      from_the_website: { title: 'Service area', text: 'Dallas and Fort Worth' },
    });

    await expect(
      prepare('decide_knowledge_suggestion', { suggestionId: gap, decision: 'accept' }),
    ).rejects.toMatchObject({ code: 'validation' });
    const args = {
      suggestionId: gap,
      decision: 'accept',
      answer: 'Yes, Saturdays 9 to 3.',
    };
    const { card } = await prepare('decide_knowledge_suggestion', args);
    expect(card.title).toBe('Answer “Do you work weekends?”?');
    expect(card.body).toBe('Yes, Saturdays 9 to 3.');
    await commit('decide_knowledge_suggestion', args);
    const made = await one<{ body: string; status: string }>(
      sql`select body, status::text as status from app.knowledge_items
          where workspace_id = ${workspaceId} and title = 'Do you work weekends?'`,
    );
    expect(made).toEqual({ body: 'Yes, Saturdays 9 to 3.', status: 'published' });

    await prepare('decide_knowledge_suggestion', { suggestionId: scan, decision: 'reject' });
    await commit('decide_knowledge_suggestion', {
      suggestionId: scan,
      decision: 'reject',
      reason: 'We cover Denton too',
    });
    const rejected = await one<{ status: string }>(
      sql`select status::text as status from app.knowledge_suggestions where id = ${scan}`,
    );
    expect(rejected.status).toBe('rejected');
  });

  it('sets the website and starts a scan on Confirm, and won’t start a second one', async () => {
    const { card } = await prepare('scan_website', { website: 'Example.com/' });
    expect(field(card, 'Website')).toBe('https://example.com/');
    const sources = async () =>
      (
        await one<{ n: number }>(
          sql`select count(*)::int as n from app.knowledge_sources where workspace_id = ${workspaceId}`,
        )
      ).n;
    expect(await sources()).toBe(0);
    await commit('scan_website', { website: 'Example.com/' });
    expect(await sources()).toBe(1);
    const scan = await one<{ status: string }>(
      sql`select status::text as status from app.knowledge_scans where workspace_id = ${workspaceId}`,
    );
    expect(scan.status).toBe('queued');

    const again = await prepare('scan_website', {});
    expect(blocked(again.card)).toContain('A scan is already');
  });

  it('adds, changes and takes off an offer', async () => {
    const create = {
      action: 'create',
      name: 'Fall tune-up',
      details: '$89 through October',
      startsOn: '2026-10-01',
      endsOn: '2026-10-31',
    };
    const { card } = await prepare('manage_offer', create);
    expect(field(card, 'Runs')).toBe('Oct 1, 2026 to Oct 31, 2026');
    await commit('manage_offer', create);
    const offers = (await read('list_offers')).result['offers'] as { id: string; name: string }[];
    const offerId = offers.find((o) => o.name === 'Fall tune-up')!.id;

    const change = await prepare('manage_offer', { action: 'change', offerId, endsOn: null });
    expect(field(change.card, 'Runs')).toBe('From Oct 1, 2026, until you take it off');
    await commit('manage_offer', { action: 'change', offerId, endsOn: null });
    const changed = await one<{ ends_on: string | null }>(
      sql`select ends_on::text from app.offers where id = ${offerId}`,
    );
    expect(changed.ends_on).toBeNull();

    const off = await prepare('manage_offer', { action: 'archive', offerId });
    expect(caution(off.card)).toContain('stops mentioning it');
    await commit('manage_offer', { action: 'archive', offerId });
    const gone = await one<{ archived: boolean }>(
      sql`select archived_at is not null as archived from app.offers where id = ${offerId}`,
    );
    expect(gone.archived).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------

describe('workflows and their runs', () => {
  let workflowId: string;
  let versionId: string;
  let personId: string;

  beforeAll(async () => {
    workflowId = (
      await run(workflowCreate, {
        workspaceId,
        name: 'Follow-up call',
        from: 'blank',
        trigger: { kind: 'manual' },
      })
    ).workflowId;
    const saved = await run(workflowSaveDraft, {
      workspaceId,
      workflowId,
      baseRevision: 1,
      ops: [
        {
          op: 'add_step',
          parentId: null,
          branchId: null,
          index: null,
          step: {
            id: 's_fuptask1',
            type: 'action',
            action: 'create_task',
            config: { title: 'Call them back' },
          },
        },
      ],
    });
    await rows(
      admin(),
      sql`update app.workflows set tested_revision = revision where id = ${workflowId}`,
    );
    versionId = (
      await run(workflowPublish, { workspaceId, workflowId, baseRevision: saved.revision })
    ).versionId;
    personId = (await run(personCreate, { workspaceId, firstName: 'Wes', lastName: 'Flow' }))
      .personId;
  });

  const newRun = async (status: string, failed = false) => {
    const r = await one<{ id: string }>(
      sql`insert into app.workflow_runs (workspace_id, workflow_id, version_id, person_id, dedupe_key, status,
            cursor, visits, ended_at)
          values (${workspaceId}, ${workflowId}, ${versionId}, ${personId}, ${randomUUID()},
            ${status}::app.workflow_run_status, 's_fuptask1', '{"s_fuptask1": 1}'::jsonb,
            ${status === 'failed' ? new Date().toISOString() : null})
          returning id`,
    );
    if (failed)
      await rows(
        admin(),
        sql`insert into app.workflow_run_steps (workspace_id, run_id, step_key, status, attempt, error, finished_at)
            values (${workspaceId}, ${r.id}, 's_fuptask1#1', 'failed', 2,
              ${JSON.stringify({ code: 'refused', message: 'Nobody to give the task to' })}::jsonb, now())`,
      );
    return r.id;
  };

  it('lists runs that need attention first, with the failed step and why', async () => {
    const failed = await newRun('failed', true);
    const { result, card } = await read('list_workflow_runs');
    const runs = result['runs'] as Record<string, unknown>[];
    expect(runs[0]).toMatchObject({
      id: failed,
      customer: 'Wes Flow',
      failedStep: expect.stringContaining('Call them back'),
      whatWentWrong: 'Nobody to give the task to',
      canRetryOrSkip: true,
    });
    expect(card?.type).toBe('list');
  });

  it('retries or skips a stuck step on Confirm, and stops a run that is going', async () => {
    const failed = await newRun('failed', true);
    const retry = await prepare('manage_workflow_run', { runId: failed, action: 'retry_step' });
    expect(retry.card.title).toContain('again for Wes Flow');
    expect(field(retry.card, 'What went wrong')).toBe('Nobody to give the task to');
    const asked = async (type: string) =>
      (
        await one<{ n: number }>(
          sql`select count(*)::int as n from app.events where entity_id = ${failed} and event_type = ${type}`,
        )
      ).n;
    expect(await asked('workflow.step_retry_requested')).toBe(0);
    await commit('manage_workflow_run', { runId: failed, action: 'retry_step' });
    expect(await asked('workflow.step_retry_requested')).toBe(1);
    await commit('manage_workflow_run', { runId: failed, action: 'skip_step' });
    expect(await asked('workflow.step_skip_requested')).toBe(1);

    const waiting = await newRun('waiting');
    const noStuck = await prepare('manage_workflow_run', { runId: waiting, action: 'skip_step' });
    expect(blocked(noStuck.card)).toContain('Nothing is stuck');
    const stop = await prepare('manage_workflow_run', { runId: waiting, action: 'stop' });
    expect(caution(stop.card)).toContain('can’t pick up again');
    await commit('manage_workflow_run', { runId: waiting, action: 'stop' });
    const stopped = await one<{ status: string }>(
      sql`select status::text as status from app.workflow_runs where id = ${waiting}`,
    );
    expect(stopped.status).toBe('stopped');
    const again = await prepare('manage_workflow_run', { runId: waiting, action: 'stop' });
    expect(blocked(again.card)).toBe('It has already ended.');
  });

  it('reads a workflow’s steps with their ids, and changes its draft step by step on Confirm', async () => {
    const { result, card } = await read('get_workflow', { workflowId });
    expect(card?.type).toBe('workflow');
    expect(result['steps']).toEqual([
      { id: 's_fuptask1', depth: 0, says: expect.stringContaining('Call them back') },
    ]);
    expect(result['liveVersion']).toBe(1);
    const draftRevision = result['draftRevision'] as number;
    const args = {
      workflowId,
      baseRevision: draftRevision,
      ops: [
        {
          op: 'update_step',
          stepId: 's_fuptask1',
          patch: { config: { title: 'Call them today' } },
        },
      ],
    };
    const title = async () =>
      one<{ title: string; revision: number }>(
        sql`select definition #>> '{steps,0,config,title}' as title, revision
            from app.workflows where id = ${workflowId}`,
      );

    const { card: c } = await prepare('edit_workflow_steps', args);
    expect(c.title).toBe('Change “Follow-up call”?');
    expect(field(c, 'Change')).toContain('Call them today');
    expect(c.warnings[0]?.text).toContain('Version 1 keeps running');
    expect(await title()).toEqual({ title: 'Call them back', revision: draftRevision });
    await commit('edit_workflow_steps', args);
    expect(await title()).toEqual({ title: 'Call them today', revision: draftRevision + 1 });

    // A card drawn on the old draft is refused, and so is a change the draft already has.
    await expect(prepare('edit_workflow_steps', args)).rejects.toMatchObject({
      rule: 'revision_conflict',
    });
    await expect(
      prepare('edit_workflow_steps', { ...args, baseRevision: draftRevision + 1 }),
    ).rejects.toThrow('Nothing would change');
  });

  it('renames a workflow, and archives it with its runs going stopped', async () => {
    await prepare('manage_workflow', { workflowId, action: 'rename', name: 'Call-back' });
    await commit('manage_workflow', { workflowId, action: 'rename', name: 'Call-back' });
    const renamed = await one<{ name: string }>(
      sql`select name from app.workflows where id = ${workflowId}`,
    );
    expect(renamed.name).toBe('Call-back');

    const going = await newRun('waiting');
    const { card } = await prepare('manage_workflow', { workflowId, action: 'archive' });
    expect(field(card, 'Runs going')).toBe('1 run stop now');
    expect(caution(card)).toContain('can’t be brought back');
    await commit('manage_workflow', { workflowId, action: 'archive' });
    const after = await one<{ wf: string; run: string }>(
      sql`select (select status::text from app.workflows where id = ${workflowId}) as wf,
            (select status::text from app.workflow_runs where id = ${going}) as run`,
    );
    expect(after).toEqual({ wf: 'archived', run: 'stopped' });
  });
});

// ------------------------------------------------------------------------------------------------

describe('the AI teammate’s drafts', () => {
  let teammateId: string;
  let personId: string;

  beforeAll(async () => {
    teammateId = (
      await run(aiTeammateCreate, { workspaceId, preset: 'lead_responder', name: 'Ava' })
    ).teammateId;
    personId = (
      await run(personCreate, {
        workspaceId,
        firstName: 'Mike',
        lastName: 'Draft',
        phone: '512-555-0199',
      })
    ).personId;
  });

  const draft = async (kind: 'reply' | 'approval', preview: Record<string, unknown>) =>
    (
      await one<{ id: string }>(
        sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, person_id, kind, preview, client_id, expires_at)
            values (${workspaceId}, ${teammateId}, ${personId}, ${kind}, ${JSON.stringify(preview)}::jsonb,
              ${`ai:${randomUUID()}`}, now() + interval '2 hours')
            returning id`,
      )
    ).id;
  const row = (id: string) =>
    one<{ status: string; edits: unknown; reason: string | null }>(
      sql`select status::text as status, edits, reason from app.ai_teammate_drafts where id = ${id}`,
    );

  it('lists what waits, with the teammate’s words marked as data', async () => {
    const id = await draft('reply', {
      message: { channel: 'sms', body: 'Hi Mike, we have Tuesday at 10 open.' },
      actions: [],
    });
    const { result } = await read('list_teammate_drafts', {}, member);
    const drafts = result['drafts'] as Record<string, unknown>[];
    expect(drafts.find((d) => d['id'] === id)).toMatchObject({
      what: 'Ava’s text to Mike Draft',
      drafted: { ai_teammate_wrote: { words: 'Hi Mike, we have Tuesday at 10 open.' } },
      canDecide: true,
    });
  });

  it('approves with the person’s own words on Confirm, saying it goes out at once', async () => {
    const id = await draft('reply', {
      message: { channel: 'sms', body: 'Hi Mike, we have Tuesday at 10 open.' },
      actions: [],
    });
    const args = {
      draftId: id,
      decision: 'approve',
      message: 'Hi Mike, Tuesday at 10 works. See you then!',
    };
    const { card } = await prepare('decide_teammate_draft', args, member);
    expect(card.title).toBe('Send Ava’s text to Mike Draft?');
    expect(card.body).toBe('Hi Mike, Tuesday at 10 works. See you then!');
    expect(field(card, 'Edited')).toBe('Your words go instead of the AI’s');
    expect(caution(card)).toContain('goes to Mike as soon as you confirm');
    expect((await row(id)).status).toBe('pending');
    await commit('decide_teammate_draft', args, member);
    expect(await row(id)).toMatchObject({
      status: 'approved',
      edits: { body: 'Hi Mike, Tuesday at 10 works. See you then!' },
    });
  });

  it('rejects with a reason, and keeps a discount for owners and admins', async () => {
    const id = await draft('reply', {
      message: { channel: 'sms', body: 'We can do it for free!' },
      actions: [],
    });
    await prepare('decide_teammate_draft', { draftId: id, decision: 'reject' });
    await commit('decide_teammate_draft', {
      draftId: id,
      decision: 'reject',
      reason: 'We never do free visits',
    });
    expect(await row(id)).toMatchObject({ status: 'rejected', reason: 'We never do free visits' });

    const discount = await draft('approval', {
      message: { channel: 'sms', body: 'Good news: 10% off your repair.' },
      actions: [],
      discount: { percent: 10, reason: 'Repeat customer' },
    });
    const forMember = await prepare(
      'decide_teammate_draft',
      { draftId: discount, decision: 'approve' },
      member,
    );
    expect(forMember.card.confirmLabel).toBe('');
    expect(blocked(forMember.card)).toContain('Only owners and admins');
    const forOwner = await prepare('decide_teammate_draft', {
      draftId: discount,
      decision: 'approve',
    });
    expect(forOwner.card.title).toBe('Approve 10% off for Mike Draft?');
    expect(field(forOwner.card, 'Discount')).toBe('10% off: Repeat customer');
  });
  it('won’t approve a reply the customer has written past, and shows what they last said', async () => {
    const conversation = await one<{ id: string }>(
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
          values (${workspaceId}, 'sms', '+15125550199', ${personId})
          returning id`,
    );
    const said = (body: string, at: string) =>
      rows(
        admin(),
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text,
              from_address, occurred_at)
            values (${workspaceId}, ${conversation.id}, 'sms', 'inbound', 'received', ${body},
              '+15125550199', ${at}::timestamptz)`,
      );
    await said('Can you come Tuesday?', new Date(Date.now() - 60_000).toISOString());
    const id = (
      await one<{ id: string }>(
        sql`insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, person_id, kind,
              preview, client_id, expires_at)
            values (${workspaceId}, ${teammateId}, ${conversation.id}, ${personId}, 'reply',
              ${JSON.stringify({ message: { channel: 'sms', body: 'Yes, Tuesday at 10.' }, actions: [] })}::jsonb,
              ${`ai:${randomUUID()}`}, now() + interval '2 hours')
            returning id`,
      )
    ).id;
    const before = await prepare('decide_teammate_draft', { draftId: id, decision: 'approve' });
    expect(field(before.card, 'They wrote')).toBe('Can you come Tuesday?');
    expect(before.card.confirmLabel).toBe('Approve and send');

    await said('Actually, Wednesday is better.', new Date(Date.now() + 60_000).toISOString());
    const after = await prepare('decide_teammate_draft', { draftId: id, decision: 'approve' });
    expect(after.card.confirmLabel).toBe('');
    expect(blocked(after.card)).toContain('Mike wrote again after this draft');
    expect(field(after.card, 'They wrote')).toBe('Actually, Wednesday is better.');
  });
});
