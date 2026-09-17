import { APP_CLIENT, APP_HEADERS } from '@hfos/core';

import type { Answer } from './rules';

/**
 * Sends one command to the API as the app: `POST /v1/commands/<name>` with the body exactly as it was saved, and the
 * app's headers (its build, the command's id, when it was made, when it was sent, and when "Still send?" was
 * answered), every time read off the phone's own clock, which the API corrects.
 */

export interface CommandRequest {
  readonly name: string;
  readonly commandId: string;
  /** JSON, exactly as saved: the API's receipt hashes the body as sent. */
  readonly input: string;
  readonly madeAt: string;
  readonly confirmedAt: string | null;
}

export interface SendDeps {
  readonly apiUrl: string;
  readonly fetch: typeof fetch;
  /** The signed-in person's access token, or null when there isn't one to send. */
  readonly token: () => Promise<string | null>;
  readonly appVersion: () => string;
  /** The phone's clock. */
  readonly now: () => number;
  /** A request that hasn't answered in this long is given up on (and tried again). */
  readonly timeoutMs?: number;
}

export const SEND_TIMEOUT_MS = 30_000;

export function appHeaders(
  deps: Pick<SendDeps, 'appVersion' | 'now'>,
  request: Pick<CommandRequest, 'commandId' | 'madeAt' | 'confirmedAt'>,
  token: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [APP_HEADERS.client]: APP_CLIENT,
    [APP_HEADERS.appVersion]: deps.appVersion(),
    [APP_HEADERS.commandId]: request.commandId,
    [APP_HEADERS.occurredAt]: request.madeAt,
    [APP_HEADERS.sentAt]: new Date(deps.now()).toISOString(),
  };
  if (request.confirmedAt) headers[APP_HEADERS.confirmedAt] = request.confirmedAt;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export async function sendCommand(deps: SendDeps, request: CommandRequest): Promise<Answer> {
  let token: string | null;
  try {
    token = await deps.token();
  } catch {
    token = null;
  }
  if (!token) return { reached: false, message: 'No sign-in to send it with yet.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const response = await deps.fetch(`${deps.apiUrl}/v1/commands/${request.name}`, {
      method: 'POST',
      headers: appHeaders(deps, request, token),
      body: request.input,
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      const text = await response.text();
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { reached: true, status: response.status, body };
  } catch (error) {
    return {
      reached: false,
      message: controller.signal.aborted
        ? 'HandsFreeOS took too long to answer.'
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
