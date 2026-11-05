import { expect, test, type Page } from '@playwright/test';
import { WORKER, consentToAssistant } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The demo player (lib/demo): HandsFreeOS staff open it with `?demo`, pick a scene, and each press of Space plays its
 * next step on the real screens with made-up people, messages and campaigns. Nobody else gets it, and Exit leaves
 * the business as it was: nothing a scene shows was ever saved.
 */

// A presenter's screen: the app beside the player's panel still has room for the customer's details.
test.use({ viewport: { width: 1680, height: 960 } });

const director = (page: Page) => page.getByTestId('demo-director');

/** Plays `count` steps with Space, each to its end, with no step reporting a problem. */
async function play(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Space');
    await expect(page.getByTestId('demo-steps').locator('li').nth(i)).toContainText('✓');
    await expect(page.getByTestId('demo-next')).not.toHaveAttribute('aria-busy', 'true', {
      timeout: 40_000,
    });
    await expect(director(page).getByRole('alert')).toHaveCount(0);
  }
  await expect(page.getByTestId('demo-scene-done')).toBeVisible();
}

/** Picks a scene (from All scenes, when one is already loaded) and waits until it has loaded, so the first Space
 * plays its first step. */
async function pick(page: Page, scene: string, firstStep: string): Promise<void> {
  const all = page.getByTestId('demo-all-scenes');
  if (await all.isVisible()) await all.click();
  await page.getByTestId(`demo-scene-${scene}`).click();
  await expect(page.getByTestId('demo-next-step')).toContainText(firstStep);
  await expect(page.getByTestId('demo-next')).not.toHaveAttribute('aria-busy', 'true');
}

async function staffBusiness(page: Page, label: string): Promise<string> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: 'Summit Plumbing & Drain' });
  // Not staff yet: `?demo` does nothing.
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(director(page)).toHaveCount(0);
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await consentToAssistant(email);
  return workspaceId;
}

test('demo player: a new lead texts, the AI teammate answers and books on your OK', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspaceId = await staffBusiness(page, 'demo-lead');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();
  await page.getByTestId('demo-scene-lead-text').click();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open the Inbox');

  await play(page, 8);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  const thread = page.getByTestId('conversation');
  await expect(
    thread.getByText(/Hi Dana, this is \S+ with Summit Plumbing & Drain\./),
  ).toBeVisible();
  await expect(thread.getByText('You’re all set for tomorrow at 9:00 AM, Dana.')).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Water heater repair')).toBeVisible();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);

  // Exit: the made-up conversation was never there.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Dana Whitfield')).toHaveCount(0);
});

test('demo player: Ask HandsFreeOS builds a text campaign you review and approve', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspaceId = await staffBusiness(page, 'demo-campaign');
  await page.goto(`/app/w/${workspaceId}?demo`);
  await page.getByTestId('demo-scene-text-campaign').click();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open Ask HandsFreeOS');

  await play(page, 7);
  await expect(page).toHaveURL(/\/campaigns\/de300000-/);
  await expect(page.getByTestId('campaign-status')).toHaveText(/Sending/);
  await expect(page.getByTestId('campaign-view')).toContainText('1 of 17 sent');
  await expect(page.getByTestId('assistant-panel')).toContainText(
    'Text our past customers about a fall tune-up, $89 this month.',
  );

  // The campaign was never made: Campaigns lists nothing once the scene is gone.
  await page.getByTestId('demo-exit').click();
  await page.goto(`/app/w/${workspaceId}/campaigns`);
  await expect(page.getByText('Fall tune-up')).toHaveCount(0);
});

test('demo player: calls, website chats, hand-offs to you, and a quote that becomes an invoice', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const workspaceId = await staffBusiness(page, 'demo-teammate');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();
  const thread = page.getByTestId('conversation');

  // Scene 2: the AI teammate answers a call, books it and texts the details; you open what was said.
  await pick(page, 'busy-call', 'Open the Inbox');
  await play(page, 6);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(thread.getByText(/at 10:00 AM for the leak under your kitchen sink/)).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Kitchen sink leak')).toBeVisible();

  // Scene 3: a website visitor gets answered, gives her name and is booked, all in the chat.
  await pick(page, 'website-chat', 'Open the Inbox');
  await play(page, 7);
  await expect(
    thread.getByText('You’re all set for tomorrow at 8:00 AM, Priya.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Drain cleaning')).toBeVisible();

  // Scene 4: a price it doesn't know goes to you; you take it and answer yourself.
  await pick(page, 'price-question', 'Open the Inbox');
  await play(page, 6);
  await expect(page.getByTestId('handling-person')).toBeVisible();
  await expect(thread.getByText(/a tankless water heater installed is \$3,850/)).toBeVisible();
  await expect(thread.getByText('Yes please, send it over.', { exact: false })).toBeVisible();

  // Scene 5: an upset customer goes straight to you, and your own words calm her down.
  await pick(page, 'upset-customer', 'Open the Inbox');
  await play(page, 6);
  await expect(thread.getByText(/Linda, this is \S+, the owner\./)).toBeVisible();
  await expect(thread.getByText('Thank you for owning it. 8 tomorrow works.')).toBeVisible();

  // Scene 6: the reminder, her approval, and one click from estimate to a sent invoice.
  await pick(page, 'quote-to-invoice', 'Open Carol’s estimate');
  await expect(page).toHaveURL(/\/money\/estimates\/de300000-/);
  await play(page, 6);
  await expect(page).toHaveURL(/\/money\/invoices\/de300000-/);
  await expect(page.getByRole('heading', { name: 'INV-1187' })).toBeVisible();
  await expect(page.getByTestId('document-activity')).toContainText('Sent to Carol Diaz');

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Marcus Reed', 'Priya', 'Tom Alvarez', 'Linda Park', 'Carol Diaz']) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
});

test('demo player: Ask HandsFreeOS sets up services, chases what’s owed, moves a job and asks for reviews', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const workspaceId = await staffBusiness(page, 'demo-assistant');
  await page.goto(`/app/w/${workspaceId}?demo`);
  await expect(director(page)).toBeVisible();
  const thread = page.getByTestId('conversation');

  // Scene 8: hours and three services from one sentence, a card for each, then the services page.
  await pick(page, 'business-setup', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(page).toHaveURL(/\/settings\/calendars\/services/);
  for (const name of ['Drain cleaning', 'Water heater flush', 'Leak repair'])
    await expect(page.getByTestId(`service-row-${name}`)).toBeVisible();
  await expect(page.getByTestId('service-editor')).toContainText('Leak repair');

  // Scene 9: what's owed, a text for each late one, and the first one answers.
  await pick(page, 'money-owed', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(thread.getByText(/Just a friendly nudge on invoice INV-1162/)).toBeVisible();
  await expect(
    thread.getByText('So sorry, that one slipped by me. Paying it tonight!'),
  ).toBeVisible();

  // Scene 10: tomorrow's jobs, one moved on a card, and the customer told.
  await pick(page, 'my-day', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(thread.getByText(/Your appointment is now/)).toBeVisible();
  await expect(thread.getByText(/\w+day works even better/)).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Water heater install')).toBeVisible();

  // Scene 11: a thank-you with the review link for each job done, and five stars back.
  await pick(page, 'review-requests', 'Open Ask HandsFreeOS');
  await play(page, 4);
  await expect(thread.getByText(/would you leave us a quick review\?/)).toBeVisible();
  await expect(thread.getByText('Done! Five stars.', { exact: false })).toBeVisible();

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/settings/calendars/services`);
  await expect(page.getByTestId('services')).toBeVisible();
  await expect(page.getByTestId('service-row-Leak repair')).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Gary Holt', 'Dave Johnson', 'Linda Park']) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
});

test('demo player: Ask HandsFreeOS answers what needs you, quotes from a sentence, learns a closed day, hears you out loud and moves jobs', async ({
  page,
}) => {
  test.setTimeout(480_000);
  const workspaceId = await staffBusiness(page, 'demo-ask-ideas');
  await page.goto(`/app/w/${workspaceId}?demo`);
  await expect(director(page)).toBeVisible();
  const panel = page.getByTestId('assistant-panel');
  const thread = page.getByTestId('conversation');

  // Scene 23: what needs you, two of the AI teammate's replies sent on your OK, and a text to the upset customer.
  await pick(page, 'what-needs-me', 'Open Ask HandsFreeOS');
  await play(page, 6);
  await expect(panel.getByTestId('assistant-card-attention')).toContainText('Gina Torres');
  await expect(panel.getByText('Approved. It goes to Linda now.')).toBeVisible();
  await expect(panel.getByText('Sent to Gina Torres')).toBeVisible();

  // Scene 24: an estimate written from one sentence, sent by text, and approved on the customer's phone.
  await pick(page, 'estimate-sentence', 'Open Ask HandsFreeOS');
  await play(page, 6);
  await expect(page).toHaveURL(/\/money\/estimates\/de300000-/);
  await expect(page.getByTestId('document-activity')).toContainText('Carol Jensen');

  // Scene 28: a closed day told once, then the AI teammate gets it right with a customer.
  await pick(page, 'teach-teammate', 'Open Ask HandsFreeOS');
  await play(page, 4);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(
    thread.getByText(/we’re closed on Friday, November \d+ for the holiday/),
  ).toBeVisible();
  // Past its training (this business has no AI teammate, so the scene makes one up): it answers on its own.
  await expect(page.getByTestId('handling-ai')).toContainText('It replies on its own.');

  // Scene 22: asked out loud, the answer read back, and a spoken yes sends the text. The player says the lines,
  // so no microphone is needed.
  await pick(page, 'talk-from-the-truck', 'Open Ask HandsFreeOS');
  await play(page, 4);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(
    thread.getByText('I’ll leave the garage open for you.', { exact: false }),
  ).toBeVisible();

  // Scene 58: what the AI teammate did today, and the reply it held for your OK.
  await pick(page, 'teammate-today', 'Open Ask HandsFreeOS');
  await play(page, 4);
  await expect(panel.getByTestId('assistant-card-list')).toContainText('6 conversations');
  await expect(panel.getByText('Approved. It goes to Ben now.')).toBeVisible();

  // Scene 60: tomorrow's outdoor jobs moved to next week, a card each.
  await pick(page, 'rain-day', 'Open Ask HandsFreeOS');
  await play(page, 3);
  await expect(panel.getByText(/^Moved to \w{3}, \w{3} \d+ at/)).toHaveCount(3);

  // Scene 62: this year's water heater installs tagged on one card, then a plain answer.
  await pick(page, 'tag-water-heaters', 'Open Ask HandsFreeOS');
  await play(page, 4);
  await expect(panel.getByText('Tags changed on 14 of 14')).toBeVisible();
  await expect(panel.getByText(/4 of the 14/)).toBeVisible();

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Gina Torres', 'Joan Riley'])
    await expect(page.getByText(name)).toHaveCount(0);
});

test('demo player: the AI teammate texts back a missed call, reads a photo, moves and fills visits, makes a referral a lead, learns from a fix, and answers email, Messenger and Instagram', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const workspaceId = await staffBusiness(page, 'demo-teammate-more');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();
  const thread = page.getByTestId('conversation');
  const side = page.getByTestId('context-panel');

  // Scene 12: a missed call, texted back in seconds and booked by text.
  await pick(page, 'missed-call', 'Open the Inbox');
  await play(page, 7);
  await expect(thread.getByText('Missed call')).toBeVisible();
  await expect(thread.getByText(/Sorry we missed your call!/)).toBeVisible();
  await expect(side.getByText('AC repair')).toBeVisible();

  // Scene 13: it asks for a photo, the photo shows in the thread, and it reads what's wrong.
  await pick(page, 'send-a-photo', 'Open the Inbox');
  await play(page, 6);
  await expect(thread.getByTestId('media-thumb').locator('img')).toHaveAttribute(
    'src',
    '/demo/water-heater-leak.svg',
  );
  await expect(thread.getByText(/coming from the relief valve pipe/)).toBeVisible();

  // Scene 14: the customer moves her own visit, on your OK.
  await pick(page, 'move-my-visit', 'Open the Inbox');
  await play(page, 5);
  await expect(thread.getByText(/I’ve moved your AC tune-up to tomorrow at 9:00 AM/)).toBeVisible();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);

  // Scene 15: a question about a quote, answered from its lines, and the quote approved.
  await pick(page, 'quote-question', 'Open the Inbox');
  await play(page, 6);
  await expect(page).toHaveURL(/\/money\/estimates\/de300000-/);
  await expect(page.getByTestId('document-activity')).toContainText('Megan Cross');

  // Scene 16: a cancelled time goes to the first person waiting, who takes it.
  await pick(page, 'cancellation-fills', 'Open the Inbox');
  await play(page, 5);
  await expect(
    thread.getByText(/A time opened on .+ at 9:00 AM \(Furnace tune-up\)/),
  ).toBeVisible();
  await expect(thread.getByText(/You're booked for .+ at 9:00 AM/)).toBeVisible();
  await expect(side.getByText('Furnace tune-up')).toBeVisible();

  // Scene 17: a neighbor mentioned in a text becomes a lead in one press on Home, and it says who sent her.
  await pick(page, 'neighbor-referral', 'Open the Inbox');
  await play(page, 7);
  await expect(page).toHaveURL(/\/leads\/de300000-/);
  await expect(page.getByTestId('lead-source')).toHaveText('Referred by Carla Benson');

  // Scene 18: your change to its draft becomes a lesson on Home, and the next customer gets it right.
  await pick(page, 'learns-from-fix', 'Open the Inbox');
  await play(page, 8);
  await expect(page.getByTestId('draft-text')).toContainText(
    'We don’t work Sundays, but we can come',
  );

  // Scene 19: an email asking for a quote, answered with questions, and a lead on the pipeline.
  await pick(page, 'property-manager-email', 'Open the Inbox');
  await play(page, 5);
  await expect(page.getByTestId('context-open-lead')).toContainText('Westpark Townhomes');

  // Scene 20: a Messenger message from an ad, booked, with the ad it came from.
  await pick(page, 'messenger-ad-lead', 'Open the Inbox');
  await play(page, 6);
  await expect(page.getByTestId('attribution-section')).toContainText('Fall furnace tune-ups');

  // Scene 21: an Instagram question answered from the price list.
  await pick(page, 'instagram-prices', 'Open the Inbox');
  await play(page, 5);
  await expect(thread.getByText(/An AC tune-up is \$89/)).toBeVisible();

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Hannah Pierce', 'Carla Benson', 'Diane Wexler', 'Nate Romero'])
    await expect(page.getByText(name)).toHaveCount(0);
});

test('demo player: a visit paid on the spot, a deposit to book, bookings online and around your own calendar, tune-ups that book themselves, a contract signed on a phone, calls and your own texts turned into tasks, and a quote', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const workspaceId = await staffBusiness(page, 'demo-calendar-money');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();
  const sheet = page.getByTestId('appointment-sheet');

  // Scene 31: the job marked done, invoiced from the visit, texted, and paid by card before leaving.
  await pick(page, 'paid-on-the-spot', 'Open Wes’s AC repair');
  await play(page, 6);
  await expect(page).toHaveURL(/\/calendar\?/);
  await expect(page.getByTestId('visit-invoice')).toHaveAttribute('data-state', 'paid');
  await expect(page.getByTestId('visit-invoice-paid')).toContainText('$385');

  // Scene 32: the booking link with a deposit, booked and paid, and the visit shows what's left.
  await pick(page, 'deposit-to-book', 'Open the Inbox');
  await play(page, 5);
  await expect(page.getByTestId('visit-deposit-paid')).toContainText('$250');
  await expect(page.getByTestId('visit-deposit-after')).toContainText('$2,200');

  // Scene 34: a booking from the website lands on tomorrow, with its reminders set.
  await pick(page, 'book-themselves', 'Open tomorrow on the calendar');
  await play(page, 4);
  await expect(sheet).toContainText('Owen Fischer');
  await expect(sheet).toContainText('Booked online');
  await expect(sheet.getByText('2 hours before')).toBeVisible();

  // Scene 35: busy on Google Calendar, so it offers other times and books one.
  await pick(page, 'own-calendar', 'Open tomorrow on the calendar');
  await play(page, 5);
  await expect(page.getByTestId('busy-block')).toBeVisible();
  await expect(page.getByText('Paige Holloway · Katy').first()).toBeVisible();

  // Scene 36: three customers due for a tune-up, all on next week's calendar.
  await pick(page, 'tune-ups-due', 'Open the Inbox');
  await play(page, 7);
  await expect(page).toHaveURL(/view=week/);
  for (const name of ['Darlene Marsh', 'Curtis Becker', 'Imelda Navarro'])
    await expect(page.getByText(name).first()).toBeVisible();

  // Scene 33: the agreement opened and signed on her phone, every step on the record.
  await pick(page, 'sign-on-phone', 'Open Heather’s agreement');
  await play(page, 4);
  await expect(page.locator('img[alt^="Signed by"]')).toBeVisible();
  await expect(page.getByTestId('document-steps')).toContainText('Signed: Heather Malone');

  // Scene 37: a recorded call's task added on its own and its follow-up email sent, with the transcript kept.
  await pick(page, 'call-to-tasks', 'Open today’s call');
  await play(page, 5);
  await expect(page.locator('[data-testid="call-suggestion"][data-status="pending"]')).toHaveCount(
    0,
  );
  await expect(page.getByTestId('appointment-transcript')).toHaveAttribute('open', '');

  // Scene 38: a video call's notes and chat, then the estimate written and texted from Ask HandsFreeOS.
  await pick(page, 'video-quote', 'Open Lauren’s lead');
  await play(page, 7);
  await expect(page).toHaveURL(/\/money\/estimates\/de300000-/);
  await expect(page.getByTestId('document-activity')).toContainText('Lauren Hayes');

  // Scene 67: a phone call's summary on the lead, its two tasks made on their own, then on the Tasks page.
  await pick(page, 'phone-call-tasks', 'Open Darnell’s lead');
  await play(page, 5);
  await expect(page).toHaveURL(/\/tasks/);
  await expect(
    page.getByText('Text Darnell a price for a new 50-gallon water heater'),
  ).toBeVisible();
  await expect(
    page.getByText('Added by the AI from your call with Darnell Ferris.').first(),
  ).toBeVisible();

  // Scene 68: the presenter's own text, and the two tasks the AI read from it.
  await pick(page, 'text-tasks', 'Maya texts about her AC');
  await play(page, 4);
  await expect(page).toHaveURL(/\/tasks/);
  await expect(page.getByText('Visit Maya to look at the upstairs AC')).toBeVisible();
  await expect(page.getByText('Text Maya the tune-up price')).toBeVisible();

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Erin Ortiz', 'Paige Holloway', 'Curtis Becker', 'Maya Castellano'])
    await expect(page.getByText(name)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/tasks`);
  await expect(page.getByTestId('tasks-page')).toBeVisible();
  await expect(page.getByText('Visit Maya to look at the upstairs AC')).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/documents`);
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await expect(page.getByText('AC system installation agreement')).toHaveCount(0);
});

test('demo player: moving in from another CRM, a form that texts back, Google reviews answered, last fall’s customers won back, a webinar that finds buyers, this month’s offer, and search that reads notes and texts', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const workspaceId = await staffBusiness(page, 'demo-day-one');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();

  // Scene 40: a spreadsheet from the old CRM, its columns matched, and six customers in with their tags.
  await pick(page, 'crm-import', 'Open Import');
  await play(page, 5);
  await expect(page).toHaveURL(/\/customers/);
  await expect(page.getByText('Marcy Delacroix').first()).toBeVisible();
  await expect(page.getByText('Moved from old CRM').first()).toBeVisible();

  // Scene 41: the quote form's lead on the board, texted in seconds, and booked from the chat.
  await pick(page, 'form-texts-back', 'Open your pipeline');
  await play(page, 6);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(page.getByTestId('context-panel')).toContainText('Water test and estimate');

  // Scene 42: both of today's Google reviews answered from Ask HandsFreeOS.
  await pick(page, 'answer-reviews', 'Open your reviews');
  await play(page, 3);
  await expect(page.getByTestId('review-answer')).toHaveCount(2);

  // Scene 43: last fall's customers found, texted, and one writes back.
  await pick(page, 'win-back', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(
    page.getByText('The furnace has been making a rattling noise').first(),
  ).toBeVisible();

  // Scene 44: the webinar's people scored Hot, Warm and Cold, and the hot one books.
  await pick(page, 'webinar-buyers', 'Open today’s webinar');
  await play(page, 5);
  await expect(page.getByText('Is tomorrow afternoon open?').first()).toBeVisible();

  // Scene 45: a website visitor hears about this month's offer and books it.
  await pick(page, 'best-offer', 'Open your offers');
  await play(page, 5);
  await expect(page.getByTestId('context-panel')).toContainText('AC tune-up');

  // Scene 65: Search finds the note and the text by their words, and opens the text.
  await pick(page, 'skylight-search', 'Search for what you remember');
  await play(page, 3);
  await expect(page).toHaveURL(/\/inbox\/de300000-.*message=/);
  await expect(page.getByText('The roofer fixed the leaky skylight!').first()).toBeVisible();

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/customers`);
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
  await expect(page.getByText('Marcy Delacroix')).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/reviews`);
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(page.getByText('Rhonda Sutton')).toHaveCount(0);
});

test('demo player: the AI calls a new lead, a sales coach on the call, a home buyer’s text, and Social Outreach’s first messages', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const workspaceId = await staffBusiness(page, 'demo-addons');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();

  // Scene 46: the AI teammate calls the form's lead, the call is kept, and the estimate is booked.
  await pick(page, 'ai-calls-lead', 'A quote request while you’re out');
  await play(page, 5);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(page.getByText('Outgoing call').first()).toBeVisible();
  await expect(page.getByTestId('context-panel')).toContainText('Furnace replacement estimate');

  // Scene 47: AI Sales Coach shows as on, with its row in the menu, and its cards come one by one.
  await pick(page, 'sales-coach', 'Curtis joins the call');
  await expect(page.locator(`aside a[href="/app/w/${workspaceId}/a/salescoach"]`)).toHaveCount(1);
  await play(page, 5);
  await expect(page.getByTestId('coach-card')).toHaveCount(3);
  await expect(page.getByTestId('coach-live')).toContainText('Writing up the call');

  // Scene 48: the teammate asks before adding the house, and the text goes once it's approved.
  await pick(page, 'buyer-texts', 'A buyer texts about a house');
  await play(page, 3);
  await expect(page.getByText(/Great find, Joanna!/).first()).toBeVisible();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);

  // Scene 49: three first messages OK'd, and the reply that asked for you handed over.
  await pick(page, 'outreach-starts', 'It found people in your groups');
  await play(page, 4);
  await expect(page.getByTestId('waiting-message')).toHaveCount(0);
  await expect(page.getByTestId('waiting-reply')).toContainText('Shonda Merritt');

  // Nothing was turned on, and nothing was saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await expect(page.locator(`aside a[href="/app/w/${workspaceId}/a/salescoach"]`)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/a/salescoach`);
  await expect(page.getByTestId('addon-unavailable')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Tamika Rhodes', 'Joanna Whitlock'])
    await expect(page.getByText(name)).toHaveCount(0);
});

test('demo player: a new owner sets up the AI teammate from their website', async ({ page }) => {
  test.setTimeout(300_000);
  const workspaceId = await staffBusiness(page, 'demo-setup');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();

  // Scene 39: the website is read into the screens, Save sets it up, and the test chat answers.
  await pick(page, 'website-setup', 'Paste your website');
  await play(page, 9);
  await expect(page).toHaveURL(/\/ai-team\/setup\?at=try/);
  await expect(page.getByTestId('ai-setup-chat-code')).toBeVisible();
  await expect(page.getByTestId('ai-setup-test')).toContainText('Katy, Cypress, Spring');
  await expect(page.getByTestId('ai-setup-test')).toContainText('Saturday from 8 AM to noon');
  await expect(
    page.locator('[data-testid^="ai-setup-test-"][data-outcome="handed_off"]'),
  ).toHaveCount(1);

  // Nothing was saved: no teammate, no website, and nothing it read.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/ai-team/setup`);
  await expect(page.getByTestId('ai-setup')).toHaveAttribute('data-step', 'business');
  await expect(page.getByTestId('ai-setup-website-input')).toHaveValue('');
});

test('demo player: Admin → Demo player plays a scene in your business, each step with its voiceover', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspaceId = await staffBusiness(page, 'demo-admin');
  await page.goto('/admin/demo');
  await expect(page.getByRole('heading', { name: 'Demo player' })).toBeVisible();
  await expect(page.getByTestId('admin-nav-demo')).toHaveAttribute('aria-current', 'page');
  // Only the founder opens Bright Path Home Services as its owner; anyone else plays in a business of their own.
  await expect(page.getByText(/Only the founder can open Bright Path Home Services/)).toBeVisible();
  await expect(page.getByTestId(`demo-place-${workspaceId}`)).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Every scene's voiceover is there to read before recording.
  const money = page.getByTestId('demo-admin-scene-money-owed');
  await money.getByText('Voiceover · 5 steps').click();
  await expect(money.getByText(/Thirty-four days late, and paid the same night\./)).toBeVisible();

  // Play opens the business on that scene, and the address stops asking for it, so a reload carries on.
  await page.getByTestId('demo-play-money-owed').click();
  await expect(director(page)).toBeVisible();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open Ask HandsFreeOS');
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(5);
  await expect(page.getByTestId('demo-next-step')).toContainText(
    'Ask HandsFreeOS knows your money',
  );
  // Not the founder in someone else's business: no note about changes being real.
  await expect(page.getByTestId('demo-acting-note')).toHaveCount(0);

  // All scenes goes back to the list, and the scene that was loaded is one press away.
  await expect(page.getByTestId('demo-scene-list')).toHaveCount(0);
  await page.getByTestId('demo-all-scenes').click();
  await expect(page.getByTestId('demo-scene-list')).toBeVisible();
  await expect(page.getByTestId('demo-steps')).toHaveCount(0);
  await expect(page.getByTestId('demo-scene-text-campaign')).toBeVisible();
  await page.getByTestId('demo-back-to-scene').click();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open Ask HandsFreeOS');
  await expect(page.getByTestId('demo-scene-list')).toHaveCount(0);

  // The voiceover hides for a cleaner panel, and stays hidden after a reload, until it's shown again.
  await page.getByTestId('demo-voiceover-toggle').click();
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('demo-steps').locator('li').nth(0)).toContainText('✓');
  await page.reload();
  await expect(page.getByTestId('demo-steps').locator('li').nth(0)).toContainText('✓');
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(0);
  await page.getByTestId('demo-voiceover-toggle').click();
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(5);
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
});
