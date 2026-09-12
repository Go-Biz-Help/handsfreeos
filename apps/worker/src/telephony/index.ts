import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { createFakeTelephony } from './fake';
import type { TelephonyProvider } from './provider';
import { createTwilioTelephony } from './twilio';

/** Twilio in production; the in-memory fake for development and tests (production refuses it in readEnv). */
export function createTelephony(env: WorkerEnv, log: Logger): TelephonyProvider {
  if (env.telephonyProvider === 'twilio')
    return createTwilioTelephony({
      accountSid: env.twilioAccountSid!,
      authToken: env.twilioAuthToken!,
      primaryProfileSid: env.twilioPrimaryProfileSid,
    });
  return createFakeTelephony({ approvalMs: env.fakeApprovalMs, callbacks: true, log });
}
