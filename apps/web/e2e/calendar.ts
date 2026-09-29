import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { confirmEmail, linkFrom, signUp, uniqueEmail, waitForMail } from './helpers';

/** Every business these specs create keeps onboarding's default zone. */
export const CHICAGO = 'America/Chicago';

/** The local date ('YYYY-MM-DD') of an instant in Chicago. */
export function chicagoDate(at: number | Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** A weekday (Monday to Friday) at least this many days ahead, as a Chicago date. */
export function weekdayAhead(days: number): string {
  for (let t = Date.now() + days * 86_400_000; ; t += 86_400_000) {
    const date = chicagoDate(t);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) return date;
  }
}

/** Invites a teammate as a member; they sign up and accept in a second browser, which stays open. */
export async function addTeammate(
  page: Page,
  browser: Browser,
  workspaceId: string,
  business: string,
  name = 'Priya Natarajan',
): Promise<{ email: string; name: string; context: BrowserContext; page: Page }> {
  const email = uniqueEmail('teammate');
  await page.goto(`/app/w/${workspaceId}/members?invite=1`);
  await page.getByTestId('invite-email').fill(email);
  await page.getByTestId('invite-role-member').click();
  const started = Date.now();
  await page.getByTestId('invite-send').click();
  await expect(page.getByTestId('invite-sent')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  const mail = await waitForMail(email, `invited you to ${business}`, { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const other = await context.newPage();
  await signUp(other, { name, email });
  await confirmEmail(other, email);
  await other.goto(link);
  await other.getByTestId('accept-invite').click();
  await expect(other).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  return { email, name, context, page: other };
}

/** Creates a calendar from a preset in Settings, turns it on, and returns its id. */
export async function createCalendar(
  page: Page,
  workspaceId: string,
  opts: { name: string; preset?: string; turnOn?: boolean },
): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/settings/calendars/new`);
  await page.getByTestId(`preset-${opts.preset ?? 'personal'}`).click();
  await page.getByLabel('Name', { exact: true }).fill(opts.name);
  await page.getByTestId('calendar-create').click();
  await expect(page).toHaveURL(/\/settings\/calendars\/[0-9a-f-]{36}$/);
  const id = /calendars\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  if (opts.turnOn ?? true) {
    await page.getByTestId('calendar-turn-on').click();
    await expect(page.getByTestId('calendar-status')).toHaveText('Active');
  }
  return id;
}

/** Adds a person from Contacts and returns their id. */
export async function addPerson(
  page: Page,
  workspaceId: string,
  first: string,
  last: string,
  phone?: string,
): Promise<string> {
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Last name').fill(last);
  if (phone) await page.getByLabel('Phone').fill(phone);
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}/);
  return /people\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

/** The id behind a grid block's `appt-<id>` test id. */
export async function apptIdOf(block: ReturnType<Page['locator']>): Promise<string> {
  return (await block.getAttribute('data-testid'))!.replace(/^appt-/, '');
}
