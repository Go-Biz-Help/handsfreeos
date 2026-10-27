/**
 * The bell (20261027012600): what HandsFreeOS sends to a person's phones is kept for them, and the web lists it too,
 * against the local stack and the worker's stand-in push service.
 * - A customer texts a business whose owner has a phone: the push goes, and the bell, open on Home, counts it
 *   without a reload.
 * - Opening the bell sees it (the count goes) and lists it, marked until it's pressed, with the business's name.
 * - Pressing it reads it and opens where the push opens: the conversation.
 * - Another customer's text is a line of its own, at the top.
 */
import { expect, test } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting, textFromCustomer } from './telephony';

const BUSINESS = 'Bellwether Heating';

interface Sent {
  readonly to: string;
  readonly body: string | null;
  readonly data: { readonly path?: string };
}

/** What the stand-in push service was handed for the business, once its waiting sends have run. */
async function pushesFor(workspaceId: string): Promise<Sent[]> {
  await fetch(`${WORKER}/test/push/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  const res = await fetch(`${WORKER}/test/push/sent?workspaceId=${workspaceId}`);
  return ((await res.json()) as { sent: Sent[] }).sent;
}

test('a push is kept under the bell, and pressing it opens the conversation', async ({ page }) => {
  test.setTimeout(240_000);
  const { email } = await signUpAndConfirm(page, 'bell-owner');
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  const number = await setUpTexting(page, workspaceId);
  const { token } = await signInOwner(email);
  const phone = `ExponentPushToken[bell-${Date.now()}]`;
  await api(token, 'commands', 'push_device.register', {
    platform: 'ios',
    token: phone,
    appVersion: '1.0.0',
    deviceName: 'Test iPhone',
  });

  await page.goto(`/app/w/${workspaceId}`);
  const bell = page.getByTestId('bell-button');
  // The side menu's bell; the phone-width header has its own.
  const count = bell.getByTestId('bell-count');
  await expect(bell).toHaveAccessibleName('Notifications');
  await expect(count).toHaveCount(0);

  // 1. A customer texts: the owner's phone gets a push, and the bell counts it.
  const first = `Is anyone free to look at my furnace? ${Date.now() % 100_000}`;
  await textFromCustomer({ from: '+17135550191', to: number, body: first });
  let push: Sent | undefined;
  await expect
    .poll(
      async () => {
        push = (await pushesFor(workspaceId)).find(
          (s) => s.to === phone && s.body?.includes(first),
        );
        return !!push;
      },
      { timeout: 60_000, message: 'the owner’s phone gets the push' },
    )
    .toBe(true);
  await expect(count).toHaveText('1', { timeout: 30_000 });
  await expect(bell).toHaveAccessibleName('Notifications: 1 new');

  // 2. Opening the bell sees it, and lists it marked until it's pressed.
  await bell.click();
  const items = page.getByTestId('bell-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(first);
  await expect(items.first()).toContainText(BUSINESS);
  await expect(items.first().getByTestId('bell-unread')).toBeVisible();
  await expect(count).toHaveCount(0);

  // 3. Pressing it reads it and opens the conversation, where the push opens.
  await items.first().click();
  expect(push!.data.path).toMatch(new RegExp(`^/app/w/${workspaceId}/inbox/[0-9a-f-]{36}$`));
  await expect(page).toHaveURL((url) => url.pathname === push!.data.path);
  await expect(page.getByTestId('message-log')).toContainText(first);
  await expect
    .poll(
      async () =>
        (
          await api<{ notifications: { readAt: string | null }[]; unseen: number }>(
            token,
            'queries',
            'notification.list',
            { workspaceId },
          )
        ).notifications.map((n) => n.readAt !== null),
      { message: 'HandsFreeOS keeps it as read, for the phone too' },
    )
    .toEqual([true]);

  // 4. Another customer: a line of its own, at the top, and the first stays read.
  const second = `Do you clean ducts too? ${Date.now() % 100_000}`;
  await textFromCustomer({ from: '+17135550192', to: number, body: second });
  await expect
    .poll(
      async () =>
        (await pushesFor(workspaceId)).some((s) => s.to === phone && s.body?.includes(second)),
      { timeout: 60_000, message: 'the owner’s phone gets the second push' },
    )
    .toBe(true);
  await expect(count).toHaveText('1', { timeout: 30_000 });
  await bell.click();
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(second);
  await expect(items.nth(0).getByTestId('bell-unread')).toBeVisible();
  await expect(items.nth(1)).toContainText(first);
  await expect(items.nth(1).getByTestId('bell-unread')).toHaveCount(0);
});
