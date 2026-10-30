import { randomUUID } from 'node:crypto';
import {
  aiTeammateCreate,
  assistantToolByName,
  AUTOMATIONS,
  DEFAULT_MENU,
  executeCommand,
  executeQuery,
  formCreate,
  formPublish,
  hasWorkspacePermission,
  knowledgePackCreate,
  menuOf,
  organizationCreate,
  pushSwitchesOf,
  guessStageRole,
  registry,
  sameMenu,
  STAGE_ROLE_LABELS,
  workflowTemplateCreate,
  workflowTemplatePublish,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import { extraAutoTools, extraConfirmTools, extraStepLabels } from '../src/assistant/tools-extra';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * The rest of what people do on the screens, by asking: the AI teammate's finer rules, Settings → Automations,
 * their own alerts and side menu, Ideas, Get help, adding a business and the agency area. Each confirm tool shows
 * its card, changes nothing until Confirm, and then does exactly what the card said, through the screen's command.
 */

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
  u: TestUser,
) =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test' as const,
    })
  ).output;

let owner: TestUser;
let priya: TestUser;
let workspaceId: string;
let organizationId: string;
let stageId: string;
const mark = randomUUID().slice(0, 8);

const ctxFor = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
const prepare = async (name: string, args: Record<string, unknown>, u: TestUser = owner) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const out = await createToolExecutor(api()).prepare(tool, parsed, ctxFor(u), randomUUID());
  return { card: out.card as ConfirmCard, result: out.result as Record<string, unknown>, parsed };
};
const confirm = (name: string, parsed: Record<string, unknown>, u: TestUser = owner) =>
  createToolExecutor(api()).commit(assistantToolByName.get(name)!, parsed, ctxFor(u), {
    toolCallId: randomUUID(),
  });
const read = async (name: string, args: Record<string, unknown>, u: TestUser = owner) => {
  const tool = assistantToolByName.get(name)!;
  const out = await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctxFor(u));
  return out as { result: Record<string, unknown>; card?: AssistantCard | null };
};
const field = (card: ConfirmCard, label: string) => card.fields.find((f) => f.label === label);
const q = async <T>(name: string, input: Record<string, unknown> = {}, u: TestUser = owner) =>
  (await executeQuery(api(), registry.query(name)!, { workspaceId, ...input }, actor(u), {
    correlationId: randomUUID(),
    channel: 'test' as const,
  })) as T;

/** Stored settings documents, read loosely: the assertions say what they expect of them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
interface Teammate {
  teammate: { name: string; revision: number; config: Doc };
}
const teammate = () => q<Teammate>('ai_teammate.get').then((t) => t.teammate);
const settings = () =>
  q<{ workspace: { settings: Doc } }>('workspace.get').then((w) => w.workspace.settings);
const me = (u: TestUser = owner) =>
  q<{
    user: { settings: Doc };
    workspaces: { id: string; name: string; organizationId: string }[];
  }>('account.me', {}, u);

beforeAll(async () => {
  owner = await createTestUser('aext-dale', { fullName: 'Dale Owner' });
  priya = await createTestUser('aext-priya', { fullName: 'Priya Admin' });
  const org = (await run(
    organizationCreate,
    { businessName: `Extra HVAC ${mark}`, timezone: CHI },
    owner,
  )) as { workspaceId: string; organizationId: string };
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  // An admin of the business who is not an owner or admin of its organization.
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${workspaceId}, ${priya.id}, 'admin')`,
  );
  await run(aiTeammateCreate, { workspaceId, preset: 'lead_responder', name: 'Ava' }, owner);
  const { pipelines } = await q<{ pipelines: { stages: { id: string }[] }[] }>('pipeline.list');
  stageId = pipelines[0]!.stages[1]!.id;
}, 60_000);

afterAll(closeTestDbs);

describe('the extra tools', () => {
  it('each has an executor, a step label, and goes only to the roles its commands allow', () => {
    const names = [...Object.keys(extraAutoTools), ...Object.keys(extraConfirmTools)];
    expect(names).toHaveLength(12);
    for (const name of names) {
      const tool = assistantToolByName.get(name);
      expect(tool, name).toBeTruthy();
      expect(extraStepLabels[name], name).toBeTruthy();
      expect(tool!.autonomy, name).toBe(name in extraAutoTools ? 'auto' : 'confirm');
    }
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    for (const name of [
      'update_my_alerts',
      'arrange_my_menu',
      'find_ideas',
      'manage_idea',
      'contact_support',
    ])
      expect(member, name).toContain(name);
    for (const name of [
      'update_ai_teammate_rules',
      'list_automations',
      'update_automations',
      'add_business',
      'get_agency_area',
      'edit_template_steps',
      'push_to_client_businesses',
    ])
      expect(member, name).not.toContain(name);
  });
});

describe('the AI teammate’s finer rules', () => {
  it('turns on Qualify with two questions, shows them, and saves only on Confirm', async () => {
    const before = await teammate();
    const { card, parsed } = await prepare('update_ai_teammate_rules', {
      qualifies: true,
      addQuestions: [
        { question: 'Do you own the home?', kind: 'yes_no', notAFitAnswers: ['No'] },
        { question: 'What is your budget?', kind: 'number', notAFitBelow: 1000 },
      ],
      qualifiedLeadStageId: stageId,
      qualifiedTell: 'owners_and_admins',
      tellTeamWhenNotAFit: false,
    });
    expect(card.title).toBe('Change Ava’s rules');
    expect(field(card, 'Qualifies leads')!.value).toBe('off → on');
    expect(card.fields.filter((f) => f.label === 'New question').map((f) => f.value)).toEqual([
      '“Do you own the home?” · yes or no · not a fit: no',
      '“What is your budget?” · number · not a fit below 1000',
    ]);
    expect(field(card, 'Who hears about qualified leads')!.value).toBe(
      'no one → owners and admins',
    );
    expect((await teammate()).revision).toBe(before.revision);

    await confirm('update_ai_teammate_rules', parsed);
    const after = await teammate();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.name).toBe('Ava');
    const qualify = after.config['qualify'];
    expect(qualify.enabled).toBe(true);
    expect(qualify.questions.map((x: { kind: string }) => x.kind)).toEqual(['yes_no', 'number']);
    expect(qualify.questions[0].notAFitIf.answers).toEqual(['no']);
    expect(qualify.whenQualified).toMatchObject({ stageId, notify: { kind: 'admins' } });
    expect(qualify.whenNotAFit.tellTeam).toBe(false);
    // Everything else stays as it was.
    expect(after.config['respond']).toEqual(before.config['respond']);
    expect(after.config['followUp']).toEqual(before.config['followUp']);
  });

  it('changes a question’s kind, keeps what fits, and removes another', async () => {
    const [own, budget] = (await teammate()).config['qualify'].questions as { id: string }[];
    const { card, parsed } = await prepare('update_ai_teammate_rules', {
      changeQuestions: [
        { questionId: own!.id, kind: 'choice', choices: ['Own', 'Rent'], notAFitAnswers: ['Rent'] },
      ],
      removeQuestionIds: [budget!.id],
    });
    expect(field(card, 'Changed question')!.value).toBe(
      '“Do you own the home?” · choice · Own / Rent · not a fit: Rent',
    );
    expect(field(card, 'Removed question')!.value).toBe('“What is your budget?”');
    await confirm('update_ai_teammate_rules', parsed);
    const questions = (await teammate()).config['qualify'].questions;
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: own!.id,
      kind: 'choice',
      options: ['Own', 'Rent'],
      notAFitIf: { answers: ['Rent'], below: null, above: null },
    });
  });

  it('sets limits, hand-off, phone calls, identity and autonomy in one go', async () => {
    const { card, parsed } = await prepare('update_ai_teammate_rules', {
      repliesPerCustomerPerDay: 5,
      discounts: 'with_approval',
      largestDiscountPercent: 15,
      addSensitiveTopics: ['Insurance claims'],
      handOffText: false,
      handOffMessage: 'Thanks! I’ve passed this on, and {expectation}.',
      answersPhoneCalls: true,
      phoneVoice: 'calm',
      emailSignature: 'Ava (AI) · Extra HVAC',
      approvalsBeforeAutomatic: 30,
      draftsExpireAfterMinutes: 240,
    });
    expect(field(card, 'Replies per conversation a day')!.value).toBe('12 → 5');
    expect(field(card, 'Discounts')!.value).toBe('never → with approval');
    expect(card.fields.at(-1)).toEqual({ label: 'And', value: '2 more changes' });
    // Texting isn't set up in this business, so there are no calls to answer yet; money waits for an OK.
    expect(card.warnings.map((w) => w.kind)).toEqual(['caution', 'note', 'note']);
    expect(card.warnings[0]!.text).toContain('business number isn’t set up yet');
    expect(card.warnings[1]!.text).toContain('waits for an owner’s or admin’s OK');
    await confirm('update_ai_teammate_rules', parsed);
    const c = (await teammate()).config;
    expect(c['limits'].repliesPerConversationPerDay).toBe(5);
    expect(c['money']).toMatchObject({ discounts: 'with_approval', maxPercent: 15 });
    expect(c['handOff'].sensitiveTopics).toEqual(['Insurance claims']);
    expect(c['handOff'].alerts).toEqual({ push: true, text: false, email: false });
    // Straight apostrophes for what a customer reads by text.
    expect(c['handOff'].tellCustomer).toBe("Thanks! I've passed this on, and {expectation}.");
    expect(c['phone']).toMatchObject({ enabled: true, voice: 'calm', answer: 'no_answer' });
    expect(c['identity'].signature).toBe('Ava (AI) · Extra HVAC');
    expect(c['autonomy']).toEqual({ approvalsNeeded: 30, draftExpiresMinutes: 240 });
  });

  it('lists each phone call change once, in the words its history uses', async () => {
    const { card } = await prepare('update_ai_teammate_rules', {
      answersPhoneCalls: false,
      phonePicksUp: 'always',
      phoneVoice: 'bright',
      phoneGreeting: 'Thanks for calling Extra HVAC!',
    });
    expect(card.fields).toEqual([
      { label: 'Phone calls', value: 'on → off' },
      { label: 'Answers calls', value: 'when nobody picks up → every call' },
      { label: 'Phone voice', value: 'Calm → Bright' },
      { label: 'Phone greeting', value: 'Thanks for calling Extra HVAC!' },
    ]);
  });

  it('says what is wrong instead of saving something the settings refuse', async () => {
    await expect(
      prepare('update_ai_teammate_rules', {
        addQuestions: [{ question: 'Which one?', kind: 'choice', choices: ['Only one'] }],
      }),
    ).rejects.toThrow('Add at least two choices.');
    await expect(
      prepare('update_ai_teammate_rules', { removeQuestionIds: ['nope'] }),
    ).rejects.toThrow('No question with the id nope');
    await expect(
      prepare('update_ai_teammate_rules', { removeSensitiveTopics: ['Refunds'] }),
    ).rejects.toThrow('isn’t one of its topics');
    await expect(
      prepare('update_ai_teammate_rules', { qualifiedLeadStageId: randomUUID() }),
    ).rejects.toThrow('No open stage with that id');
    await expect(
      prepare('update_ai_teammate_rules', { repliesPerCustomerPerDay: 5 }),
    ).rejects.toThrow('Nothing would change.');
  });
});

describe('Settings → Automations', () => {
  it('lists every automation with its id and where it stands', async () => {
    const { result } = await read('list_automations', {});
    const list = result['automations'] as { id: string; on: boolean; [k: string]: unknown }[];
    expect(list.map((a) => a.id)).toEqual(AUTOMATIONS.map((a) => a.id));
    expect(list.find((a) => a.id === 'day_before_confirmation')!.on).toBe(true);
    expect(list.find((a) => a.id === 'reengage_dead_leads')).toMatchObject({
      on: false,
      messageReadFirst: expect.any(String),
    });
    expect(list.find((a) => a.id === 'drafts_awaiting_review')!['alwaysOn']).toBe(true);
    const leads = await read('list_automations', { group: 'leads' });
    expect((leads.result['automations'] as unknown[]).length).toBeLessThan(list.length);
  });

  it('switches rows wherever their switch lives, and the timings, only on Confirm', async () => {
    const { card, parsed } = await prepare('update_automations', {
      turnOff: [
        'day_before_confirmation',
        'waitlist_slot_opened',
        'morning_brief',
        'hot_lead_alert',
        'never_replied',
      ],
      endOfDayEmailAt: '19:30',
      whenVoicemailAnswers: 'hang_up',
      askForOkToCall: true,
      callLeadsFrom: '10:00',
      callLeadsUntil: '18:00',
      callTries: 2,
    });
    expect(card.title).toBe('Change your automations');
    expect(field(card, 'Ask for an OK to call')!.value).toBe('On');
    expect(field(card, 'Calling hours for leads')!.value).toBe(
      '10:00 AM to 6:00 PM, in each lead’s own time',
    );
    expect(field(card, 'When a lead doesn’t answer')!.value).toBe('Try up to 2 times, a day apart');
    expect(field(card, 'Day-before confirmation')!.value).toBe('Off');
    expect(field(card, 'Hot lead alert')!.value).toBe('Off');
    expect(field(card, 'End-of-day email at')!.value).toBe('19:30');
    expect(card.confirmLabel).toBe('Save the change');
    expect((await settings())['automations']).toBeUndefined();

    await confirm('update_automations', parsed);
    const s = await settings();
    expect(s['automations'].switches).toMatchObject({
      dayBefore: false,
      waitlist: false,
      morningBrief: false,
      dayOf: true,
    });
    expect(s['automations'].briefings.eveningAt).toBe('19:30');
    expect(s['automations'].calls).toMatchObject({
      voicemail: 'hang_up',
      askConsent: true,
      hours: { start: '10:00', end: '18:00', weekends: true },
      tries: 2,
      businessLandlines: false,
    });
    // Never wider than the law allows.
    await expect(prepare('update_automations', { callLeadsFrom: '07:00' })).rejects.toThrow(
      'Calls can’t start before 8 AM',
    );
    expect(s['attention'].kinds.hot_lead).toBe(false);
    expect(s['attention'].kinds.unanswered_lead).toBe(true);
    expect((await teammate()).config['followUp'].neverReplied).toBe(false);
  });

  it('turns on calling business landlines with what each check costs on the card', async () => {
    const { card, parsed } = await prepare('update_automations', { callBusinessLandlines: true });
    // As Settings → Automations shows it, from the live prices.
    expect(card.fields).toEqual([
      {
        label: 'Call business landlines without a yes',
        value:
          'On. Each check is charged to your balance: $0.02 to check what kind of line a number is, and $0.02 more to check who a landline belongs to',
      },
    ]);
    await confirm('update_automations', parsed);
    expect((await settings())['automations'].calls.businessLandlines).toBe(true);
  });

  it('says so when turning one on reaches customers, and what it still needs', async () => {
    const { card, parsed } = await prepare('update_automations', {
      turnOn: ['day_before_confirmation', 'intake_questions'],
    });
    // Intake questions is on by default, so only the reminder changes.
    expect(card.fields).toEqual([{ label: 'Day-before confirmation', value: 'On' }]);
    expect(card.warnings[0]).toMatchObject({ kind: 'caution' });
    expect(card.warnings[0]!.text).toContain('Day-before confirmation reaches customers');
    await confirm('update_automations', parsed);
    expect((await settings())['automations'].switches.dayBefore).toBe(true);
  });

  it('turns on re-engaging dead leads the first time with its message on the card, but never turns off what’s always on', async () => {
    const reengage = await prepare('update_automations', { turnOn: ['reengage_dead_leads'] });
    expect(reengage.card.confirmLabel).toBe('Save the change');
    expect(reengage.card.warnings[0]).toMatchObject({ kind: 'caution' });
    expect(reengage.card.warnings[0]!.text).toContain('Looks good, turn on');
    const message = field(reengage.card, 'Re-engage message')?.value;
    expect(message).toBeTruthy();
    expect((await settings())['automations'].switches.reengage).toBe(false);
    await confirm('update_automations', reengage.parsed);
    const after = (await settings())['automations'];
    expect(after.switches.reengage).toBe(true);
    expect(after.reengage.reviewedAt).toBeTruthy();
    expect(after.reengage.template).toBe(message);
    // Back as it was, unread, for the tests after.
    await rows(
      admin(),
      sql`update app.workspaces set settings = jsonb_set(jsonb_set(settings,
            '{automations,switches,reengage}', 'false'::jsonb), '{automations,reengage,reviewedAt}', 'null'::jsonb)
          where id = ${workspaceId}`,
    );

    const locked = await prepare('update_automations', { turnOff: ['drafts_awaiting_review'] });
    expect(locked.card.confirmLabel).toBe('');
    expect(locked.card.warnings[0]!.text).toBe('Drafts awaiting review is always on.');
  });

  it('changes re-engaging’s timing and message without turning it on', async () => {
    const { card, parsed } = await prepare('update_automations', {
      reengageAfterDays: 120,
      reengageMessage: 'Hi {firstName}, it’s {businessName}. Still thinking about {leadTitle}?',
    });
    expect(field(card, 'Re-engage: gone cold after')!.value).toBe('120 days');
    // Off, so nobody gets it yet: no warning about reaching customers.
    expect(card.warnings).toEqual([]);
    await confirm('update_automations', parsed);
    const r = (await settings())['automations'];
    expect(r.reengage).toMatchObject({
      afterDays: 120,
      template: "Hi {firstName}, it's {businessName}. Still thinking about {leadTitle}?",
      reviewedAt: null,
    });
    expect(r.switches.reengage).toBe(false);
    await expect(
      prepare('update_automations', { reengageMessage: 'Hi {name}, still keen?' }),
    ).rejects.toThrow('can’t be filled in');
    await expect(
      prepare('update_automations', { turnOff: ['day_of_reminder'], turnOn: ['day_of_reminder'] }),
    ).rejects.toThrow('not both');
  });

  it('changes the maintenance plan text, what a stage means and how the business tags, only on Confirm', async () => {
    const { pipelines } = await q<{
      pipelines: { name: string; stages: { id: string; name: string; kind: string }[] }[];
    }>('pipeline.list');
    const stage = pipelines[0]!.stages.find((st) => st.kind === 'open')!;
    const guess = guessStageRole(stage.name) ?? 'none';
    const pick = guess === 'quoted' ? 'booked' : 'quoted';
    const planText = 'Hi {firstName}, your {service} is due and your {plan} covers it: {link}';
    const guide = 'VIP: has spent over $2,000 with us. Commercial: a business, not a home.';
    const { card, parsed } = await prepare('update_automations', {
      maintenancePlanMessage: planText,
      stageMeanings: [{ stageId: stage.id, means: pick }],
      howYouTag: guide,
    });
    expect(field(card, 'For customers on a maintenance plan')!.value).toBe(planText);
    expect(field(card, `${stage.name} (${pipelines[0]!.name})`)!.value).toBe(
      STAGE_ROLE_LABELS[pick],
    );
    expect(field(card, 'How you tag customers')!.value).toBe(guide);
    // Maintenance due is on, so the new words go to customers on their own.
    expect(card.warnings[0]!.text).toContain('The maintenance due text reaches customers');
    expect((await settings())['automations'].contactAi?.guide ?? '').toBe('');

    await confirm('update_automations', parsed);
    const a = (await settings())['automations'];
    expect(a.maintenance.planTemplate).toBe(planText);
    expect(a.pipeline.roles).toEqual({ [stage.id]: pick });
    expect(a.contactAi.guide).toBe(guide);
    const { result } = await read('list_automations', {});
    expect(result['howYouTag']).toBe(guide);
    expect(
      (result['stageMeanings'] as { stageId: string; means: string }[]).find(
        (st) => st.stageId === stage.id,
      )!.means,
    ).toBe(STAGE_ROLE_LABELS[pick]);

    // Set back to the guess from its name, the pick goes, as on the page.
    const back = await prepare('update_automations', {
      stageMeanings: [{ stageId: stage.id, means: guess }],
    });
    await confirm('update_automations', back.parsed);
    expect((await settings())['automations'].pipeline.roles).toEqual({});
    await expect(
      prepare('update_automations', { maintenanceMessage: 'Your {service} is due soon.' }),
    ).rejects.toThrow('Put {link} where the booking link goes');
    await expect(
      prepare('update_automations', {
        stageMeanings: [{ stageId: randomUUID(), means: 'booked' }],
      }),
    ).rejects.toThrow('No open stage with that id');
  });
});

describe('Settings → Migrations', () => {
  it('pauses and carries on a move from another CRM on Confirm, warns before one starts, and never deletes one', async () => {
    const tools = allScreenActionTools();
    const named = (name: string) => tools.find((t) => t.name === name);
    expect(named('do_migration_pause')!.permission).toBe('migrations.manage');
    expect(named('do_migration_start')!.warning).toContain('Roll back');
    expect(named('do_migration_map_scopes')!.warning).toContain('new business');
    expect(named('do_migration_delete')).toBeUndefined();
    expect(named('do_migration_rollback')).toBeUndefined();

    const [connection] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.migration_connections (organization_id, workspace_id, source_system, status, adapter_version)
          values (${organizationId}, ${workspaceId}, 'gohighlevel', 'active', 1) returning id`,
    );
    const [migration] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.migrations (organization_id, connection_id, source_system, status, name, adapter_version)
          values (${organizationId}, ${connection!.id}, 'gohighlevel', 'importing'::app.migration_status,
            ${`Off GoHighLevel ${mark}`}, 1)
          returning id`,
    );
    const status = async () =>
      (
        await rows<{ status: string }>(
          admin(),
          sql`select status::text as status from app.migrations where id = ${migration!.id}`,
        )
      )[0]!.status;
    const exec = createToolExecutor(api());
    const args = { migrationId: migration!.id };

    const pause = named('do_migration_pause')!;
    const card = await exec.prepare(pause, args, ctxFor(owner), randomUUID());
    expect(card.card?.type).toBe('confirm');
    expect(await status()).toBe('importing');
    await exec.commit(pause, args, ctxFor(owner), { toolCallId: randomUUID() });
    expect(await status()).toBe('paused');

    const resume = named('do_migration_resume')!;
    await exec.prepare(resume, args, ctxFor(owner), randomUUID());
    await exec.commit(resume, args, ctxFor(owner), { toolCallId: randomUUID() });
    expect(await status()).toBe('importing');
  });
});

describe('the form Intake questions sends', () => {
  it('picks a live form, and says the automation now reaches customers', async () => {
    const created = (await run(
      formCreate,
      { workspaceId, name: `Intake ${mark}`, starter: 'enquiry' },
      owner,
    )) as { formId: string; revision: number };
    await expect(prepare('update_automations', { intakeFormId: created.formId })).rejects.toThrow(
      'isn’t live yet',
    );
    await run(
      formPublish,
      { workspaceId, formId: created.formId, baseRevision: created.revision },
      owner,
    );
    const { card, parsed } = await prepare('update_automations', { intakeFormId: created.formId });
    expect(card.fields).toEqual([{ label: 'Intake form', value: `Intake ${mark}` }]);
    expect(card.warnings[0]!.text).toContain('Intake questions reaches customers');
    expect((await settings())['automations'].intake.formId).toBeNull();
    await confirm('update_automations', parsed);
    expect((await settings())['automations'].intake.formId).toBe(created.formId);
    const { result } = await read('list_automations', {});
    expect(result['intakeForm']).toBe(`Intake ${mark}`);
    await expect(prepare('update_automations', { intakeFormId: randomUUID() })).rejects.toThrow(
      'No form with that id',
    );
  });
});

describe('your own alerts and side menu', () => {
  it('turns phone alerts on and off one kind at a time, and the agency digest', async () => {
    const { card, parsed } = await prepare('update_my_alerts', {
      turnOn: ['payment'],
      turnOff: ['missedCall'],
      agencyDigestEmail: false,
    });
    expect(card.fields).toEqual([
      { label: 'Phone alert: A call nobody took', value: 'Off' },
      { label: 'Phone alert: A customer pays', value: 'On' },
      { label: 'Email: Daily agency digest', value: 'No' },
    ]);
    // Nobody here has signed in on the phone app.
    expect(card.warnings[0]!.text).toContain('phone alerts start once you are');
    expect((await me()).user.settings['push']).toBeUndefined();

    await confirm('update_my_alerts', parsed);
    const after = (await me()).user.settings;
    expect(Object.keys(after['push'])).toHaveLength(14);
    expect(pushSwitchesOf(after)).toMatchObject({ payment: true, missedCall: false, urgent: true });
    expect(after['notifications']).toEqual({ agencyDigest: false });
    await expect(prepare('update_my_alerts', { turnOn: ['payment'] })).rejects.toThrow(
      'Nothing would change.',
    );
  });

  it('hides and shows places, and never hides Home or Settings', async () => {
    const hide = await prepare('arrange_my_menu', {
      action: 'hide',
      places: ['audit', 'campaigns'],
    });
    expect(field(hide.card, 'Hide')!.value).toBe('Audit log and Campaigns');
    expect(field(hide.card, 'Your menu')!.value).toBe('15 in the menu · 2 hidden');
    expect((await me()).user.settings['menu']).toBeUndefined();
    // The web's menu reads the saved menu again once this is confirmed, so there's no reload to ask for.
    expect((await confirm('arrange_my_menu', hide.parsed)).outcome).toBe('Menu saved');
    expect(menuOf((await me()).user.settings).hidden).toEqual(['audit', 'campaigns']);

    const home = await prepare('arrange_my_menu', { action: 'hide', places: ['home'] });
    expect(home.card.confirmLabel).toBe('');
    expect(home.card.warnings[0]).toEqual({
      kind: 'blocked',
      text: 'Home always stays in the menu.',
    });

    const show = await prepare('arrange_my_menu', { action: 'show', places: ['audit'] });
    await confirm('arrange_my_menu', show.parsed);
    expect(menuOf((await me()).user.settings).hidden).toEqual(['campaigns']);
  });

  it('uses the suggested groups, then starts over', async () => {
    const suggested = await prepare('arrange_my_menu', { action: 'use_suggested' });
    expect(field(suggested.card, 'In More')!.value).toContain('Workflows');
    expect(suggested.card.warnings[0]!.text).toContain('hidden places come back');
    await confirm('arrange_my_menu', suggested.parsed);
    const menu = menuOf((await me()).user.settings);
    expect(menu.entries.some((e) => e.kind === 'group' && e.label === 'More')).toBe(true);
    expect(menu.hidden).toEqual([]);

    const over = await prepare('arrange_my_menu', { action: 'start_over' });
    await confirm('arrange_my_menu', over.parsed);
    expect(sameMenu(menuOf((await me()).user.settings), DEFAULT_MENU)).toBe(true);
    await expect(prepare('arrange_my_menu', { action: 'start_over' })).rejects.toThrow(
      'Nothing would change.',
    );
  });
});

describe('Ideas', () => {
  const title = `Text invoices with a pay link ${mark}`;
  let ideaId: string;

  it('shares an idea on Confirm, with the areas to pick from', async () => {
    const board = await read('find_ideas', {});
    expect(board.result['areas']).toContainEqual({ id: 'money', name: 'Money' });

    const { card, parsed } = await prepare('manage_idea', {
      action: 'share',
      title,
      details: 'So customers pay from their phone.',
      areaId: 'money',
    });
    expect(card.title).toBe('Share this idea with HandsFreeOS?');
    expect(field(card, 'About')!.value).toBe('Money');
    expect(card.warnings[0]!.text).toContain('Other businesses on HandsFreeOS can see it');
    const found = await read('find_ideas', { search: mark });
    expect(found.result['count']).toBe(0);

    const done = await confirm('manage_idea', parsed);
    expect(done.outcome).toMatch(/^Thanks — that’s idea #\d+/);
    const mine = await read('find_ideas', { search: mark });
    const ideas = mine.result['ideas'] as { id: string; youVoted: boolean; words: unknown }[];
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.youVoted).toBe(true);
    // What people wrote comes back as their words.
    expect(ideas[0]!.words).toEqual({
      someone_wrote: `${title} — So customers pay from their phone.`,
    });
    ideaId = ideas[0]!.id;
    await expect(
      prepare('manage_idea', { action: 'share', title: 'Something', areaId: 'nowhere' }),
    ).rejects.toThrow('isn’t one of the areas an idea can be about');
  });

  it('votes and takes the vote back, as someone else', async () => {
    const vote = await prepare('manage_idea', { action: 'vote', ideaId }, priya);
    expect(vote.card.title).toMatch(/^Vote for #\d+ “Text invoices/);
    expect(field(vote.card, 'Votes now')!.value).toBe('1 vote');
    await confirm('manage_idea', vote.parsed, priya);
    const idea = () =>
      read('find_ideas', { ideaId }, priya).then(
        (r) => r.result['idea'] as Record<string, unknown>,
      );
    expect(await idea()).toMatchObject({ votes: 2, youVoted: true });
    await expect(prepare('manage_idea', { action: 'vote', ideaId }, priya)).rejects.toThrow(
      'Nothing would change.',
    );

    const back = await prepare('manage_idea', { action: 'unvote', ideaId }, priya);
    await confirm('manage_idea', back.parsed, priya);
    expect(await idea()).toMatchObject({ votes: 1, youVoted: false });
  });

  it('comments, and stops following', async () => {
    const comment = await prepare('manage_idea', {
      action: 'comment',
      ideaId,
      comment: 'We would use it every day.',
    });
    expect(field(comment.card, 'Your comment')!.value).toBe('We would use it every day.');
    await confirm('manage_idea', comment.parsed);
    const got = await read('find_ideas', { ideaId });
    expect(got.result['comments']).toEqual([
      {
        by: 'You',
        on: expect.any(String),
        words: { someone_wrote: 'We would use it every day.' },
      },
    ]);

    // Sharing follows an idea on its own.
    await expect(prepare('manage_idea', { action: 'follow', ideaId })).rejects.toThrow(
      'Nothing would change.',
    );
    const stop = await prepare('manage_idea', { action: 'unfollow', ideaId });
    expect(stop.card.title).toMatch(/^Stop the emails about #\d+/);
    await confirm('manage_idea', stop.parsed);
    const after = await read('find_ideas', { ideaId });
    expect((after.result['idea'] as Record<string, unknown>)['youFollow']).toBe(false);
  });
});

describe('Get help', () => {
  const tickets = async () =>
    (
      await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from platform.tickets where workspace_id = ${workspaceId}`,
      )
    )[0]!.n;

  it('sends a request to a person at HandsFreeOS on Confirm', async () => {
    const { card, parsed } = await prepare('contact_support', {
      subject: 'Reminders stopped',
      details: 'The day-before texts stopped going out on Monday.',
    });
    expect(card.title).toBe('Send this to HandsFreeOS support?');
    expect(field(card, 'In a few words')!.value).toBe('Reminders stopped');
    expect(card.confirmLabel).toBe('Send it');
    expect(await tickets()).toBe(0);
    const done = await confirm('contact_support', parsed);
    expect(done.outcome).toMatch(/^Got it — that is ticket #\d+/);
    expect(await tickets()).toBe(1);
  });

  it('won’t send a card number or a password', async () => {
    for (const details of [
      'My card 4242 4242 4242 4242 was declined.',
      'My password is hunter2, why can’t I get in?',
    ]) {
      const { card, parsed } = await prepare('contact_support', { details });
      expect(card.confirmLabel).toBe('');
      expect(card.warnings[0]!.kind).toBe('blocked');
      await expect(confirm('contact_support', parsed)).rejects.toThrow('Take out');
    }
    expect(await tickets()).toBe(1);
  });
});

describe('adding a business, and the agency area', () => {
  const name = `Bayou Plumbing ${mark}`;
  let newId: string;
  let templateId: string;
  let packId: string;

  it('adds a business for a client on Confirm', async () => {
    const { card, parsed } = await prepare('add_business', { name, whoRunsIt: 'client' });
    expect(card.title).toBe(`Add ${name}?`);
    expect(field(card, 'Time zone')!.value).toBe(CHI);
    expect(card.warnings[0]!.text).toContain('You won’t be on its team');
    expect((await me()).workspaces.some((w) => w.name === name)).toBe(false);
    const done = await confirm('add_business', parsed);
    const added = (await me()).workspaces.find((w) => w.name === name)!;
    expect(added.organizationId).toBe(organizationId);
    expect(done.href).toBe(`/app/w/${added.id}`);
    newId = added.id;
    await expect(
      prepare('add_business', { name: 'Elsewhere', whoRunsIt: 'me', timezone: 'Mars/Olympus' }),
    ).rejects.toThrow('isn’t a time zone');
  });

  it('lists the agency’s businesses, templates and packs', async () => {
    templateId = (
      (await run(workflowTemplateCreate, { organizationId, name: `Follow-up ${mark}` }, owner)) as {
        templateId: string;
      }
    ).templateId;
    await run(workflowTemplatePublish, { organizationId, templateId }, owner);
    packId = (
      (await run(
        knowledgePackCreate,
        {
          organizationId,
          name: `HVAC FAQs ${mark}`,
          items: [{ kind: 'faq', title: 'Do you service heat pumps?', body: 'Yes, every brand.' }],
        },
        owner,
      )) as { packId: string }
    ).packId;
    const { result } = await read('get_agency_area', {});
    expect(result['businesses']).toContainEqual({ id: newId, name });
    expect(result['templates']).toContainEqual(
      expect.objectContaining({ id: templateId, published: true, version: 1 }),
    );
    expect(result['packs']).toContainEqual(
      expect.objectContaining({ id: packId, items: 1, version: 1 }),
    );
  });

  it('pushes a template to a client business on Confirm, leaving its details to it', async () => {
    const { card, parsed } = await prepare('push_to_client_businesses', {
      what: 'template',
      templateId,
      businessIds: [newId],
    });
    expect(card.title).toBe(`Push “Follow-up ${mark}” to 1 business?`);
    expect(field(card, 'Businesses')!.value).toBe(name);
    expect(card.warnings[0]!.text).toContain('Nothing runs until it tests and publishes it');
    const installs = () =>
      q<{ installs: { workspaceId: string; status: string }[] }>('workflow_template.get', {
        organizationId,
        templateId,
      }).then((t) => t.installs);
    expect(await installs()).toEqual([]);
    await confirm('push_to_client_businesses', parsed);
    expect(await installs()).toEqual([expect.objectContaining({ workspaceId: newId })]);
  });

  it('reads a template’s steps and changes its draft step by step on Confirm', async () => {
    const look = async () =>
      (await read('get_agency_area', { templateId })).result['template'] as Record<string, unknown>;
    const before = await look();
    expect(before['steps']).toEqual([]);
    const args = {
      templateId,
      baseRevision: before['draftRevision'],
      ops: [
        {
          op: 'add_step',
          parentId: null,
          branchId: null,
          index: null,
          step: {
            id: 's_tpltask1',
            type: 'action',
            action: 'create_task',
            config: { title: 'Call them back' },
          },
        },
      ],
    };
    const { card, parsed } = await prepare('edit_template_steps', args);
    expect(card.title).toBe(`Change the template “Follow-up ${mark}”?`);
    expect(field(card, 'Change')!.value).toContain('Call them back');
    expect(card.confirmLabel).toBe('Save draft');
    expect(card.warnings[0]!.text).toContain('Businesses keep version 1');
    expect((await look())['steps']).toEqual([]);
    const done = await confirm('edit_template_steps', parsed);
    expect(done.outcome).toMatch(/^Saved the draft/);
    expect(done.href).toBe(`/app/org/${organizationId}/templates/${templateId}`);
    const after = await look();
    expect(after['steps']).toEqual([
      { id: 's_tpltask1', depth: 0, says: expect.stringContaining('Call them back') },
    ]);
    expect(after['draftRevision']).toBe((before['draftRevision'] as number) + 1);

    // A card drawn on the old draft is refused, and so is a change the draft already has.
    await expect(prepare('edit_template_steps', args)).rejects.toMatchObject({
      rule: 'revision_conflict',
    });
    await expect(
      prepare('edit_template_steps', {
        templateId,
        baseRevision: after['draftRevision'],
        ops: [
          {
            op: 'update_step',
            stepId: 's_tpltask1',
            patch: { config: { title: 'Call them back' } },
          },
        ],
      }),
    ).rejects.toThrow('Nothing would change');
  });

  it('pushes a knowledge pack as suggestions on Confirm', async () => {
    const pushed = async () =>
      (
        await rows<{ n: number }>(
          admin(),
          sql`select count(*)::int as n from app.events
              where event_type = 'knowledge_pack.pushed' and entity_id = ${packId}`,
        )
      )[0]!.n;
    const { card, parsed } = await prepare('push_to_client_businesses', {
      what: 'pack',
      packId,
      businessIds: [newId, workspaceId],
    });
    expect(field(card, 'Pack')!.value).toBe(`HVAC FAQs ${mark} · 1 item`);
    expect(await pushed()).toBe(0);
    await confirm('push_to_client_businesses', parsed);
    expect(await pushed()).toBe(1);
    await expect(
      prepare('push_to_client_businesses', {
        what: 'pack',
        packId,
        businessIds: [randomUUID()],
      }),
    ).rejects.toThrow('isn’t in');
  });

  it('refuses a template that was never published', async () => {
    const draft = (
      (await run(workflowTemplateCreate, { organizationId, name: `Draft ${mark}` }, owner)) as {
        templateId: string;
      }
    ).templateId;
    await expect(
      prepare('push_to_client_businesses', {
        what: 'template',
        templateId: draft,
        businessIds: [newId],
      }),
    ).rejects.toThrow('hasn’t been published yet');
  });

  it('tells an admin of one business that only the agency’s owners and admins can', async () => {
    const add = await prepare('add_business', { name: 'Side job', whoRunsIt: 'me' }, priya);
    expect(add.card.confirmLabel).toBe('');
    expect(add.card.warnings[0]!.kind).toBe('blocked');
    await expect(confirm('add_business', add.parsed, priya)).rejects.toThrow();

    const area = await read('get_agency_area', {}, priya);
    expect(area.result['notYours']).toContain('Only the owners and admins');
    const push = await prepare(
      'push_to_client_businesses',
      { what: 'pack', packId, businessIds: [workspaceId] },
      priya,
    );
    expect(push.card.confirmLabel).toBe('');
    const edit = await prepare(
      'edit_template_steps',
      { templateId, baseRevision: 1, ops: [{ op: 'delete_step', stepId: 's_tpltask1' }] },
      priya,
    );
    expect(edit.card.confirmLabel).toBe('');
    expect(edit.card.warnings[0]!.kind).toBe('blocked');
  });

  it('puts an agency owner on a client’s business, from that business, on Confirm', async () => {
    const join = allScreenActionTools().find((t) => t.name === 'do_workspace_join')!;
    expect(join.permission).toBe('workspace.update');
    const there = { ...ctxFor(owner), workspaceId: newId };
    const tools = createToolExecutor(api());
    const onIt = async () =>
      (
        await rows<{ n: number }>(
          admin(),
          sql`select count(*)::int as n from app.workspace_memberships
              where workspace_id = ${newId} and user_id = ${owner.id}`,
        )
      )[0]!.n;
    await tools.prepare(join, {}, there, randomUUID());
    expect(await onIt()).toBe(0);
    await tools.commit(join, {}, there, { toolCallId: randomUUID() });
    expect(await onIt()).toBe(1);
  });
});
