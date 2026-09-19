/**
 * Setup for the AI teammate specs: a business with a texting number (the fake carrier), quiet hours off so the
 * specs pass at any hour, and "Ava" on training wheels answering texts all day from the scripted stand-in model.
 * A customer's text reaches the worker as Twilio's would; step 7's test route then runs the teammate's reply
 * at once instead of after its debounce wait.
 */
import type { Page } from '@playwright/test';
import { api, leadIntakeOff, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting } from './telephony';

type Json = Record<string, unknown>;

export const BUSINESS = 'Lone Star HVAC & Roofing';

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/** Objects merge key by key; arrays and plain values replace (like the teammate's settings patches). */
function merge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

/** A POST to the worker's test routes (registered only with the fake providers). */
export async function worker<T = Json>(path: string, body: Json): Promise<T> {
  const res = await fetch(`${WORKER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

/** Runs the business's teammate replies now, skipping their debounce wait. */
export const runDue = (workspaceId: string, all = false) =>
  worker('/test/ai-team/run-due', { workspaceId, all });

/** What the helpers need to act as the owner (booking-helpers' Owner fits too). */
export interface Owner {
  readonly workspaceId: string;
  readonly token: string;
}

export interface TeammateBusiness extends Owner {
  readonly userId: string;
  readonly email: string;
  /** The business's texting number, E.164. */
  readonly business: string;
  readonly teammateId: string;
}

export interface TeammateOptions {
  readonly preset?: 'lead_responder' | 'lead_qualifier' | 'appointment_coordinator' | 'blank';
  /** Changes to its settings (merged over the preset's) before it's turned on. */
  readonly patch?: Json;
  /** Where it ends up: training wheels unless said otherwise. */
  readonly status?: 'off' | 'training';
}

/**
 * Creates "Ava" through the API: texts only, working all day, no first messages to new leads or nudges (so
 * only the customers' texts start it), then turns it on with training wheels unless `status` says off.
 */
export async function createTeammate(
  token: string,
  workspaceId: string,
  opts: TeammateOptions = {},
): Promise<string> {
  const { teammateId } = await api<{ teammateId: string }>(
    token,
    'commands',
    'ai_teammate.create',
    {
      workspaceId,
      preset: opts.preset ?? 'lead_responder',
      name: 'Ava',
      disclosure: 'first_message',
    },
  );
  const got = await api<{ teammate: { config: Json; revision: number } }>(
    token,
    'queries',
    'ai_teammate.get',
    { workspaceId },
  );
  const config = merge(
    got.teammate.config,
    merge(
      {
        channels: { sms: true, email: false, chat: false },
        hours: { mode: 'always' },
        respond: { newLeads: { enabled: false } },
        followUp: { enabled: false },
      },
      opts.patch ?? {},
    ),
  );
  await api(token, 'commands', 'ai_teammate.save_config', {
    workspaceId,
    teammateId,
    baseRevision: got.teammate.revision,
    config,
  });
  if (opts.status !== 'off')
    await api(token, 'commands', 'ai_teammate.set_status', {
      workspaceId,
      teammateId,
      status: 'training',
    });
  return teammateId;
}

/** Quiet hours off, so a text can go out whatever the hour the spec runs at. */
export async function quietHoursOff(token: string, workspaceId: string): Promise<void> {
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
}

/** A new business with texting set up, quiet hours off, and Ava on training wheels. */
export async function teammateBusiness(
  page: Page,
  label: string,
  opts: TeammateOptions = {},
): Promise<TeammateBusiness> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  const { token, userId } = await signInOwner(email);
  const business = await setUpTexting(page, workspaceId);
  await quietHoursOff(token, workspaceId);
  // The teammate's own work is what these specs watch, so a texter stays a stranger (M14).
  await leadIntakeOff(token, workspaceId);
  const teammateId = await createTeammate(token, workspaceId, opts);
  return { workspaceId, token, userId, email, business, teammateId };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The conversation a customer's number texted into, once the worker has filed it. */
export async function conversationFor(
  owner: Owner,
  phone: string,
  timeoutMs = 20_000,
): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { items } = await api<{ items: { id: string; counterpart: string }[] }>(
      owner.token,
      'queries',
      'inbox.list',
      { workspaceId: owner.workspaceId, q: phone.replace(/^\+1/, ''), limit: 5 },
    );
    const found = items.find((c) => c.counterpart === phone);
    if (found) return found.id;
    if (Date.now() > until) throw new Error(`no conversation for ${phone}`);
    await pause(500);
  }
}

export interface DraftOut {
  readonly id: string;
  readonly kind: 'reply' | 'approval';
  readonly status: string;
  readonly conversationId: string | null;
  readonly preview: {
    readonly message: { readonly body: string; readonly subject: string | null } | null;
    readonly actions: readonly { readonly kind: string; readonly summary: string }[];
  };
}

/** Pending drafts, oldest first. */
export async function pendingDrafts(owner: Owner): Promise<DraftOut[]> {
  const { items } = await api<{ items: DraftOut[] }>(
    owner.token,
    'queries',
    'ai_teammate.draft_list',
    {
      workspaceId: owner.workspaceId,
      status: 'pending',
      limit: 100,
    },
  );
  return items;
}

/** Runs the teammate until it has a draft waiting in this conversation. */
export async function draftIn(
  owner: Owner,
  conversationId: string,
  timeoutMs = 45_000,
): Promise<DraftOut> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await runDue(owner.workspaceId);
    const found = (await pendingDrafts(owner)).find((d) => d.conversationId === conversationId);
    if (found) return found;
    if (Date.now() > until) throw new Error('the AI teammate wrote no draft');
    await pause(750);
  }
}

/** Runs the teammate until `count` drafts wait. */
export async function draftsWaiting(
  owner: Owner,
  count: number,
  timeoutMs = 60_000,
): Promise<DraftOut[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await runDue(owner.workspaceId);
    const all = await pendingDrafts(owner);
    if (all.length >= count) return all;
    if (Date.now() > until) throw new Error(`only ${all.length} of ${count} drafts arrived`);
    await pause(750);
  }
}

interface ThreadOut {
  readonly items: readonly {
    readonly direction: string;
    readonly body: string | null;
    readonly type: string;
  }[];
}

/** Runs the teammate until the conversation has a message the business sent with these words. */
export async function sentIn(
  owner: Owner,
  conversationId: string,
  words: RegExp,
  timeoutMs = 45_000,
): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await runDue(owner.workspaceId);
    const { items } = await api<ThreadOut>(owner.token, 'queries', 'conversation.thread', {
      workspaceId: owner.workspaceId,
      conversationId,
      limit: 10,
    });
    const found = items.find((i) => i.direction === 'outbound' && words.test(i.body ?? ''));
    if (found?.body) return found.body;
    if (Date.now() > until) throw new Error(`nothing matching ${words} was sent`);
    await pause(750);
  }
}

/** Runs the teammate until the business has this many conversations waiting for a person. */
export async function needsPerson(owner: Owner, count: number, timeoutMs = 45_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await runDue(owner.workspaceId);
    const s = await api<{ needsPerson: number }>(owner.token, 'queries', 'inbox.summary', {
      workspaceId: owner.workspaceId,
    });
    if (s.needsPerson >= count) return;
    if (Date.now() > until) throw new Error('nothing went to a person');
    await pause(750);
  }
}
