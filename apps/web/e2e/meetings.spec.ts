import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  api,
  bookThroughWorker,
  daysFromNow,
  makeCalendar,
  ownerWithSite,
  WORKER,
} from './booking-helpers';

/**
 * Video meetings, end to end on the stand-ins: the owner connects Zoom, a customer books an online visit set to
 * record, the appointment gets its Zoom link, the call ends with a transcript (Zoom's signed webhook), and the
 * owner adds the task the AI suggests from it.
 */

/** What the stand-in's webhooks are signed with (apps/worker/src/meetings/fake.ts). Not a secret. */
const FAKE_ZOOM_WEBHOOK_SECRET = 'fake-zoom-webhook-secret';

async function zoomWebhook(event: unknown): Promise<number> {
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', FAKE_ZOOM_WEBHOOK_SECRET).update(`v0:${ts}:${raw}`).digest('hex')}`;
  const res = await fetch(`${WORKER}/webhooks/zoom`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zm-request-timestamp': ts,
      'x-zm-signature': signature,
    },
    body: raw,
  });
  return res.status;
}

test('a recorded Zoom call becomes a transcript and a suggested task someone adds', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await ownerWithSite(page, 'zoom-owner', 'Lone Star Consults');

  // Connect Zoom through the stand-in sign-in.
  // Right after sign-up the new business can take a moment to show to the server-rendered page.
  await expect(async () => {
    await page.goto(`/app/w/${owner.workspaceId}/settings/my-calendar`);
    await expect(page.getByTestId('connect-zoom')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId('connect-zoom').click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/settings\/my-calendar$/);
  await expect(page.getByTestId('meeting-connection')).toContainText('Connected');

  // An online calendar that makes a Zoom link for each visit and records it.
  const cal = await makeCalendar(owner, 'Video consults', {
    locations: { options: [{ kind: 'virtual', video: 'zoom', record: true }] },
  });
  const startsAt = daysFromNow(1);
  expect(await bookThroughWorker(owner.site, cal.slug, startsAt)).toBe(200);
  const at = Date.parse(startsAt);
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

  // The worker makes the meeting in Zoom and puts its link on the appointment.
  type Got = { appointment: { location: { meetingUrl: string | null; meetingId: string | null } } };
  let meetingId: string | null = null;
  await expect
    .poll(
      async () => {
        const got = await api<Got>(owner.token, 'queries', 'appointment.get', {
          workspaceId: owner.workspaceId,
          appointmentId,
        });
        meetingId = got.appointment.location.meetingId;
        return got.appointment.location.meetingUrl;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^https:\/\//);

  await page.goto(`/app/w/${owner.workspaceId}/calendar?appt=${appointmentId}`);
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('zoom.us/j/');

  // The call ends: Zoom has the transcript and says so.
  const made = await fetch(`${WORKER}/test/zoom/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      meetingId,
      lines: ['Dale: Thanks for joining.', 'Customer: Could you send me a quote for two units?'],
    }),
  });
  expect(made.ok).toBe(true);
  const file = (await made.json()) as { url: string; fileId: string };
  expect(
    await zoomWebhook({
      event: 'recording.transcript_completed',
      payload: {
        object: {
          id: meetingId,
          recording_files: [
            {
              id: file.fileId,
              file_type: 'TRANSCRIPT',
              download_url: file.url,
              status: 'completed',
            },
          ],
        },
      },
    }),
  ).toBe(200);

  // The transcript and the AI's suggestions show on the appointment; the owner adds the task.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('appointment-transcript')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('call-suggestion').first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  const task = page.getByTestId('call-suggestion').filter({ hasText: 'Suggested task' });
  await expect(task.getByLabel('Task')).toHaveValue('Send the quote');
  await task.getByRole('button', { name: 'Add task' }).click();
  await expect(task).toHaveAttribute('data-status', 'approved');
  await expect(task).toContainText('Done');
});
