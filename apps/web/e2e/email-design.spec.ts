import { expect, test } from '@playwright/test';
import { quietHoursOff } from './ai-team';
import { api, ownerWithSite } from './booking-helpers';
import { MAILPIT } from './helpers';

/** A 64 × 48 picture in one colour. */
const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAfUlEQVRoge2SAQkAURSDlsC0F8TIF2M8/sAAOhY+T5O6AQuwviK7kHdJ3YAFWF+RXci7pG7AAqyvyC7kXVI3YAHWV2QX8i6pG7AA6yuyC3mX1A1YgPUV2YW8S+oGLMD6iuxC3iV1AxZgfUV2Ie+SugELsL4iu5B3Sd2AxwN+6nXYtTxbdTgAAAAASUVORK5CYII=',
  'base64',
);

/** The HTML of the first email that reached this address. */
async function htmlTo(address: string): Promise<{ html: string; text: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const hit = ((await res.json()) as { messages: { ID: string }[] }).messages[0];
    if (hit) {
      const m = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as {
        HTML: string;
        Text: string;
      };
      return { html: m.HTML, text: m.Text };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no email reached ${address}`);
}

/**
 * Emails in design tools part 5 (docs/forms.md, "How your emails look"): the owner adds a social link to the brand kit,
 * picks the email layout in Settings → Email and sees it in the preview, then designs a campaign email in blocks: its
 * words become blocks, a picture from Your pictures goes in, a button moves up and lines up in the centre, and the
 * preview shows it. Sent, the email has the picture, the button, the band and the footer.
 */
test('email layout, social links and a campaign email in blocks', async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'email-design', 'Email Design HVAC');
  const ws = owner.workspaceId;
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: ws,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  await quietHoursOff(owner.token, ws);
  await api(owner.token, 'commands', 'money.save_settings', {
    workspaceId: ws,
    settings: { businessAddress: '12 Main St\nHouston, TX 77002' },
  });

  // The brand kit's social links.
  await page.goto(`/app/w/${ws}/settings/workspace`);
  await page.getByTestId('brand-kit-social-input').fill('not a link');
  await page.getByTestId('brand-kit-social-add').click();
  await expect(page.getByTestId('brand-kit-socials')).toContainText('Type a web address');
  await page.getByTestId('brand-kit-social-input').fill('facebook.com/emaildesignhvac');
  await page.getByTestId('brand-kit-social-add').click();
  await expect(page.getByTestId('brand-kit-social')).toContainText('Facebook');
  await expect(page.getByTestId('brand-kit-social-input')).toHaveValue('');

  // Settings → Email: the layout, shown in the preview before it's saved.
  await page.goto(`/app/w/${ws}/settings/email`);
  const card = page.getByTestId('email-look');
  await expect(card).toBeVisible();
  await page.getByTestId('email-look-logo-center').click();
  const preview = page.frameLocator('[data-testid="email-look-preview"]');
  await expect(preview.locator('body')).toContainText('Email Design HVAC');
  await expect(preview.locator('body')).toContainText('12 Main St, Houston, TX 77002');
  await expect(preview.getByRole('link', { name: 'Facebook' })).toBeVisible();
  await expect(preview.getByRole('link', { name: 'Change or cancel' })).toBeVisible();
  await page.getByTestId('email-look-save').click();
  await expect(page.getByTestId('email-look-usual')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('email-look-usual')).toBeVisible();
  await expect(page.getByTestId('email-look-save')).toBeDisabled();

  // A campaign email, its words given, so it waits for review at once.
  const stamp = Date.now().toString(36);
  const to = `eve-${stamp}@example.com`;
  const { tagId } = await api<{ tagId: string }>(owner.token, 'commands', 'tag.create', {
    workspaceId: ws,
    name: 'Newsletter',
  });
  await api(owner.token, 'commands', 'person.create', {
    workspaceId: ws,
    firstName: 'Eve',
    lastName: 'Tester',
    email: to,
    tagIds: [tagId],
  });
  const made = await api<{ campaignId: string }>(owner.token, 'commands', 'campaign.create', {
    workspaceId: ws,
    name: 'Fall in blocks',
    goal: 'Fall tune-ups',
    audience: { tagIds: [tagId], stageIds: [] },
    channel: 'email',
    words: {
      subject: 'Fall tune-ups',
      body: 'Hi {first_name},\n\nTune-ups are $89 this month.',
    },
  });
  await page.goto(`/app/w/${ws}/campaigns/${made.campaignId}`);
  const view = page.getByTestId('campaign-view');
  await expect(view).toHaveAttribute('data-status', 'review', { timeout: 60_000 });

  // Its words become blocks; a picture and a button go in.
  await page.getByTestId('campaign-email-blocks').click();
  const blocks = page.getByTestId('email-block');
  await expect(blocks).toHaveCount(1);
  await page.getByTestId('email-blocks-add-picture').click();
  await page.getByTestId('email-block-picture-change').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('picture-upload-input').setInputFiles({
    name: 'van.png',
    mimeType: 'image/png',
    buffer: PHOTO_PNG,
  });
  const tile = dialog.getByTestId('picture-tile');
  await expect(tile).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await tile.click();
  await expect(dialog).toHaveCount(0);
  await blocks.nth(1).getByTestId('email-block-caption').fill('Our van');

  await page.getByTestId('email-blocks-add-button').click();
  const button = blocks.nth(2);
  await button.getByTestId('email-block-button-label').fill('Book now');
  await button.getByTestId('email-block-button-url').fill('https://example.com/book');
  await button.getByTestId('email-block-align-center').click();
  // Moved above the picture with its arrow.
  await button.getByTestId('email-block-up').click();
  await expect(blocks.nth(1)).toHaveAttribute('data-kind', 'button');
  await page.getByTestId('campaign-email-save').click();
  await expect(page.getByTestId('campaign-email-save')).toBeDisabled();

  // The preview: the button, then the picture, as Sam gets it.
  await page.getByTestId('campaign-email-preview-tab').click();
  const shown = page.frameLocator('[data-testid="campaign-email-preview"]');
  await expect(shown.getByRole('link', { name: 'Book now' })).toBeVisible();
  await expect(shown.getByRole('img', { name: 'Our van' })).toBeVisible();
  await expect(shown.locator('body')).toContainText('Hi Sam,');

  // Kept: after a reload it's still in blocks.
  await page.reload();
  await expect(page.getByTestId('email-block')).toHaveCount(3);

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('campaign-approve').click();
  await expect(view).not.toHaveAttribute('data-status', 'review');

  const mail = await htmlTo(to);
  expect(mail.text).toContain('Book now: https://example.com/book');
  expect(mail.html).toContain(`/storage/v1/object/public/pictures/${ws}/`);
  expect(mail.html).toContain('alt="Our van"');
  expect(mail.html).toMatch(/>Book now<\/a>/);
  expect(mail.html).toContain('Hi Eve,');
  expect(mail.html).toContain('>Facebook</a>');
  expect(mail.html).toContain('max-width:600px');
});
