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
