/**
 * The real API, in this process, listening on a port of its own: the phones' uploaders reach its command routes
 * over HTTP exactly as the app will, and teammates "on the web" call the same routes without the app's headers.
 */
import { buildApp } from '@hfos/api/src/app';
import { readEnv } from '@hfos/api/src/env';
import { signInTestUser, testDbs, testEnv, type TestUser } from '@hfos/db/testing';

export interface RunningApi {
  readonly url: string;
  close(): Promise<void>;
}

export async function startApi(): Promise<RunningApi> {
  const env = testEnv();
  // Built from explicit values: this process holds the local secret key, which the API refuses to start with.
  const app = await buildApp({
    env: readEnv({
      PORT: '0',
      SUPABASE_URL: env.supabaseUrl,
      DATABASE_URL: env.apiDbUrl,
      WEB_ORIGINS: 'http://localhost:3000',
    }),
    logger: false,
    db: testDbs().api,
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url, close: () => app.close() };
}

export class ApiRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: { code?: string; rule?: string; disposition?: string } } | null,
  ) {
    super(`${status} ${JSON.stringify(body)}`);
  }
}

/** Someone using the web app: signed in, sending commands with no phone headers, so each happens now. */
export class WebUser {
  private token: string | null = null;

  constructor(
    readonly api: RunningApi,
    readonly user: TestUser,
  ) {}

  async command<T = Record<string, unknown>>(
    name: string,
    input: Record<string, unknown>,
  ): Promise<T> {
    this.token ??= await signInTestUser(this.user);
    const res = await fetch(`${this.api.url}/v1/commands/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => null)) as T;
    if (!res.ok)
      throw new ApiRefusal(res.status, body as ConstructorParameters<typeof ApiRefusal>[1]);
    return body;
  }
}
