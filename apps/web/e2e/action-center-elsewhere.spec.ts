/**
 * The Action Center away from Home (M8, step 9): the lead page's banner with its Handle, Snooze and Undo, the
 * pipeline card's overdue dot, and the inbox header's waiting chip. The items are the worker's own, opened by its
 * detection, so these check what a person actually sees on those pages.
 */
import { expect, test, type Page } from '@playwright/test';
import { api, leadIntakeOff, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting, textFromCustomer } from './telephony';

interface Owner {
  readonly token: string;
  readonly userId: string;
  readonly workspaceId: string;
}

/** Open every hour of every day: a business is open weekdays 8 to 5 until it says otherwise. */
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

/** A new business, open all week with quiet hours off, so nothing here leans on the hour it runs at. */
async function newOwner(page: Page, label: string, replyMinutes?: number): Promise<Owner> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: 'Lone Star Elsewhere HVAC' });
  const { token, userId } = await signInOwner(email);
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: { openHours: ALL_WEEK },
  });
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
    ...(replyMinutes === undefined ? {} : { unansweredReminderMinutes: replyMinutes }),
  });
  // The chip these specs watch is about the conversation, so a texter stays a stranger (M14).
  await leadIntakeOff(token, workspaceId);
  return { token, userId, workspaceId };
}

/** Reconciles the business now, so an item is open without waiting for the next sweep. */
async function sweep(o: Owner): Promise<void> {
  const res = await fetch(`${WORKER}/test/attention/sweep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: o.workspaceId }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function addLead(
  o: Owner,
  firstName: string,
  lastName: string,
  title: string,
  valueCents: number,
): Promise<{ personId: string; leadId: string }> {
  const { personId } = await api<{ personId: string }>(o.token, 'commands', 'person.create', {
    workspaceId: o.workspaceId,
    firstName,
    lastName,
  });
  const { leadId } = await api<{ leadId: string }>(o.token, 'commands', 'lead.create', {
    workspaceId: o.workspaceId,
    personId,
    title,
    valueCents,
  });
  return { personId, leadId };
}

interface Item {
  readonly kind: string;
  readonly leadId: string | null;
  readonly conversationId: string | null;
}

async function openItems(o: Owner): Promise<Item[]> {
  const { items } = await api<{ items: Item[] }>(o.token, 'queries', 'attention.list', {
    workspaceId: o.workspaceId,
    scope: 'everyone',
  });
  return items;
}

test('the lead page banner handles, snoozes and comes back, and an overdue lead card shows its dot', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const o = await newOwner(page, 'ac-elsewhere');
  const tom = await addLead(o, 'Tom', 'Reyes', 'Rooftop unit replacement', 1_240_000);
  const maria = await addLead(o, 'Maria', 'Lopez', 'New AC install', 1_850_000);
  // Maria's next action was due two hours ago; Tom has none at all.
  await api(o.token, 'commands', 'lead.set_next_action', {
    workspaceId: o.workspaceId,
    leadId: maria.leadId,
    text: 'Call about the quote',
    dueAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  });
  await sweep(o);

  // The pipeline: the overdue dot on Maria's card, and none on Tom's (his next action isn't set at all).
  await page.goto(`/app/w/${o.workspaceId}/pipeline`);
  await expect(
    page.getByTestId(`lead-card-${maria.leadId}`).getByTestId('lead-overdue-dot'),
  ).toBeVisible();
  await expect(
    page.getByTestId(`lead-card-${tom.leadId}`).getByTestId('lead-overdue-dot'),
  ).toHaveCount(0);

  // The worker opens "No next action" for Tom.
  await expect
    .poll(
      async () =>
        (await openItems(o)).some(
          (i) => i.leadId === tom.leadId && i.kind === 'missing_next_action',
        ),
      { timeout: 30_000, message: 'the worker opens Tom’s item' },
    )
    .toBe(true);

  // His lead page: the banner names the kind, and Last contact says nothing has happened yet.
  await page.goto(`/app/w/${o.workspaceId}/leads/${tom.leadId}`);
  const banner = page.getByTestId('attention-banner');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toHaveAttribute('data-kind', 'missing_next_action');
  await expect(banner.getByTestId('attention-banner-title')).toContainText('No next action');
  await expect(page.getByTestId('lead-last-contact')).toHaveText('No contact yet');

  // Handle opens the lead page's own next-action dialog.
  await banner.getByTestId('attention-banner-handle').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Snooze it from the ⋯ menu, and take it back from the toast.
  await banner.getByTestId('attention-banner-more').click();
  await page.getByTestId('attention-snooze-hour').click();
  await expect(page.getByText('Snoozed for an hour.')).toBeVisible();
  await expect(page.getByTestId('attention-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('It’s back on Home.')).toBeVisible();
  await expect(page.getByTestId('attention-banner')).toBeVisible();
});

test('the inbox header shows a waiting chip while a customer waits for a reply', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A reply time of 0 minutes opens the item as soon as the text arrives.
  const o = await newOwner(page, 'ac-chip', 0);
  const number = await setUpTexting(page, o.workspaceId);
  const from = `+1713555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  await textFromCustomer({ from, to: number, body: 'Hi, I have a question about my bill.' });

  // The worker files the text and opens "Customer waiting" for the conversation.
  const conversationId = async () =>
    (await openItems(o)).find((i) => i.kind === 'customer_waiting')?.conversationId ?? null;
  await expect.poll(conversationId, { timeout: 60_000 }).not.toBeNull();

  await page.goto(`/app/w/${o.workspaceId}/inbox/${(await conversationId())!}`);
  // The header renders for wide screens and for phones; this run is wide, so take the first (the phone one is hidden).
  const chip = page.getByTestId('attention-chip').first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute('data-kind', 'customer_waiting');
  await expect(chip).toHaveAttribute('aria-label', /Customer waiting/);
  // Under a minute it reads "Just now", and it counts on from there.
  await expect(chip).toHaveText(/Just now|Waiting \d+ min/);
  // It opens Home, where the item can be handled.
  await expect(chip).toHaveAttribute('href', `/app/w/${o.workspaceId}`);

  // Answering the customer clears it, and the chip goes.
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Happy to help — I’ll check your bill now.');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('attention-chip')).toHaveCount(0, { timeout: 30_000 });
});
