import { expect, test } from '@playwright/test';
import { createTeammate } from './ai-team';
import { api, ownerWithSite } from './booking-helpers';

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
