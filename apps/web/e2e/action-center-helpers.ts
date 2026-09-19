/**
 * Setup for the Action Center specs: a new business (quiet hours set off explicitly, so the specs pass at any
 * hour), people and leads through the API, and waiting for the worker to open their items (its detection runs on
 * each lead's events).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { api, leadIntakeOff, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

type Json = Record<string, unknown>;

export const BUSINESS = 'Lone Star HVAC & Roofing';

/** Open every hour of every day. */
export const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  start: '00:00',
  end: '24:00',
}));

export interface AcOwner {
  readonly token: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly email: string;
}

/** One item as `attention.list` returns it (the fields these specs read). */
export interface AcItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly urgent: boolean;
  readonly state: string;
  readonly valueCents: number;
  readonly subject: { readonly type: string; readonly id: string };
  readonly leadId: string | null;
  readonly conversationId: string | null;
  readonly assignee: { readonly id: string; readonly fullName: string } | null;
}

/**
 * A new business with its owner signed in on the page, and the owner's API token. Open every hour of every day
 * (an unanswered lead's 15 minutes count open hours only, so the default weekdays 8 to 5 would flip results at
 * night and at weekends), and quiet hours off.
 */
export async function actionCenterOwner(page: Page, label: string): Promise<AcOwner> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  const { token, userId } = await signInOwner(email);
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: { openHours: ALL_WEEK },
  });
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  // These specs are about the cards a conversation opens, so the stranger who texts stays a stranger.
  await leadIntakeOff(token, workspaceId);
  return { token, userId, workspaceId, email };
}

/** A customer and a lead a person typed in: with no next action, it opens "No next action". */
export async function addLead(
  o: AcOwner,
  first: string,
  last: string,
  title: string,
  valueCents: number,
  extra: Json = {},
): Promise<{ personId: string; leadId: string }> {
  const { personId } = await api<{ personId: string }>(o.token, 'commands', 'person.create', {
    workspaceId: o.workspaceId,
    firstName: first,
    lastName: last,
  });
  const { leadId } = await api<{ leadId: string }>(o.token, 'commands', 'lead.create', {
    workspaceId: o.workspaceId,
    personId,
    title,
    valueCents,
    ...extra,
  });
  return { personId, leadId };
}

export async function attentionList(
  o: AcOwner,
  scope: 'mine' | 'everyone' = 'everyone',
): Promise<{ items: AcItem[]; affectedCents: number }> {
  return api(o.token, 'queries', 'attention.list', { workspaceId: o.workspaceId, scope });
}

/** Waits until the worker has opened an item whose title has each of these words, and returns the list. */
export async function itemsFor(
  o: AcOwner,
  titles: readonly string[],
  timeoutMs = 30_000,
): Promise<AcItem[]> {
  await expect
    .poll(
      async () => {
        const { items } = await attentionList(o);
        return titles.filter((t) => !items.some((i) => i.title.includes(t)));
      },
      { timeout: timeoutMs, message: 'the worker opens an item for each' },
    )
    .toEqual([]);
  return (await attentionList(o)).items;
}

/**
 * Reconciles the whole business now, or as of `at` (the worker's hourly sweep, on demand): the way a spec opens the
 * items that need time to pass, like an overdue task or a lead gone quiet.
 */
export async function sweep(
  workspaceId: string,
  at?: string,
): Promise<{ transitions: { type: string; kind: string; itemId: string }[] }> {
  const res = await fetch(`${WORKER}/test/attention/sweep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, ...(at ? { at } : {}) }),
  });
  if (!res.ok) throw new Error(`the sweep failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as { transitions: { type: string; kind: string; itemId: string }[] };
}

/** Runs the business's due jobs now; jobs named by dedupe key first, as of when they were due. */
export async function runDue(workspaceId: string, dedupeKeys: readonly string[] = []) {
  const res = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, dedupeKeys }),
  });
  if (!res.ok) throw new Error(`run-due failed (${res.status}): ${await res.text()}`);
}

/** A card on Home by the words on it. */
export const cardOf = (page: Page, text: string) =>
  page.getByTestId('attention-card').filter({ hasText: text });

/**
 * Home's card for `text`, once it's really there (or, with `gone`, once it has gone.)
 *
 * Home follows item changes live, but the item itself is opened and cleared by the worker, which in a full run
 * can be several seconds behind its events. So each try nudges the business through the sweep route — the hourly
 * sweep, on demand — and reads the page again, instead of waiting on the worker's own pace.
 */
export async function cardOnHome(
  page: Page,
  workspaceId: string,
  text: string,
  opts: { gone?: boolean; tries?: number } = {},
): Promise<Locator> {
  const card = cardOf(page, text);
  const tries = opts.tries ?? 8;
  for (let attempt = 1; attempt <= tries; attempt++) {
    await expect(page.getByTestId('action-center')).toBeVisible();
    try {
      if (opts.gone) await expect(card).toHaveCount(0, { timeout: 4_000 });
      else await expect(card.first()).toBeVisible({ timeout: 4_000 });
      return card;
    } catch {
      if (attempt === tries) break;
    }
    await sweep(workspaceId);
    await page.reload();
  }
  // Out of tries: let the assertion itself report what's on the page.
  if (opts.gone) await expect(card).toHaveCount(0);
  else await expect(card.first()).toBeVisible();
  return card;
}

/** The day before yesterday, as an ISO instant (an all-day task due then is overdue today anywhere). */
export const twoDaysAgo = () => new Date(Date.now() - 2 * 86_400_000).toISOString();

export const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
