import { expect, test } from '@playwright/test';
import { api, ownerWithSite } from './booking-helpers';
import { MAILPIT } from './helpers';

/** The unsubscribe link in the first campaign email that reached one of these addresses. */
async function unsubscribeLink(addresses: readonly string[]): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const to of addresses) {
      const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
      const hit = ((await res.json()) as { messages: { ID: string }[] }).messages[0];
      if (!hit) continue;
      const mail = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      const url = /Unsubscribe: (\S+)/.exec(mail.Text)?.[1];
      if (url) return url;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no campaign email arrived');
}

/**
 * Email campaigns, in the browser: a new campaign sent as one email says who it would email and who it leaves
 * out; the AI (the scripted stand-in) writes the one email; the owner changes it on the review screen; "Approve
 * all and send" starts it; and the unsubscribe page asks before it unsubscribes anybody.
 */
test('Email campaign: one email, edit it, approve; the unsubscribe page', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'email-campaigns', 'Email Campaign HVAC');
  const ws = owner.workspaceId;
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: ws,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  const { tagId } = await api<{ tagId: string }>(owner.token, 'commands', 'tag.create', {
    workspaceId: ws,
    name: 'Newsletter',
  });
  // Ana and Ben have email addresses; Cal doesn't, so he's left out.
  const stamp = Date.now().toString(36);
  const addresses = [`ana-${stamp}@example.com`, `ben-${stamp}@example.com`];
  for (const [first, email] of [
    ['Ana', addresses[0]],
    ['Ben', addresses[1]],
    ['Cal', null],
  ] as const)
    await api(owner.token, 'commands', 'person.create', {
      workspaceId: ws,
      firstName: first,
      lastName: 'Tester',
      ...(email ? { email } : {}),
      tagIds: [tagId],
    });

  await page.goto(`/app/w/${ws}/campaigns/new`);
  await page.getByTestId('campaign-channel-email').click();
  await page.getByLabel('Name').fill('Fall news');
  await page.getByLabel('What’s it for?').fill('Our fall tune-up is $89 this month');
  await page
    .getByTestId('campaign-new')
    .getByTestId('tag-picker')
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('menuitemcheckbox', { name: 'Newsletter' }).click();
  await page.keyboard.press('Escape');
  const preview = page.getByTestId('campaign-preview');
  await expect(preview).toContainText('It would email 2 people.');
  await expect(preview).toContainText('1 person left out: no email address');
  // Every email shows the business's address: none yet, so it can't be made.
  await expect(page.getByTestId('campaign-no-address')).toBeVisible();
  await expect(page.getByTestId('campaign-create')).toBeDisabled();

  await api(owner.token, 'commands', 'money.save_settings', {
    workspaceId: ws,
    settings: { businessAddress: '12 Main St\nHouston, TX 77002' },
  });
  // The preview asks again when the picks change.
  await page.getByTestId('campaign-channel-sms').click();
  await page.getByTestId('campaign-channel-email').click();
  await expect(page.getByTestId('campaign-no-address')).toHaveCount(0);
  await page.getByTestId('campaign-create').click();

  await expect(page).toHaveURL(new RegExp(`/app/w/${ws}/campaigns/[0-9a-f-]{36}$`));
  const view = page.getByTestId('campaign-view');
  await expect(view).toHaveAttribute('data-status', 'review', { timeout: 60_000 });
  const subject = page.getByTestId('campaign-email-subject');
  const body = page.getByTestId('campaign-email-body');
  await expect(subject).toHaveValue('Our fall tune-up is $89 this month');
  await expect(body).toHaveValue(/^Hi \{first_name\},/);
  await expect(page.getByTestId('campaign-email-footer')).toContainText('12 Main St');

  await subject.fill('Fall tune-up: $89 this month');
  await subject.blur();
  await expect(page.getByTestId('campaign-email')).toContainText('Edited');
  await page.reload();
  await expect(page.getByTestId('campaign-email-subject')).toHaveValue(
    'Fall tune-up: $89 this month',
  );

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('campaign-approve').click();
  await expect(view).not.toHaveAttribute('data-status', 'review');

  // The email's own unsubscribe link: opening it asks; pressing the button does it.
  const link = new URL(await unsubscribeLink(addresses));
  await page.goto(link.pathname);
  await expect(page.getByTestId('unsubscribe-ask')).toContainText(
    'Stop emails from Email Campaign HVAC?',
  );
  await page.getByTestId('unsubscribe-button').click();
  await expect(page.getByTestId('unsubscribe-done')).toContainText('You’re unsubscribed');
  await page.reload();
  await expect(page.getByTestId('unsubscribe-done')).toBeVisible();

  // A link that doesn't work says so.
  await page.goto(`/u/${'0'.repeat(32)}${'A'.repeat(16)}`);
  await expect(page.getByTestId('unsubscribe-missing')).toBeVisible();
});
