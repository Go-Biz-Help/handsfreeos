import { expect, test, type Page } from '@playwright/test';
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

async function funnelForm(page: Page): Promise<string> {
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
  return `/f/${site!.slug}/${created.slug}`;
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
