/**
 * Requests from the phone app (M10) and the browser extension (Social Outreach): reading what they say about a
 * request, and the moment rules a command from them must pass. The API reads the headers once per request;
 * `executeCommand` applies the rules to the command the request is for, never to a command run inside it (those
 * share its moment and were checked with it).
 */
import { HfosError } from '../errors';
import {
  APP_CLIENT,
  APP_HEADERS,
  CONFIRMED_MINUTES,
  EXTENSION_CLIENT,
  ONLINE_MINUTES,
  onServerClock,
  type AppClient,
} from '../mobile';
import type { CommandDef, RequestMeta } from './types';

/** Request headers as an HTTP server hands them over. */
export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/** What a request from the app or the extension adds to RequestMeta, its times already on the server's clock. */
export interface AppRequestDetails {
  readonly channel: AppClient;
  readonly commandId: string | null;
  readonly occurredAt: Date | null;
  readonly sentAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly appVersion: string | null;
}

const MIN = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function header(headers: HeaderBag, name: string): string | null {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : null;
}

/** Whether a request says it comes from the app (`x-hfos-client: mobile`). */
export function isAppRequest(headers: HeaderBag): boolean {
  return appClientOf(headers) === APP_CLIENT;
}

/** The app or the extension, when a request says it comes from one of them; null for the web and everything else. */
export function appClientOf(headers: HeaderBag): AppClient | null {
  const client = header(headers, APP_HEADERS.client)?.toLowerCase();
  return client === APP_CLIENT || client === EXTENSION_CLIENT ? client : null;
}

/** What to update when a client's build sends something HandsFreeOS can't use. */
const UPDATE: Record<AppClient, string> = { mobile: 'the app', extension: 'the extension' };

/**
 * The app's or the extension's details on a request, with the times it read off its device's clock moved onto the
 * server's (`occurredAt + (now − sentAt)`, never later than now); null for any other client. They always send them
 * well-formed, so one that isn't is refused rather than guessed at.
 */
export function readAppRequest(headers: HeaderBag, now: Date): AppRequestDetails | null {
  const client = appClientOf(headers);
  if (!client) return null;
  const problems: { path: string; message: string }[] = [];
  const time = (name: string): Date | null => {
    const raw = header(headers, name);
    if (raw === null) return null;
    const ms = Date.parse(raw);
    if (!ISO_TIME.test(raw) || Number.isNaN(ms)) {
      problems.push({ path: name, message: 'Send a time like 2026-09-21T14:03:11.402Z.' });
      return null;
    }
    return new Date(ms);
  };
  const commandId = header(headers, APP_HEADERS.commandId);
  if (commandId !== null && !UUID.test(commandId))
    problems.push({ path: APP_HEADERS.commandId, message: 'Send the command’s id as a UUID.' });
  const occurredAt = time(APP_HEADERS.occurredAt);
  const sentAt = time(APP_HEADERS.sentAt);
  const confirmedAt = time(APP_HEADERS.confirmedAt);
  if (problems.length)
    throw HfosError.validation(
      problems,
      `${client === APP_CLIENT ? 'The app' : 'The extension'} sent this change with details HandsFreeOS can’t use. Update ${UPDATE[client]}, then try it again.`,
    );
  return {
    channel: client,
    commandId: commandId?.toLowerCase() ?? null,
    occurredAt: occurredAt ? onServerClock(occurredAt, sentAt, now) : null,
    sentAt,
    confirmedAt: confirmedAt ? onServerClock(confirmedAt, sentAt, now) : null,
    appVersion: header(headers, APP_HEADERS.appVersion)?.slice(0, 40) ?? null,
  };
}

/** A wait in words: "12 minutes", "3 hours", "2 days". */
export function waitInWords(ms: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(ms / MIN));
  if (minutes < 90) return unit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 36 ? unit(hours, 'hour') : unit(Math.round(hours / 24), 'day');
}

/**
 * Every command from the app or the extension says which command it is and when it was done, or it is refused
 * (final), before its receipt is claimed: a fixed build can send it again under the same id.
 */
export function assertAppRequest(meta: RequestMeta): void {
  const client =
    meta.channel === APP_CLIENT || meta.channel === EXTENSION_CLIENT ? meta.channel : null;
  if (client && (!meta.commandId || !meta.occurredAt))
    throw HfosError.validation(
      [
        ...(meta.commandId ? [] : [{ path: APP_HEADERS.commandId, message: 'Required.' }]),
        ...(meta.occurredAt ? [] : [{ path: APP_HEADERS.occurredAt, message: 'Required.' }]),
      ],
      `${client === APP_CLIENT ? 'The app' : 'The extension'} sent this change without saying which one it is and when it was done. Update ${UPDATE[client]}, then try it again.`,
    );
}

/**
 * Where a person decided a draft or an approval, as its `via` says: in the Assistant, on the phone, or on the web
 * (the browser extension is the web too).
 */
export const decidedVia = (meta: RequestMeta): 'assistant' | 'mobile' | 'web' =>
  meta.channel === 'assistant' ? 'assistant' : meta.channel === 'mobile' ? 'mobile' : 'web';

/**
 * The moment rules, in executeCommand once a repeat has been answered and before the command runs:
 * - a customer-facing command done longer ago than its fresh minutes waits for the person's OK (`stale_action`,
 *   ask) unless they said "Still send?" yes within the last few minutes;
 * - an online-only command done more than two minutes ago is refused (`online_only`, final): money moves, calls
 *   and settings happen with signal or not at all.
 * `occurredAt` is only ever set for the app and the extension, so the web's commands pass untouched.
 */
export function assertOnTime(cmd: CommandDef, meta: RequestMeta, now: Date): void {
  if (!meta.occurredAt || cmd.offline === 'anytime') return;
  const age = now.getTime() - meta.occurredAt.getTime();
  if (cmd.offline === 'online') {
    if (age > ONLINE_MINUTES * MIN)
      throw new HfosError(
        'rule_violation',
        409,
        `This has to be done with signal, and it waited ${waitInWords(age)} to go, so it wasn’t done. Try it again.`,
        { occurredAt: meta.occurredAt.toISOString() },
        'online_only',
      );
    return;
  }
  if (age <= cmd.offline.freshMinutes * MIN) return;
  const confirmed =
    !!meta.confirmedAt && now.getTime() - meta.confirmedAt.getTime() <= CONFIRMED_MINUTES * MIN;
  if (!confirmed)
    throw new HfosError(
      'rule_violation',
      409,
      `This was done ${waitInWords(age)} ago, so it waits for your OK before it goes.`,
      { occurredAt: meta.occurredAt.toISOString(), freshMinutes: cmd.offline.freshMinutes },
      'stale_action',
    );
}
