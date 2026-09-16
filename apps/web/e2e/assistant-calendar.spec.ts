import { expect, test, type Locator, type Page } from '@playwright/test';
import { consentToAssistant } from './booking-helpers';
import { createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const DAY = 86_400_000;

const panel = (page: Page): Locator => page.getByTestId('assistant-panel');

/** The newest answer, once it has finished streaming in. */
async function lastAnswer(page: Page): Promise<Locator> {
  const answer = panel(page).getByTestId('assistant-message').last();
  await expect(answer).toHaveAttribute('data-state', 'done');
  return answer;
}

/** Sends a question with Return and waits until its answer has finished streaming in. */
async function ask(page: Page, question: string): Promise<Locator> {
  const box = panel(page).getByRole('textbox', { name: 'Message the Assistant' });
  await box.fill(question);
  await box.press('Enter');
  await expect(panel(page).getByTestId('assistant-question').last()).toHaveText(question);
  return lastAnswer(page);
}

/** A bearer token from Supabase's password sign-in, with the publishable key the web app holds. */
async function signInForApi(email: string): Promise<{ token: string; userId: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error('The Supabase URL and publishable key come from .env.local (pnpm env:local).');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Signing in for the API failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; user: { id: string } };
  return { token: body.access_token, userId: body.user.id };
}

/** Runs a command or query through the API as that person, as the web app does. */
const apiAs =
  (token: string) =>
  async <T = Record<string, unknown>>(
    path: `${'commands' | 'queries'}/${string}`,
    body: Record<string, unknown>,
  ): Promise<T> => {
    const res = await fetch(`${API_URL}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

interface CalendarGet {
  calendar: {
    revision: number;
    config: { team: object; services: object; window: object } & Record<string, unknown>;
  };
}
interface AppointmentList {
  items: { source: string; attendees: { fullName: string }[]; staff: { fullName: string }[] }[];
}

/**
 * The Assistant on the calendar, against the scripted stand-in model. A calendar and hours are set up through
 * API commands (the staff calendar pages are built separately). On Mike's page, "When is Dale free
 * tomorrow?" shows the open times; tapping one asks to book it in plain words; the booking waits for
 * Confirm, nothing is on the calendar until then, and afterwards it is, marked "via Assistant" in the audit log.
 */
test('assistant calendar: open times, a tapped time, book on Confirm, audit', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'assistant-calendar');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await consentToAssistant(owner.email);
  const { token, userId } = await signInForApi(owner.email);
  const call = apiAs(token);

  // Dale works 8 to 5 every day, and the Tune-ups calendar books him for a 1-hour AC tune-up.
  await call('commands/user.update_profile', { fullName: 'Dale Johnson' });
  await call('commands/schedule.set', {
    workspaceId,
    weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '08:00', end: '17:00' })),
  });
  const { serviceId } = await call<{ serviceId: string }>('commands/service.create', {
    workspaceId,
    name: 'AC tune-up',
    durations: [60],
  });
  const { calendarId } = await call<{ calendarId: string }>('commands/calendar.create', {
    workspaceId,
    name: 'Tune-ups',
  });
  const { calendar } = await call<CalendarGet>('queries/calendar.get', {
    workspaceId,
    calendarId,
  });
  const { config } = calendar;
  await call('commands/calendar.save', {
    workspaceId,
    calendarId,
    baseRevision: calendar.revision,
    draft: {
      ...config,
      team: { ...config.team, members: [{ userId }], assignment: 'fixed' },
      services: { ...config.services, mode: 'one', items: [{ serviceId }] },
      window: { ...config.window, minNoticeMinutes: 0 },
    },
  });
  await call('commands/calendar.set_status', { workspaceId, calendarId, status: 'active' });
  const { personId } = await call<{ personId: string }>('commands/person.create', {
    workspaceId,
    firstName: 'Mike',
    lastName: 'Johnson',
    phone: '(713) 555-0142',
    email: 'mike.johnson@example.com',
  });
  const mikesAppointments = async () =>
    (
      await call<AppointmentList>('queries/appointment.list', {
        workspaceId,
        personId,
        from: new Date().toISOString(),
        to: new Date(Date.now() + 3 * DAY).toISOString(),
      })
    ).items;

  // On Mike's page: when is Dale free tomorrow? Eight times spread over his day, and a link to his week.
  await page.goto(`/app/w/${workspaceId}/customers/people/${personId}`);
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page).getByTestId('assistant-page')).toHaveText('On this page: Mike Johnson');
  let answer = await ask(page, 'When is Dale free tomorrow?');
  await expect(answer).toContainText(/Dale has \d+ open times for a 1 hour visit/);
  const slots = answer.getByTestId('assistant-card-slots');
  await expect(slots).toContainText('Dale Johnson · ');
  await expect(slots).toContainText('AC tune-up · 1 hour · Central Time');
  await expect(slots.getByRole('link', { name: 'Open Dale’s week' })).toHaveAttribute(
    'href',
    new RegExp(`/calendar\\?view=week&date=\\d{4}-\\d{2}-\\d{2}&people=${userId}$`),
  );
  const times = slots.getByRole('group').getByRole('button');
  await expect(times).toHaveCount(8);
  const time = (await times.first().textContent())!.trim();
  expect(time).toBe('8:00 AM');

  // Tapping a time asks in plain words, and the booking waits for Confirm.
  await times.first().click();
  await expect(panel(page).getByTestId('assistant-question').last()).toHaveText(
    `Book AC tune-up at ${time} tomorrow with Dale Johnson`,
  );
  answer = await lastAnswer(page);
  const card = answer.getByTestId('assistant-card-confirm');
  await expect(card).toContainText('Needs your OK');
  await expect(card).toContainText('Book this appointment?');
  await expect(card).toContainText('Mike Johnson · (713) 555-0142');
  await expect(card).toContainText('AC tune-up · 1 hour');
  await expect(card).toContainText('8:00–9:00 AM Central Time');
  await expect(card).toContainText('Dale Johnson');
  await expect(card).toContainText('By email, since texting isn’t set up yet');
  await expect(card.getByTestId('assistant-confirm')).toHaveText('Book');
  expect(await mikesAppointments()).toHaveLength(0);

  // Confirm books it: on the calendar for Mike with Dale, made through the Assistant.
  await card.getByTestId('assistant-confirm').click();
  const result = card.getByTestId('assistant-result');
  await expect(result).toContainText(/^Booked for .+ at 8:00 AM\./);
  await expect(result.getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    new RegExp(`^/app/w/${workspaceId}/calendar\\?date=\\d{4}-\\d{2}-\\d{2}&appt=[0-9a-f-]{36}$`),
  );
  expect(await mikesAppointments()).toEqual([
    expect.objectContaining({
      source: 'assistant',
      attendees: [expect.objectContaining({ fullName: 'Mike Johnson' })],
      staff: [expect.objectContaining({ fullName: 'Dale Johnson' })],
    }),
  ]);

  // The audit log says it was done through the Assistant.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await page.getByLabel('Filter by activity').selectOption('assistant');
  await expect(
    page
      .getByTestId('audit-log')
      .getByText(/(appointment|booked).* via Assistant$/i)
      .first(),
  ).toBeVisible();
});
