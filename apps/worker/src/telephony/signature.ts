import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Twilio's request signature: HMAC-SHA1 (keyed with the auth token of the account the number belongs to)
 * over the full URL Twilio called, followed by every POST parameter sorted by name as name+value
 * (repeated names contribute each value, in sorted order), base64 encoded.
 */
export function twilioSignature(authToken: string, url: string, params: WebhookParams): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of [...value].sort()) data += key + v;
    else data += key + (value as string);
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: WebhookParams,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
