import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
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
 * - Facebook's download file, read in the browser, says since when they've been friends, when a request was sent,
 *   and the latest message with each person.
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
  await expect(card.getByTestId('addon-testing')).toBeVisible();
  await page.getByTestId('addon-install-outreach').click();
  await expect(card.getByTestId('addon-state')).toHaveText('On', { timeout: 90_000 });
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
  await page.getByTestId('outreach-tab-playbooks').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=playbooks$`));
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
  await builder.getByTestId('playbook-save').click();
  await expect(page.getByText('Office orders is ready.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=playbooks$`));
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
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=playbooks$`));

  // A template's conversation comes with it, and answers lead further down.
  await page.getByTestId('playbook-new').click();
  await page.getByTestId('template-crm_demos').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach/playbooks/new\\?template=crm_demos$`));
  for (let i = 0; i < 7; i++) await builder.getByTestId('playbook-next').click();
  await expect(builder.getByTestId('question-1-text')).toHaveValue('Do you use a CRM?');
  await expect(builder.getByLabel('After answer 2 to question 1')).toHaveValue('q4');
  await builder.getByTestId('playbook-next').click();
  await builder.getByTestId('playbook-next').click();
  await expect(builder.getByTestId('playbook-name')).toHaveValue('CRM demos');
  await expect(script).toContainText(
    '“No”, then ask question 4: “How do you keep track of follow-ups now?”',
  );
});

test('the activity tab counts what the extension noted, by group and person, over a stretch of days', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'outreach-activity');
  const workspaceId = await createBusiness(page, { name: 'Maple Lane Plumbing' });
  await turnOnOutreach(page, email, workspaceId);

  await page.goto(`/app/w/${workspaceId}/a/outreach`);
  await expect(page.getByTestId('activity-empty')).toContainText(
    'Nothing noted in the last 7 days',
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

  // The owner's day against the limits, whatever the stretch.
  await expect(page.getByTestId('activity-today-friend_request')).toContainText('1 of 20');
  await expect(page.getByTestId('activity-today-first_message')).toContainText('1 of 15');

  // Another stretch, and everyone's steps for the owner, each in the address.
  await page.getByTestId('activity-period-today').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?period=today$`));
  await expect(numbers.getByTestId('activity-number-people')).toContainText('3');
  await page.getByTestId('activity-who-everyone').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?period=today&who=everyone$`));
  await expect(page.getByTestId('activity-who-everyone')).toHaveAttribute('aria-selected', 'true');
  await expect(people).toHaveCount(3);
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
  await page.getByTestId('outreach-tab-friends').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=friends$`));
  const people = page.getByTestId('friend');
  await expect(people).toHaveText([/Parker Reed/, /Quinn Harper/, /Sky Patel/]);
  await expect(page.getByTestId('friends-show-friends')).toContainText('3');
  await expect(page.getByTestId('friends-show-requests')).toContainText('1');
  await expect(page.getByTestId('friends-cap')).toContainText('3 of 5,000');

  // Found by part of a name as it's typed, with no Enter, in the address; an empty box shows everyone again.
  await page.getByTestId('friends-search').pressSequentially('sky', { delay: 50 });
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=friends&q=sky$`));
  await expect(people).toHaveText([/Sky Patel/]);
  await expect(page.getByTestId('friends-search')).toHaveValue('sky');
  await page.getByTestId('friends-search').fill('');
  await expect(people).toHaveCount(3);

  // Keep: never suggested for unfriending.
  await people.filter({ hasText: 'Sky Patel' }).getByTestId('friend-keep').click();
  await expect(page.getByText('You’ll keep Sky Patel.')).toBeVisible();
  await expect(page.getByTestId('friends-show-keep')).toContainText('1');
  await expect(people.filter({ hasText: 'Sky Patel' }).getByTestId('friend-keep')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // The request still waiting, by fit: mutual friends alone until a playbook says what to look for.
  await page.getByTestId('friends-show-requests').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=friends&show=requests$`));
  await expect(people).toHaveText([/Avery Lane/]);
  await expect(people.getByTestId('friend-fit')).toHaveText('Might fit');
  await expect(people.getByTestId('friend-fit-reasons')).toHaveText('12 mutual friends');

  // Don't pitch: the business's list says who added them, and a step to them isn't counted as outreach.
  await people.getByTestId('friend-dont-pitch').click();
  await expect(page.getByText('Avery Lane is on the Don’t pitch list.')).toBeVisible();
  await page.getByTestId('friends-show-dont_pitch').click();
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
  await page.getByTestId('friends-show-friends').click();
  await expect(page.getByTestId('friends-show-friends')).toContainText('101');
  await expect(people).toHaveCount(100);
  await expect(page.getByTestId('friends-range')).toContainText('1–100 of 101');
  await expect(page.getByTestId('friends-page')).toHaveText('Page 1 of 2');
  await expect(page.getByTestId('friends-page-previous')).toBeDisabled();
  await page.getByTestId('friends-page-next').click();
  await expect(page).toHaveURL(new RegExp(`/a/outreach\\?view=friends&page=2$`));
  await expect(people).toHaveText([/Zoe Friend 98/]);
  await expect(page.getByTestId('friends-page')).toHaveText('Page 2 of 2');
  await expect(page.getByTestId('friends-page-next')).toBeDisabled();
  // A search starts again at its first page: Zoe Friend 9, and 90 to 98.
  await page.getByTestId('friends-search').fill('zoe friend 9');
  await expect(page).toHaveURL(
    new RegExp(`/a/outreach\\?view=friends&q=zoe(\\+|%20)friend(\\+|%20)9$`),
  );
  await expect(people).toHaveCount(10);
  await expect(page.getByTestId('friends-pages')).toHaveCount(0);
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

  await page.goto(`/app/w/${workspaceId}/a/outreach?view=friends`);
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

  const people = page.getByTestId('friend');
  await expect(people.filter({ hasText: 'Sky Patel' }).getByTestId('friend-since')).toHaveText(
    `Friends since May 2016 · Last message ${day(noon(20))}, from them`,
  );
  await expect(people.filter({ hasText: 'Parker Reed' }).getByTestId('friend-since')).toHaveText(
    `Friends since Jul 2019 · Last message ${day(noon(20))}, from you`,
  );
  // The request's real day, for cancelling the ones nobody answers.
  await page.getByTestId('friends-show-sent').click();
  await expect(people).toHaveText([/Quinn Harper/]);
  await expect(people.getByTestId('friend-since')).toHaveText(`Sent · ${day(sentAt)}`);
});
