import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting, textFromCustomer } from './telephony';

const ROSA = '+17135550199';

/**
 * Asking a customer for a video (20261018000200), end to end: the reply box's "Ask for a video" puts a link in the
 * text, the customer opens it signed out and sends a video at full quality, and it arrives in the thread as their
 * reply, marked as having come through the link, and plays in the viewer.
 */
test('asking for a video: the link goes by text, and the video comes back into the thread', async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'video-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const business = await setUpTexting(page, workspaceId);
  // Tests text at any hour.
  await page.getByTestId('quiet-hours-switch').click();
  await expect(page.getByText('Quiet hours off')).toBeVisible();

  await textFromCustomer({
    from: ROSA,
    to: business,
    body: 'The unit is making a grinding noise.',
  });
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('conversation-list').getByText('grinding noise').click();
  await expect(page.getByTestId('message-log')).toContainText('grinding noise');

  // The button writes the ask, with the link, into the box; the person sends it like any text.
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await page.getByTestId('composer-ask-video').click();
  await expect(box).toHaveValue(
    /Use this link so it comes through clear: http:\/\/localhost:3000\/v\//,
  );
  const link = (await box.inputValue()).match(/http:\/\/localhost:3000\/v\/\S+/)![0];
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('message-log')).toContainText(
    'Use this link so it comes through clear',
  );

  // The customer, signed out, on their phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const customer = await phone.newPage();
  await customer.goto(link);
  await expect(customer.getByTestId('video-link-ready')).toContainText(
    'Send Lone Star HVAC & Roofing a video',
  );
  await customer.getByTestId('video-link-file').setInputFiles({
    name: 'noise.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('a whole video, as the phone recorded it'),
  });
  await expect(customer.getByTestId('video-link-sent')).toContainText(
    'Sent. Lone Star HVAC & Roofing has your video.',
  );
  await phone.close();

  // It lands in the thread as Rosa's reply, says how it came, and opens in the viewer.
  const thumb = page.getByRole('button', { name: 'Play noise.mp4' });
  await expect(thumb).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('came-by-video-link')).toHaveText('Sent with your video link');
  await thumb.click();
  await expect(page.getByTestId('video-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('video-viewer')).toHaveCount(0);
});
