import { expect, test } from '@playwright/test';
import { createBusiness, linkFrom, signUpAndConfirm, waitForMail } from './helpers';
import { setUpTexting, textFromCustomer } from './telephony';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54424';

/** Nobody answers: the owner gets one email (after 8 seconds in tests), and its button opens the thread. */
test('an unanswered text emails the owner once, and the link opens the conversation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'alert-owner');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const business = await setUpTexting(page, workspaceId);

  const sentAt = Date.now();
  await textFromCustomer({
    from: '+17135550188',
    to: business,
    body: 'Can someone call me back about my water heater?',
  });
  const mail = await waitForMail(owner.email, 'is waiting for a reply', {
    after: sentAt,
    timeoutMs: 60_000,
  });
  expect(mail.text).toContain('Can someone call me back about my water heater?');
  expect(mail.text).toContain('Bayou Plumbing Co.');
  const link = linkFrom(
    mail.text,
    /http:\/\/localhost:3000\/app\/w\/[0-9a-f-]{36}\/inbox\/[0-9a-f-]{36}/,
  );

  await page.goto(link);
  await expect(page.getByTestId('message-log')).toContainText(
    'Can someone call me back about my water heater?',
  );

  // One reminder per wait, even after the check has had time to run again.
  await page.waitForTimeout(5000);
  const res = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${owner.email}" subject:"is waiting for a reply"`)}`,
  );
  const { messages } = (await res.json()) as { messages: { Subject: string }[] };
  expect(messages.filter((m) => m.Subject.includes('is waiting for a reply'))).toHaveLength(1);
});
