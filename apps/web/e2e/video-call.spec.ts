import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, test } from '@playwright/test';
import {
  api,
  makeCalendar,
  openTimes,
  ownerWithSite,
  randomPhone,
  TURNSTILE_TEST_TOKEN,
  WORKER,
} from './booking-helpers';
import { linkFrom, waitForMail } from './helpers';

/**
 * HandsFreeOS video calls (docs/video-calls.md), end to end on a real LiveKit server: support turns them on in
 * /admin, a customer books an online visit set to one, opens their own Join link and waits, the owner joins from the
 * appointment, and the customer goes straight in (the owner's 6a). They see each other, chat and raise a hand, End
 * for everyone ends it for both, and the appointment says who joined.
 *
 * It needs the worker on LiveKit: CI starts one before the browser tests ("Start a local LiveKit server" in
 * .github/workflows/ci.yml). On the worker's stand-in nothing connects, so it's skipped. Read from apps/worker/.env as
 * the worker does, since Playwright takes LIVEKIT_* out of the environment it hands the servers.
 */
function videoProvider(): string {
  if (process.env.VIDEO_PROVIDER) return process.env.VIDEO_PROVIDER;
  const file = resolve('../worker/.env');
  if (!existsSync(file)) return 'fake';
  return parseEnv(readFileSync(file, 'utf8')).VIDEO_PROVIDER ?? 'fake';
}

test.skip(
  videoProvider() !== 'livekit',
  'The worker isn’t on LiveKit. Run one locally as "Video calls: LiveKit" in docs/operations.md says.',
);

// Chromium's own stand-in camera and microphone, allowed without asking.
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
  permissions: ['camera', 'microphone'],
});

test('a customer and the owner meet in a booked HandsFreeOS video call', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'video-owner', 'Clear Line Coaching');
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, {
    data: { email: owner.email },
  });
  expect(((await made.json()) as { made: number }).made).toBe(1);

  // Support turns video calls on for the business.
  await page.goto(`/admin/businesses/${owner.workspaceId}`);
  const on = page.getByTestId('admin-video-calls-on');
  await on.click();
  await expect(on).toHaveAttribute('aria-selected', 'true');

  // The Online place makes a HandsFreeOS video call for each visit, and Settings says so.
  const cal = await makeCalendar(owner, 'Coaching call', {
    locations: { options: [{ kind: 'virtual', video: 'handsfree' }] },
  });
  await page.goto(`/app/w/${owner.workspaceId}/settings/calendars/${cal.id}`);
  await page.getByTestId('module-locations').click();
  await expect(page.getByLabel('Video link')).toHaveValue('handsfree');
  await expect(page.getByTestId('handsfree-place')).toContainText('nothing to set up');

  // A customer books the first open time, within the hour, so their link opens the call now.
  const [first] = await openTimes(owner.site, cal.slug);
  const email = `maya-${randomUUID().slice(0, 8)}@hfos.test`;
  const booked = await fetch(`${WORKER}/public/book/${owner.site}/${cal.slug}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: randomUUID(),
      startsAt: first!.startsAt,
      name: 'Maya Brooks',
      phone: randomPhone(),
      email,
      turnstileToken: TURNSTILE_TEST_TOKEN,
    }),
  });
  expect(booked.status, await booked.clone().text()).toBe(200);
  const at = Date.parse(first!.startsAt);
  const { items } = await api<{ items: { id: string }[] }>(
    owner.token,
    'queries',
    'appointment.list',
    {
      workspaceId: owner.workspaceId,
      from: new Date(at - 60_000).toISOString(),
      to: new Date(at + 60_000).toISOString(),
      calendarIds: [cal.id],
    },
  );
  const appointmentId = items[0]!.id;

  // Their confirmation carries their own Join link, which opens the call itself: a camera check, then Join.
  const mail = await waitForMail(email, 'You’re booked: Coaching call');
  const join = linkFrom(mail.text || mail.html, /http:\/\/localhost:3000\/j\/[0-9A-Za-z]{18}/);
  const customer = await (
    await browser.newContext({ permissions: ['camera', 'microphone'] })
  ).newPage();
  await customer.goto(join);
  await expect(customer.getByTestId('call-heading')).toHaveText('Coaching call');
  await expect(customer.getByTestId('prejoin-name')).toHaveValue('Maya Brooks');
  await customer.getByTestId('prejoin-join').click();
  // Nobody from the team is there yet.
  await expect(customer.getByTestId('call-waiting')).toContainText('will be right with you');

  // The owner joins from the appointment, in a tab of its own.
  await page.goto(`/app/w/${owner.workspaceId}/calendar?appt=${appointmentId}`);
  const sheet = page.getByRole('dialog');
  const joinCall = sheet.getByTestId('sheet-join-call');
  await expect(joinCall).toBeVisible({ timeout: 30_000 });
  const [team] = await Promise.all([page.context().waitForEvent('page'), joinCall.click()]);
  await expect(team).toHaveURL(/\/call\/[0-9a-f-]{36}$/);
  await team.getByTestId('prejoin-join').click();
  await expect(team.getByTestId('call-room')).toBeVisible();

  // The customer goes straight in, and they see each other.
  for (const p of [team, customer])
    await expect(p.locator('[data-testid="call-tile"][data-video="on"]')).toHaveCount(2, {
      timeout: 30_000,
    });

  // Chat reaches the other side.
  await team.getByTestId('call-chat-button').click();
  await team.getByTestId('call-chat-input').fill('Hi Maya, can you hear me?');
  await team.keyboard.press('Enter');
  await customer.getByTestId('call-chat-button').click();
  await expect(customer.getByTestId('call-chat')).toContainText('Hi Maya, can you hear me?');

  // A raised hand shows on the customer's tile for the owner.
  await customer.getByTestId('call-raise-hand').click();
  await expect(
    team.locator('[data-testid="call-tile"][data-name="Maya Brooks"]').getByTestId('call-hand'),
  ).toBeVisible();

  // End for everyone ends it on both sides.
  await team.getByTestId('call-leave').click();
  await team.getByTestId('call-end-for-everyone').click();
  await team.getByTestId('call-end-confirm').click();
  await expect(team.getByTestId('call-ended')).toBeVisible();
  await expect(customer.getByTestId('call-ended')).toBeVisible();

  // The appointment says who joined, once LiveKit has told the worker they left.
  const people = sheet.getByTestId('sheet-call-person');
  await expect(people).toHaveCount(2, { timeout: 30_000 });
  await expect(sheet.getByTestId('sheet-call-people')).toContainText('Maya Brooks');
  await expect(sheet.getByTestId('sheet-call-people')).not.toContainText('In the call now', {
    timeout: 30_000,
  });
});
