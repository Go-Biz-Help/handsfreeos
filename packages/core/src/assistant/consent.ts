/**
 * The Assistant's consent step (M10): before the first question, on the phone or the web, the person is told that
 * what they ask about goes to an AI service, and their OK is kept with their account (`users.settings`, under
 * `assistantConsent`: the wording's version and when they said it). One OK covers every app; "Not now" keeps
 * nothing, so it asks again next time. Browser-safe: the panels read the same answer the worker enforces.
 */

/**
 * The version of the consent wording people are asked to OK. Raise it when the wording changes in a way that
 * matters (what is sent, or to whom), and everyone is asked again.
 */
export const ASSISTANT_CONSENT_VERSION = 2;

/** Where the OK is kept in a person's settings. */
export const ASSISTANT_CONSENT_KEY = 'assistantConsent';

export interface AssistantConsent {
  /** The wording version the Assistant asks for now. */
  readonly version: number;
  /** When the person said OK; null until they do. */
  readonly consentedAt: string | null;
  /** The wording version they said OK to; null until they do. */
  readonly consentedVersion: number | null;
  /** Whether the consent step shows before the next question. */
  readonly needed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A person's consent, read from their settings. Anything malformed counts as no OK yet. */
export function assistantConsentOf(settings: unknown): AssistantConsent {
  const stored = isRecord(settings) ? settings[ASSISTANT_CONSENT_KEY] : undefined;
  const version = isRecord(stored) ? stored['version'] : undefined;
  const at = isRecord(stored) ? stored['at'] : undefined;
  const ok =
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > 0 &&
    typeof at === 'string' &&
    !Number.isNaN(Date.parse(at));
  return {
    version: ASSISTANT_CONSENT_VERSION,
    consentedAt: ok ? at : null,
    consentedVersion: ok ? version : null,
    needed: !ok || version < ASSISTANT_CONSENT_VERSION,
  };
}
