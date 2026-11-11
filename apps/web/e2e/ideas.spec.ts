import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/** The answer to the next run of one command, so a step can wait for its save and not only for the screen. */
const saved = (page: Page, command: string) =>
  page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/v1/commands/${command}`),
  );

/**
 * Ideas, the roadmap and What's new (0102), as a business owner finds them: a place in the side menu, an idea
 * shared with their vote already on it, the board offering the existing idea instead of a second copy, a vote
 * taken back and given again, a comment, and the emails turned off. Who may do what is proven on the database
 * (packages/db/test/ideas-rls.test.ts) and the team's side through the commands (packages/core/test/ideas.test.ts).
 */
test('shares an idea, is offered it again instead of a copy, votes, comments and stops the emails', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'ideas');
  const workspaceId = await createBusiness(page, { name: 'Ideas Plumbing' });
  // A word no other run's idea has, nor anything like it: search matches titles that look alike too.
  const word = Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');
  const title = `Route the day by drive time ${word}`;

  // Ideas sits at the foot of the menu, above Get help.
  await page
    .getByRole('navigation', { name: 'HandsFreeOS' })
    .getByRole('link', { name: /^Ideas/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/ideas$`));
  await expect(page.getByRole('heading', { name: 'Ideas' })).toBeVisible();

  // Sharing: the idea opens with its author's vote on it.
  await page.getByTestId('share-idea').first().click();
  await page.getByTestId('idea-title').fill(title);
  await page
    .getByTestId('idea-body')
    .fill('Put the visits in the order that wastes the least driving.');
  await page.getByTestId('idea-area').selectOption('calendar');
  await page.getByTestId('idea-submit').click();
  await expect(page).toHaveURL(/\/ideas\/[0-9a-f-]{36}$/);
  const ideaUrl = page.url();
  await expect(page.getByTestId('idea-title-shown')).toHaveText(title);
  await expect(page.getByTestId('idea-status').first()).toHaveText('Under review');
  await expect(page.getByTestId('idea-vote-count')).toHaveText('1');

  // Taking the vote back, and giving it again. Each save is waited for on purpose: the count changes on the
  // press, and the button ignores a second press while the first is still on its way.
  const unvoted = saved(page, 'idea.unvote');
  await page.getByTestId('idea-vote').click();
  await expect(page.getByTestId('idea-vote-count')).toHaveText('0');
  expect((await unvoted).ok()).toBe(true);
  const voted = saved(page, 'idea.vote');
  await page.getByTestId('idea-vote').click();
  await expect(page.getByTestId('idea-vote-count')).toHaveText('1');
  expect((await voted).ok()).toBe(true);

  // A comment, and the emails turned off.
  await page.getByTestId('idea-comment-body').fill('We would use this every single morning.');
  await page.getByTestId('idea-comment-send').click();
  await expect(page.getByTestId('idea-comments')).toContainText(
    'We would use this every single morning.',
  );
  await expect(page.getByTestId('idea-follow')).toHaveAttribute('aria-checked', 'true');
  // Waited for on purpose: the switch moves on the press, and a reload before the save lands would lose it.
  const unfollowed = saved(page, 'idea.follow');
  await page.getByTestId('idea-follow').click();
  await expect(page.getByTestId('idea-follow')).toHaveAttribute('aria-checked', 'false');
  expect((await unfollowed).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('idea-follow')).toHaveAttribute('aria-checked', 'false');

  // Starting to share the same thing again offers the idea that exists.
  await page.goto(`/app/w/${workspaceId}/ideas`);
  await page.getByTestId('share-idea').first().click();
  await page.getByTestId('idea-title').fill(`Drive time ${word} routing`);
  await expect(page.getByTestId('idea-similar')).toContainText(title);
  await page.keyboard.press('Escape');

  // The board finds it by a word in it, marked as theirs and voted for.
  await page.getByTestId('ideas-search').fill(word);
  await page.getByTestId('ideas-search').press('Enter');
  await expect(page).toHaveURL(new RegExp(`q=${word}`));
  const row = page.getByTestId('idea-row').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('idea-vote')).toHaveAttribute('aria-pressed', 'true');

  // The roadmap and What's new are one press away.
  await page.getByTestId('ideas-tab-roadmap').click();
  await expect(page.getByTestId('roadmap-planned')).toBeVisible();
  await page.getByTestId('ideas-tab-whats-new').click();
  await expect(page).toHaveURL(/\/ideas\/whats-new$/);

  // An email's link opens the idea in the business they were last in.
  await page.goto(ideaUrl.replace(`/app/w/${workspaceId}/ideas/`, '/app/ideas/'));
  await expect(page).toHaveURL(ideaUrl);
});
