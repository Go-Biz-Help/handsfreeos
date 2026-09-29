import { expect, test } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting } from './telephony';

type Json = Record<string, unknown>;
interface RunSummary {
  id: string;
  status: string;
  person: { id: string } | null;
}
interface RunGet {
  run: { id: string; status: string; endReason: string | null };
  steps: { stepKey: string; status: string }[];
}
interface Stage {
  id: string;
  name: string;
  kind: string;
}

const addStep = (step: Json) => ({
  op: 'add_step',
  parentId: null,
  branchId: null,
  index: null,
  step,
});
const waitHour = (id: string) => ({
  id,
  type: 'wait',
  until: { kind: 'duration', duration: { amount: 1, unit: 'hours' } },
});

/**
 * Test runs, publishing and real runs, end to end on the fake carrier:
 * 1. Publish stays off until a Simulate test of the draft passes; the Test tab's log and the step list show
 *    what each step would do.
 * 2. Publish version 1.
 * 3. A new lead for a customer who agreed to texts starts a real run: the text reaches the inbox, the
 *    customer's timeline says "Workflow: Speed to lead", and the audit log names the workflow.
 * 4. Pause and Resume from the list, each confirmed with what happens.
 * 5. Retry and Skip on a failed step: moving an archived lead is refused (a rule, so onError stop fails the
 *    run); restoring the lead and Retry carries on; the next move fails the same way and Skip finishes.
 * 6. "Add to workflow…" on the customer page starts a manual workflow; Remove takes them out of another.
 * 7. A calendar's Automations lists the workflow its "Add automation" made.
 *
 * Quiet hours are switched off for this business, so no text waits for the morning whatever the hour.
 */
test('workflow runs: test, publish, a real run, pause, retry and skip, add to workflow, automations', async ({
  page,
}) => {
  test.setTimeout(480_000);
  const { email } = await signUpAndConfirm(page, 'wf-run');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const { token } = await signInOwner(email);
  const call = <T = Json>(kind: 'commands' | 'queries', name: string, input: Json) =>
    api<T>(token, kind, name, { workspaceId, ...input });

  /** Creates a workflow through the API, has the engine pass a Simulate test, and publishes it. */
  async function published(body: Json, ops: Json[]): Promise<string> {
    const created = await call<{ workflowId: string; revision: number }>(
      'commands',
      'workflow.create',
      body,
    );
    const { workflowId } = created;
    const revision = ops.length
      ? (
          await call<{ revision: number }>('commands', 'workflow.save_draft', {
            workflowId,
            baseRevision: created.revision,
            ops,
          })
        ).revision
      : created.revision;
    await call('commands', 'workflow.test', { workflowId, mode: 'simulate' });
    await expect
      .poll(
        async () =>
          (await call<{ workflow: { tested: boolean } }>('queries', 'workflow.get', { workflowId }))
            .workflow.tested,
        { timeout: 60_000, message: 'the worker passes a Simulate test of the draft' },
      )
      .toBe(true);
    await call('commands', 'workflow.publish', { workflowId, baseRevision: revision });
    return workflowId;
  }

  /** The newest run of a workflow for a customer, once the engine has started it. */
  async function runOf(workflowId: string, personId: string): Promise<RunSummary> {
    let found: RunSummary | undefined;
    await expect
      .poll(
        async () => {
          found = (
            await call<{ items: RunSummary[] }>('queries', 'workflow.run_list', {
              workflowId,
              personId,
            })
          ).items[0];
          return !!found;
        },
        { timeout: 60_000, message: 'the engine starts the run' },
      )
      .toBe(true);
    return found!;
  }
  const runGet = (runId: string) => call<RunGet>('queries', 'workflow.run_get', { runId });
  const runStatus = async (runId: string) => (await runGet(runId)).run.status;
  /** A waiting run's next job, run now as of when it was due (an hour's wait passes at once). */
  async function runDue(runId: string) {
    const res = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, dedupeKeys: [`wf-run:${runId}`] }),
    });
    expect(res.ok).toBe(true);
  }

  // Texting on the fake carrier, with quiet hours off so a text's timing never depends on the hour.
  await setUpTexting(page, workspaceId);
  await call('commands', 'phone.update_settings', {
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  const { personId: mike } = await call<{ personId: string }>('commands', 'person.create', {
    firstName: 'Mike',
    lastName: 'Johnson',
    phone: '(713) 555-0142',
    email: 'mike.johnson@example.test',
  });
  await call('commands', 'person.set_sms_consent', { personId: mike, consent: 'opted_in' });

  // 1. Speed to lead from its recipe: Publish waits for a passing test of this draft.
  await page.goto(`/app/w/${workspaceId}/workflows/new`);
  await page.getByTestId('recipe-speed_to_lead').click();
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const speed = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByTestId('workflow-rail')).toBeVisible();
  const publish = page.getByTestId('workflow-publish');
  await expect(publish).toBeDisabled();
  await expect(page.getByTestId('publish-gate')).toHaveText('Run a test first');

  await page.getByTestId('rail-test').click();
  await expect(page.getByTestId('test-contact')).toContainText('Mike Johnson');
  await expect(page.getByTestId('test-mode-note')).toContainText('Sends nothing');
  await page.getByTestId('test-mode-send').click();
  await expect(page.getByTestId('test-mode-note')).toContainText(
    'Texts come to your email, because your profile has no mobile number.',
  );
  await page.getByTestId('test-mode-simulate').click();
  await page.getByTestId('test-run').click();
  const result = page.getByTestId('test-result');
  await expect(result).toHaveAttribute('data-outcome', 'passed', { timeout: 90_000 });
  await expect(result).toHaveText('Test passed, ready to publish.');
  const log = page.getByTestId('test-log');
  await expect(log.getByTestId('test-row-s_stltext1')).toContainText(
    'Would send: “Hi Mike, thanks for reaching out to Lone Star HVAC & Roofing!',
  );
  await expect(log.getByTestId('test-row-s_stlwait1')).toContainText('the test skips waits');
  // Mike has no lead in a test, so the task's {{lead.title}} has no value and the step is skipped.
  await expect(log.getByTestId('test-row-s_stltask1')).toContainText(
    'Skipped: no value for {{lead.title}}',
  );
  // The same marks on the step list.
  await expect(page.getByTestId('step-s_stltext1').getByTestId('step-note')).toContainText(
    'Would send',
  );
  await expect(page.getByTestId('publish-gate')).toHaveText('Tested, ready to publish');

  // 2. Publish version 1.
  await expect(publish).toBeEnabled();
  await publish.click();
  const confirmPublish = page.getByRole('dialog', { name: 'Publish version 1?' });
  await expect(confirmPublish.getByTestId('publish-preview')).toContainText(
    'This is its first version.',
  );
  await confirmPublish.getByTestId('publish-confirm').click();
  await expect(page.getByText('Version 1 is live.')).toBeVisible();
  await expect(page.getByTestId('version-note')).toHaveText('Version 1 is live');
  await expect(page.getByTestId('workflow-status')).toHaveText('Active');
  await expect(page.getByTestId('workflow-pause')).toBeVisible();

  // 3. A new lead for Mike starts a real run; the fake carrier sends the text.
  await call('commands', 'lead.create', { title: 'AC not cooling', personId: mike });
  const run = await runOf(speed, mike);
  await expect
    .poll(
      async () =>
        (await runGet(run.id)).steps.find((s) => s.stepKey === 's_stltext1#1')?.status ?? 'none',
      { timeout: 60_000, message: 'the first text goes out' },
    )
    .toBe('done');
  await expect
    .poll(
      async () =>
        (
          await call<{ items: { channel: string; lastPreview: string | null }[] }>(
            'queries',
            'inbox.list',
            { personId: mike },
          )
        ).items.find((c) => c.channel === 'sms')?.lastPreview ?? '',
      { timeout: 30_000, message: 'the text reaches the inbox' },
    )
    .toContain('thanks for reaching out to Lone Star HVAC & Roofing');

  await page.goto(`/app/w/${workspaceId}/customers/people/${mike}`);
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('Workflow: Speed to lead');
  await expect(timeline.getByTestId('timeline-run-link').first()).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}/workflows/runs/${run.id}`,
  );
  const card = page.getByTestId('contact-workflows');
  await expect(card.getByTestId(`contact-run-${run.id}`)).toContainText('Speed to lead');

  await page.goto(`/app/w/${workspaceId}/audit`);
  const audit = page.getByTestId('audit-log');
  await expect(audit).toContainText('Workflow: Speed to lead sent a text');
  await page.getByLabel('Filter by activity').selectOption('workflows');
  await expect(audit).toContainText('published “Speed to lead” version 1');
  await expect(audit).toContainText('Workflow: Speed to lead');
  await page.getByLabel('Filter by person').selectOption({ label: 'Workflow: Speed to lead' });
  await expect(audit).not.toContainText('published “Speed to lead”');
  await expect(audit).toContainText('Workflow: Speed to lead sent a text');

  // 4. Pause, then Resume, from the list; each says what happens first.
  await page.goto(`/app/w/${workspaceId}/workflows`);
  await expect(page.getByTestId('workflow-stats')).toContainText('Runs started today');
  const row = page.getByTestId(`workflow-row-${speed}`);
  await expect(row).toContainText('On');
  await page.getByTestId(`workflow-switch-${speed}`).click();
  const pause = page.getByRole('dialog', { name: 'Pause “Speed to lead”?' });
  await expect(pause).toContainText('New triggers are ignored while it’s paused.');
  await pause.getByTestId('status-change-confirm').click();
  await expect(row).toHaveAttribute('data-status', 'paused');
  await expect(row).toContainText('Paused');
  await page.getByTestId(`workflow-switch-${speed}`).click();
  const resume = page.getByRole('dialog', { name: 'Resume “Speed to lead”?' });
  await expect(resume).toContainText('Held runs continue');
  await resume.getByTestId('status-change-confirm').click();
  await expect(row).toHaveAttribute('data-status', 'active');

  // 5. Retry and Skip: a workflow that moves each new lead along an hour apart.
  const { pipelines } = await call<{ pipelines: { id: string; stages: Stage[] }[] }>(
    'queries',
    'pipeline.list',
    {},
  );
  const pipeline = pipelines[0]!;
  const open = pipeline.stages.filter((s) => s.kind === 'open');
  const move = (id: string, stage: Stage) => ({
    id,
    type: 'action',
    action: 'move_lead_stage',
    config: { pipelineId: pipeline.id, stageId: stage.id, lostReason: null },
    onError: 'stop',
  });
  const mover = await published(
    {
      name: 'Move new leads along',
      from: 'blank',
      trigger: { kind: 'event', event: 'lead.created' },
    },
    [
      addStep(waitHour('s_rtywait1')),
      addStep(move('s_rtymove1', open[1] ?? open[0]!)),
      addStep(waitHour('s_rtywait2')),
      addStep(move('s_rtymove2', open[2] ?? open[0]!)),
    ],
  );
  const { personId: rosa } = await call<{ personId: string }>('commands', 'person.create', {
    firstName: 'Rosa',
    lastName: 'Diaz',
  });
  const { leadId } = await call<{ leadId: string }>('commands', 'lead.create', {
    title: 'Roof leak',
    personId: rosa,
  });
  const moving = await runOf(mover, rosa);
  await expect.poll(() => runStatus(moving.id), { timeout: 30_000 }).toBe('waiting');
  await call('commands', 'lead.archive', { leadId });
  await runDue(moving.id);
  await expect
    .poll(() => runStatus(moving.id), { timeout: 30_000, message: 'moving an archived lead fails' })
    .toBe('failed');

  await page.goto(`/app/w/${workspaceId}/workflows/runs/${moving.id}`);
  const detail = page.getByTestId('run-detail');
  await expect(detail).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('run-failed')).toContainText('Stopped at “Move the lead to ');
  await expect(page.getByTestId('run-failed-reason')).toContainText(
    'This lead is archived. Restore it, then move it.',
  );
  await call('commands', 'lead.restore', { leadId });
  await page.getByTestId('run-retry').click();
  await expect(detail).toHaveAttribute('data-status', 'waiting', { timeout: 30_000 });
  await expect(page.getByTestId('step-s_rtymove1').getByTestId('step-note')).toHaveText(
    'Moved the lead',
  );
  await page.getByTestId('step-s_rtymove1').click();
  await expect(page.getByTestId('run-step-panel').getByTestId('run-step-title')).toContainText(
    'Move the lead to ',
  );
  await call('commands', 'lead.archive', { leadId });
  await runDue(moving.id);
  await expect(detail).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
  await page.getByTestId('run-skip').click();
  await expect(detail).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
  await expect(page.getByTestId('step-s_rtymove2').getByTestId('step-note')).toHaveText(
    'Skipped by hand',
  );
  await expect(page.getByTestId('run-end-reason')).toContainText('It finished every step');

  // 6. "Add to workflow…" from Mike's page, then Remove from Speed to lead.
  const welcome = await published(
    { name: 'Welcome note', from: 'blank', trigger: { kind: 'manual' } },
    [
      addStep({
        id: 's_welnote1',
        type: 'action',
        action: 'add_note',
        config: { body: 'Welcome aboard, {{person.first_name}}!' },
      }),
    ],
  );
  await page.goto(`/app/w/${workspaceId}/customers/people/${mike}`);
  await page.getByTestId('add-to-workflow').click();
  const add = page.getByRole('dialog', { name: 'Add Mike to a workflow' });
  await expect(add.getByTestId(`add-to-${welcome}`)).toHaveAttribute('aria-checked', 'true');
  await expect(add.getByTestId(`add-to-${mover}`)).toHaveCount(0);
  await add.getByTestId('add-to-workflow-confirm').click();
  await expect(
    page.getByText('Added Mike to “Welcome note”. It starts in a moment.'),
  ).toBeVisible();
  const welcomeRun = await runOf(welcome, mike);
  await expect(card.getByTestId(`contact-run-${welcomeRun.id}`)).toHaveAttribute(
    'data-status',
    'completed',
    { timeout: 30_000 },
  );
  await expect(timeline).toContainText('Workflow: Welcome note added a note');
  const speedRun = card.getByTestId(`contact-run-${run.id}`);
  await speedRun.getByTestId('contact-run-remove').click();
  await page
    .getByRole('dialog', { name: 'Take Mike out of “Speed to lead”?' })
    .getByTestId('contact-run-remove-confirm')
    .click();
  await expect(speedRun).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });

  // 7. A calendar's Automations: "Add automation" opens the recipe with the calendar filled in, and the
  // workflow it makes shows in the list.
  const { calendarId } = await call<{ calendarId: string }>('commands', 'calendar.create', {
    name: 'AC tune-up',
    preset: 'scratch',
  });
  await page.goto(`/app/w/${workspaceId}/settings/calendars/${calendarId}`);
  await page.getByTestId('module-automations').click();
  const automations = page.getByTestId('calendar-automations');
  await expect(automations).toContainText('No workflows start from this calendar yet.');
  await page.getByTestId('automation-add').click();
  await page.getByTestId('automation-add-appointment_follow_up_review').click();
  await expect(page).toHaveURL(/\/workflows\/new\?recipe=appointment_follow_up_review&calendar=/);
  await expect(page.getByTestId('recipe-appointment_follow_up_review')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('placeholder-mapper').getByLabel('Calendar')).toHaveValue(
    calendarId,
  );
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const review = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await page.goto(`/app/w/${workspaceId}/settings/calendars/${calendarId}`);
  await page.getByTestId('module-automations').click();
  const listed = page.getByTestId(`automation-${review}`);
  await expect(listed).toContainText('Appointment follow-up + review');
  await expect(listed).toContainText('Draft');
});
