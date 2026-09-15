import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import { conversationFor, draftIn, needsPerson, sentIn, teammateBusiness } from './ai-team';
import {
  businessWithChat,
  CHAT_SITE,
  chatConversations,
  chatFrame,
  sitePage,
  tabToLauncher,
} from './chat-helpers';
import { textFromCustomer } from './telephony';

const MIKE = '+17135550142';
const TOM = '+17135550155';

interface Progress {
  progress: { approvedCount: number; editedCount: number; rejectedCount: number };
}

/**
 * The AI teammate's drafts inline in the inbox: one approved as it is, one edited first, one rejected with a
 * reason and then taken over with "I'll reply". Each arrives live in the open conversation; the list marks the
 * conversation "Ava · draft waiting"; training progress counts the approvals (the edited one too) and the
 * rejection. Quiet hours are off, so it passes at any hour.
 */
test('AI teammate in the inbox: approve, edit and reject its drafts', async ({ page }) => {
  test.setTimeout(240_000);
  const b = await teammateBusiness(page, 'ai-inbox');

  // Mike texts; Ava's reply waits for an OK, inline in the thread.
  await textFromCustomer({ from: MIKE, to: b.business, body: 'Hi, do you service Katy?' });
  const conversationId = await conversationFor(b, MIKE);
  const first = await draftIn(b, conversationId);
  const firstText = first.preview.message!.body;
  await page.goto(`/app/w/${b.workspaceId}/inbox/${conversationId}`);
  const card = page.getByTestId('draft-card');
  await expect(card.getByTestId('draft-text')).toHaveText(firstText);
  await expect(card.getByTestId('draft-expires')).toContainText('Expires');
  await expect(card.getByTestId('draft-progress')).toHaveText('0 of 20 approved');
  await expect(page.getByTestId(`conversation-row-${conversationId}`)).toContainText(
    'Ava · draft waiting',
  );

  // Approve: it goes out a moment later, as the teammate.
  await card.getByTestId('draft-approve').click();
  await expect(page.getByText('Approved. Ava texts them now. 1 of 20 approved.')).toBeVisible();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
  const log = page.getByTestId('message-log');
  await expect(log.locator('[data-direction="outbound"]').last()).toContainText(firstText, {
    timeout: 30_000,
  });

  // Edit: the person's version is what goes out, and it still counts toward training.
  await textFromCustomer({ from: MIKE, to: b.business, body: 'What are your hours?' });
  await draftIn(b, conversationId);
  await expect(page.getByTestId('draft-card')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('draft-edit').click();
  await page.getByTestId('draft-input').fill('We are open 8 to 5, Monday to Friday. Dale here.');
  await page.getByTestId('draft-send-edit').click();
  await expect(
    page.getByText('Sent with your edit. Ava texts them now. 2 of 20 approved.'),
  ).toBeVisible();
  await expect(log.locator('[data-direction="outbound"]').last()).toContainText(
    'We are open 8 to 5',
    { timeout: 30_000 },
  );

  // Reject with a reason: nothing goes out, then "I'll reply" takes the conversation over.
  await textFromCustomer({ from: MIKE, to: b.business, body: 'Do you do ductwork?' });
  await draftIn(b, conversationId);
  await expect(page.getByTestId('draft-card')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('draft-reject').click();
  await page.getByTestId('draft-reject-reason').fill('Ask which system first. I will call him.');
  await page.getByTestId('draft-reject-confirm').click();
  await expect(page.getByText('Rejected. Nothing went to them.')).toBeVisible();
  const next = page.getByTestId('draft-rejected');
  await expect(next).toContainText('You rejected Ava’s draft. Nothing went to them. What next?');
  await next.getByTestId('draft-ill-reply').click();
  await expect(page.getByText('It’s yours. Ava stays quiet until you hand it back.')).toBeVisible();
  await expect(page.getByTestId('draft-rejected')).toHaveCount(0);

  const got = await api<Progress>(b.token, 'queries', 'ai_teammate.get', {
    workspaceId: b.workspaceId,
  });
  expect(got.progress).toMatchObject({ approvedCount: 2, editedCount: 1, rejectedCount: 1 });
});

/**
 * Who handles a conversation, and the teammate's labels: "Ava (AI) is handling this" with Take over and the
 * composer's warning; "Ava (AI) · approved by …" under an approved reply; "You took over" with Hand back (it
 * asks first); a rejected draft's Try again, which has Ava write a new one; asking for a person lands the
 * conversation in "Needs a person" with Ava's reason, the hand-off line to the customer ("Ava (AI) · hand-off
 * message"), a Home card and the box; Take it clears it.
 */
test('AI teammate in the inbox: take over, hand back and needs a person', async ({ page }) => {
  test.setTimeout(240_000);
  const b = await teammateBusiness(page, 'ai-handling');
  const me = await api<{ user: { fullName: string } }>(b.token, 'queries', 'account.me', {});
  const myFirst = me.user.fullName.split(/\s+/)[0];

  await textFromCustomer({ from: TOM, to: b.business, body: 'Hi, do you service Katy?' });
  const conversationId = await conversationFor(b, TOM);
  await draftIn(b, conversationId);
  await page.goto(`/app/w/${b.workspaceId}/inbox/${conversationId}`);
  await expect(page.getByTestId('handling-ai')).toContainText(
    'Ava (AI) is handling this. Each reply waits for an OK.',
  );
  await expect(page.getByTestId('composer-handover')).toContainText(
    'Sending takes this conversation over from Ava.',
  );
  await expect(page.getByTestId('box-ai-count')).toHaveText('1');

  // Approved, it's labelled as the teammate's with the approver's name.
  await page.getByTestId('draft-approve').click();
  await expect(page.getByTestId('ai-label').last()).toHaveText(
    `Ava (AI) · approved by ${myFirst}`,
    { timeout: 30_000 },
  );

  // Take over: Ava stays quiet; Hand back asks first, then Ava has it again.
  await page.getByTestId('take-over').click();
  await expect(page.getByTestId('handling-person')).toContainText('You took over');
  await expect(page.getByTestId('composer-handover')).toHaveCount(0);
  await page.getByTestId('hand-back').click();
  await expect(page.getByRole('dialog')).toContainText('Hand them back to Ava?');
  await page.getByTestId('hand-back-confirm').click();
  await expect(page.getByTestId('handling-ai')).toBeVisible();

  // Reject with a reason, then Try again: Ava writes a new draft for the same message.
  await textFromCustomer({ from: TOM, to: b.business, body: 'Do you do ductwork?' });
  await draftIn(b, conversationId);
  const card = page.getByTestId('draft-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  const rejectedId = await card.getAttribute('data-draft-id');
  await card.getByTestId('draft-reject').click();
  await page.getByTestId('draft-reject-reason').fill('Mention the free estimate.');
  await page.getByTestId('draft-reject-confirm').click();
  const rejected = page.getByTestId('draft-rejected');
  await expect(rejected).toContainText('Try again asks Ava for a new draft, with your reason.');
  await rejected.getByTestId('draft-try-again').click();
  await expect(page.getByTestId('draft-retrying')).toContainText('Ava is writing a new draft…');
  const retried = await draftIn(b, conversationId);
  expect(retried.id).not.toBe(rejectedId);
  await expect(page.getByTestId('draft-card')).toHaveAttribute('data-draft-id', retried.id, {
    timeout: 20_000,
  });

  // Asking for a person hands it over: the reason, the hand-off line, the box and Home's card.
  await textFromCustomer({ from: TOM, to: b.business, body: 'I want to talk to a real person' });
  await needsPerson(b, 1);
  await expect(page.getByTestId('handling-needs-person')).toContainText('Needs a person.', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('handoff-why')).toHaveText('Why: they asked for a person.');
  await sentIn(b, conversationId, /passed this to our team/);
  await expect(page.getByTestId('box-needs_person-count')).toHaveText('1');
  await page.getByTestId('box-needs_person').click();
  await expect(page).toHaveURL(/box=needs_person/);
  await expect(page.getByTestId(`conversation-row-${conversationId}`)).toContainText(
    'Needs a person',
  );

  await page.goto(`/app/w/${b.workspaceId}`);
  const home = page.getByTestId('home-needs-person');
  await expect(home).toContainText('Needs a person');
  await expect(home.getByTestId('home-needs-person-row')).toHaveCount(1);
  await home.getByTestId('home-take-it').click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${conversationId}`));
  await expect(page.getByTestId('handling-person')).toContainText('You took over');
  await expect(page.getByTestId('box-needs_person-count')).toHaveCount(0);
});

/**
 * A website chat in the inbox: a visitor writes from the business's site and gives their name in the chat's
 * details form. The thread shows "Website chat" with the page they're on and "On the site now", "Said their name
 * is …", and the chat composer (no Text or Email switch), whose reply shows in the chat window live and reads
 * "Seen" once the visitor's window has it.
 */
test('a website chat in the inbox: the page, their name, and a reply from the chat composer', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const biz = await businessWithChat(page, 'chat-inbox');
  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const site = await context.newPage();
  await site.goto(sitePage(CHAT_SITE, biz.key));
  await tabToLauncher(site);
  await site.keyboard.press('Enter');
  await expect(site.locator('hfos-chat[open]')).toHaveCount(1);
  const chat = await chatFrame(site);
  // The window is ready to send once its chat has started and the composer has focus.
  await expect(chat.getByTestId('chat-window')).toHaveAttribute('data-phase', 'ready');
  await expect(chat.getByTestId('chat-input')).toBeFocused();
  await site.keyboard.type('Hi, do you service AC units?');
  await site.keyboard.press('Enter');
  await expect(chat.getByTestId('chat-message-visitor')).toContainText(
    'Hi, do you service AC units?',
  );
  // With only people answering, the details form follows the first message: a name, and nothing else.
  await chat.getByTestId('chat-details-name').fill('Linda Park');
  await chat.getByTestId('chat-details-submit').click();
  await expect(chat.getByTestId('chat-details-done')).toContainText('Linda Park');

  await expect
    .poll(async () => (await chatConversations(biz.token, biz.workspaceId)).length, {
      timeout: 20_000,
    })
    .toBe(1);
  const [conversation] = await chatConversations(biz.token, biz.workspaceId);
  await page.goto(`/app/w/${biz.workspaceId}/inbox/${conversation!.id}`);
  await expect(page.getByTestId('thread-name')).toHaveText('Linda Park');
  const channel = page.getByTestId('thread-channel');
  await expect(channel).toContainText('Website chat · on ');
  await expect(channel).toContainText('/services/ac-tune-up');
  await expect(page.getByTestId('on-site-now')).toBeVisible();
  await expect(
    page.getByTestId(`conversation-row-${conversation!.id}`).getByTestId('row-on-site-now'),
  ).toBeVisible();
  await expect(page.getByTestId('chat-visitor')).toContainText('Said their name is Linda Park.');
  await expect(page.getByTestId('composer-mode-chat')).toBeVisible();
  await expect(page.getByTestId('composer-mode-text')).toHaveCount(0);

  // The composer replies in the chat: the visitor sees it live, and it reads "Seen" live once they have.
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Hi Linda, Dale here. Yes, we do.');
  await page.getByTestId('composer-send').click();
  await expect(chat.getByTestId('chat-message-person')).toContainText('Dale here');
  await expect(
    page.getByTestId('message-log').locator('[data-direction="outbound"]').last(),
  ).toContainText('Seen', { timeout: 45_000 });
  await context.close();
});
