/**
 * Setup for the website chat specs. An owner signs up through the app ("Dale Ramsey", so his chat replies say "Dale
 * joined"), then the widget and the AI teammate are set up through API commands with his token. The widget shows on
 * the stand-in site at 127.0.0.1:4191 (e2e/fixtures/chat-site.mjs), which pastes the snippet it's given; the one at
 * 127.0.0.1:4192 isn't on the widget's list. Visitors use their own signed-out browser contexts.
 *
 * The teammate, "Ava", answers website chat on its own (automatic) from the worker's scripted model: a first reply
 * says it's an AI assistant (it discloses in its first message), and "Are you a real person?" gets the admission.
 */
import { expect, type Frame, type Page } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { confirmEmail, createBusiness, signUp, uniqueEmail } from './helpers';

export const APP = 'http://localhost:3000';
export const CHAT_SITE = 'http://127.0.0.1:4191';
export const OTHER_SITE = 'http://127.0.0.1:4192';
export const BUSINESS = 'Lone Star HVAC & Roofing';

/** The snippet exactly as Settings → Website chat shows it. */
export const snippetFor = (key: string) =>
  `<script async src="${APP}/embed/v1/${key}.js"></script>`;

/** A page of a stand-in site with the snippet pasted in. */
export const sitePage = (site: string, key: string, path = '/services/ac-tune-up', hash = '') =>
  `${site}${path}?snippet=${encodeURIComponent(snippetFor(key))}${hash}`;

export interface ChatBusiness {
  readonly token: string;
  readonly workspaceId: string;
  readonly widgetId: string;
  readonly key: string;
  readonly teammateId: string | null;
}

type Json = Record<string, unknown>;

/** Signs Dale up and creates the business; returns his token. */
export async function chatOwner(
  page: Page,
  label: string,
): Promise<{ token: string; workspaceId: string }> {
  const email = uniqueEmail(label);
  await signUp(page, { name: 'Dale Ramsey', email });
  await confirmEmail(page, email);
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  const { token } = await signInOwner(email);
  // Quiet hours set explicitly: they start at 01:00 UTC for Chicago businesses (chat has none; texts do).
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });
  // Open all week, all day: by default a business is open weekdays 8 to 5, and outside that a chat with nobody
  // answering shows the away form instead of the composer, so the specs would fail at night and on weekends.
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  return { token, workspaceId };
}

/**
 * "Ava": the Lead Responder preset on website chat only, working all hours, switched to automatic (through training,
 * as the database allows), and answering this widget.
 */
export async function automaticTeammate(
  token: string,
  workspaceId: string,
  widgetId: string,
): Promise<string> {
  const { teammateId } = await api<{ teammateId: string }>(
    token,
    'commands',
    'ai_teammate.create',
    {
      workspaceId,
      preset: 'lead_responder',
      name: 'Ava',
      disclosure: 'first_message',
    },
  );
  const got = await api<{ teammate: { revision: number; config: Record<string, Json> } }>(
    token,
    'queries',
    'ai_teammate.get',
    { workspaceId },
  );
  const config = got.teammate.config;
  await api(token, 'commands', 'ai_teammate.save_config', {
    workspaceId,
    teammateId,
    baseRevision: got.teammate.revision,
    config: {
      ...config,
      channels: { ...config.channels, sms: false, email: false, chat: true, widgetId },
      respond: {
        ...config.respond,
        newLeads: { ...(config.respond?.newLeads as Json), enabled: false },
      },
      followUp: { ...config.followUp, enabled: false },
      hours: { ...config.hours, mode: 'always' },
    },
  });
  await api(token, 'commands', 'ai_teammate.set_status', {
    workspaceId,
    teammateId,
    status: 'training',
  });
  await api(token, 'commands', 'ai_teammate.set_status', {
    workspaceId,
    teammateId,
    status: 'automatic',
  });
  await api(token, 'commands', 'chat_widget.update', { workspaceId, widgetId, teammateId });
  return teammateId;
}

/** A business with a website chat on 127.0.0.1:4191, and Ava answering it when `teammate` is on. */
export async function businessWithChat(
  page: Page,
  label: string,
  opts: { teammate?: boolean } = {},
): Promise<ChatBusiness> {
  const { token, workspaceId } = await chatOwner(page, label);
  const widget = await api<{ widgetId: string; publicKey: string }>(
    token,
    'commands',
    'chat_widget.create',
    {
      workspaceId,
      allowedOrigins: [CHAT_SITE],
    },
  );
  const teammateId = opts.teammate
    ? await automaticTeammate(token, workspaceId, widget.widgetId)
    : null;
  return { token, workspaceId, widgetId: widget.widgetId, key: widget.publicKey, teammateId };
}

/** Runs the business's due AI replies now (the worker's test route skips the 3-second debounce). */
export async function replyNow(workspaceId: string): Promise<void> {
  await fetch(`${WORKER}/test/ai-team/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  }).catch(() => undefined);
}

/** Waits for the AI teammate's reply number `n` (1-based) in the chat window, nudging the worker meanwhile. */
export async function teammateReply(frame: Frame, workspaceId: string, n = 1) {
  const replies = frame.getByTestId('chat-message-teammate');
  await expect
    .poll(
      async () => {
        await replyNow(workspaceId);
        return replies.count();
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBeGreaterThanOrEqual(n);
  return replies.nth(n - 1);
}

/** The chat window's frame, once the loader has created it (it's inside a closed shadow root). */
export async function chatFrame(page: Page): Promise<Frame> {
  const find = () => page.frames().find((f) => /\/chat\/wk_/.test(f.url()));
  await expect.poll(() => !!find(), { timeout: 20_000 }).toBe(true);
  return find()!;
}

/** Tabs through the page until the chat button has focus (its host element, from outside the shadow root). */
export async function tabToLauncher(page: Page): Promise<void> {
  await expect(page.locator('hfos-chat')).toHaveCount(1);
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.tagName === 'HFOS-CHAT')) return;
  }
  throw new Error('the chat button never took focus');
}

/** Everything the chat window posts to the page around it, recorded from the page's side. */
export async function recordWindowMessages(page: Page): Promise<void> {
  await page.addInitScript((app) => {
    const w = window as unknown as { __hfosMessages: unknown[] };
    w.__hfosMessages = [];
    window.addEventListener('message', (e) => {
      if (e.origin === app) w.__hfosMessages.push(e.data);
    });
  }, APP);
}

export const windowMessages = (page: Page) =>
  page.evaluate(() => (window as unknown as { __hfosMessages: unknown[] }).__hfosMessages);

/** The business's website chats in the inbox. */
export async function chatConversations(token: string, workspaceId: string) {
  const { items } = await api<{ items: { id: string; lastPreview: string | null }[] }>(
    token,
    'queries',
    'inbox.list',
    { workspaceId, channel: 'chat' },
  );
  return items;
}
