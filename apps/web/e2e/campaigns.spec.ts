import { expect, test } from '@playwright/test';
import { api, ownerWithSite, randomPhone } from './booking-helpers';

/**
 * Outreach campaigns (Automations, stage 5), in the browser: Campaigns in the side menu; a new campaign picks
 * customers by tag and says who it would text and who it leaves out; the AI (the scripted stand-in) writes each
 * text; every text can be changed on the review screen; and "Approve all and send" starts it.
 */
test('Campaigns: pick by tag, the AI writes each text, edit one, approve all', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'campaigns', 'Campaign Test HVAC');
  const ws = owner.workspaceId;
  // Open around the clock, so the texts may go whatever the hour the spec runs.
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: ws,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  const { tagId } = await api<{ tagId: string }>(owner.token, 'commands', 'tag.create', {
    workspaceId: ws,
    name: 'Fall list',
  });
  // Ana and Ben agreed to texts; Cal never did, so he's left out.
  for (const [first, agreed] of [
    ['Ana', true],
    ['Ben', true],
    ['Cal', false],
  ] as const) {
    const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
      workspaceId: ws,
      firstName: first,
      lastName: 'Tester',
      phone: randomPhone(),
      tagIds: [tagId],
    });
    if (agreed)
      await api(owner.token, 'commands', 'person.set_sms_consent', {
        workspaceId: ws,
        personId,
        consent: 'opted_in',
      });
  }

  await page.goto(`/app/w/${ws}`);
  await page.getByRole('link', { name: 'Campaigns' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${ws}/campaigns$`));
  await expect(page.getByText('No campaigns yet')).toBeVisible();

  await page.getByTestId('campaign-new-link').click();
  await page.getByLabel('Name').fill('Fall tune-up');
  await page.getByLabel('What’s it for?').fill('Our fall tune-up is $89 this month');
  await page
    .getByTestId('campaign-new')
    .getByTestId('tag-picker')
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('menuitemcheckbox', { name: 'Fall list' }).click();
  await page.keyboard.press('Escape');
  const preview = page.getByTestId('campaign-preview');
  await expect(preview).toContainText('It would text 2 people.');
  await expect(preview).toContainText('1 person left out: hasn’t agreed to texts');

  await page.getByTestId('campaign-create').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${ws}/campaigns/[0-9a-f-]{36}$`));
  const view = page.getByTestId('campaign-view');
  // The worker writes the texts; the page keeps up on its own.
  await expect(view).toHaveAttribute('data-status', 'review', { timeout: 60_000 });
  await expect(page.getByTestId('campaign-status')).toHaveText('Ready to review');
  const ana = page.getByLabel('Text to Ana Tester');
  await expect(ana).toHaveValue('Hi Ana, Our fall tune-up is $89 this month. Just reply here.');
  await page.getByTestId('campaign-left-out').locator('summary').click();
  await expect(page.getByTestId('campaign-left-out')).toContainText('Hasn’t agreed to texts');

  // Change Ana's text: it saves when the box is left.
  await ana.fill('Ana, the fall tune-up is back at $89. Want a spot?');
  await ana.blur();
  await expect(view.getByText('Edited')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Text to Ana Tester')).toHaveValue(
    'Ana, the fall tune-up is back at $89. Want a spot?',
  );

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('campaign-approve').click();
  // Sending (or paused by itself when this test business can't text yet): no longer waiting for review.
  await expect(view).not.toHaveAttribute('data-status', 'review');
  await page.goto(`/app/w/${ws}/campaigns`);
  await expect(page.getByTestId('campaign-list')).toContainText('Fall tune-up');
});
