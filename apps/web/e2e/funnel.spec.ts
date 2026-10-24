import { expect, test, type Page } from '@playwright/test';
import {
  api as bookingApi,
  daysFromNow,
  makeCalendar,
  ownerWithSite,
  randomPhone,
} from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { apiAs, signInForApi } from './workflow-approval-api';

/**
 * A step-by-step funnel on a form's public link: their name, a video that holds Next until they've watched 80% of
 * it, then their phone.
 *
 * The video is YouTube's address, answered by a stand-in player: the test serves the frame itself, and the
 * stand-in reports its position by message the way YouTube's player does, from YouTube's own origin. So the page
 * reads it exactly as it would read YouTube.
 */

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** The stand-in: answers the page's hello, and `playTo(percent)` plays a 100-second video from the top. */
const STAND_IN_PLAYER = `<!doctype html><html><body style="margin:0;background:#000">
<script>
  let id = null;
  const say = (m) => parent.postMessage(JSON.stringify({ ...m, id, channel: 'widget' }), '*');
  window.addEventListener('message', (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.event === 'listening') {
        id = m.id;
        say({ event: 'onReady' });
        say({ event: 'initialDelivery', info: { duration: 100, currentTime: 0 } });
      }
    } catch {}
  });
  // Like YouTube's, it reports nothing until the page has said hello.
  window.playTo = async (percent) => {
    while (id === null) await new Promise((r) => setTimeout(r, 50));
    for (let t = 0; t <= percent; t += 0.5) say({ event: 'infoDelivery', info: { currentTime: t } });
  };
</script></body></html>`;

const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://127.0.0.1:4100').replace(
  /\/+$/,
  '',
);

async function funnelForm(page: Page): Promise<string> {
  return (await funnelBusiness(page)).link;
}

async function funnelBusiness(page: Page, ops: Record<string, unknown>[] = []) {
  const owner = await signUpAndConfirm(page, 'funnel');
  const workspaceId = await createBusiness(page, { name: 'Robbins Recruiting' });
  const api = apiAs(await signInForApi(owner.email));
  const created = await api<{ formId: string; revision: number; slug: string }>(
    'commands/form.create',
    { workspaceId, name: 'Meet the team' },
  );
  const got = await api<{ definition: { pages: { id: string }[] } }>('queries/form.get', {
    workspaceId,
    formId: created.formId,
  });
  const first = got.definition.pages[0]!.id;
  const saved = await api<{ revision: number }>('commands/form.save_draft', {
    workspaceId,
    formId: created.formId,
    baseRevision: created.revision,
    ops: [
      { op: 'set_settings', patch: { onePageAtATime: true } },
      { op: 'update_page', pageId: first, patch: { title: 'Before we get started' } },
      {
        op: 'add_question',
        pageId: first,
        index: null,
        question: {
          id: 'q_name0000',
          type: 'short_text',
          title: 'What should we call you?',
          required: true,
          mapTo: 'person.first_name',
          config: {},
        },
      },
      {
        op: 'add_page',
        index: null,
        page: { id: 'p_teaser00', title: 'A quick look', questions: [] },
      },
      {
        op: 'add_question',
        pageId: 'p_teaser00',
        index: null,
        question: {
          id: 'q_teaser00',
          type: 'video',
          title: 'Watch this first',
          config: { url: VIDEO, minPercent: 80 },
        },
      },
      {
        op: 'add_page',
        index: null,
        page: { id: 'p_reach000', title: 'How to reach you', questions: [] },
      },
      {
        op: 'add_question',
        pageId: 'p_reach000',
        index: null,
        question: {
          id: 'q_phone000',
          type: 'phone',
          title: 'Your phone',
          required: true,
          mapTo: 'person.phone',
          config: {},
        },
      },
      ...ops,
    ],
  });
  await api('commands/form.publish', {
    workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });
  const { site } = await api<{ site: { slug: string } | null }>('queries/booking_site.get', {
    workspaceId,
  });
  return { link: `/f/${site!.slug}/${created.slug}`, api, workspaceId, formId: created.formId };
}

test('a video holds Next until enough of it is watched, one page at a time', async ({ page }) => {
  const link = await funnelForm(page);
  await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: STAND_IN_PLAYER }),
  );

  await page.goto(link);
  await expect(page.getByText('Step 1 of 3')).toBeVisible();
  await expect(page.getByTestId('form-send')).toHaveCount(0);
  await page.getByLabel('What should we call you?').fill('Dana');
  await page.getByTestId('form-next').click();

  await expect(page.getByText('Step 2 of 3')).toBeVisible();
  await expect(page.getByTestId('video-frame')).toBeVisible();
  await page.getByTestId('form-next').click();
  await expect(page.getByText('Watch at least 80% of the video to go on.')).toBeVisible();

  const player = async () => {
    await expect
      .poll(() => page.frames().some((f) => f.url().includes('youtube-nocookie')))
      .toBe(true);
    return page.frames().find((f) => f.url().includes('youtube-nocookie'))!;
  };
  const playTo = async (percent: number) =>
    (await player()).evaluate(
      (p) => (window as unknown as { playTo(p: number): Promise<void> }).playTo(p),
      percent,
    );
  await playTo(50);
  await expect(page.getByTestId('video-watched')).toHaveText('Watched 50%');
  await page.getByTestId('form-next').click();
  await expect(page.getByText('Step 2 of 3')).toBeVisible();

  await playTo(85);
  await expect(page.getByTestId('video-watched')).toHaveText('Watched 85%');
  await page.getByTestId('form-next').click();

  await expect(page.getByText('Step 3 of 3')).toBeVisible();
  await page.getByLabel('Your phone').fill('(512) 555-0188');
  // Back keeps what they watched.
  await page.getByTestId('form-back').click();
  await expect(page.getByTestId('video-watched')).toHaveText('Watched 85%');
  await page.getByTestId('form-next').click();
  await expect(page.getByLabel('Your phone')).toHaveValue('(512) 555-0188');
  await page.getByTestId('form-send').click();
  await expect(page.getByTestId('form-sent')).toBeVisible();
});

/** The funnel's details page saves them, and a last page greets them by name. */
const SAVE_ON_PAGE_TWO = [
  { op: 'update_page', pageId: 'p_reach000', patch: { savesContact: true } },
  { op: 'add_page', index: null, page: { id: 'p_goals000', title: 'Last thing', questions: [] } },
  {
    op: 'add_question',
    pageId: 'p_goals000',
    index: null,
    question: {
      id: 'q_goals000',
      type: 'long_text',
      title: '{{person.first_name | default:"So"}}, what are you hoping for?',
      config: {},
    },
  },
];

type People = {
  items: { personId?: string; id?: string; firstName: string; phone?: string | null }[];
};

test('the details page saves them as they leave it, before the form is sent', async ({ page }) => {
  const { link, api, workspaceId } = await funnelBusiness(page, SAVE_ON_PAGE_TWO);
  await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: STAND_IN_PLAYER }),
  );
  await page.goto(link);
  await page.getByLabel('What should we call you?').fill('Dana');
  await page.getByTestId('form-next').click();
  await (async () => {
    await expect
      .poll(() => page.frames().some((f) => f.url().includes('youtube-nocookie')))
      .toBe(true);
    await page
      .frames()
      .find((f) => f.url().includes('youtube-nocookie'))!
      .evaluate(() => (window as unknown as { playTo(p: number): Promise<void> }).playTo(90));
  })();
  await expect(page.getByTestId('video-watched')).toHaveText('Watched 90%');
  await page.getByTestId('form-next').click();

  // The details page carries the texting box, and Next saves them.
  await expect(page.getByText('Step 3 of 4')).toBeVisible();
  await page.getByLabel('Your phone').fill('(512) 555-0420');
  await page.getByTestId('form-sms-consent').check();
  await expect(page.getByTestId('form-next')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('form-next').click();
  await expect(page.getByText('Step 4 of 4')).toBeVisible();
  // Their name, from what they typed on the first page.
  await expect(page.getByText('Dana, what are you hoping for?')).toBeVisible();
  await expect
    .poll(async () => {
      const people = await api<People>('queries/person.list', { workspaceId, limit: 20 });
      return people.items.map((p) => p.firstName);
    })
    .toContain('Dana');

  await page.getByLabel('Dana, what are you hoping for?').fill('Work from home');
  await page.getByTestId('form-send').click();
  await expect(page.getByTestId('form-sent')).toBeVisible();
  const people = await api<People>('queries/person.list', { workspaceId, limit: 20 });
  expect(people.items.filter((p) => p.firstName === 'Dana')).toHaveLength(1);
});

test('a personal link skips what we know, greets them, and shows nothing on file', async ({
  page,
}) => {
  const { link, api, workspaceId, formId } = await funnelBusiness(page, SAVE_ON_PAGE_TWO);
  await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: STAND_IN_PLAYER }),
  );
  const { personId } = await api<{ personId: string }>('commands/person.create', {
    workspaceId,
    firstName: 'Christina',
    lastName: 'Lee',
    phone: '(512) 555-0421',
  });
  const res = await fetch(`${WORKER_URL}/test/forms/personal-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, formId, personId }),
  });
  const { key } = (await res.json()) as { key: string };
  // Nothing about them is in the address.
  expect(key).not.toMatch(/christina|lee|0421/i);

  await page.goto(`${link}?k=${key}`);
  // Their name and phone are on file: the name page and the details page are skipped.
  await expect(page.getByText('Step 1 of 2')).toBeVisible();
  await expect(page.getByLabel('What should we call you?')).toHaveCount(0);
  await expect(page.getByTestId('video-frame')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('0421');
  await page
    .frames()
    .find((f) => f.url().includes('youtube-nocookie'))!
    .evaluate(() => (window as unknown as { playTo(p: number): Promise<void> }).playTo(90));
  await expect(page.getByTestId('video-watched')).toHaveText('Watched 90%');
  await page.getByTestId('form-next').click();

  await expect(page.getByText('Christina, what are you hoping for?')).toBeVisible();
  await page.getByLabel('Christina, what are you hoping for?').fill('A side income');
  // A link we texted them needs no "are you a person" check.
  await page.getByTestId('form-send').click();
  await expect(page.getByTestId('form-sent')).toBeVisible();
  const people = await api<People>('queries/person.list', { workspaceId, limit: 20 });
  expect(people.items.filter((p) => p.firstName === 'Christina')).toHaveLength(1);
});

test('the last step books a session, and the calendar’s page can stay off', async ({ page }) => {
  const owner = await ownerWithSite(page, 'funnel-book', 'Robbins Recruiting');
  const cal = await makeCalendar(owner, 'Live presentation', {
    public: false,
    schedule: { mode: 'sessions' },
    capacity: { seats: 10 },
  });
  const publish = (startsAt: string) =>
    bookingApi<{ appointmentId: string }>(owner.token, 'commands', 'session.publish', {
      workspaceId: owner.workspaceId,
      calendarId: cal.id,
      startsAt,
      userIds: [owner.userId],
      acknowledgeWarnings: true,
    });
  const tuesday = await publish(daysFromNow(3));
  await publish(daysFromNow(5));

  const created = await bookingApi<{ formId: string; revision: number; slug: string }>(
    owner.token,
    'commands',
    'form.create',
    { workspaceId: owner.workspaceId, name: 'Meet the team' },
  );
  const got = await bookingApi<{ definition: { pages: { id: string }[] } }>(
    owner.token,
    'queries',
    'form.get',
    { workspaceId: owner.workspaceId, formId: created.formId },
  );
  const first = got.definition.pages[0]!.id;
  const saved = await bookingApi<{ revision: number }>(owner.token, 'commands', 'form.save_draft', {
    workspaceId: owner.workspaceId,
    formId: created.formId,
    baseRevision: created.revision,
    ops: [
      { op: 'set_settings', patch: { onePageAtATime: true } },
      { op: 'update_page', pageId: first, patch: { savesContact: true } },
      {
        op: 'add_question',
        pageId: first,
        index: null,
        question: {
          id: 'q_name0000',
          type: 'short_text',
          title: 'Your name',
          required: true,
          mapTo: 'person.first_name',
          config: {},
        },
      },
      {
        op: 'add_question',
        pageId: first,
        index: null,
        question: {
          id: 'q_phone000',
          type: 'phone',
          title: 'Your phone',
          required: true,
          mapTo: 'person.phone',
          config: {},
        },
      },
      {
        op: 'add_page',
        index: null,
        page: { id: 'p_book0000', title: 'Meet us live', questions: [] },
      },
      {
        op: 'add_question',
        pageId: 'p_book0000',
        index: null,
        question: {
          id: 'q_when0000',
          type: 'booking',
          title: 'Pick a presentation',
          required: true,
          config: { calendarId: cal.id },
        },
      },
    ],
  });
  await bookingApi(owner.token, 'commands', 'form.publish', {
    workspaceId: owner.workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });

  await page.goto(`/f/${owner.site}/${created.slug}`);
  await page.getByLabel('Your name').fill('Jordan Price');
  await page.getByLabel('Your phone').fill(randomPhone());
  await expect(page.getByTestId('form-next')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('form-next').click();

  await expect(page.getByText('Meet us live')).toBeVisible();
  const times = page.getByTestId('booking-time');
  await expect(times).toHaveCount(2);
  await expect(times.first()).toContainText('10 seats left');
  await times.first().click();
  await expect(times.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('form-send')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('form-send').click();
  await expect(page.getByTestId('form-sent')).toBeVisible();

  const session = await bookingApi<{
    appointment: { attendees: { fullName: string; seats: number }[] };
  }>(owner.token, 'queries', 'appointment.get', {
    workspaceId: owner.workspaceId,
    appointmentId: tuesday.appointmentId,
  });
  expect(session.appointment.attendees).toEqual([
    expect.objectContaining({ fullName: 'Jordan Price', seats: 1 }),
  ]);
});
