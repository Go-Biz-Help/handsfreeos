import { expect, test } from '@playwright/test';
import { createTeammate, quietHoursOff } from './ai-team';
import { api, ownerWithSite, randomPhone } from './booking-helpers';

/**
 * AI outbound calls, in the browser: the two rows on Settings → Automations (off to begin with, "Calls customers",
 * waiting for the teammate's phone), the Adjust sheet's choice for a voicemail box, and a customer's written consent
 * to calls on their Details.
 */
test('AI calls: the rows, the voicemail choice, and a customer’s consent to calls', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await ownerWithSite(page, 'ai-calls', 'AI Calls HVAC');
  const ws = owner.workspaceId;
  await createTeammate(owner.token, ws);

  await page.goto(`/app/w/${ws}/settings/automations`);
  const row = page.getByTestId('automation-call_back_missed');
  await expect(row).toContainText('Call back a missed call');
  await expect(row).toContainText('Calls customers');
  const flip = page.getByTestId('automation-switch-call_back_missed');
  await expect(flip).not.toBeChecked();
  // Turned on, it says what it's waiting for: the teammate's phone.
  await flip.click();
  await expect(flip).toBeChecked();
  await expect(page.getByTestId('needs-setup-call_back_missed')).toContainText(
    'Turn on phone calls for your AI teammate to start.',
  );
  await expect(page.getByTestId('automation-call_confirm_visits')).toContainText(
    'Call to confirm tomorrow’s visit',
  );
  await expect(page.getByTestId('automation-call_quotes')).toContainText(
    'Call about a quote with no answer',
  );

  // What it does when a voicemail box answers: saved as it's picked.
  await page.getByTestId('adjust-open-call_back_missed').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByTestId('ai-calls-voicemail').selectOption('message');
  await expect(page.getByText('It leaves a short message after the beep.')).toBeVisible();
  await expect
    .poll(async () => {
      const { workspace } = await api<{
        workspace: { settings: { automations?: { calls?: { voicemail?: string } } } };
      }>(owner.token, 'queries', 'workspace.get', { workspaceId: ws });
      return workspace.settings.automations?.calls?.voicemail;
    })
    .toBe('message');
  await page.keyboard.press('Escape');

  // A customer who agreed to calls in writing.
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: ws,
    firstName: 'Ana',
    lastName: 'Tester',
  });
  await page.goto(`/app/w/${ws}/customers/people/${personId}`);
  await page.getByTestId('tab-details').click();
  await expect(page.getByTestId('call-consent-value')).toHaveText('Not asked');
  await page.getByTestId('call-consent-edit').click();
  await expect(page.getByTestId('call-consent-save')).toBeDisabled();
  await page.getByTestId('call-consent-source').fill('Signed service agreement');
  await page.getByTestId('call-consent-save').click();
  await expect(page.getByTestId('call-consent-value')).toHaveText(
    'Agreed in writing (Signed service agreement)',
  );
  await page.reload();
  await page.getByTestId('tab-details').click();
  await expect(page.getByTestId('call-consent-value')).toHaveText(
    'Agreed in writing (Signed service agreement)',
  );
});

/**
 * A call campaign, in the browser: only people who agreed to calls in writing; the AI (the scripted stand-in)
 * writes how every call opens; the owner changes it; approved, it pauses and says why when the teammate isn't
 * taking calls.
 */
test('Call campaign: written consent only, the opening line, approve', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'call-campaigns', 'Call Campaign HVAC');
  const ws = owner.workspaceId;
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: ws,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  await quietHoursOff(owner.token, ws);
  await createTeammate(owner.token, ws);
  const { tagId } = await api<{ tagId: string }>(owner.token, 'commands', 'tag.create', {
    workspaceId: ws,
    name: 'Call list',
  });
  // Ana agreed to calls in writing; Ben didn't, so he's left out.
  for (const [first, agreed] of [
    ['Ana', true],
    ['Ben', false],
  ] as const) {
    const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
      workspaceId: ws,
      firstName: first,
      lastName: 'Tester',
      phone: randomPhone(),
      tagIds: [tagId],
    });
    if (agreed)
      await api(owner.token, 'commands', 'person.set_call_consent', {
        workspaceId: ws,
        personId,
        consent: 'opted_in',
        source: 'Signed service agreement',
      });
  }

  await page.goto(`/app/w/${ws}/campaigns/new`);
  await page.getByTestId('campaign-channel-call').click();
  await page.getByLabel('Name').fill('Fall calls');
  await page.getByLabel('What’s it for?').fill('Our fall tune-up is $89 this month');
  await page
    .getByTestId('campaign-new')
    .getByTestId('tag-picker')
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('menuitemcheckbox', { name: 'Call list' }).click();
  await page.keyboard.press('Escape');
  const preview = page.getByTestId('campaign-preview');
  await expect(preview).toContainText('It would call 1 person.');
  await expect(preview).toContainText('1 person left out: hasn’t agreed to calls in writing');
  await page.getByTestId('campaign-create').click();

  await expect(page).toHaveURL(new RegExp(`/app/w/${ws}/campaigns/[0-9a-f-]{36}$`));
  const view = page.getByTestId('campaign-view');
  await expect(view).toHaveAttribute('data-status', 'review', { timeout: 60_000 });
  const opening = page.getByTestId('campaign-call-opening');
  await expect(opening).toHaveValue('about our fall tune-up is $89 this month.');
  await opening.fill('about our fall tune-up, which is $89 this month.');
  await opening.blur();
  await expect(page.getByTestId('campaign-call')).toContainText('Edited');

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('campaign-approve').click();
  // The teammate here doesn't take calls, so it stops and says why.
  await expect(view).toHaveAttribute('data-status', 'paused', { timeout: 60_000 });
  await expect(page.getByTestId('campaign-paused-reason')).toContainText(
    'your AI teammate isn’t taking calls',
  );
});
