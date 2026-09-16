/**
 * Typed client for the HandsFreeOS API. `paths` is generated from the API's OpenAPI document
 * (`pnpm openapi`), so a command or query renamed on the server is a compile error here.
 */
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from './schema';

export type { paths } from './schema';
export type ApiClient = Client<paths>;

export type CommandPath = Extract<keyof paths, `/v1/commands/${string}`>;
export type QueryPath = Extract<keyof paths, `/v1/queries/${string}`>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Returns the current Supabase access token, or null when signed out. */
  readonly getToken: () => Promise<string | null> | string | null;
  /** Optional correlation id per request; the API mints one when absent or malformed. */
  readonly correlationId?: () => string;
  readonly fetch?: typeof fetch;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly rule?: string;
    readonly details?: unknown;
    /**
     * What a client keeping a queue of changes does with it: `final` (it never goes through as sent), `retry` (send
     * it again later, unchanged) or `ask` (a person can answer it, then it goes again).
     */
    readonly disposition?: 'final' | 'retry' | 'ask';
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const auth: Middleware = {
    async onRequest({ request }) {
      const token = await opts.getToken();
      if (token) request.headers.set('authorization', `Bearer ${token}`);
      if (opts.correlationId) request.headers.set('x-correlation-id', opts.correlationId());
      return request;
    },
  };
  client.use(auth);
  return client;
}
