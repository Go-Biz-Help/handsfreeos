import { expect, test, type Locator, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting, tapFromCustomer, textFromCustomer } from './telephony';

/** A phone that shows RCS, and (in the fake carrier, any number ending in 7) one that doesn't. */
const MIKE = '+17135550142';
const DANA = '+17135550167';
/** The fake carrier's approved stand-in sender (apps/worker/src/telephony/fake.ts). */
const SENDER = 'hfos_demo_agent';

async function addCustomer(page: Page, workspaceId: string, first: string, phone: string) {
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Last name').fill('Rivera');
  await page.getByLabel('Phone').fill(phone);
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
}

/** Writes a text with two reply buttons in the open conversation and sends it; returns its bubble. */
async function sendWithButtons(page: Page, words: string): Promise<Locator> {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(words);
  await page.getByTestId('composer-rich').click();
  const editor = page.getByTestId('rich-editor');
  const titles = editor.getByTestId('rich-button-title');
  await titles.nth(0).fill('Confirm');
  await editor.getByTestId('rich-add-button').click();
  await titles.nth(1).fill('Reschedule');
  // Nobody picks RCS or SMS: the editor shows what a phone without RCS gets instead.
  await expect(editor.getByTestId('rich-plain-face')).toContainText(
    'Reply 1 for Confirm or 2 for Reschedule.',
  );
  await page.getByTestId('composer-send').click();
  await expect(editor).toHaveCount(0);
  const sent = page.getByTestId('message-log').locator('[data-direction="outbound"]').last();
  await expect(sent).toContainText(words);
  await expect(sent.getByTestId('rich-button')).toHaveText(['Confirm', 'Reschedule']);
  return sent;
}

/**
 * RCS (0103) in the same inbox as texts: a business connects the sender it made at Twilio, its texts then go RCS
 * first — buttons and all — and say so, a tap comes back to the same thread naming the button, and a phone that
 * can't show RCS gets the words with the choices listed, whose texted-back number counts as the tap.
 */
test('RCS: connect a sender, send buttons, see how each text went, and read the answers', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signUpAndConfirm(page, 'rcs-owner');
  const workspaceId = await createBusiness(page, { name: 'Bluebonnet Plumbing' });
  const business = await setUpTexting(page, workspaceId);
  // Tests text at any hour.
  await page.getByTestId('quiet-hours-switch').click();
  await expect(page.getByText('Quiet hours off')).toBeVisible();

  // Settings → Texting & calls: a business asks us to make its sender (0104), and pays; one that already has
  // a sender connects it — the senders already in the business's Twilio account, one click to connect.
  const card = page.getByTestId('rcs-card');
  await expect(card.getByTestId('rcs-badge')).toHaveText('Off');
  await expect(card.getByTestId('rcs-first-year')).toHaveText('$800');
  await expect(card.getByTestId('rcs-yearly')).toHaveText('$215');
  await card.getByTestId('rcs-connect-own').click();
  const accountSid = (await card.getByTestId('rcs-account').textContent())!.trim();
  expect(accountSid).toMatch(/^AC/);
  await card.getByTestId('rcs-found-sender').filter({ hasText: SENDER }).click();
  await expect(card.getByTestId('rcs-sender-id')).toHaveValue(SENDER);
  await card.getByTestId('rcs-connect').click();
  await expect(card.getByTestId('rcs-badge')).toHaveText('On', { timeout: 30_000 });
  await expect(page.getByTestId('rcs-on-badge')).toBeVisible();

  // A customer whose phone shows RCS: the reply goes RCS first, and the thread says so, then that they read it.
  await addCustomer(page, workspaceId, 'Mike', '(713) 555-0142');
  await textFromCustomer({ from: MIKE, to: business, body: 'Can someone look at a leak Tuesday?' });
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('conversation-list').getByText('Mike Rivera').click();
  const log = page.getByTestId('message-log');
  await expect(log).toContainText('Can someone look at a leak Tuesday?');
  const toMike = await sendWithButtons(page, 'Tuesday at 2 PM works. Does that suit you?');
  await expect(toMike).toHaveAttribute('data-transport', 'rcs', { timeout: 20_000 });
  await expect(toMike).toHaveAttribute('data-status', 'read', { timeout: 20_000 });
  await expect(toMike.getByTestId('transport')).toHaveText('RCS');
  await expect(toMike).toContainText('Read');
  await expect(toMike.getByTestId('plain-face')).toHaveCount(0);

  // Mike taps Confirm: it lands in the same thread, naming the button.
  const messageId = (await toMike.getAttribute('data-testid'))!.replace('message-', '');
  await tapFromCustomer({
    accountSid,
    from: MIKE,
    sender: SENDER,
    title: 'Confirm',
    payload: `${messageId.replace(/-/g, '').slice(0, 8)}.r1`,
  });
  const tap = log.locator('[data-direction="inbound"]').last();
  await expect(tap).toContainText('Confirm');
  await expect(tap.getByTestId('button-reply')).toHaveText('Tapped “Confirm”');
  await expect(tap.getByTestId('transport')).toHaveText('RCS');

  // A phone without RCS: the same message goes as a text with the choices listed, and a texted 2 is the button.
  await addCustomer(page, workspaceId, 'Dana', '(713) 555-0167');
  await textFromCustomer({ from: DANA, to: business, body: 'Any time Thursday?' });
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await page.getByTestId('conversation-list').getByText('Dana Rivera').click();
  await expect(log).toContainText('Any time Thursday?');
  const toDana = await sendWithButtons(page, 'Thursday at 10 AM is open.');
  await expect(toDana).toHaveAttribute('data-transport', 'sms', { timeout: 20_000 });
  await expect(toDana).toHaveAttribute('data-status', 'delivered', { timeout: 20_000 });
  await expect(toDana.getByTestId('transport')).toContainText('SMS');
  await toDana.getByTestId('plain-face').locator('summary').click();
  await expect(toDana.getByTestId('plain-face')).toContainText(
    'Reply 1 for Confirm or 2 for Reschedule.',
  );
  await textFromCustomer({ from: DANA, to: business, body: '2' });
  const answer = log.locator('[data-direction="inbound"]').last();
  await expect(answer.getByTestId('button-reply')).toHaveText('Texted 2 for “Reschedule”');

  // Paused, texts go as they did before; switched back on, the card follows the sender back onto texting.
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  await card.getByTestId('rcs-enabled').click();
  await expect(card.getByTestId('rcs-badge')).toHaveText('Paused');
  await expect(page.getByTestId('rcs-on-badge')).toHaveCount(0);
  await card.getByTestId('rcs-enabled').click();
  await expect(card.getByTestId('rcs-badge')).toHaveText('On', { timeout: 30_000 });
});
