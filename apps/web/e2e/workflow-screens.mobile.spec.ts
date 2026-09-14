import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import {
  apiAs,
  createWorkflow,
  runFor,
  runState,
  signInForApi,
  testAndPublish,
} from './workflow-approval-api';

const WORKER_URL = (process.env.WORKER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
/** The stand-in website playwright.config.ts serves, which the worker may scan (FETCH_TEST_ORIGINS). */
const KNOWLEDGE_SITE = 'http://127.0.0.1:4190';
/** A folder to keep a screenshot of every screen in both themes, for a person to look through. */
const SHOTS = process.env.PHONE_SHOTS;

const addStep = (step: Record<string, unknown>) => ({
  op: 'add_step',
  parentId: null,
  branchId: null,
  index: null,
  step,
});

/**
 * Every Milestone 6 screen on a 390 px phone, in the light theme and in the dark: Workflows (the list, New, the
 * Steps editor and its bottom sheet, the view-only Canvas, Describe with a proposal, the Test sheet, Publish,
 * Runs, a failed run and a step's sheet, Approvals), every Knowledge tab, the agency area, a calendar's
 * Automations and a customer's Workflows card. Nothing on any of them is wider than the phone.
 */
test('every workflow, knowledge and agency screen fits a phone, light and dark', async ({
  page,
}) => {
  test.setTimeout(360_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  let shot = 0;
  /**
   * What reaches past the phone's right edge, outside anything that scrolls or clips sideways. An absolutely
   * placed element escapes the scroll boxes between it and the box it's placed against (screen-reader words at
   * the end of a scrolling tab row widen the page that way); fixed bars only follow the page's width.
   */
  const overflowing = () =>
    page.evaluate(() => {
      const fixed = (el: Element) => {
        for (let e: Element | null = el; e; e = e.parentElement)
          if (getComputedStyle(e).position === 'fixed') return true;
        return false;
      };
      const clipped = (el: Element) => {
        let e = el.parentElement;
        if (getComputedStyle(el).position === 'absolute') {
          const placedAgainst = (el as HTMLElement).offsetParent;
          while (e && e !== placedAgainst) e = e.parentElement;
        }
        for (; e; e = e.parentElement)
          if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(e).overflowX))
            return true;
        return false;
      };
      return [...document.body.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > 391 && !fixed(el) && !clipped(el))
        .slice(0, 6)
        .map((el) => {
          const id = el.getAttribute('data-testid');
          return `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ''} class="${String(el.getAttribute('class') ?? '').slice(0, 90)}"> right ${Math.round(el.getBoundingClientRect().right)}`;
        });
    });
  async function check(name: string, ready: Locator) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(ready).toBeVisible();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 390)
        expect
          .soft(
            width,
            `${name} is wider than the phone in the ${colorScheme} theme:\n${(await overflowing()).join('\n')}`,
          )
          .toBeLessThanOrEqual(390);
      if (SHOTS)
        await page.screenshot({
          path: join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}-${colorScheme}.png`),
          fullPage: true,
          animations: 'disabled',
        });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // One agency business with a second business, workflows with runs, a knowledge base and a calendar.
  const owner = await signUpAndConfirm(page, 'wf-screens');
  const workspaceId = await createBusiness(page, {
    name: 'Lone Star HVAC & Roofing',
    agencyName: 'Go Biz Help',
  });
  const api = apiAs(await signInForApi(owner.email));
  const call = <T = unknown>(
    path: `${'commands' | 'queries'}/${string}`,
    body: Record<string, unknown> = {},
  ) => api<T>(path, { workspaceId, ...body });
  const me = await api<{ workspaces: { id: string; organizationId: string }[] }>(
    'queries/account.me',
    {},
  );
  const orgId = me.workspaces.find((w) => w.id === workspaceId)!.organizationId;
  const { workspaceId: bayou } = await api<{ workspaceId: string }>('commands/workspace.create', {
    organizationId: orgId,
    name: 'Bayou Plumbing Co.',
    timezone: 'America/Chicago',
  });

  const { workflowId: speed } = await call<{ workflowId: string }>('commands/workflow.create', {
    name: 'Speed to lead',
    from: 'recipe',
    recipeKey: 'speed_to_lead',
  });
  const note = await createWorkflow(api, workspaceId, 'Welcome note', [
    {
      id: 's_scnote01',
      type: 'action',
      action: 'add_note',
      config: { body: 'Welcome aboard, {{person.first_name}}!' },
    },
  ]);
  await testAndPublish(api, workspaceId, note.workflowId);
  const reply = await createWorkflow(api, workspaceId, 'Reply for approval', [
    {
      id: 's_scwrite1',
      type: 'ai',
      task: 'write',
      prompt: 'Thank them for getting in touch.',
      fallback: 'Thanks for getting in touch!',
    },
    {
      id: 's_scappr01',
      type: 'approval',
      message: 'Check this before it goes.',
      previewStepId: 's_scwrite1',
    },
    {
      id: 's_scnote02',
      type: 'action',
      action: 'add_note',
      config: { body: 'Sent: {{ai.message}}' },
    },
  ]);
  await testAndPublish(api, workspaceId, reply.workflowId);
  const { pipelines } = await call<{
    pipelines: { id: string; stages: { id: string; name: string }[] }[];
  }>('queries/pipeline.list');
  const pipeline = pipelines[0]!;
  const mover = await call<{ workflowId: string; revision: number }>('commands/workflow.create', {
    name: 'Move new leads along',
    from: 'blank',
    trigger: { kind: 'event', event: 'lead.created' },
  });
  await call('commands/workflow.save_draft', {
    workflowId: mover.workflowId,
    baseRevision: mover.revision,
    ops: [
      addStep({
        id: 's_scwait01',
        type: 'wait',
        until: { kind: 'duration', duration: { amount: 1, unit: 'hours' } },
      }),
      addStep({
        id: 's_scmove01',
        type: 'action',
        action: 'move_lead_stage',
        config: {
          pipelineId: pipeline.id,
          stageId: pipeline.stages.find((s) => s.name === 'Contacted')!.id,
        },
      }),
    ],
  });
  await testAndPublish(api, workspaceId, mover.workflowId);

  // Runs: a finished one and one waiting for an OK for Pat; Rosa's lead, archived, fails at the move.
  const person = async (firstName: string) =>
    (await call<{ personId: string }>('commands/person.create', { firstName, lastName: 'Nguyen' }))
      .personId;
  const pat = await person('Pat');
  await call('commands/workflow.enrol', { workflowId: note.workflowId, personId: pat });
  await call('commands/workflow.enrol', { workflowId: reply.workflowId, personId: pat });
  const rosa = await person('Rosa');
  const { leadId } = await call<{ leadId: string }>('commands/lead.create', {
    title: 'Roof leak',
    personId: rosa,
  });
  await expect
    .poll(() => runState(api, workspaceId, mover.workflowId, rosa), { timeout: 30_000 })
    .toBe('waiting');
  await call('commands/lead.archive', { leadId });
  const moving = (await runFor(api, workspaceId, mover.workflowId, rosa))!;
  const due = await fetch(`${WORKER_URL}/test/scheduled-jobs/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, dedupeKeys: [`wf-run:${moving.id}`] }),
  });
  expect(due.ok).toBe(true);
  await expect
    .poll(() => runState(api, workspaceId, mover.workflowId, rosa), { timeout: 30_000 })
    .toMatch(/^failed/);
  await expect
    .poll(() => runState(api, workspaceId, reply.workflowId, pat), { timeout: 30_000 })
    .toBe('awaiting_approval');

  // The knowledge base: a profile, two FAQs, and a scan of the stand-in site with its suggestions.
  await call('commands/knowledge.profile_update', {
    profile: {
      description: 'Heating, cooling and roofs around Houston.',
      services: [{ name: 'AC repair', description: 'Same or next day for most calls.' }],
      serviceArea: 'Houston and nearby',
      hours: 'Monday to Friday 7 AM to 6 PM',
      tone: 'Friendly and plain-spoken',
    },
  });
  for (const [question, answer] of [
    ['Do you service all brands?', 'Yes, every major brand of air conditioner and furnace.'],
    ['Do you offer emergency service?', 'Yes, heating and cooling emergencies are answered 24/7.'],
  ])
    await call('commands/knowledge_item.create', {
      content: { kind: 'faq', question, answer, tags: ['hvac'] },
      status: 'published',
    });
  await call('commands/knowledge_source.set', { url: 'https://lonestar-hvac.example' });
  const scan = await page.request.post(`${WORKER_URL}/test/knowledge/scan-at`, {
    data: { workspaceId, url: KNOWLEDGE_SITE },
  });
  expect(scan.status(), await scan.text()).toBe(200);
  await expect
    .poll(
      async () =>
        (await call<{ scan: { status: string } | null }>('queries/knowledge_scan.get')).scan
          ?.status,
      { timeout: 120_000, message: 'the scan of the stand-in site finishes' },
    )
    .toBe('done');

  // A calendar with an automation, and the agency's template (pushed to Bayou) and pack.
  const { calendarId } = await call<{ calendarId: string }>('commands/calendar.create', {
    name: 'AC tune-up',
    preset: 'scratch',
  });
  const { workflowId: review } = await call<{ workflowId: string }>('commands/workflow.create', {
    name: 'Appointment follow-up + review',
    from: 'recipe',
    recipeKey: 'appointment_follow_up_review',
    mapping: { calendar: calendarId },
  });
  const { templateId } = await api<{ templateId: string }>(
    'commands/workflow_template.create_from_workflow',
    { organizationId: orgId, workflowId: speed, name: 'Speed to lead (home services)' },
  );
  await api('commands/workflow_template.publish', { organizationId: orgId, templateId });
  await api('commands/workflow_template.push', {
    organizationId: orgId,
    templateId,
    workspaceIds: [bayou],
  });
  await api('commands/knowledge_pack.create', {
    organizationId: orgId,
    name: 'HVAC FAQs',
    items: [
      {
        kind: 'faq',
        title: 'How often should I change my air filter?',
        body: 'Every one to three months.',
      },
    ],
  });

  const ws = `/app/w/${workspaceId}`;

  // ---- Workflows ----
  await page.goto(`${ws}/workflows`);
  await check('workflow-list', page.getByTestId(`workflow-row-${speed}`));
  await page.goto(`${ws}/workflows/new`);
  await check('workflow-new', page.getByRole('heading', { name: 'How do you want to start?' }));

  await page.goto(`${ws}/workflows/${speed}`);
  await check('editor-steps', page.getByTestId('step-list'));
  await page.getByTestId('step-s_stlwait1').click();
  await check('editor-step-sheet', page.getByTestId('step-sheet'));
  await page.getByTestId('sheet-done').click();
  await expect(page.getByTestId('step-sheet')).toBeHidden();

  await page.getByTestId('mode-canvas').click();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-ready', 'true');
  await check('editor-canvas', page.getByTestId('workflow-canvas'));

  await page.getByTestId('mode-describe').click();
  const pane = page.getByTestId('describe-pane');
  await check('editor-describe', pane);
  await pane.getByTestId('describe-input').fill('Wait two days instead');
  await pane.getByTestId('describe-send').click();
  await expect(pane.getByTestId('proposal-card')).toBeVisible({ timeout: 60_000 });
  await check('editor-describe-proposal', pane.getByTestId('proposal-card'));

  const follow = await createWorkflow(api, workspaceId, 'Follow-up call', [
    {
      id: 's_sctask01',
      type: 'action',
      action: 'create_task',
      config: { title: 'Call them back' },
    },
  ]);
  await page.goto(`${ws}/workflows/${follow.workflowId}`);
  await page.getByTestId('test-open').click();
  const sheet = page.getByTestId('step-sheet');
  await check('editor-test-sheet', sheet.getByTestId('workflow-test'));
  await sheet.getByTestId('test-run').click();
  await expect(sheet.getByTestId('test-result')).toHaveAttribute('data-outcome', 'passed', {
    timeout: 60_000,
  });
  await check('editor-test-passed', sheet.getByTestId('test-result'));
  await sheet.getByTestId('test-sheet-done').click();
  await expect(sheet).toBeHidden();
  await page.getByTestId('workflow-publish').click();
  const publish = page.getByRole('dialog', { name: 'Publish version 1?' });
  await check('editor-publish', publish);
  await publish.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('version-note')).toHaveText('Version 1 is live');

  await page.goto(`${ws}/workflows/runs`);
  await check('runs', page.getByTestId(`run-row-${moving.id}`));
  await page.goto(`${ws}/workflows/runs/${moving.id}`);
  await check('run-failed', page.getByTestId('run-failed'));
  await page.getByTestId('step-s_scmove01').click();
  await check('run-step-sheet', page.getByTestId('run-step-sheet'));

  await page.goto(`${ws}/workflows/approvals`);
  await check('approvals', page.getByTestId('approval-card'));

  // ---- Knowledge ----
  await page.goto(`${ws}/knowledge`);
  await check('knowledge-overview', page.getByTestId('profile-card'));
  await page.goto(`${ws}/knowledge/items`);
  await check('knowledge-items', page.getByTestId('items-list'));
  await page.goto(`${ws}/knowledge/items/new`);
  await check('knowledge-item-new', page.getByTestId('item-title'));
  await page.goto(`${ws}/knowledge/documents`);
  await check('knowledge-documents', page.getByTestId('documents-empty'));
  await page.goto(`${ws}/knowledge/website`);
  await check('knowledge-website', page.getByTestId('scan-result'));
  await page.goto(`${ws}/knowledge/suggestions`);
  await check('knowledge-suggestions', page.getByTestId('suggestion').first());
  await page.goto(`${ws}/knowledge/profile`);
  await check('knowledge-profile', page.getByTestId('profile-form'));

  // ---- A calendar's Automations and a customer's Workflows card ----
  await page.goto(`${ws}/settings/calendars/${calendarId}`);
  // A phone picks the calendar's settings from a list instead of the side menu (again if the page was still
  // starting up and put its first module back).
  await expect(async () => {
    await page
      .getByRole('combobox', { name: 'Settings on this calendar' })
      .selectOption('automations');
    await expect(page.getByTestId('module-panel-automations')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await check('calendar-automations', page.getByTestId(`automation-${review}`));
  await page.goto(`${ws}/customers/people/${pat}`);
  await check('customer-workflows', page.getByTestId('contact-workflows'));

  // ---- The agency area ----
  await page.goto(`/app/org/${orgId}/templates`);
  await check('agency-templates', page.getByTestId(`template-row-${templateId}`));
  await page.goto(`/app/org/${orgId}/templates/${templateId}`);
  await check('agency-template', page.getByTestId('step-list'));
  await page.goto(`/app/org/${orgId}/businesses`);
  await check('agency-businesses', page.getByTestId('businesses-list'));
  await page.goto(`/app/org/${orgId}/packs`);
  await check('agency-packs', page.getByTestId(/^pack-row-/));
});
