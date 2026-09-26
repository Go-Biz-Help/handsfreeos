import { expect, test } from '@playwright/test';
import { api, makeCalendar, ownerWithSite } from './booking-helpers';
import {
  BUSINESS,
  conversationFor,
  createTeammate,
  draftIn,
  quietHoursOff,
  sentIn,
} from './ai-team';
import { setUpTexting, textFromCustomer } from './telephony';

const MIKE = '+17135550142';
const DAY = 86_400_000;

/**
 * Booking through the teammate: a customer asks to book, the draft holds the booking (nothing is on the
 * calendar yet), approving books it and then sends the reply, and the appointment shows on the customer's page.
 * The calendar is open every day, all day, and quiet hours are off, so it passes at any hour.
 */
test('AI teammate booking: the draft holds the booking, and approving books it', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'ai-booking', BUSINESS);
  const calendar = await makeCalendar(owner, 'AC tune-up');
  const business = await setUpTexting(page, owner.workspaceId);
  await quietHoursOff(owner.token, owner.workspaceId);
  await createTeammate(owner.token, owner.workspaceId, {
    preset: 'appointment_coordinator',
    patch: { book: { enabled: true, calendarIds: [calendar.id] } },
  });
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName: 'Mike',
    lastName: 'Johnson',
    phone: '(713) 555-0142',
  });
  const visits = async () =>
    (
      await api<{ items: { id: string; title: string }[] }>(
        owner.token,
        'queries',
        'appointment.list',
        {
          workspaceId: owner.workspaceId,
          personId,
          from: new Date().toISOString(),
          to: new Date(Date.now() + 9 * DAY).toISOString(),
        },
      )
    ).items;

  // Mike asks to book: Ava finds a time and holds it in its draft.
  await textFromCustomer({ from: MIKE, to: business, body: 'Can you book me tomorrow?' });
  const conversationId = await conversationFor(owner, MIKE);
  const draft = await draftIn(owner, conversationId);
  expect(draft.preview.actions.map((a) => a.kind)).toEqual(['book']);
  expect(await visits()).toHaveLength(0);

  await page.goto(`/app/w/${owner.workspaceId}/inbox/${conversationId}`);
  const card = page.getByTestId('draft-card');
  await expect(card.getByTestId('draft-action')).toContainText(/^Will book /);
  // Texts go out with a straight apostrophe (the plain text encoding).
  await expect(card.getByTestId('draft-text')).toContainText(/You['’]re booked for/);

  // Approving books the time, then sends the reply.
  await card.getByTestId('draft-approve').click();
  await expect(
    page.getByText('Approved. Ava makes the change and texts Mike now. 1 of 20 approved.'),
  ).toBeVisible();
  await expect.poll(async () => (await visits()).length, { timeout: 30_000 }).toBe(1);
  await sentIn(owner, conversationId, /You['’]re booked for/);
  await expect(
    page.getByTestId('message-log').locator('[data-direction="outbound"]').last(),
  ).toContainText(/You['’]re booked for/, { timeout: 20_000 });

  await page.goto(`/app/w/${owner.workspaceId}/customers/people/${personId}`);
  await expect(page.getByTestId('upcoming-appointments')).toContainText('AC tune-up');
});

/**
 * Saying what a calendar is for, right in the Book module: the box opens in the row (empty the first time,
 * with what was said after that), saves to the calendar, and the page never leaves the teammate.
 */
test('AI teammate booking: say what a calendar is for in its row', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = await ownerWithSite(page, 'ai-calendar-for', BUSINESS);
  const calendar = await makeCalendar(owner, 'AC tune-up');
  await createTeammate(owner.token, owner.workspaceId, {
    preset: 'appointment_coordinator',
    patch: { book: { enabled: true, calendarIds: [calendar.id] } },
  });
  const description = async () =>
    (
      await api<{ calendar: { description: string | null } }>(
        owner.token,
        'queries',
        'calendar.get',
        { workspaceId: owner.workspaceId, calendarId: calendar.id },
      )
    ).calendar.description;
  const aiTeam = `/app/w/${owner.workspaceId}/ai-team`;

  await page.goto(aiTeam);
  await page.getByTestId('module-book').click();
  const row = page.getByTestId(`book-calendar-${calendar.id}`);
  const say = row.getByTestId(`book-calendar-say-for-${calendar.id}`);
  const text = row.getByTestId(`book-calendar-purpose-text-${calendar.id}`);
  const shown = row.getByTestId(`book-calendar-for-${calendar.id}`);

  await expect(say).toHaveText('Tell Ava what it’s for');
  await say.click();
  await expect(text).toHaveValue('');
  await expect(text).toBeFocused();
  await text.fill('Seasonal tune-ups at the customer’s home.');
  await row.getByTestId(`book-calendar-purpose-save-${calendar.id}`).click();
  await expect(shown).toHaveText('Seasonal tune-ups at the customer’s home.');
  await expect(text).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${aiTeam}$`));
  expect(await description()).toBe('Seasonal tune-ups at the customer’s home.');

  // Again: the box opens with what it says now, and Cancel leaves it as it was.
  await expect(say).toHaveText('Change what it’s for');
  await say.click();
  await expect(text).toHaveValue('Seasonal tune-ups at the customer’s home.');
  await text.fill('Something else');
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(shown).toHaveText('Seasonal tune-ups at the customer’s home.');

  // Emptied, it clears the description and asks again.
  await say.click();
  await text.fill('');
  await text.press('ControlOrMeta+Enter');
  await expect(shown).toHaveCount(0);
  await expect(say).toHaveText('Tell Ava what it’s for');
  expect(await description()).toBeNull();
});
