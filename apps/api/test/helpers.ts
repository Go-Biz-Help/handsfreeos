import { testDbs, testEnv } from '@hfos/db/testing';
import { buildApp } from '../src/app';
import { readEnv } from '../src/env';

/** The API's own env is built explicitly: the test process holds the local secret key, the API must not. */
export function apiEnv() {
  const env = testEnv();
  return readEnv({
    PORT: '0',
    SUPABASE_URL: env.supabaseUrl,
    DATABASE_URL: env.apiDbUrl,
    WEB_ORIGINS: 'http://localhost:3000',
  });
}

export async function testApp() {
  return buildApp({ env: apiEnv(), logger: false, db: testDbs().api });
}
