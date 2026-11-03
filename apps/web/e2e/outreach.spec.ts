import { randomUUID } from 'node:crypto';
import { blankPlaybook } from '@hfos/core/addons/outreach/playbooks';
import { expect, test, type Page } from '@playwright/test';
import { api, makeCalendar, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, linkFrom, signUpAndConfirm, waitForMail } from './helpers';
import { madeUpDownload, makeZip } from './outreach-download';

/**
 * Social Outreach (docs/outreach.md): HandsFreeOS staff hand the add-on in testing to a business.
 * - Its owner writes a playbook a step at a time, ending in a conversation where each answer can tag the person and
 *   says what's next. A step with a problem on it won't carry on. Changing the playbook opens on its summary, and
 *   taking a tag out takes it off the answers that added it.
 * - The activity tab counts the steps the browser extension noted, by group and person, over a stretch of days, with
 *   the owner's day against the daily limits.
 * - The friends tab lists the friends and requests the extension saved and the answers it noted, finds one by name,
 *   keeps a friend, and puts someone on the Don't pitch list, after which a step to them isn't counted.
 * - Anyone kept as a profile has a menu on their name on the Friends tab, as on Today: Add to Contacts and Demo booked.
 * - A name in Waiting for you opens the same menu, their page first (decision 91). Mark as client adds them to
 *   Contacts tagged Client, skips the message waiting for them, and moves them to the Pipeline's Client stage, off the
 *   board; Not a client after all takes the tag off.
 * - Facebook's download file, read in the browser, says since when they've been friends, when a request was sent,
 *   and the latest message with each person; a chat from it goes onto the customer's card from the Chats tab.
 * - The groups tab scores the groups the extension saved, and Today waits for a group's admins before it suggests
 *   anyone from it.
 * - A first-timer is sent to the setup (decision 83): the main setup, then a short one for each network they turn on,
 *   each step ticked from facts (the extension signing in, the rules kept, their goal saved), Skip leaving it to do,
 *   Start saying what's still in the way, Set up in the side menu with how far it's come (decision 129), and Set up
 *   again on Settings.
 * - Settings has a page for each part, opened from its menu: You, then each network (decision 73), and Team for an
 *   owner (decision 129). Every change saves as it's made, with no Save button, and is still there after a reload. A network's On for you saves at once
 *   with a line beside it (Chris, 2026-10-16); one that can't be saved goes back, saying why.
 * - The Partners list, under People (decision 81), has everyone the AI found could send the business customers, by
 *   stage, and marks them along.
 * - A partner the business lets into its portal is told about their partner page, signs in with a code, accepts the
 *   business's terms there, and only then gets their link (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2c).
 * - The business sets how partners are paid and their terms in Settings → Partners, makes a customer a partner and
 *   marks who sent a client from their pages, and sees each partner's link, clients and what they earned (stage 2d).
 */
/**
 * Opens one of Social Outreach's pages from its one row in the side menu, where they pop out (decisions 127 to 129):
 * Set up while anything's left, Needs you, Today, People, Find people, Results, Playbooks and Settings.
 */
async function openOutreachPage(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByTestId('menu-addon-outreach')
    .click();
  await page
    .getByTestId('menu-addon-panel-outreach')
    .getByRole('link', { name: new RegExp(`^${name}`) })
    .click();
}

async function turnOnOutreach(page: Page, email: string, workspaceId: string) {
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.goto(`/admin/businesses/${workspaceId}`);
  const testing = page.getByTestId('admin-addon-testing');
  await testing.getByTestId('admin-addon-testing-outreach').click();
  await expect(testing).toContainText('they can add it');
  await page.goto(`/app/w/${workspaceId}/add-ons`);
  const card = page.getByTestId('addon-outreach');
  await expect(card.getByTestId('addon-testing')).toBeVisible();
  await page.getByTestId('addon-install-outreach').click();
  await expect(card.getByTestId('addon-state')).toHaveText('On', { timeout: 90_000 });
  // A first-timer is sent to the setup; leaving it for later lets the page open as it was.
  await page.goto(`/app/w/${workspaceId}/a/outreach`);
  await expect(page).toHaveURL(new RegExp(`/a/outreach/setup(\\?.*)?$`));
  // A page of its own, as the main app's onboarding is: the welcome first, with Finish later at the top.
  await expect(page.getByTestId('outreach-setup-page')).toBeVisible();
  await expect(page.getByTestId('outreach-setup')).toHaveAttribute('data-screen', 'welcome');
  await page.getByTestId('outreach-setup-later').click();
  await expect(page.getByTestId('outreach-home')).toBeVisible();
}

test('an owner builds a playbook a step at a time, with answers that tag people and lead on, and changes it from its summary', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { email } = await signUpAndConfirm(page, 'outreach-owner');
  const workspaceId = await createBusiness(page, { name: 'Pine Street Bakery' });
  await turnOnOutreach(page, email, workspaceId);

  await page.goto(`/app/w/${workspaceId}/a/outreach`);
  await expect(page.getByTestId('outreach-home')).toBeVisible();
  // Its pages pop out from its one row in the side menu, Playbooks among them (decision 127), and Set up first while
  // anything's left, with how far it's come (decision 129).
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByTestId('menu-addon-outreach')
    .click();
  await expect(page.getByTestId('menu-addon-panel-outreach').getByRole('link')).toHaveText([
    /^Set up/,
    /^Needs you/,
    'Today',
    'People',
    'Find people',
    'Results',
    'Playbooks',
    'Settings',
  ]);
  await page.keyboard.press('Escape');
  await openOutreachPage(page, 'Playbooks');
  await expect(page).toHaveURL(new RegExp(`/a/outreach/playbooks$`));
  await expect(page.getByTestId('outreach-home')).toHaveAttribute('data-page', 'playbooks');
  await page.getByTestId('playbook-new').click();
  await page.getByTestId('template-blank').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/playbooks/new$`));
  const builder = page.getByTestId('playbook-builder');
  const next = builder.getByTestId('playbook-next');

  // What it's after, and the offer: an idea tapped, and a bare address made whole.
  await expect(
    builder.getByRole('heading', { name: 'What do you want from Facebook?' }),
  ).toBeVisible();
  await builder.getByTestId('goal-sale').click();
  await next.click();
  // The niche narrows the main offer; with none live it says where to build one, and carries on without.
  await expect(builder.getByTestId('playbook-no-main-offer')).toBeVisible();
  await next.click();
  await builder.getByRole('button', { name: 'A free trial' }).click();
  await expect(builder.getByTestId('playbook-offer')).toHaveValue('A free trial');
  await builder.getByTestId('playbook-link').fill('pinestreet.test/order');
  await builder.getByTestId('playbook-link').blur();
  await expect(builder.getByTestId('playbook-link')).toHaveValue('https://pinestreet.test/order');
  await next.click();

  // Who: a sign typed in and one tapped. Who to leave alone: one tapped.
  await builder.getByTestId('playbook-audience').fill('Office managers who order for their team.');
  await builder.getByLabel('Signs someone fits', { exact: true }).fill('Plans office parties');
  await builder.getByLabel('Signs someone fits', { exact: true }).press('Enter');
  await builder.getByRole('button', { name: 'Lives or works in your area' }).click();
  await expect(builder.getByRole('listitem')).toHaveText([
    /Plans office parties/,
    /Lives or works in your area/,
  ]);
  await next.click();
  await builder.getByRole('button', { name: 'Friends and family' }).click();
  await next.click();

  // Where: words typed and not added yet are kept on carrying on.
  await builder.getByLabel('Words to search for groups', { exact: true }).fill('office managers');
  await next.click();
  await expect(builder.getByRole('heading', { name: 'What it does, and how fast' })).toBeVisible();

  // The pace: the first message two days after they accept.
  await builder.getByTestId('pace-message').getByRole('button', { name: /^More/ }).click();
  await expect(builder.getByTestId('pace-message')).toContainText('2');
  await next.click();

  // The short video can wait: no script or link yet.
  await expect(builder.getByTestId('playbook-video-write')).toBeVisible();
  await next.click();

  // Tags: one of its own, and an idea tapped.
  await builder.getByLabel('Tags it may use').fill('Wants a tasting');
  await builder.getByLabel('Tags it may use').press('Enter');
  await builder.getByRole('button', { name: 'Not a fit' }).click();
  await next.click();

  // The conversation: two questions; the first one's answers tag people and lead on.
  await builder.getByTestId('question-add').click();
  await builder.getByTestId('question-1-text').fill('Do you order food for the office?');
  const first = builder.getByTestId('question-1');
  await first.getByRole('button', { name: 'Yes', exact: true }).click();
  await first.getByRole('button', { name: 'No', exact: true }).click();
  await builder.getByTestId('question-add').click();
  await builder.getByTestId('question-2-text').fill('How many people are in the office?');
  await first.getByLabel('Tag for answer 1 to question 1').selectOption('Wants a tasting');
  await first.getByLabel('After answer 1 to question 1').selectOption('offer');
  await first.getByLabel('Tag for answer 2 to question 1').selectOption('Not a fit');
  await first.getByLabel('After answer 2 to question 1').selectOption('stop');

  // An answer with no words stops the step, saying why, until it's taken out.
  await first.getByTestId('question-1-add-answer').click();
  await expect(first.getByText('Write the answer, or take it out.')).toBeVisible();
  await expect(next).toBeDisabled();
  await first.getByRole('button', { name: 'Take out answer 3 to question 1' }).click();
  await expect(next).toBeEnabled();
  await next.click();

  // How it sounds: words tapped in.
  await builder.getByRole('button', { name: 'Friendly' }).click();
  await builder.getByRole('button', { name: 'No hard sell' }).click();
  await expect(builder.getByLabel('Your tone')).toHaveValue('Friendly, no hard sell');
  await next.click();

  // How it starts a chat: a style tapped, and an opener of the business's own.
  await expect(builder.getByRole('heading', { name: 'How do you start a chat?' })).toBeVisible();
  await builder.getByRole('button', { name: /^Say it could bring them more customers/ }).click();
  await builder.getByRole('button', { name: 'Add an opener' }).click();
  await builder
    .getByLabel('Your opener 1')
    .fill('Hi {first name}! Who orders lunch at your office?');
  await next.click();

  // The summary: named after its goal to start with, and the conversation as it reads.
  await expect(builder.getByTestId('playbook-name')).toHaveValue('Make a sale');
  await builder.getByTestId('playbook-name').fill('Office orders');
  await expect(builder.getByTestId('review-where')).toContainText('office managers');
  await expect(builder.getByTestId('review-steps')).toContainText(
    'First message 2 days after they accept',
  );
  const script = builder.getByTestId('review-conversation');
  await expect(script).toContainText('1. Do you order food for the office?');
  await expect(script).toContainText('“Yes” adds Wants a tasting, then make the offer');
  await expect(script).toContainText('“No” adds Not a fit, then stop here');
  await expect(script).toContainText('They answer in their own words.');
  await expect(builder.getByTestId('review-openers')).toContainText(
    'Say it could bring them more customers without more work',
  );
  await expect(builder.getByTestId('review-openers')).toContainText('1 opener of your own');
  await builder.getByTestId('playbook-save').click();
  await expect(page.getByText('Office orders is ready.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/playbooks$`));
  const card = page.getByTestId('playbook-Office orders');
  await expect(card.getByTestId('playbook-questions')).toHaveText(
    'Asks 2 questions, starting with “Do you order food for the office?”',
  );

  // Changing it opens on the summary. Taking a tag out takes it off the answer that added it.
  await card.getByTestId('playbook-change').click();
  await expect(builder.getByTestId('playbook-step-review')).toBeVisible();
  await builder.getByTestId('review-change-tags').click();
  await builder.getByRole('button', { name: 'Take out “Wants a tasting”' }).click();
  await builder.getByTestId('playbook-next').click();
  await expect(builder.getByTestId('playbook-step-review')).toBeVisible();
  await expect(script).toContainText('“Yes”, then make the offer');
  await builder.getByTestId('playbook-save').click();
  await expect(page.getByText('Office orders is saved.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/playbooks$`));

  // A template's conversation comes with it, and answers lead further down.
  await page.getByTestId('playbook-new').click();
  await page.getByTestId('template-crm_demos').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/playbooks/new\\?template=crm_demos$`));
  for (let i = 0; i < 9; i++) await builder.getByTestId('playbook-next').click();
  await expect(builder.getByTestId('question-1-text')).toHaveValue('Do you use a CRM?');
  await expect(builder.getByLabel('After answer 2 to question 1')).toHaveValue('q4');
  for (let i = 0; i < 3; i++) await builder.getByTestId('playbook-next').click();
  await expect(builder.getByTestId('playbook-name')).toHaveValue('CRM demos');
  await expect(script).toContainText(
    '“No”, then ask question 4: “How do you keep track of follow-ups now?”',
  );
});

test('the Results tab counts what the extension noted, by group and person, over a stretch of days', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-activity');
  const workspaceId = await createBusiness(page, { name: 'Maple Lane Plumbing' });
  await turnOnOutreach(page, email, workspaceId);

  await page.goto(`/app/w/${workspaceId}/a/outreach`);
  await openOutreachPage(page, 'Results');
  await expect(page).toHaveURL(new RegExp(`/a/outreach/results$`));
  await expect(page.getByTestId('activity-empty')).toContainText(
    'Nothing noted in the last 7 days',
  );
  // The three numbers lead, with no goal set yet and no review before the first Monday.
  await expect(page.getByTestId('tracking-numbers')).toContainText(
    'No first messages in the last 7 days.',
  );
  await expect(page.getByTestId('tracking-no-goal')).toBeVisible();
  await expect(page.getByTestId('tracking-review-none')).toContainText(
    'Your first review comes on Monday morning',
  );

  // What the extension sends as the owner works on Facebook: made-up people, found in two groups and in a chat.
  const { token } = await signInOwner(email);
  const fb = 'https://www.facebook.com';
  const makers = {
    id: '4455667788',
    slug: null,
    url: `${fb}/groups/4455667788/`,
    name: 'Westfield Makers Market',
  };
  const riverside = {
    id: null,
    slug: 'riverside.pros',
    url: `${fb}/groups/riverside.pros/`,
    name: null,
  };
  const note = (kind: string, who: { id: string; name: string }, more: Record<string, unknown>) =>
    api(token, 'commands', 'outreach.touch.save', {
      workspaceId,
      platform: 'facebook',
      kind,
      profile: { id: who.id, username: null, url: `${fb}/profile.php?id=${who.id}` },
      name: who.name,
      group: null,
      postUrl: null,
      threadKey: null,
      replying: null,
      ...more,
    });
  const kim = { id: '100003000000002', name: 'Kim Lowe' };
  const owen = { id: '100005000000001', name: 'Owen Pratt' };
  const dana = { id: '100009000000002', name: 'Dana Reyes' };
  const post = `${fb}/groups/riverside.pros/posts/5555666677778888/`;
  await note('friend_request', kim, { group: makers });
  await note('like', owen, { group: riverside, postUrl: post });
  await note('comment', owen, { group: riverside, postUrl: post });
  await note('message', dana, { threadKey: dana.id, replying: false });

  await page.reload();
  const numbers = page.getByTestId('activity-numbers');
  await expect(numbers.getByTestId('activity-number-people')).toContainText('3');
  await expect(numbers.getByTestId('activity-number-friendRequests')).toContainText('1');
  await expect(numbers.getByTestId('activity-number-likes')).toContainText('1');
  await expect(numbers.getByTestId('activity-number-comments')).toContainText('1');
  await expect(numbers.getByTestId('activity-number-chatsStarted')).toContainText('1');
  // The first message to Dana counts as a message sent, with no playbook's opener behind it.
  await expect(page.getByTestId('tracking-number-messages')).toContainText('1');
  await expect(page.getByTestId('tracking-number-positive')).toContainText('0');
  await expect(page.getByTestId('tracking-rate-yes')).toContainText('0 of 1 message, 0%');
  await expect(page.getByTestId('tracking-rate-yes')).toContainText('Too few to tell yet');
  await expect(page.getByTestId('tracking-playbooks-row')).toContainText('No playbook');

  // By group: the one whose name hasn't been seen goes by its link.
  const groups = page.getByTestId('activity-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.filter({ hasText: 'Westfield Makers Market' })).toContainText('1');
  await expect(groups.filter({ hasText: 'Group riverside.pros' })).toBeVisible();

  // Person by person, how far each has come.
  const people = page.getByTestId('activity-person');
  await expect(people).toHaveCount(3);
  await expect(people.filter({ hasText: 'Owen Pratt' })).toContainText('Liked');
  await expect(people.filter({ hasText: 'Owen Pratt' })).toContainText('Commented');
  await expect(people.filter({ hasText: 'Owen Pratt' })).toContainText('From Group riverside.pros');
  await expect(people.filter({ hasText: 'Kim Lowe' })).toContainText('Friend request');
  await expect(people.filter({ hasText: 'Dana Reyes' })).toContainText('Messaged');

  // Another stretch, and everyone's steps for the owner, each in the address.
  await page.getByTestId('activity-period-today').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/results\\?period=today$`));
  await expect(numbers.getByTestId('activity-number-people')).toContainText('3');
  await page.getByTestId('activity-who-everyone').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/results\\?period=today&who=everyone$`));
  await expect(page.getByTestId('activity-who-everyone')).toHaveAttribute('aria-selected', 'true');
  await expect(people).toHaveCount(3);
  await expect(page.getByTestId('tracking-numbers')).toContainText('The team’s numbers');
  await expect(page.getByTestId('tracking-review-none')).toHaveCount(0);

  // The day's report is on to start; turned off on Settings → You, it saves by itself and stays off.
  await page.goto(`/app/w/${workspaceId}/a/outreach/settings`);
  const dayReport = page.getByTestId('outreach-my-dayReport');
  await expect(dayReport).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('outreach-my-day-report-sample')).toContainText(
    'Today: 14 messages, 2 said yes, 1 booked. 1 more message hits your target.',
  );
  const reportSaved = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().endsWith('/v1/commands/outreach.automation.save'),
  );
  await dayReport.click();
  await expect(page.getByTestId('outreach-my-day-report-sample')).toHaveCount(0);
  expect((await reportSaved).ok()).toBe(true);
  await expect(page.getByTestId('outreach-settings-status')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.getByTestId('outreach-my-dayReport')).toHaveAttribute('aria-checked', 'false');

  // The owner's day against the limits is at the top of Today, each half while Facebook is new to them (decision 96),
  // said under Heads up.
  await openOutreachPage(page, 'Today');
  await expect(page.getByTestId('today-heads-up').getByTestId('today-fresh')).toContainText(
    'your daily limits there',
  );
  await expect(page.getByTestId('today-limit-friend_request')).toContainText('1 of 10');
  await expect(page.getByTestId('today-limit-first_message')).toContainText('1 of 7');
  // The old addresses still open the page they became (decision 127): the activity's Results, a network's settings
  // its page there, and the extension's Needs you link, on Today, Needs you.
  await page.goto(`/app/w/${workspaceId}/a/outreach?view=activity&period=today`);
  await expect(page).toHaveURL(new RegExp(`/a/outreach/results\\?period=today$`));
  await expect(page.getByTestId('outreach-home')).toHaveAttribute('data-page', 'results');
  await page.goto(`/app/w/${workspaceId}/a/outreach?view=settings&part=linkedin`);
  await expect(page).toHaveURL(new RegExp(`/a/outreach/settings/linkedin$`));
  await page.goto(`/app/w/${workspaceId}/a/outreach?view=today#needs-you`);
  await expect(page).toHaveURL(new RegExp(`/a/outreach/needs-you$`));
  await expect(page.getByTestId('outreach-waiting')).toBeVisible();
  // Groups went under Find people (decision 128): the old view and part 1's address both open them there.
  await page.goto(`/app/w/${workspaceId}/a/outreach?view=groups&show=all`);
  await expect(page).toHaveURL(new RegExp(`/a/outreach/find/groups\\?show=all$`));
  await page.goto(`/app/w/${workspaceId}/a/outreach/groups?show=maybe`);
  await expect(page).toHaveURL(new RegExp(`/a/outreach/find/groups\\?show=maybe$`));
  await expect(page.getByTestId('outreach-home')).toHaveAttribute('data-page', 'find');
});

test('the friends tab lists what the extension saved a page at a time, keeps a friend, and puts someone on the Don’t pitch list', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-friends');
  const workspaceId = await createBusiness(page, { name: 'Cedar Street Roofing' });
  await turnOnOutreach(page, email, workspaceId);

  // What the extension sends from the owner's friends list and requests, and a request they confirmed: made-up people.
  const { token } = await signInOwner(email);
  const fb = 'https://www.facebook.com';
  const who = (id: string, name: string, mutualFriends: number | null = null) => ({
    profile: { id, username: null, url: `${fb}/profile.php?id=${id}` },
    name,
    mutualFriends,
  });
  const save = (list: string, people: unknown[]) =>
    api(token, 'commands', 'outreach.friends.save', {
      workspaceId,
      platform: 'facebook',
      list,
      people,
    });
  await save('friends', [
    who('100007000000011', 'Sky Patel', 4),
    who('100007000000012', 'Parker Reed'),
  ]);
  await save('requests', [
    who('100007000000002', 'Quinn Harper', 1),
    who('100007000000001', 'Avery Lane', 12),
  ]);
  await api(token, 'commands', 'outreach.friend.note', {
    workspaceId,
    platform: 'facebook',
    answer: 'confirm',
    ...who('100007000000002', 'Quinn Harper'),
  });

  await page.goto(`/app/w/${workspaceId}/a/outreach`);
  // Friends are one of People's views (decisions 59, 127 and 128), with each friends list's count.
  await openOutreachPage(page, 'People');
  await page.getByTestId('people-view-friends').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/friends$`));
  const people = page.getByTestId('friend');
  await expect(people).toHaveText([/Parker Reed/, /Quinn Harper/, /Sky Patel/]);
  await expect(page.getByTestId('people-view-friends')).toContainText('3');
  await expect(page.getByTestId('people-view-requests')).toContainText('1');
  await expect(page.getByTestId('friends-cap')).toContainText('3 of 5,000');

  // Found by part of a name as it's typed, with no Enter, in the address; an empty box shows everyone again.
  await page.getByTestId('friends-search').pressSequentially('sky', { delay: 50 });
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/friends\\?q=sky$`));
  await expect(people).toHaveText([/Sky Patel/]);
  await expect(page.getByTestId('friends-search')).toHaveValue('sky');
  await page.getByTestId('friends-search').fill('');
  await expect(people).toHaveCount(3);

  // Keep: never suggested for unfriending.
  await people.filter({ hasText: 'Sky Patel' }).getByTestId('friend-keep').click();
  await expect(page.getByText('You’ll keep Sky Patel.')).toBeVisible();
  await expect(people.filter({ hasText: 'Sky Patel' }).getByTestId('friend-keep')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Anyone kept as a profile has the person panel on their name, here as on Today: Add to Contacts, and Demo booked.
  // Don't pitch and Never contact are the row's own switches, so the panel leaves them out.
  const parker = people.filter({ hasText: 'Parker Reed' });
  const parkerPage = await parker.getByTestId('network-name').getAttribute('href');
  expect(parkerPage).toContain('100007000000012');
  await parker.getByTestId('person-menu').click();
  await expect(page.getByTestId('person-open-page')).toHaveAttribute('href', parkerPage!);
  await expect(page.getByTestId('person-dont-pitch')).toHaveCount(0);
  await page.getByTestId('person-add-contact').click();
  await expect(page.getByText('Parker Reed is in Contacts now.')).toBeVisible();
  await parker.getByTestId('person-menu').click();
  await expect(page.getByTestId('person-in-contacts')).toHaveAttribute(
    'href',
    new RegExp(`/app/w/${workspaceId}/customers/people/[0-9a-f-]{36}$`),
  );
  await page.getByTestId('person-demo-mark').click();
  await expect(page.getByText('Marked: Parker Reed booked a demo.')).toBeVisible();

  // The request still waiting, by fit: mutual friends alone until a playbook says what to look for.
  await page.getByTestId('people-view-requests').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/friends\\?show=requests$`));
  await expect(people).toHaveText([/Avery Lane/]);
  await expect(people.getByTestId('friend-fit')).toHaveText('Might fit');
  await expect(people.getByTestId('friend-fit-reasons')).toHaveText('12 mutual friends');

  // Don't pitch: the business's list says who added them, and a step to them isn't counted as outreach.
  await people.getByTestId('friend-dont-pitch').click();
  await expect(page.getByText('Avery Lane is on the Don’t pitch list.')).toBeVisible();
  // Left alone opens on Don't pitch, with Keep beside it.
  await page.getByTestId('people-view-left_alone').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/friends\\?show=dont_pitch$`));
  await expect(page.getByTestId('people-alone-dont_pitch')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('people-alone-keep')).toContainText('1');
  await expect(people).toHaveText([/Avery Lane/]);
  await expect(people).toContainText('Added to Don’t pitch by');
  await expect(
    api(token, 'commands', 'outreach.touch.save', {
      workspaceId,
      platform: 'facebook',
      kind: 'like',
      profile: who('100007000000001', 'Avery Lane').profile,
      name: 'Avery Lane',
      group: null,
      postUrl: null,
      threadKey: null,
      replying: null,
    }),
  ).rejects.toThrow(/outreach_dont_pitch/);

  // A long list comes a page at a time: 98 more friends make 101, so the last by name is on page 2.
  await save(
    'friends',
    Array.from({ length: 98 }, (_, i) =>
      who(`1000070000002${String(i).padStart(2, '0')}`, `Zoe Friend ${i + 1}`),
    ),
  );
  await page.getByTestId('people-view-friends').click();
  await expect(page.getByTestId('people-view-friends')).toContainText('101');
  await expect(people).toHaveCount(100);
  await expect(page.getByTestId('friends-range')).toContainText('1–100 of 101');
  await expect(page.getByTestId('friends-page')).toHaveText('Page 1 of 2');
  await expect(page.getByTestId('friends-page-previous')).toBeDisabled();
  await page.getByTestId('friends-page-next').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/friends\\?page=2$`));
  await expect(people).toHaveText([/Zoe Friend 98/]);
  await expect(page.getByTestId('friends-page')).toHaveText('Page 2 of 2');
  await expect(page.getByTestId('friends-page-next')).toBeDisabled();
  // A search starts again at its first page: Zoe Friend 9, and 90 to 98.
  await page.getByTestId('friends-search').fill('zoe friend 9');
  await expect(page).toHaveURL(
    new RegExp(`/a/outreach/people/friends\\?q=zoe(\\+|%20)friend(\\+|%20)9$`),
  );
  await expect(people).toHaveCount(10);
  await expect(page.getByTestId('friends-pages')).toHaveCount(0);
});

test('a name opens the person menu, their page first; Mark as client ends outreach to them, and Not a client after all takes it back', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { email } = await signUpAndConfirm(page, 'outreach-client');
  const workspaceId = await createBusiness(page, { name: 'Birch Hollow Landscaping' });
  await turnOnOutreach(page, email, workspaceId);

  // Two made-up friends of the owner's whose posts they liked, and a first message to one, drafted and waiting.
  const { token } = await signInOwner(email);
  const fb = 'https://www.facebook.com';
  const profileOf = (id: string) => ({ id, username: null, url: `${fb}/profile.php?id=${id}` });
  const rowan = { id: '100011000000001', name: 'Rowan Ellis' };
  const sage = { id: '100011000000002', name: 'Sage Moreno' };
  await api(token, 'commands', 'outreach.friends.save', {
    workspaceId,
    platform: 'facebook',
    list: 'friends',
    people: [rowan, sage].map((p) => ({
      profile: profileOf(p.id),
      name: p.name,
      mutualFriends: null,
    })),
  });
  const group = {
    id: null,
    slug: 'birch.hollow.neighbors',
    url: `${fb}/groups/birch.hollow.neighbors/`,
    name: null,
  };
  for (const [i, p] of [rowan, sage].entries())
    await api(token, 'commands', 'outreach.touch.save', {
      workspaceId,
      platform: 'facebook',
      kind: 'like',
      profile: profileOf(p.id),
      name: p.name,
      group,
      postUrl: `${fb}/groups/birch.hollow.neighbors/posts/111122223333444${i}/`,
      threadKey: null,
      replying: null,
    });
  const { people } = await api<{ people: { profileId: string; name: string }[] }>(
    token,
    'queries',
    'outreach.friends',
    { workspaceId },
  );
  const rowanId = people.find((p) => p.name === rowan.name)?.profileId;
  expect(rowanId).toBeTruthy();
  await api(token, 'commands', 'outreach.send.queue', {
    workspaceId,
    profileId: rowanId,
    kind: 'opener',
    text: 'Hi Rowan! How is the spring rush treating you?',
  });

  // Needs you: the name is a button that opens the person menu, and the card keeps its own Open.
  await page.goto(`/app/w/${workspaceId}/a/outreach/needs-you`);
  const card = page
    .getByTestId('waiting-message')
    .getByTestId('waiting-item')
    .filter({ hasText: rowan.name });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('waiting-send-open')).toHaveAttribute('href', new RegExp(rowan.id));
  const name = card.getByRole('button', { name: rowan.name, exact: true });
  await expect(name).toHaveAttribute('data-testid', 'person-menu');
  await expect(name).toHaveAttribute('aria-haspopup', 'dialog');
  await name.click();
  const menu = page.getByTestId('person-menu-items');
  const first = menu.getByRole('link').first();
  await expect(first).toHaveAttribute('data-testid', 'person-open-page');
  await expect(first).toHaveText('Open on Facebook');
  await expect(first).toHaveAttribute('href', new RegExp(rowan.id));
  await expect(first).toHaveAttribute('target', '_blank');
  await expect(menu.getByTestId('person-add-contact')).toHaveText('Add to Contacts');
  await expect(menu.getByTestId('person-dont-pitch')).toHaveText('Don’t pitch');
  await expect(menu.getByTestId('person-never-contact')).toHaveText('Never contact');

  // Mark as client: nobody in Contacts has the name, so Rowan is added there, tagged Client, and the message waiting
  // for them is skipped, so the card leaves.
  await expect(menu.getByTestId('person-client')).toHaveText('Mark as client');
  await menu.getByTestId('person-client').click();
  await expect(
    page.getByText(
      'Rowan Ellis is a client now. Nobody here sends them outreach, and their replies still come to Waiting for you.',
    ),
  ).toBeVisible();
  await expect(card).toHaveCount(0);

  // Contacts lists them under Clients, with the Client tag.
  await page.goto(`/app/w/${workspaceId}/customers?show=clients`);
  const contact = page.getByTestId('people-table').getByRole('row').filter({ hasText: rowan.name });
  await expect(contact).toHaveCount(1);
  await expect(contact.getByRole('cell').filter({ hasText: /^Client$/ })).toHaveCount(1);

  // The Pipeline: clients are left off the board, with a link to them beside Not a fit's, and have a stage of their
  // own with why, and no moves.
  await page.goto(`/app/w/${workspaceId}/a/outreach/people`);
  await expect(page.getByTestId('pipeline-board')).toContainText(sage.name);
  await expect(page.getByTestId('pipeline-board')).not.toContainText(rowan.name);
  await expect(page.getByTestId('pipeline-show-client')).toContainText(/Client\s*1/);
  await page.getByTestId('pipeline-clients').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people\\?show=client$`));
  await expect(page.getByTestId('pipeline-note')).toContainText('A client gets no outreach');
  const listed = page.getByTestId('pipeline-person').filter({ hasText: rowan.name });
  await expect(listed.getByTestId('pipeline-stage')).toHaveText('Client');
  await expect(listed.getByTestId('pipeline-why')).toContainText(
    'A client in Contacts: they’re tagged Client',
  );

  // Enter on the focused name opens the menu too. Not a client after all takes the tag off.
  await listed.getByTestId('person-menu').focus();
  await page.keyboard.press('Enter');
  await expect(menu.getByTestId('person-open-page')).toBeVisible();
  await expect(menu.getByTestId('person-move-to')).toHaveCount(0);
  await expect(menu.getByTestId('person-in-contacts')).toBeVisible();
  await expect(menu.getByTestId('person-client')).toHaveText('Not a client after all');
  await menu.getByTestId('person-client').click();
  await expect(
    page.getByText(
      'Rowan Ellis isn’t a client any more. Messages skipped when you marked them stay skipped.',
    ),
  ).toBeVisible();
  await expect(listed).toHaveCount(0);
  await expect(page.getByTestId('pipeline-show-client')).toContainText(/Client\s*0/);
});

test('the friends tab brings in Facebook’s download file: since when they’ve been friends, when a request went, and the latest message', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-download');
  const workspaceId = await createBusiness(page, { name: 'Maple Lane Plumbing' });
  await turnOnOutreach(page, email, workspaceId);

  // What the extension saved: two friends and a request sent, made-up people.
  const { token } = await signInOwner(email);
  const fb = 'https://www.facebook.com';
  const who = (id: string, name: string) => ({
    profile: { id, username: null, url: `${fb}/profile.php?id=${id}` },
    name,
    mutualFriends: null,
  });
  const save = (list: string, people: unknown[]) =>
    api(token, 'commands', 'outreach.friends.save', {
      workspaceId,
      platform: 'facebook',
      list,
      people,
    });
  await save('friends', [
    who('100008000000001', 'Sky Patel'),
    who('100008000000002', 'Parker Reed'),
  ]);
  await save('sent', [who('100008000000003', 'Quinn Harper')]);

  // The file: made yesterday, with a request sent 40 days ago and the last messages 20 days ago, at noon UTC.
  const noon = (daysAgo: number) => {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    d.setUTCHours(12, 0, 0, 0);
    return d;
  };
  const sentAt = noon(40);
  const zip = makeZip(madeUpDownload(sentAt.toISOString(), noon(20).toISOString()), noon(1));
  const day = (d: Date) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    });

  // Facebook's file is under Find people's Old friends and chats (decision 128).
  await page.goto(`/app/w/${workspaceId}/a/outreach/find`);
  const card = page.getByTestId('download-card');
  await expect(card).toContainText('Only names and dates are sent');
  await card
    .getByTestId('download-files')
    .setInputFiles({ name: 'facebook-made-up.zip', mimeType: 'application/zip', buffer: zip });
  const counts = card.getByTestId('download-counts');
  await expect(counts).toContainText('Friends3');
  await expect(counts).toContainText('Requests you sent1');
  await expect(counts).toContainText('Chats2');
  await card.getByTestId('download-send').click();
  await expect(
    page.getByText('Your Facebook file is in. 5 names match people saved here.'),
  ).toBeVisible();
  await expect(card.getByTestId('download-done')).toContainText(
    '5 of 6 names match people saved here',
  );

  await page.goto(`/app/w/${workspaceId}/a/outreach/people/friends`);
  const people = page.getByTestId('friend');
  await expect(people.filter({ hasText: 'Sky Patel' }).getByTestId('friend-since')).toHaveText(
    `Friends since May 2016 · Last message ${day(noon(20))}, from them`,
  );
  await expect(people.filter({ hasText: 'Parker Reed' }).getByTestId('friend-since')).toHaveText(
    `Friends since Jul 2019 · Last message ${day(noon(20))}, from you`,
  );
  // The request's real day, for cancelling the ones nobody answers.
  await page.getByTestId('people-view-sent').click();
  await expect(people).toHaveText([/Quinn Harper/]);
  await expect(people.getByTestId('friend-since')).toHaveText(`Sent · ${day(sentAt)}`);

  // The chats it brought in go onto the customer's card from the Chats tab: Sky isn't in Contacts, so is added.
  // Sky's chat waits for the AI's read, or is read already where the worker has one.
  const sky = page.getByTestId('chat').filter({ hasText: 'Sky Patel' });
  for (const show of ['waiting', 'read']) {
    await page.goto(`/app/w/${workspaceId}/a/outreach/people/chats?show=${show}`);
    await expect(page.getByTestId('chats-list').or(page.getByTestId('chats-empty'))).toBeVisible();
    if (await sky.count()) break;
  }
  await sky.getByTestId('chat-keep').click();
  await expect(
    page.getByText('Sky Patel is in Contacts now, with your chat on their card.'),
  ).toBeVisible();
  // The AI may read the chat meanwhile, which moves it from Not read yet to All read: look wherever it is now.
  await expect(async () => {
    for (const show of ['read', 'waiting']) {
      await page.goto(`/app/w/${workspaceId}/a/outreach/people/chats?show=${show}`);
      await expect(
        page.getByTestId('chats-list').or(page.getByTestId('chats-empty')),
      ).toBeVisible();
      if (await sky.count()) break;
    }
    await expect(sky).toContainText('On their card', { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  // Their name opens the person menu, whose In Contacts goes to their card.
  await sky.getByTestId('person-menu').click();
  await page.getByTestId('person-in-contacts').click();
  await expect(page.getByTestId('outreach-panel')).toContainText('Made-up words');
});

test('the groups tab scores saved groups, and today waits for a group’s admins and a playbook', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-groups');
  const workspaceId = await createBusiness(page, { name: 'Maple Lane Plumbing' });
  await turnOnOutreach(page, email, workspaceId);

  // What the extension sends from the owner's groups and one group's People tab: made-up groups and people.
  const { token } = await signInOwner(email);
  const fb = 'https://www.facebook.com';
  const austin = {
    id: '223456789',
    slug: null,
    url: `${fb}/groups/223456789/`,
    name: 'Austin Small Business Owners',
  };
  await api(token, 'commands', 'outreach.groups.save', {
    workspaceId,
    platform: 'facebook',
    groups: [
      { group: austin, members: 34_718, privacy: 'public', joined: true },
      {
        group: {
          id: '223456790',
          slug: null,
          url: `${fb}/groups/223456790/`,
          name: 'Knitting Circle',
        },
        detail: 'Private group · 40 members',
      },
    ],
  });
  await api(token, 'commands', 'outreach.group.save', {
    workspaceId,
    platform: 'facebook',
    group: austin,
    people: [
      {
        profile: {
          id: '100007000000021',
          username: null,
          url: `${fb}/profile.php?id=100007000000021`,
        },
        name: 'Rowan Ellis',
        lines: ['Owner at Ellis Electric'],
      },
    ],
  });

  await page.goto(`/app/w/${workspaceId}/a/outreach`);
  // The groups are under Find people (decision 128).
  await openOutreachPage(page, 'Find people');
  await expect(page).toHaveURL(new RegExp(`/a/outreach/find$`));
  await expect(page.getByTestId('find-way-groups')).toBeVisible();
  await page.getByTestId('find-part-groups').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/find/groups$`));
  // Without a playbook, nothing says a group is worth working: being big and being in it make a maybe.
  await expect(page.getByTestId('groups-empty')).toBeVisible();
  await page.getByTestId('groups-show-all').click();
  const groups = page.getByTestId('group');
  await expect(groups).toHaveText([/Austin Small Business Owners/, /Knitting Circle/]);
  await expect(groups.first()).toContainText('Maybe');
  await expect(groups.first()).toContainText('1 person saved');
  await expect(groups.first()).toContainText('Admins not read');
  await expect(groups.last()).toContainText('Skip');
  // Its name opens its own page (decision 103): who was found there and how each turned out.
  await groups.first().getByTestId('group-open').click();
  await expect(page.getByTestId('group-page-name')).toHaveText('Austin Small Business Owners');
  await expect(page.getByTestId('group-page-person')).toHaveText([/Rowan Ellis/]);
  await expect(page.getByTestId('group-page-stage')).toHaveText('Not reached yet');
  await page.getByTestId('group-page-back').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/find/groups$`));

  await openOutreachPage(page, 'Today');
  await expect(page).toHaveURL(new RegExp(`/a/outreach/today$`));
  // Not ready yet (decision 63): a line in place of the list says how much is left, with Set up a press away.
  await expect(page.getByTestId('today-get-ready')).toContainText(
    'before the extension reaches anyone on Facebook',
  );
  await expect(page.getByTestId('today-read-admins')).toContainText('Austin Small Business Owners');
  await expect(page.getByText('Friend requests need a playbook')).toBeVisible();
  // Half while Facebook is new to them (decision 96).
  await expect(page.getByTestId('today-limits')).toContainText('Friend requests0 of 10');
  // Get ready is on Set up (decision 129), its playbook still to write.
  await page.getByTestId('today-get-ready-open').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/set-up$`));
  await expect(page.getByTestId('get-ready')).toBeVisible();
  await expect(page.getByTestId('ready-playbook')).toHaveAttribute('data-state', 'todo');
});

test('a first-timer is sent to the setup: the main setup, then each network, each step ticked from facts', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { email } = await signUpAndConfirm(page, 'outreach-setup');
  const workspaceId = await createBusiness(page, { name: 'Maple Lane Plumbing' });
  await turnOnOutreach(page, email, workspaceId);
  const setup = page.getByTestId('outreach-setup');
  const rail = (key: string) => page.getByTestId(`outreach-setup-rail-${key}`).first();

  // Set up is first in the side menu, with how far it's come (decision 129); its page names the next step, and Carry on
  // opens it (they started when they left it for later).
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByTestId('menu-addon-outreach')
    .click();
  await expect(page.getByTestId('addon-menu-setup')).toContainText('0 of 10 setup steps done');
  await page.keyboard.press('Escape');
  await openOutreachPage(page, 'Set up');
  await expect(page).toHaveURL(new RegExp(`/a/outreach/set-up$`));
  await expect(page.getByTestId('outreach-setup-banner')).toContainText(
    'Next: Main offer · 0 of 8 done.',
  );
  await page.getByTestId('outreach-setup-carry-on').click();
  await expect(setup).toHaveAttribute('data-screen', 'offer');
  await expect(page.getByTestId('outreach-setup-counter')).toHaveText('Your business · 1 of 4');
  // The main offer is built on its own page, which comes back here.
  await expect(page.getByTestId('outreach-setup-offer-open')).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}/main-offer/build?back=${encodeURIComponent(`/app/w/${workspaceId}/a/outreach/setup?step=offer`)}`,
  );
  await expect(rail('offer')).toHaveAttribute('data-state', 'todo');
  await page.getByTestId('outreach-setup-skip').click();

  // A playbook: a template opens the builder and comes back to this step.
  await expect(setup).toHaveAttribute('data-screen', 'playbook');
  await expect(page.getByTestId('outreach-setup-template-crm_demos')).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}/a/outreach/playbooks/new?from=setup&template=crm_demos`,
  );
  // Skipped, it's still left to do.
  await page.getByTestId('outreach-setup-skip').click();
  await expect(rail('playbook')).toHaveAttribute('data-state', 'todo');

  // The short video is optional (decision 83): the business can say it doesn't use one.
  await expect(setup).toHaveAttribute('data-screen', 'video');
  await expect(rail('video')).toContainText('Optional');
  await page.getByTestId('outreach-setup-no-video').click();

  // The team's rules, kept in one press, tick.
  await expect(setup).toHaveAttribute('data-screen', 'rules');
  await expect(rail('video')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('outreach-setup-rules')).toContainText('20 friend requests');
  // Each network the business uses shows its own limits, in its own words.
  await expect(page.getByTestId('outreach-setup-rules-limits-linkedin')).toContainText(
    'On LinkedIn, a day',
  );
  await expect(page.getByTestId('outreach-setup-rules-limits-linkedin')).toContainText(
    '15 invitations to connect',
  );
  await expect(page.getByTestId('outreach-setup-rules-limits-instagram')).toContainText(
    '20 follows',
  );
  await page.getByTestId('outreach-setup-rules-keep').click();

  // The extension: HandsFreeOS's own download, five steps with pictures, then it waits until the extension signs in.
  await expect(setup).toHaveAttribute('data-screen', 'extension');
  await expect(rail('rules')).toHaveAttribute('data-state', 'done');
  const download = page.getByTestId('outreach-setup-download');
  await expect(download).toHaveAttribute(
    'href',
    /^\/downloads\/hfos-social\.zip\?v=\d+\.\d+\.\d+$/,
  );
  await expect(page.getByTestId('outreach-download-about')).toContainText(
    'for Chrome on a computer',
  );
  await expect(page.getByTestId('outreach-install-steps')).toContainText('Developer mode');
  await expect(page.getByTestId('outreach-install-steps')).toContainText('Load unpacked');
  await expect(page.getByTestId('outreach-install-step-5')).toContainText(email);
  const zip = await page.request.get((await download.getAttribute('href'))!);
  expect(zip.status()).toBe(200);
  expect((await zip.body()).readUInt32LE(0)).toBe(0x04034b50);
  await expect(page.getByTestId('outreach-setup-waiting')).toBeVisible();
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'outreach.setup.save', { workspaceId, extension: true });
  await expect(page.getByTestId('outreach-setup-signed-in')).toBeVisible({ timeout: 15_000 });
  await expect(rail('extension')).toHaveAttribute('data-state', 'done');
  await page.getByTestId('outreach-setup-next').click();

  // Their messages wait on the offer and a niche.
  await expect(setup).toHaveAttribute('data-screen', 'messages');
  await page.getByTestId('outreach-setup-skip').click();

  // The networks they use come before the goal, which counts them all (decision 88). LinkedIn turned on gets a short
  // setup of its own, after Facebook's.
  await expect(setup).toHaveAttribute('data-screen', 'networks');
  await page.getByTestId('outreach-setup-network-linkedin-on').click();
  await expect(page.getByTestId('outreach-setup-networks-next')).toContainText(
    'Next: your goal, then set up Facebook and LinkedIn.',
  );
  await expect(page.getByTestId('outreach-setup-networks-save')).toHaveText('Save and carry on');
  await page.getByTestId('outreach-setup-networks-save').click();

  // Their goal, at the safe pace of both networks together; it saves and ticks.
  await expect(setup).toHaveAttribute('data-screen', 'numbers');
  await expect(rail('networks')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('ready-verdict')).toContainText(
    'Your safe pace is 30 first messages a day: 15 on Facebook and 15 on LinkedIn.',
  );
  await page.getByTestId('ready-numbers-save').click();

  // Facebook's short setup: the profile, what it does there, then the first day.
  await expect(setup).toHaveAttribute('data-screen', 'facebook-profile');
  await expect(rail('numbers')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('outreach-setup-counter')).toHaveText('Facebook · 1 of 3');
  await expect(rail('linkedin')).toContainText('5 steps');
  await page.getByTestId('outreach-setup-skip').click();
  await expect(setup).toHaveAttribute('data-screen', 'facebook-choices');
  // Nothing picked to start (decision 26): Save waits for a pick.
  await expect(page.getByTestId('outreach-setup-choices-save')).toBeDisabled();
  await page.getByTestId('outreach-setup-sending-steps').click();
  await page.getByTestId('outreach-setup-choices-save').click();

  // Start: what's still in the way says so, with where to fix it.
  await expect(setup).toHaveAttribute('data-screen', 'facebook-start');
  await expect(page.getByTestId('outreach-setup-blocker')).toBeVisible();
  await expect(page.getByTestId('outreach-setup-fix')).toHaveAttribute(
    'href',
    `/app/w/${workspaceId}/a/outreach/setup?step=offer`,
  );
  await expect(page.getByTestId('outreach-setup-start-day')).toBeDisabled();
  await expect(page.getByTestId('outreach-setup-then')).toContainText('Then LinkedIn');

  // LinkedIn's own setup starts with Chrome's Allow, waiting until the computer says it's let on.
  await page.goto(`/app/w/${workspaceId}/a/outreach/setup?net=linkedin&step=allow`);
  await expect(setup).toHaveAttribute('data-screen', 'linkedin-allow');
  await expect(page.getByTestId('outreach-setup-counter')).toHaveText('LinkedIn · 1 of 5');
  await expect(page.getByTestId('outreach-setup-allow-steps')).toContainText('linkedin.com');
  await expect(page.getByTestId('outreach-setup-allow-waiting')).toBeVisible();

  // Left for later: Set up says what's next, and Carry on opens there, saying where they left off.
  await page.getByTestId('outreach-setup-later').click();
  await openOutreachPage(page, 'Set up');
  await expect(page.getByTestId('outreach-setup-rail-rules')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('outreach-setup-banner')).toContainText(
    'Next: Main offer · 5 of 8 done.',
  );
  await page.getByTestId('outreach-setup-carry-on').click();
  await expect(setup).toHaveAttribute('data-screen', 'offer');

  // Set up again on Settings opens the first step.
  await page.goto(`/app/w/${workspaceId}/a/outreach/settings`);
  await page.getByTestId('outreach-setup-again-open').click();
  await expect(setup).toHaveAttribute('data-screen', 'offer');
});

test('a network’s On for you saves at once on its page, with a line beside it, and goes back when it can’t be saved', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-switch');
  const workspaceId = await createBusiness(page, { name: 'Birch Road Bikes' });
  await turnOnOutreach(page, email, workspaceId);
  const { token } = await signInOwner(email);
  type Kept = { networks: Record<'facebook' | 'linkedin', { on: boolean; sending: string }> };
  const kept = async () =>
    (await api<{ settings: Kept }>(token, 'queries', 'outreach.automation', { workspaceId }))
      .settings;
  const isSave = (url: string, method: string) =>
    method === 'POST' && url.endsWith('/v1/commands/outreach.automation.save');

  await page.goto(`/app/w/${workspaceId}/a/outreach/settings/linkedin`);
  const linkedIn = page.getByTestId('outreach-my-networks-linkedin-on');
  await expect(linkedIn).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('outreach-my-networks-linkedin-off')).toBeVisible();

  // LinkedIn on saves at once, and says so beside the switch.
  const switched = page.waitForRequest((r) => isSave(r.url(), r.method()));
  await linkedIn.click();
  const sent = (await switched).postDataJSON() as { settings: Kept };
  expect(sent.settings.networks.linkedin.on).toBe(true);
  await expect(page.getByTestId('outreach-my-networks-linkedin-saved')).toHaveText(
    'LinkedIn is on. The extension picks it up in a few seconds.',
  );
  expect((await kept()).networks.linkedin.on).toBe(true);

  // Its choices show, and one picked saves by itself too: no Save button.
  await expect(page.getByTestId('outreach-my-save')).toHaveCount(0);
  const picked = page.waitForResponse((r) => isSave(r.url(), r.request().method()));
  await page.getByTestId('outreach-my-networks-linkedin-sending-steps').click();
  expect((await picked).ok()).toBe(true);
  expect((await kept()).networks.linkedin).toMatchObject({ on: true, sending: 'steps' });

  // A switch that can't be saved goes back, with the server's words beside it: here, sent for someone who isn't in
  // the business.
  const save = '**/v1/commands/outreach.automation.save';
  await page.route(save, (route) => {
    const r = route.request();
    if (r.method() !== 'POST') return route.continue();
    const body = r.postDataJSON() as Record<string, unknown>;
    return route.continue({ postData: JSON.stringify({ ...body, userId: randomUUID() }) });
  });
  await linkedIn.click();
  await expect(page.getByTestId('outreach-my-networks-linkedin-problem')).toContainText(
    'can’t use Social Outreach in this business',
  );
  await expect(page.getByTestId('outreach-settings-status')).toHaveAttribute(
    'data-state',
    'failed',
  );
  await expect(linkedIn).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('outreach-my-networks-linkedin-saved')).toHaveCount(0);
  await page.unroute(save);
  expect((await kept()).networks.linkedin.on).toBe(true);

  // Off, then: saved at once, and kept after a reload, with the choice picked before.
  await linkedIn.click();
  await expect(page.getByTestId('outreach-my-networks-linkedin-saved')).toHaveText(
    'LinkedIn is off.',
  );
  await expect(page.getByTestId('outreach-my-networks-linkedin-problem')).toHaveCount(0);
  await page.reload();
  await expect(linkedIn).toHaveAttribute('aria-checked', 'false');
  expect((await kept()).networks.linkedin).toMatchObject({ on: false, sending: 'steps' });
});

test('Settings opens You, LinkedIn’s page, Facebook’s and Team from its menu, and each change saves by itself', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-settings');
  const workspaceId = await createBusiness(page, { name: 'Cedar Hill Fitness' });
  await turnOnOutreach(page, email, workspaceId);
  const { token } = await signInOwner(email);
  type Kept = {
    readChats: boolean;
    voice: { emoji: boolean };
    networks: Record<'facebook' | 'linkedin', { on: boolean }>;
  };
  const kept = async () =>
    (await api<{ settings: Kept }>(token, 'queries', 'outreach.automation', { workspaceId }))
      .settings;
  const saved = (command: 'outreach.automation.save' | 'addon.save_settings') =>
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/v1/commands/${command}`),
    );
  const view = page.getByTestId('outreach-settings-view');
  const title = page.getByTestId('outreach-settings-title');
  const status = page.getByTestId('outreach-settings-status');

  // Settings opens on You: the person's own on every network, and for an owner a line to Team, which has the team's
  // say (decision 129). No Save buttons.
  await openOutreachPage(page, 'Settings');
  await expect(page).toHaveURL(new RegExp(`/a/outreach/settings$`));
  await expect(view).toHaveAttribute('data-part', 'general');
  await expect(title).toHaveText('You');
  await expect(status).toHaveText('Changes save as you make them.');
  await expect(page.getByTestId('outreach-team-moved')).toContainText('are on Team');
  await expect(page.getByTestId('outreach-team')).toHaveCount(0);
  for (const gone of ['outreach-my-save', 'outreach-rules-save', 'outreach-settings-save'])
    await expect(page.getByTestId(gone)).toHaveCount(0);
  // The menu: each network with whether it's on for them, then those still to come, which don't open.
  await expect(page.getByTestId('outreach-settings-part-general')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByTestId('outreach-settings-part-facebook-state')).toHaveText('On');
  await expect(page.getByTestId('outreach-settings-part-linkedin-state')).toHaveText('Off');
  await expect(page.getByTestId('outreach-settings-part-instagram-state')).toHaveText('Off');
  await expect(page.getByTestId('outreach-settings-part-alignable-state')).toHaveText('Off');
  await expect(page.getByTestId('outreach-settings-soon-threads')).toContainText('Soon');

  // An emoji now and then: saved by itself, and still ticked after a reload.
  const emojiSaved = saved('outreach.automation.save');
  await page.getByTestId('outreach-my-voice-emoji').check();
  expect((await emojiSaved).ok()).toBe(true);
  await expect(status).toHaveText('Saved. The extension follows it in a few seconds.');
  await page.reload();
  await expect(page.getByTestId('outreach-my-voice-emoji')).toBeChecked();

  // Team, from the menu (decision 129): the owner among their people, what people may pick, the extension's link box
  // with its own Save, and each network's say for everyone.
  await page.getByTestId('outreach-settings-part-team').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/settings/team$`));
  await expect(view).toHaveAttribute('data-part', 'team');
  await expect(title).toHaveText('Team');
  await expect(page.getByTestId('outreach-team-person')).toContainText('(you)');
  await expect(page.getByTestId('outreach-team')).toContainText('For your team');
  await expect(page.getByTestId('outreach-extension-link-save')).toBeVisible();
  await expect(page.getByTestId('outreach-team-facebook')).toContainText('Always allowed');
  await expect(page.getByTestId('outreach-rules-network-linkedin')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // LinkedIn's page, from the menu: off for them, with a line to Team for an owner.
  await page.getByTestId('outreach-settings-part-linkedin').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/settings/linkedin$`));
  await expect(view).toHaveAttribute('data-part', 'linkedin');
  await expect(title).toHaveText('LinkedIn');
  await expect(page.getByTestId('outreach-my-networks-linkedin-off')).toBeVisible();
  await expect(page.getByTestId('outreach-team-moved-linkedin')).toContainText(
    'Your team’s say on LinkedIn is on Team.',
  );
  // On for you: its choices, that it works there from install, and its limits as they stand show; the menu says it's on.
  await page.getByTestId('outreach-my-networks-linkedin-on').click();
  await expect(page.getByTestId('outreach-my-networks-linkedin-saved')).toBeVisible();
  await expect(page.getByTestId('outreach-my-networks-linkedin-chrome')).toContainText(
    'nothing to allow in Chrome',
  );
  await expect(
    page.getByTestId('outreach-my-networks-linkedin-limit-friend_request'),
  ).toContainText('At most 80 in any 7 days');
  await expect(page.getByTestId('outreach-settings-part-linkedin-state')).toHaveText('On');
  // Their LinkedIn profile, here too: not read yet, and Get ready's sheet to read it (decision 80).
  await expect(page.getByTestId('outreach-my-networks-linkedin-profile-state')).toHaveText(
    'Have the extension read your LinkedIn profile, and the AI says what to change.',
  );
  await page.getByTestId('outreach-my-networks-linkedin-profile-open').click();
  const profileSheet = page.getByRole('dialog', { name: 'Check your LinkedIn profile' });
  await expect(profileSheet.getByTestId('ready-profile-read')).toContainText(
    'Have the extension read your LinkedIn profile',
  );
  await page.keyboard.press('Escape');
  await expect(profileSheet).toHaveCount(0);
  // The team's daily invitations, typed on Team: saved once it's left, and their own limit on LinkedIn's page follows,
  // half while LinkedIn is new to them (decision 96).
  await page.getByTestId('outreach-team-moved-linkedin-open').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/settings/team$`));
  const invites = page.getByTestId('outreach-rules-linkedin-limit-friend_request');
  await expect(invites).toHaveValue('15');
  const limitSaved = saved('addon.save_settings');
  await invites.fill('10');
  await invites.blur();
  expect((await limitSaved).ok()).toBe(true);
  await page.reload();
  await expect(invites).toHaveValue('10');
  await page.getByTestId('outreach-settings-part-linkedin').click();
  await expect(page.getByTestId('outreach-my-networks-linkedin-fresh')).toContainText(
    'New on LinkedIn',
  );
  await expect(
    page.getByTestId('outreach-my-networks-linkedin-limit-friend_request').locator('div').first(),
  ).toHaveText('5');
  await expect(page.getByTestId('outreach-my-networks-linkedin-on')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Facebook's page: no Chrome step, and the extension's switches are here. One turned off saves by itself.
  await page.getByTestId('outreach-settings-part-facebook').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/settings/facebook$`));
  await expect(title).toHaveText('Facebook');
  await expect(page.getByTestId('outreach-my-networks-facebook-chrome')).toHaveCount(0);
  const readChats = page.getByTestId('outreach-my-readChats');
  await expect(readChats).toHaveAttribute('aria-checked', 'true');
  const chatsSaved = saved('outreach.automation.save');
  await readChats.click();
  expect((await chatsSaved).ok()).toBe(true);
  await page.reload();
  await expect(readChats).toHaveAttribute('aria-checked', 'false');
  expect(await kept()).toMatchObject({
    readChats: false,
    voice: { emoji: true },
    networks: { linkedin: { on: true } },
  });
});

test('the Partners list has who could send the business customers, by stage, and marks them along', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-partners');
  const workspaceId = await createBusiness(page, { name: 'Summit Roofing' });
  await turnOnOutreach(page, email, workspaceId);

  // A playbook whose goal is Find partners, and a friend the extension read with a following, for the AI's check.
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'outreach.playbook.save', {
    workspaceId,
    name: 'Partners',
    template: null,
    details: {
      ...blankPlaybook(),
      goal: 'partner',
      offer: '10% of what each customer pays for a year',
      audience: 'Homeowners in Austin',
      link: 'https://summit.test/partner-call',
    },
  });
  const fb = 'https://www.facebook.com';
  await api(token, 'commands', 'outreach.friends.save', {
    workspaceId,
    list: 'friends',
    people: [
      {
        profile: { id: null, username: 'dana.reyes.12', url: `${fb}/dana.reyes.12` },
        name: 'Dana Reyes',
        mutualFriends: null,
      },
    ],
  });
  const friends = await api<{ people: { profileId: string }[] }>(
    token,
    'queries',
    'outreach.friends',
    { workspaceId },
  );
  await api(token, 'commands', 'outreach.partner.look', {
    workspaceId,
    profileId: friends.people[0]!.profileId,
    kind: 'creator',
    lines: ['Dana Reyes', 'Home tips for Austin homeowners'],
    followers: 3400,
  });
  // The AI checks them on the worker.
  await expect
    .poll(
      async () =>
        (
          await api<{ partners: unknown[] }>(token, 'queries', 'outreach.partners', {
            workspaceId,
          })
        ).partners.length,
      { timeout: 60_000 },
    )
    .toBe(1);

  await page.goto(`/app/w/${workspaceId}/a/outreach/people`);
  await page.getByTestId('people-view-partners').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/partners$`));
  await expect(page.getByTestId('partners-show-all')).toContainText(/Everyone\s*1/);
  const row = page.getByTestId('partner');
  await expect(row).toContainText('Dana Reyes');
  await expect(row).toContainText('Creator · 3,400 people');
  await expect(row).toContainText('Might be a partner');
  await expect(row.getByTestId('partner-stage')).toContainText('Found');
  await row.getByTestId('partner-mark-interested').click();
  await expect(page.getByText('Dana Reyes is interested.')).toBeVisible();
  await expect(page.getByTestId('partners-show-interested')).toContainText(/Interested\s*1/);
  await expect(row.getByTestId('partner-stage')).toContainText('Interested');
  // Interested: what's ahead is the call and making them a partner.
  await expect(row.getByTestId('partner-mark-interested')).toHaveCount(0);
  await expect(row.getByTestId('partner-mark-partner')).toBeVisible();
  await page.getByTestId('partners-show-asked').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/people/partners\\?show=asked$`));
  await expect(page.getByTestId('partners-empty')).toContainText('Nobody is at Asked yet.');
});

test('a partner signs in to their own page, accepts the terms, and only then gets their link', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const business = 'Cedar Roofing';
  const { email } = await signUpAndConfirm(page, 'partner-page-owner');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnOutreach(page, email, workspaceId);
  const { token, userId } = await signInOwner(email);
  const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
  await api(token, 'commands', 'schedule.set', { workspaceId, ownerId: userId, weekly });
  const site = `e2e-${randomUUID().slice(0, 8)}`;
  await api(token, 'commands', 'booking_site.update', { workspaceId, slug: site, name: business });
  const calendar = await makeCalendar(
    { token, userId, workspaceId, site, business },
    'Roof checks',
  );
  await api(token, 'commands', 'partners.save_settings', {
    workspaceId,
    settings: {
      rateBp: 1_200,
      terms: 'Paid on the 1st of each month, by bank transfer.',
      smallestPayoutCents: 2_500,
      calendarId: calendar.id,
    },
  });
  const partnerEmail = `pat-${randomUUID().slice(0, 8)}@example.com`;
  const { personId } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Pat',
    lastName: 'Partner',
    email: partnerEmail,
  });
  const { code } = await api<{ code: string }>(token, 'commands', 'partner.add', {
    workspaceId,
    personId,
  });
  const sent = Date.now();
  await api(token, 'commands', 'portal_access.give', { workspaceId, personId });
  const invite = await waitForMail(partnerEmail, `Your partner page with ${business}`, {
    after: sent,
  });
  const link = linkFrom(invite.text, /http:\/\/localhost:3000\/c\/[A-Za-z0-9_.~-]+/);

  // On their phone they ask for a code and type it in: Home says they're a partner.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pat = await phone.newPage();
  await pat.goto(link);
  await expect(pat.getByTestId('portal-sign-in')).toContainText('Hi Pat');
  const asked = Date.now();
  await pat.getByTestId('portal-send-code').click();
  const codeMail = await waitForMail(partnerEmail, `Your ${business} code`, { after: asked });
  await pat.getByTestId('portal-digit-0').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await expect(pat.getByTestId('portal-home-partner')).toContainText(
    `You’re a partner of ${business}`,
  );
  await pat
    .getByRole('navigation', { name: 'Your portal' })
    .getByRole('link', { name: 'Partner' })
    .click();

  // The terms first: no link until they're accepted.
  const terms = pat.getByTestId('portal-partner-terms');
  await expect(terms).toContainText('Paid on the 1st of each month, by bank transfer.');
  await expect(pat.getByTestId('portal-partner')).toContainText('You earn 12% of what each client');
  await expect(pat.getByTestId('portal-partner-link')).toHaveCount(0);
  await terms.getByRole('button', { name: 'I accept these terms' }).click();
  await expect(terms).toContainText('You accepted these terms on');
  await expect(pat.getByTestId('portal-partner-link')).toContainText(
    `/book/c/${calendar.id}?ref=pa-${code}`,
  );
  await expect(pat.getByTestId('portal-partner-earnings')).toContainText('$0');
  await expect(pat.getByTestId('portal-partner-clients')).toContainText(
    'Nobody has booked through your link yet.',
  );
  await phone.close();
});

test('the business sets how partners are paid, makes a customer a partner, marks who sent a client, and sees what they earned', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const business = 'Birch Plumbing';
  const { email } = await signUpAndConfirm(page, 'partners-owner');
  const workspaceId = await createBusiness(page, { name: business });
  await turnOnOutreach(page, email, workspaceId);
  const { token, userId } = await signInOwner(email);
  const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
  await api(token, 'commands', 'schedule.set', { workspaceId, ownerId: userId, weekly });
  const site = `e2e-${randomUUID().slice(0, 8)}`;
  await api(token, 'commands', 'booking_site.update', { workspaceId, slug: site, name: business });
  const calendar = await makeCalendar(
    { token, userId, workspaceId, site, business },
    'Drain checks',
  );
  const partnerEmail = `pia-${randomUUID().slice(0, 8)}@example.com`;
  const { personId: pia } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Pia',
    lastName: 'Partner',
    email: partnerEmail,
  });
  const { personId: cal } = await api<{ personId: string }>(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Cal',
    lastName: 'Client',
  });

  // Settings → Partners: the share saves as it's left; the terms wait for their button.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(
    page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Partners' }),
  ).toHaveAttribute('href', `/app/w/${workspaceId}/settings/partners`);
  await page.goto(`/app/w/${workspaceId}/settings/partners`);
  const settings = page.getByTestId('partners-settings');
  await expect(settings.getByTestId('partners-empty')).toContainText('No partners yet.');
  // Paying partners through HandsFreeOS waits until HandsFreeOS opens it for the business.
  await expect(settings.getByTestId('partner-payouts')).toContainText(
    'HandsFreeOS doesn’t pay your partners for you yet.',
  );
  await settings.getByTestId('partners-rate').fill('12');
  await settings.getByTestId('partners-rate').blur();
  await expect(page.getByText('Saved.')).toBeVisible();
  await settings.getByTestId('partners-terms-text').fill('Paid on the 1st of each month.');
  await expect(settings.getByTestId('partners-terms-state')).toHaveText('Not saved yet.');
  await settings.getByTestId('partners-terms-save').click();
  await expect(settings.getByTestId('partners-terms-state')).toHaveText('Version 1');
  await page.reload();
  await expect(page.getByTestId('partners-rate')).toHaveValue('12');

  // On Pia's page: make her a partner.
  await page.goto(`/app/w/${workspaceId}/customers/people/${pia}`);
  const piaCard = page.getByTestId('partner-card');
  await piaCard.getByTestId('partner-card-make').click();
  await expect(piaCard.getByTestId('partner-card-is')).toContainText(
    'They’re one of your partners.',
  );

  // On Cal's: Pia sent him.
  await page.goto(`/app/w/${workspaceId}/customers/people/${cal}`);
  const calCard = page.getByTestId('partner-card');
  await expect(calCard.getByTestId('partner-card-sent-by')).toHaveText('Nobody');
  await calCard.getByTestId('partner-card-change').click();
  await calCard.getByTestId('partner-card-pick').selectOption({ label: 'Pia Partner' });
  await expect(calCard.getByTestId('partner-card-sent-by')).toContainText('Pia Partner');
  await expect(calCard.getByTestId('partner-card-sent-by')).toContainText('Marked by hand');

  // Cal pays $1,000: Pia earns 12% of it, waiting its 30 days.
  const { invoiceId } = await api<{ invoiceId: string }>(token, 'commands', 'invoice.create', {
    workspaceId,
    personId: cal,
    title: 'Repipe',
    lines: [
      {
        productId: null,
        name: 'Repipe',
        description: null,
        quantity: 1,
        unitLabel: 'each',
        unitPriceCents: 100_000,
        taxable: false,
        discountCents: 0,
      },
    ],
  });
  await api(token, 'commands', 'invoice.send', { workspaceId, invoiceId, channels: [] });
  await api(token, 'commands', 'invoice.record_cash_payment', {
    workspaceId,
    invoiceId,
    amountCents: 100_000,
  });
  await expect(async () => {
    await page.goto(`/app/w/${workspaceId}/settings/partners`);
    await expect(page.getByTestId('partners-row')).toContainText('$120', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const row = page.getByTestId('partners-row');
  await expect(row).toContainText('Pia Partner');
  await expect(row).toContainText('12% · 1 client');
  await expect(row).toContainText('Hasn’t accepted your terms yet');

  // Her page: her link, what she earned and from whom, pausing and bringing her back, and sending her page.
  await row.click();
  const detail = page.getByTestId('partner-detail');
  await expect(detail.getByTestId('partner-link')).toContainText(`/book/c/${calendar.id}?ref=pa-`);
  await expect(detail.getByTestId('partner-terms')).toContainText(
    'Hasn’t accepted your latest terms yet',
  );
  const commission = detail.getByTestId('partner-commission');
  await expect(commission).toContainText('Cal Client');
  await expect(commission).toContainText('12% of $1,000 paid');
  await expect(commission).toContainText('Free to pay out');
  await expect(detail.getByTestId('partner-clients')).toContainText('Earning them a share until');
  await expect(detail.getByTestId('partner-payouts-of-partner')).toContainText(
    'Hasn’t set up payouts yet.',
  );
  await detail.getByTestId('partner-pause').click();
  await expect(detail.getByTestId('partner-status')).toHaveText('Paused');
  await expect(detail.getByTestId('partner-status-line')).toContainText('Pia Partner is paused.');
  await detail.getByTestId('partner-resume').click();
  await expect(detail.getByTestId('partner-status')).toHaveText('Active');
  const sent = Date.now();
  await detail.getByTestId('partner-send-page').click();
  await expect(page.getByText(`Sent to ${partnerEmail}.`)).toBeVisible();
  await waitForMail(partnerEmail, `Your partner page with ${business}`, { after: sent });

  // Deleting her for good says her partner record goes with her.
  await page.goto(`/app/w/${workspaceId}/customers/people/${pia}`);
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-delete').click();
  await expect(page.getByTestId('delete-dialog')).toContainText(
    'They’re one of your partners. Their partner record goes too',
  );
});
