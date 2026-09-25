import { expect, test, type Page } from '@playwright/test';
import { createTeammate } from './ai-team';
import { api, ownerWithSite, type Owner } from './booking-helpers';

/**
 * Settings → Automations, which took in Settings → Action Center: last in the nav, and the old address lands on
 * it; each row's switch saves where that automation's setting lives (an Action Center kind, or Automations' own
 * switches); approvals are always on; and the Adjust sheets keep the Action Center's settings — thresholds that
 * save as they're changed, the follow-up wording's live preview and its problems in plain words (a price, a link,
 * a carrier keyword, double braces), follow-ups that stay off until an owner reads the wording and chooses “Looks
 * good, turn on”, and Reply C to confirm. Every change is checked in the saved settings.
 */

type Attention = {
  kinds: Record<string, boolean>;
  hot: { urgentAfterMinutes: number; minValueCents: number };
  stale: { days: number; stageDays: Record<string, number> };
  typicalJobValueCents: number | null;
  auto: { confirmRequests: boolean; nudges: boolean; nudgeReviewedAt: string | null };
  nudge: { template: string };
  replyToConfirm: boolean;
};

type Automations = {
  switches: Record<string, boolean>;
  intake?: { formId: string | null; message: string };
  maintenance?: { leadDays: number };
  briefings?: { eveningAt: string };
  pipeline?: { roles: Record<string, string> };
  reengage?: { reviewedAt: string | null; maxPerDay: number; template: string };
};

async function settingsOf(owner: Owner) {
  const { workspace } = await api<{
    workspace: { settings: { attention?: Attention; automations?: Automations } };
  }>(owner.token, 'queries', 'workspace.get', { workspaceId: owner.workspaceId });
  return workspace.settings;
}

/** The saved Action Center settings (`workspaces.settings.attention`), or {} before the first save. */
async function saved(owner: Owner): Promise<Partial<Attention>> {
  return (await settingsOf(owner)).attention ?? {};
}

/** Automations' own switches (`workspaces.settings.automations`), or {} before the first save. */
async function savedSwitches(owner: Owner): Promise<Record<string, boolean>> {
  return (await settingsOf(owner)).automations?.switches ?? {};
}

/** Opens one automation's Adjust sheet. */
async function adjust(page: Page, id: string) {
  await page.getByTestId(`adjust-open-${id}`).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** Closes the sheet that's open. */
async function close(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** Types into a box and leaves it, which saves it. */
async function enter(page: Page, testId: string, value: string) {
  const box = page.getByTestId(testId);
  await box.fill(value);
  await box.press('Enter');
}

test('Automations: switches, the Adjust sheets, the wording’s preview and problems, and Looks good, turn on', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'ac-settings', 'Lone Star Settings HVAC');
  // Open hours and quiet hours set explicitly: nothing here sends, but no spec leans on the defaults (a business
  // is open weekdays 8 to 5 until it says otherwise).
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: owner.workspaceId,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  await api(owner.token, 'commands', 'phone.update_settings', {
    workspaceId: owner.workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });

  // Last in the Settings nav, after the channels and the money pages Milestone 9 added.
  await page.goto(`/app/w/${owner.workspaceId}/settings`);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  const tabs = await nav.getByRole('link').allTextContents();
  expect(tabs.indexOf('Automations')).toBe(tabs.length - 1);
  expect(tabs.indexOf('Automations')).toBeGreaterThan(tabs.indexOf('Website chat'));
  expect(tabs).not.toContain('Action Center');
  await nav.getByRole('link', { name: 'Automations' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${owner.workspaceId}/settings/automations$`));
  await expect(page.getByTestId('automations-settings')).toBeVisible();
  // The old address lands here.
  await page.goto(`/app/w/${owner.workspaceId}/settings/action-center`);
  await expect(page).toHaveURL(new RegExp(`/app/w/${owner.workspaceId}/settings/automations$`));

  // Grouped the way the owner reads them, each with what it touches.
  await expect(page.getByTestId('section-customers')).toContainText('Reaching customers');
  await expect(page.getByTestId('section-business')).toContainText('Keeping the business on track');
  await expect(page.getByTestId('group-leads')).toContainText('Leads and sales');
  await expect(page.getByTestId('automation-day_before_confirmation')).toContainText(
    'Texts customers',
  );
  await expect(page.getByTestId('automation-hot_lead_alert')).toContainText('Just alerts you');
  // With no AI teammate yet, what it would write says so.
  await expect(page.getByTestId('needs-setup-new_lead_greeting')).toContainText(
    'Set up your AI teammate to start.',
  );
  await expect(page.getByTestId('automation-switch-new_lead_greeting')).toBeDisabled();
  // The header counts only what's actually working: the AI teammate's four rows and the three health rows
  // about its work wait on it, intake questions on a form, and maintenance reminders on a service that repeats.
  await expect(page.getByTestId('automations-count')).toContainText(
    '9 need something set up first.',
  );

  // An Action Center kind off and on again, saved each time.
  const hot = page.getByTestId('automation-switch-hot_lead_alert');
  await expect(hot).toHaveAttribute('aria-checked', 'true');
  await hot.click();
  await expect(page.getByText('Hot lead alert is off.')).toBeVisible();
  await expect.poll(async () => (await saved(owner)).kinds?.hot_lead).toBe(false);
  // Its threshold waits while it's off.
  await adjust(page, 'hot_lead_alert');
  await expect(page.getByTestId('ac-threshold-hot_lead')).toBeDisabled();
  await close(page);
  await hot.click();
  await expect(hot).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await saved(owner)).kinds?.hot_lead).toBe(true);
  // One row, two kinds: both go off together, and each can be switched on its own in Adjust.
  await page.getByTestId('automation-switch-unanswered_alert').click();
  await expect
    .poll(async () => {
      const k = (await saved(owner)).kinds;
      return [k?.unanswered_lead, k?.customer_waiting];
    })
    .toEqual([false, false]);
  await adjust(page, 'unanswered_alert');
  await page.getByTestId('ac-kind-switch-customer_waiting').click();
  await expect.poll(async () => (await saved(owner)).kinds?.customer_waiting).toBe(true);
  await close(page);
  await expect(page.getByTestId('automation-switch-unanswered_alert')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // Approvals are always on.
  await expect(page.getByTestId('automation-drafts_awaiting_review')).toContainText('Always on');
  await expect(page.getByTestId('automation-switch-drafts_awaiting_review')).toHaveCount(0);

  // Automations' own switches: the day-of reminder off, saved in its own document.
  await page.getByTestId('automation-switch-day_of_reminder').click();
  await expect(page.getByText('Day-of reminder is off.')).toBeVisible();
  await expect.poll(async () => (await savedSwitches(owner)).dayOf).toBe(false);
  await expect.poll(async () => (await savedSwitches(owner)).dayBefore).toBe(true);

  // The leads rows the Automations stage added, each with what it touches.
  for (const id of ['never_replied', 'chase_offered_time', 'reengage_dead_leads'])
    await expect(page.getByTestId(`automation-${id}`)).toContainText('Texts customers');
  // Re-engaging starts off, and its switch opens the message to read instead of turning it on.
  const reengage = page.getByTestId('automation-switch-reengage_dead_leads');
  await expect(reengage).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('automation-reengage_dead_leads')).toContainText(
    'Read the message first',
  );
  await reengage.click();
  await expect(page.getByTestId('adjust-reengage')).toBeVisible();
  await expect(reengage).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('re-preview')).toContainText("It's been a while");
  await enter(page, 're-max-per-day', '5');
  await expect.poll(async () => (await settingsOf(owner)).automations?.reengage?.maxPerDay).toBe(5);
  // A price in the wording is caught before it can be turned on.
  await page.getByTestId('re-template').fill('Hi {firstName}, AC tune-ups are $89 this month!');
  await expect(page.getByTestId('re-check-money')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('re-look-good')).toBeDisabled();
  await page.getByTestId('re-reset').click();
  await page.getByTestId('re-look-good').click();
  await expect(page.getByTestId('re-on')).toHaveText('On');
  await expect
    .poll(async () => {
      const a = (await settingsOf(owner)).automations;
      return [a?.switches.reengage, !!a?.reengage?.reviewedAt];
    })
    .toEqual([true, true]);
  await close(page);
  await expect(reengage).toHaveAttribute('aria-checked', 'true');
  // Once read, the row's switch turns it off and on.
  await reengage.click();
  await expect.poll(async () => (await savedSwitches(owner)).reengage).toBe(false);

  // A threshold saves when it's left; one out of range goes back.
  await adjust(page, 'hot_lead_alert');
  await enter(page, 'ac-threshold-hot_lead', '20');
  await expect(page.getByText('A hot lead is urgent after 20 min.')).toBeVisible();
  await expect.poll(async () => (await saved(owner)).hot?.urgentAfterMinutes).toBe(20);
  await enter(page, 'ac-threshold-hot_lead', '999');
  await expect(page.getByText('Use a whole number from 1 to 240.')).toBeVisible();
  await expect(page.getByTestId('ac-threshold-hot_lead')).toHaveValue('20');

  // The typical job value, and a stage that goes quiet sooner.
  await enter(page, 'ac-typical-value', '4200');
  await expect(page.getByTestId('ac-typical-value')).toHaveValue('$4,200');
  await expect.poll(async () => (await saved(owner)).typicalJobValueCents).toBe(420_000);
  await close(page);
  await adjust(page, 'stale_opportunities');
  const stage = page.locator('[data-testid^="ac-stale-"]').first();
  const stageId = (await stage.getAttribute('data-testid'))!.replace('ac-stale-', '');
  await stage.fill('3');
  await stage.press('Enter');
  await expect.poll(async () => (await saved(owner)).stale?.stageDays?.[stageId]).toBe(3);

  // Follow-ups are off until an owner reads the wording: the switch alone won't turn them on.
  const nudges = page.getByTestId('ac-nudge-switch');
  await expect(page.getByTestId('ac-nudge-badge')).toHaveText(
    'Off until an owner reads the wording',
  );
  await nudges.click();
  await expect(
    page.getByText('Read the wording first, then use Looks good, turn on.'),
  ).toBeVisible();
  await expect(nudges).toHaveAttribute('aria-checked', 'false');

  // The preview fills in a sample customer as it's typed.
  const box = page.getByTestId('ac-template');
  const preview = page.getByTestId('ac-preview');
  await expect(preview).toContainText('Hi Maria, it');
  await expect(preview).toContainText('at Lone Star Settings HVAC.');
  await expect(page.getByTestId('ac-check-length')).toContainText(/\d+ characters · 1 text/);
  await box.fill('Hi {firstName}, checking in on your');
  await box.press('End');
  await page.getByTestId('ac-insert-leadTitle').click();
  await expect(box).toHaveValue('Hi {firstName}, checking in on your {leadTitle}');
  await expect(preview).toHaveText('Hi Maria, checking in on your AC replacement');

  // Problems in plain words: a price and a link, then a carrier keyword and double braces.
  await box.fill('Hi {firstName}, the new unit is $4,500. Book at https://deals.example.com/ac');
  await expect(page.getByTestId('ac-check-money')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('ac-check-link')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('ac-problems')).toBeVisible();
  await expect(page.getByTestId('ac-look-good')).toBeDisabled();
  await box.fill('Hi {{firstName}}, reply CANCEL if you’re no longer interested.');
  await expect(page.getByTestId('ac-problems')).toContainText(
    'Use single braces: {firstName}, not {{firstName}}.',
  );
  await expect(page.getByTestId('ac-problems')).toContainText('Don’t ask them to reply CANCEL');
  // A wording with problems isn't saved when it's left.
  await box.blur();
  await expect.poll(async () => (await saved(owner)).nudge?.template ?? '').not.toContain('CANCEL');

  // Reset puts the original back, with nothing to fix.
  await page.getByTestId('ac-reset').click();
  await expect(page.getByTestId('ac-problems')).toHaveCount(0);
  await expect(page.getByTestId('ac-check-money')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('ac-check-link')).toHaveAttribute('data-ok', 'true');

  // “Looks good, turn on”: follow-ups are on, and the review is recorded.
  await page.getByTestId('ac-look-good').click();
  await expect(page.getByTestId('ac-on')).toHaveText('On');
  await expect(nudges).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ac-nudge-badge')).toHaveCount(0);
  await expect
    .poll(async () => {
      const s = await saved(owner);
      return [s.auto?.nudges, !!s.auto?.nudgeReviewedAt];
    })
    .toEqual([true, true]);
  // Once read, the switch turns them off and on.
  await nudges.click();
  await expect(page.getByText('Follow-ups are off. Nothing waiting will go.')).toBeVisible();
  await expect.poll(async () => (await saved(owner)).auto?.nudges).toBe(false);
  await nudges.click();
  await expect.poll(async () => (await saved(owner)).auto?.nudges).toBe(true);

  await close(page);

  // Reply C to confirm: the reminder's sample loses its last line, and it's saved.
  await adjust(page, 'day_before_confirmation');
  const replyC = page.getByTestId('ac-replyc-preview');
  await expect(replyC).toContainText('Reply C to confirm.');
  await page.getByTestId('ac-replyc-switch').click();
  await expect(replyC).not.toContainText('Reply C to confirm.');
  await expect.poll(async () => (await saved(owner)).replyToConfirm).toBe(false);

  await close(page);

  // Everything is still there after a reload.
  await page.reload();
  await expect(page.getByTestId('automation-switch-day_of_reminder')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await adjust(page, 'stale_opportunities');
  await expect(page.getByTestId('ac-nudge-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId(`ac-stale-${stageId}`)).toHaveValue('3');
  await close(page);
  await adjust(page, 'day_before_confirmation');
  await expect(page.getByTestId('ac-replyc-switch')).toHaveAttribute('aria-checked', 'false');
  await close(page);
  await adjust(page, 'hot_lead_alert');
  await expect(page.getByTestId('ac-threshold-hot_lead')).toHaveValue('20');
});

test('Automations: the AI teammate’s rows and the follow-up schedule', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await ownerWithSite(page, 'ac-ladder', 'Lone Star Ladder HVAC');
  await createTeammate(owner.token, owner.workspaceId, { patch: { followUp: { enabled: true } } });
  const teammate = async () =>
    (
      await api<{
        teammate: {
          config: {
            followUp: {
              ladder: { after: number; unit: string }[];
              monthlyForMonths: number;
              chaseTimes: boolean;
            };
          };
        };
      }>(owner.token, 'queries', 'ai_teammate.get', { workspaceId: owner.workspaceId })
    ).teammate.config.followUp;

  await page.goto(`/app/w/${owner.workspaceId}/settings/automations`);
  // Training: what it writes waits for approval, and the rows say so.
  await expect(page.getByTestId('automations-training')).toContainText('still training');
  await expect(page.getByTestId('automation-follow_ups_after_silence')).toContainText(
    'Waits for your approval while training',
  );
  await expect(page.getByTestId('needs-setup-new_lead_greeting')).toHaveCount(0);

  // A teammate row writes to the teammate's own settings.
  const chase = page.getByTestId('automation-switch-chase_offered_time');
  await expect(chase).toHaveAttribute('aria-checked', 'true');
  await chase.click();
  await expect.poll(async () => (await teammate()).chaseTimes).toBe(false);

  // The ladder: in plain words, each step editable in its own unit, and it only goes forward.
  await adjust(page, 'follow_ups_after_silence');
  await expect(page.getByTestId('followup-ladder-words')).toHaveText(
    '4 hours, then days 1, 2, 4, 7, 10, 14, 21 and 30, then once a month for 6 months.',
  );
  await enter(page, 'followup-step-0', '6');
  await expect.poll(async () => (await teammate()).ladder[0]).toEqual({ after: 6, unit: 'hours' });
  await expect(page.getByTestId('followup-ladder-words')).toContainText('6 hours, then days 1');
  // 30 minutes takes two moves. Halfway, 30 hours would come after day 1: it says so, and saves nothing yet.
  await enter(page, 'followup-step-0', '30');
  await expect(page.getByTestId('followup-problem-1')).toHaveText(
    'Has to come after follow-up 1 (30 hours).',
  );
  await expect(page.getByTestId('followup-unsaved')).toBeVisible();
  await page.getByTestId('followup-unit-0').selectOption('minutes');
  await expect(page.getByTestId('followup-problem-1')).toHaveCount(0);
  await expect
    .poll(async () => (await teammate()).ladder[0])
    .toEqual({ after: 30, unit: 'minutes' });
  await expect(page.getByTestId('followup-ladder-words')).toContainText('30 minutes, then days 1');
  // Remove the last, then add one: it comes after the last that's left, and can be in weeks.
  await page.getByTestId('followup-remove-8').click();
  await expect.poll(async () => (await teammate()).ladder.length).toBe(8);
  await page.getByTestId('followup-add').click();
  await expect.poll(async () => (await teammate()).ladder[8]).toEqual({ after: 42, unit: 'days' });
  await enter(page, 'followup-step-8', '8');
  await page.getByTestId('followup-unit-8').selectOption('weeks');
  await expect.poll(async () => (await teammate()).ladder[8]).toEqual({ after: 8, unit: 'weeks' });
  await expect(page.getByTestId('followup-ladder-words')).toContainText('21, then week 8');
  // Quiet hours: what waits, and where to change them.
  await expect(page.getByTestId('followup-quiet-note')).toContainText(
    'Anything over 20 minutes won’t send in quiet hours.',
  );
  await expect(page.getByTestId('followup-quiet-link')).toHaveAttribute(
    'href',
    `/app/w/${owner.workspaceId}/settings/texting#quiet-hours`,
  );
  await enter(page, 'followup-monthly', '2');
  await expect.poll(async () => (await teammate()).monthlyForMonths).toBe(2);
  await page.getByTestId('followup-reset').click();
  await expect
    .poll(async () => {
      const f = await teammate();
      return [f.ladder.map((x) => `${x.after} ${x.unit}`).join(), f.monthlyForMonths];
    })
    .toEqual(['4 hours,1 days,2 days,4 days,7 days,10 days,14 days,21 days,30 days', 6]);
});

test('Automations: intake questions’ form and message, the thank-you without a teammate, and referrals', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await ownerWithSite(page, 'ac-afterjob', 'Lone Star After HVAC');
  // A live form to pick.
  const form = await api<{ formId: string }>(owner.token, 'commands', 'form.create', {
    workspaceId: owner.workspaceId,
    name: 'Before your first visit',
  });
  const got = await api<{ definition: { pages: { id: string }[] }; revision: number }>(
    owner.token,
    'queries',
    'form.get',
    { workspaceId: owner.workspaceId, formId: form.formId },
  );
  const draft = await api<{ revision: number }>(owner.token, 'commands', 'form.save_draft', {
    workspaceId: owner.workspaceId,
    formId: form.formId,
    baseRevision: got.revision,
    ops: [
      {
        op: 'add_question',
        pageId: got.definition.pages[0]!.id,
        index: null,
        question: { id: 'q_pets0000', type: 'yes_no', title: 'Any pets at home?', config: {} },
      },
    ],
  });
  await api(owner.token, 'commands', 'form.publish', {
    workspaceId: owner.workspaceId,
    formId: form.formId,
    baseRevision: draft.revision,
  });
  const intake = async () => (await settingsOf(owner)).automations?.intake;

  await page.goto(`/app/w/${owner.workspaceId}/settings/automations`);
  // On, but waiting for a form: its link opens the sheet where the form is picked.
  await expect(page.getByTestId('needs-setup-intake_questions')).toContainText(
    'Pick a form to start.',
  );
  await page.getByTestId('needs-setup-open-intake_questions').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByTestId('intake-form').selectOption({ label: 'Before your first visit' });
  await expect.poll(async () => (await intake())?.formId).toBe(form.formId);

  // The message: it must carry the link, and the preview shows what a customer reads.
  const box = page.getByTestId('intake-message');
  await box.fill('Hi {firstName}, please fill in our form before we come.');
  await expect(page.getByTestId('intake-message-error')).toContainText('{link}');
  await expect(page.getByTestId('intake-message-save')).toBeDisabled();
  await box.fill('Hi {firstName}! A few questions from {businessName} before we come: {link}');
  await expect(page.getByTestId('intake-preview')).toHaveText(
    'Hi Maria! A few questions from Lone Star After HVAC before we come: https://.../f/your-form',
  );
  await page.getByTestId('intake-message-save').click();
  await expect
    .poll(async () => (await intake())?.message)
    .toBe('Hi {firstName}! A few questions from {businessName} before we come: {link}');
  await close(page);
  await expect(page.getByTestId('needs-setup-intake_questions')).toHaveCount(0);

  // With no AI teammate the thank-you still does something, and says what.
  await expect(page.getByTestId('fallback-job_thank_you')).toContainText('card on Home');
  await expect(page.getByTestId('automation-switch-job_thank_you')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Maintenance due waits for a service that repeats; its sheet shows the reminder as a customer reads it.
  await expect(page.getByTestId('needs-setup-maintenance_due')).toContainText(
    'Set how often a service repeats to start.',
  );
  await adjust(page, 'maintenance_due');
  await expect(page.getByTestId('maint-preview')).toHaveText(
    "Hi Maria, it's Lone Star After HVAC. Your AC tune-up is due soon. Book a time that suits you here: https://.../book/your-calendar",
  );
  await expect(page.getByTestId('maint-plan-preview')).toContainText(
    "it's included in your Comfort Club",
  );
  await enter(page, 'maint-lead-days', '21');
  await expect
    .poll(async () => (await settingsOf(owner)).automations?.maintenance?.leadDays)
    .toBe(21);
  await close(page);
  // A service that repeats every 6 months: the row has what it needs.
  await api(owner.token, 'commands', 'service.create', {
    workspaceId: owner.workspaceId,
    name: 'AC tune-up',
    repeatMonths: 6,
  });
  await page.reload();
  await expect(page.getByTestId('needs-setup-maintenance_due')).toHaveCount(0);

  // The end-of-day email goes at the business's own time.
  await adjust(page, 'evening_brief');
  await page.getByTestId('evening-at').selectOption('20:00');
  await expect
    .poll(async () => (await settingsOf(owner)).automations?.briefings?.eveningAt)
    .toBe('20:00');
  await close(page);

  // Moving deals along: each open stage shows what its name suggests, and a different pick is kept.
  const { pipelines } = await api<{
    pipelines: { stages: { id: string; name: string }[] }[];
  }>(owner.token, 'queries', 'pipeline.list', { workspaceId: owner.workspaceId });
  const stages = pipelines[0]!.stages;
  const contacted = stages.find((st) => st.name === 'Contacted')!;
  const quoted = stages.find((st) => st.name === 'Estimate sent')!;
  await adjust(page, 'pipeline_moves');
  await expect(page.getByTestId(`stage-role-${quoted.id}`)).toHaveValue('quoted');
  await expect(page.getByTestId(`stage-role-${contacted.id}`)).toHaveValue('contacted');
  await page.getByTestId(`stage-role-${contacted.id}`).selectOption('none');
  await expect
    .poll(async () => (await settingsOf(owner)).automations?.pipeline?.roles?.[contacted.id])
    .toBe('none');
  await close(page);

  // Referrals are an Action Center kind: the row turns it off.
  await expect(page.getByTestId('automation-referral_mentioned')).toContainText('Just alerts you');
  await page.getByTestId('automation-switch-referral_mentioned').click();
  await expect.poll(async () => (await saved(owner)).kinds?.['referral_mentioned']).toBe(false);
});
