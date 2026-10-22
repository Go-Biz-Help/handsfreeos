import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The business's main offer (docs/main-offer.md), with the scripted stand-in model:
 * - It shows in Settings only once an add-on that uses it (Social Outreach) is on.
 * - The owner builds it a step at a time: the niche from their best customer, the AI's help on a part, the method's
 *   steps, a line put together from the answers, then the score. A part under the bar goes live only with a reason,
 *   kept with the version. Leaving for later keeps the draft.
 * - Changing it makes a draft beside the live version; scored over the bar, it goes live as version 2.
 * - A Social Outreach playbook narrows it: its niche starts from the offer's who, the AI says whether a niche fits
 *   inside it or is really a second offer, its proof is picked from the offer's, and its offer starts as the outcome.
 * - Get ready (decision 63): with the offer live and a playbook's niche, Today waits on the owner's profile and numbers,
 *   holding Start my day, until both are done. The profile is read by their computer and checked by the AI
 *   (decision 64), and what it says to change is ticked once done.
 */
async function turnOnOutreach(page: Page, email: string, workspaceId: string) {
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.goto(`/admin/businesses/${workspaceId}`);
  const testing = page.getByTestId('admin-addon-testing');
  await testing.getByTestId('admin-addon-testing-outreach').click();
  await expect(testing).toContainText('they can add it');
  await page.goto(`/app/w/${workspaceId}/add-ons`);
  const card = page.getByTestId('addon-outreach');
  await page.getByTestId('addon-install-outreach').click();
  await expect(card.getByTestId('addon-state')).toHaveText('On', { timeout: 90_000 });
}

test('an owner builds the main offer a step at a time, scores it and goes live, then changes it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { email } = await signUpAndConfirm(page, 'main-offer-owner');
  const workspaceId = await createBusiness(page, { name: 'Summit Roof Leads' });

  // Not there until an add-on that uses it is on.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await expect(page.getByTestId('settings-nav').getByText('Main offer')).toHaveCount(0);
  await turnOnOutreach(page, email, workspaceId);
  await page.goto(`/app/w/${workspaceId}/settings`);
  await page.getByTestId('settings-nav').getByRole('link', { name: 'Main offer' }).click();
  await expect(page.getByTestId('main-offer-start')).toBeVisible();
  await page.getByTestId('main-offer-start-building').click();

  const builder = page.getByTestId('offer-builder');
  const step = builder.getByTestId('offer-builder-step');
  const next = builder.getByTestId('offer-continue');
  await expect(step).toHaveAttribute('data-step', 'niche');

  // The niche, from the best customer: the AI's first pick fills Who and moves on.
  await builder.getByLabel('Who’s the best customer you’ve had?').fill('Peak Roofing, 3 crews');
  await builder.getByLabel('What line of work are they in?').fill('Roofing');
  await builder.getByTestId('offer-find-niche').click();
  await expect(builder.getByTestId('offer-niches')).toContainText(
    'Roofing like your best customer',
  );
  await builder.getByTestId('offer-niche-use-0').click();
  await expect(step).toHaveAttribute('data-step', 'who');
  await expect(builder.getByLabel('What line of work are they in?')).toHaveValue('Roofing');
  await builder
    .getByLabel('Their single most painful problem')
    .fill('No steady jobs between storms');
  await next.click();

  // The outcome, written by the AI and picked.
  await expect(step).toHaveAttribute('data-step', 'outcome');
  await builder.getByTestId('offer-outcome-result-ai').click();
  await builder.getByTestId('offer-outcome-result-use-0').click();
  await expect(builder.getByLabel('The result, measurable')).toHaveValue(
    'Option 1 for the result, measurable',
  );
  await next.click();
  await builder.getByLabel('How long does it usually take?').fill('60 days');
  await next.click();

  // The method: the AI's steps, picked whole.
  await expect(step).toHaveAttribute('data-step', 'method');
  await builder.getByTestId('offer-method-ai').click();
  await builder.getByTestId('offer-method-use-0').click();
  await expect(builder.getByTestId('offer-method-step-3')).toHaveValue('Check the results');
  await next.click();

  // Leaving for later keeps the draft, and opening it carries on.
  await builder
    .getByLabel('What do you promise if it doesn’t work?')
    .fill('If you don’t get 10 in 60 days, you don’t pay');
  await builder.getByTestId('offer-finish-later').click();
  await expect(page.getByTestId('main-offer-draft')).toContainText('is changing your offer');
  await page.getByTestId('main-offer-open-draft').click();
  await builder.getByTestId('offer-step-price').click();
  await expect(step).toHaveAttribute('data-step', 'price');
  // A price still to be filled in holds the offer under the bar.
  await builder.getByLabel('What’s your price?').fill('[price] a month');
  await next.click();
  await builder.getByTestId('offer-proof-0').fill('Peak Roofing got 22 inspections in 60 days');
  await next.click();

  // Put together from the answers, then the few words messages carry.
  await expect(step).toHaveAttribute('data-step', 'line');
  await expect(builder.getByLabel('Your offer in one line')).toHaveValue(
    /^We help Roofing like your best customer get/,
  );
  await builder.getByLabel('The outcome, in a few words').fill('10 to 20 booked inspections');
  await builder.getByLabel('The guarantee, in a few words').fill('you only pay for results');
  await expect(builder.getByTestId('offer-preview')).toContainText(
    'open to 10 to 20 booked inspections, where you only pay for results?',
  );
  await next.click();

  // The score: the price is under the bar, so it goes live only with a reason, or after a try.
  await expect(step).toHaveAttribute('data-step', 'score');
  await builder.getByTestId('offer-score-it').click();
  await expect(builder.getByTestId('offer-score')).toHaveAttribute('data-clears', 'false');
  await expect(builder.getByTestId('offer-score-title')).toHaveText('Under 7: price');
  await expect(builder.getByTestId('offer-part-price-note')).toBeVisible();
  await expect(builder.getByTestId('offer-make-try-foot')).toHaveText('Make Try 1');
  await builder.getByTestId('offer-use-anyway').click();
  await page.getByLabel('Why is it going live now?').fill('Pricing after the first call');
  await page.getByTestId('offer-anyway-go').click();

  await expect(page.getByTestId('main-offer-live')).toContainText('Live · version 1');
  await expect(page.getByTestId('main-offer-live')).toContainText('Under the bar');
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByTestId('main-offer-versions')).toContainText(
    'went live anyway: “Pricing after the first call”',
  );

  // Changing it: a draft beside the live version, scored over the bar, goes live as version 2.
  await page.getByRole('tab', { name: 'Live version' }).click();
  await page.getByTestId('main-offer-change').click();
  await expect(step).toHaveAttribute('data-step', 'who');
  await builder.getByTestId('offer-step-price').click();
  await builder.getByLabel('What’s your price?').fill('$2,000 a month');
  await builder.getByTestId('offer-step-score').click();
  await builder.getByTestId('offer-score-it').click();
  await expect(builder.getByTestId('offer-score')).toHaveAttribute('data-clears', 'true');
  await builder.getByTestId('offer-go-live').click();
  await expect(page.getByTestId('main-offer-live')).toContainText('Live · version 2');
  await expect(page.getByTestId('main-offer-live')).toContainText('Every part 7 or more');

  // A playbook narrows it: the niche from the offer's who fits, another niche is really a second offer.
  await page.goto(`/app/w/${workspaceId}/a/outreach/playbooks/new`);
  const playbook = page.getByTestId('playbook-builder');
  await playbook.getByTestId('playbook-next').click();
  await expect(playbook.getByTestId('playbook-main-offer')).toContainText(
    'Who it’s for: Roofing like your best customer',
  );
  await playbook.getByRole('button', { name: /^Roofing like your best customer/ }).click();
  await playbook.getByTestId('playbook-niche-check').click();
  await expect(playbook.getByTestId('playbook-niche-fit')).toHaveAttribute('data-fit', 'inside');
  await playbook.getByTestId('playbook-niche').fill('Dentists in Ohio');
  await expect(playbook.getByTestId('playbook-niche-fit')).toHaveCount(0);
  await playbook.getByTestId('playbook-niche-check').click();
  await expect(playbook.getByTestId('playbook-niche-fit')).toHaveAttribute(
    'data-fit',
    'second_offer',
  );
  await expect(playbook.getByTestId('playbook-niche-fit')).toContainText('really a second offer');
  await playbook.getByTestId('playbook-niche').fill('Roofers with 2 to 3 crews');
  await playbook.getByTestId('playbook-problem').fill('No steady jobs between storms');
  await playbook
    .getByRole('button', { name: 'Peak Roofing got 22 inspections in 60 days' })
    .click();
  await playbook.getByTestId('playbook-next').click();
  await expect(playbook.getByTestId('playbook-offer')).toHaveValue('10 to 20 booked inspections');
  await playbook.getByTestId('playbook-useful-what').fill('A storm-season checklist');
  await playbook.getByTestId('playbook-useful-link').fill('summit.test/checklist');
  await playbook.getByTestId('playbook-useful-link').blur();
  await expect(playbook.getByTestId('playbook-useful-link')).toHaveValue(
    'https://summit.test/checklist',
  );
  for (let i = 0; i < 5; i++) await playbook.getByTestId('playbook-next').click();

  // The short video: the AI writes its script from the offer and the niche, one part is written again, and the link
  // is put in (an address without https:// gets it).
  await playbook.getByTestId('playbook-video-write').click();
  const parts = playbook.getByTestId('playbook-video-parts');
  await expect(parts.getByRole('listitem')).toHaveCount(6);
  await expect(playbook.getByTestId('playbook-video-say-who')).toHaveValue(
    /Roofers with 2 to 3 crews/,
  );
  await playbook.getByTestId('playbook-video-improve-call').click();
  await expect(playbook.getByTestId('playbook-video-say-call')).toHaveValue(
    /Said even more plainly\./,
  );
  await playbook.getByTestId('playbook-video-link').fill('www.loom.com/share/abc123');
  await playbook.getByTestId('playbook-video-link').blur();
  await expect(playbook.getByTestId('playbook-video-link')).toHaveValue(
    'https://www.loom.com/share/abc123',
  );
  for (let i = 0; i < 5; i++) await playbook.getByTestId('playbook-next').click();
  await expect(playbook.getByTestId('review-video')).toContainText('Video linked, with its script');
  await expect(playbook.getByTestId('review-niche')).toContainText('Roofers with 2 to 3 crews');
  await expect(playbook.getByTestId('review-niche')).toContainText('1 result as proof');
  await expect(playbook.getByTestId('review-offer')).toContainText(
    'Useful to send: A storm-season checklist',
  );
  await playbook.getByTestId('playbook-save').click();
  await expect(page.getByText('Book a demo is ready.')).toBeVisible();

  // Get ready: the offer and the niche are done; Today waits on the owner's profile and numbers.
  await page.goto(`/app/w/${workspaceId}/a/outreach?view=today`);
  const ready = page.getByTestId('get-ready');
  await expect(ready.getByTestId('ready-offer')).toHaveAttribute('data-state', 'done');
  await expect(ready.getByTestId('ready-playbook')).toHaveAttribute('data-state', 'done');
  await expect(ready.getByTestId('ready-profile')).toHaveAttribute('data-state', 'todo');
  await expect(page.getByTestId('live-start')).toBeDisabled();
  await expect(page.getByTestId('live-not-ready')).toBeVisible();

  // The profile: the computer reads it (here, as the extension would, straight to the worker) and the AI checks it;
  // the two it says to change are ticked once done.
  await ready.getByTestId('ready-open-profile').click();
  const profile = page.getByTestId('ready-profile-sheet');
  await expect(profile.getByTestId('ready-profile-read')).toContainText('Have the extension read');
  const { token } = await signInOwner(email);
  const checked = await page.request.post(
    `${WORKER}/v1/addons/outreach/actions/outreach.profile.check`,
    {
      headers: { authorization: `Bearer ${token}` },
      data: {
        workspaceId,
        input: {
          name: 'Test Owner',
          picture: 'May be an image of 1 person, smiling',
          bio: 'Roofing leads for crews that want steady work',
          intro: ['Owner at Summit Roof Leads'],
          posts: ['Another roof done before the storm.'],
        },
      },
    },
  );
  expect(checked.status()).toBe(200);
  await page.reload();
  await page.getByTestId('get-ready').getByTestId('ready-open-profile').click();
  await expect(profile.getByTestId('ready-profile-ai-cover')).toContainText('To change');
  await expect(profile.getByTestId('ready-profile-ai-picture')).toContainText('Looks right');
  await expect(profile.getByTestId('ready-bios')).toContainText('More booked calls for Roofing');
  // The whole profile (decision 84): how it comes across, then Show me more bios, steered by a chip and their words.
  await expect(profile.getByTestId('ready-profile-look')).toContainText('This reads as you.');
  await profile.getByTestId('ready-more-bio-open').click();
  const more = page.getByTestId('ready-more-bio');
  await more.getByRole('button', { name: 'Warmer' }).click();
  await expect(more.getByRole('button', { name: 'Warmer' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await more.getByRole('textbox').fill('Say crews, not companies');
  await more.getByTestId('ready-more-bio-go').click();
  await expect(more).toBeHidden();
  await expect(profile.getByTestId('ready-bios')).toContainText('A new bio');
  // A new username asks first. As the extension would, the computer found one taken and one free; the taken one can't
  // be picked, and Show me more offers others to pick from.
  await api(token, 'commands', 'outreach.profile.usernames_save', {
    workspaceId,
    platform: 'facebook',
    found: [
      { value: 'testowner', free: false },
      { value: 'testowner.roofs', free: true },
    ],
  });
  await page.reload();
  await page.getByTestId('get-ready').getByTestId('ready-open-profile').click();
  await profile.getByTestId('ready-username-open').click();
  const usernames = page.getByTestId('ready-username-dialog');
  await expect(usernames.getByRole('status')).toContainText('testowner is taken');
  await expect(usernames.getByTestId('ready-username-testowner')).toBeDisabled();
  await expect(usernames.getByTestId('ready-username-testowner.roofs')).toContainText('Free');
  await usernames.getByTestId('ready-username-more').click();
  await page.getByTestId('ready-more-username').getByRole('button', { name: 'Shorter' }).click();
  await page.getByTestId('ready-more-username-go').click();
  await usernames.getByTestId('ready-username-casey.roofs').click();
  await expect(usernames.getByTestId('ready-username-casey.roofs')).toContainText('Not checked');
  await usernames.getByTestId('ready-username-use').click();
  await expect(usernames).toBeHidden();
  await expect(profile.getByTestId('ready-part-username')).toContainText('casey.roofs');
  for (const item of ['cover', 'featured']) {
    await profile.getByTestId(`ready-profile-${item}`).click();
    await expect(profile.getByTestId(`ready-profile-${item}`)).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }
  await page.getByTestId('ready-profile-done').click();
  await expect(ready.getByTestId('ready-profile')).toHaveAttribute('data-state', 'done');

  // Your messages: the AI writes samples for the playbook in the owner's voice, and they OK how they read.
  await ready.getByTestId('ready-open-messages').click();
  const messages = page.getByTestId('ready-messages-sheet');
  await messages.getByTestId('ready-messages-write').click();
  const samples = messages.getByTestId('ready-messages-samples');
  await expect(samples).toContainText('First message, once they accept');
  await expect(samples).toContainText('If they go quiet: 6 follow-ups');
  await expect(samples).toContainText('If they say yes: the video');
  await expect(samples).toContainText('[video link]');
  await messages.getByTestId('ready-messages-ok').click();
  await expect(ready.getByTestId('ready-messages')).toHaveAttribute('data-state', 'done');

  // The numbers: the math changes as the goal does, and saving it makes them ready.
  await ready.getByTestId('ready-open-numbers').click();
  const numbers = page.getByTestId('ready-numbers-sheet');
  await expect(numbers.getByTestId('ready-math')).toContainText(
    '8 calls a month ÷ 22 working days = 0.4 calls a day',
  );
  await numbers.getByTestId('ready-goal').getByRole('button', { name: /^More/ }).click();
  await numbers.getByTestId('ready-day-6').click();
  await expect(numbers.getByTestId('ready-math')).toContainText(
    '9 calls a month ÷ 26 working days',
  );
  await expect(numbers.getByTestId('ready-verdict')).toContainText('Facebook’s safe pace');
  await numbers.getByTestId('ready-numbers-save').click();
  await expect(page.getByTestId('get-ready')).toHaveCount(0);
  await expect(page.getByTestId('live-not-ready')).toHaveCount(0);

  // The main offer's page: how the live version is doing in Social Outreach, too new to judge with no messages yet.
  await page.goto(`/app/w/${workspaceId}/settings/main-offer`);
  const doing = page.getByTestId('outreach-offer-panel');
  await expect(doing).toContainText('How version 2 is doing');
  await expect(doing.getByTestId('outreach-offer-too-new')).toContainText(
    'Give it 100 more first messages',
  );
});

test('an owner steers the AI with notes and a direction, compares its try and takes parts from it', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { email } = await signUpAndConfirm(page, 'main-offer-tries');
  const workspaceId = await createBusiness(page, { name: 'Lead Answer Co' });
  await turnOnOutreach(page, email, workspaceId);

  // A whole draft, a box at a time.
  await page.goto(`/app/w/${workspaceId}/main-offer/build?step=who`);
  const builder = page.getByTestId('offer-builder');
  const step = builder.getByTestId('offer-builder-step');
  await expect(step).toHaveAttribute('data-step', 'who');
  await builder.getByLabel('What line of work are they in?').fill('Roofing');
  await builder.getByLabel('Their single most painful problem').fill('Leads go cold on the job');
  await builder.getByTestId('offer-step-outcome').click();
  await builder.getByLabel('The result, measurable').fill('Every lead answered in 30 seconds');
  await builder.getByTestId('offer-step-timeframe').click();
  await builder.getByLabel('How long does it usually take?').fill('2 weeks');
  await builder.getByTestId('offer-step-method').click();
  for (const [i, s] of ['Sign up', 'Plug in your leads', 'Attach your calendar'].entries())
    await builder.getByTestId(`offer-method-step-${i}`).fill(s);
  await builder.getByTestId('offer-step-guarantee').click();
  await builder
    .getByLabel('What do you promise if it doesn’t work?')
    .fill('A month free if one waits');
  await builder.getByTestId('offer-step-price').click();
  await builder.getByLabel('What’s your price?').fill('$97 a month');
  await builder.getByTestId('offer-step-line').click();
  await builder.getByLabel('The outcome, in a few words').fill('every lead answered fast');
  await builder.getByLabel('The guarantee, in a few words').fill('a month free if not');

  // Reviewed: each part says what's working; a note on the who, the price kept, and a direction.
  await builder.getByTestId('offer-step-score').click();
  await expect(step).toHaveAttribute('data-step', 'score');
  await expect(builder.getByTestId('offer-versions')).toContainText('The AI’s tries show up here');
  await builder.getByTestId('offer-score-it').click();
  await expect(builder.getByTestId('offer-score')).toHaveAttribute('data-clears', 'true');
  await builder.getByTestId('offer-part-who-toggle').click();
  await expect(builder.getByTestId('offer-part-who')).toContainText(
    'The who is clear and specific.',
  );
  await builder.getByTestId('offer-part-who-pick-0').click();
  await expect(builder.getByTestId('offer-part-who-note')).toHaveValue('This is broad on purpose.');
  await builder.getByTestId('offer-part-price-toggle').click();
  await builder.getByTestId('offer-part-price-keep').check();
  await builder.getByTestId('offer-direction').fill('It’s for any business that lives on leads.');
  await expect(builder.getByTestId('offer-going-into')).toContainText('Your direction');
  await expect(builder.getByTestId('offer-going-into')).toContainText('Your note on who');
  await expect(builder.getByTestId('offer-going-into')).toContainText('Price kept as is');

  // The try, beside the draft: every part starts on yours, and kept parts show once.
  await builder.getByTestId('offer-make-try').click();
  await expect(builder.getByRole('heading', { level: 1 })).toHaveText(
    'Try 1 is ready. Pick what to keep.',
  );
  await expect(page).toHaveURL(/[?&]try=/);
  await expect(builder.getByTestId('offer-followed')).toContainText(
    '“It’s for any business that lives on leads.”',
  );
  await expect(builder.getByTestId('offer-compare-price')).toContainText(
    'You kept this as is, so Try 1 left it alone.',
  );
  await expect(builder.getByTestId('offer-compare-who-try')).toContainText(
    'Businesses that live on leads',
  );
  await expect(builder.getByTestId('offer-compare-who-try')).toContainText(
    'Scored with your direction',
  );
  await expect(builder.getByTestId('offer-apply')).toHaveText('Keep my draft as is');
  await builder.getByTestId('offer-compare-who-try').click();
  await builder.getByTestId('offer-compare-outcome-try').click();
  await expect(builder.getByTestId('offer-compare-who-try')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(builder.getByTestId('offer-apply')).toHaveText('Apply 2 parts to my draft');

  // Two of its parts taken in: the mix gets a line of its own, then it's scored.
  await builder.getByTestId('offer-apply').click();
  await expect(builder.getByTestId('offer-applied')).toContainText(
    'Your draft now uses Try 1’s who and outcome.',
  );
  await expect(builder.getByTestId('offer-version-before')).toContainText('Before Try 1');
  await builder.getByTestId('offer-line-line-0').check();
  await builder.getByTestId('offer-line-score').click();
  await expect(builder.getByTestId('offer-score')).toHaveAttribute('data-clears', 'true');
  await expect(builder.getByTestId('offer-part-who')).toContainText('Scored with your direction');
  await builder.getByTestId('offer-go-live').click();

  // Live, with the try's who and the direction kept for next time.
  await expect(page.getByTestId('main-offer-live')).toContainText('Live · version 1');
  await expect(page.getByTestId('main-offer-live')).toContainText(
    'Option 1 for the whole offer in one line',
  );
  await expect(page.getByTestId('main-offer-part-who')).toContainText(
    'Businesses that live on leads',
  );
  await expect(page.getByTestId('main-offer-direction')).toContainText(
    'It’s for any business that lives on leads.',
  );
});
