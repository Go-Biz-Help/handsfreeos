/**
 * The Assistant asks for each person's OK before their first question (M10): suites that ask it questions say OK for
 * their people first, as the consent step would.
 */
import { randomUUID } from 'node:crypto';
import { ASSISTANT_CONSENT_VERSION, assistantConsent, executeCommand } from '@hfos/core/server';
import { testDbs, type TestUser } from '@hfos/db/testing';

export async function consentToAssistant(...people: readonly TestUser[]): Promise<void> {
  for (const u of people)
    await executeCommand(
      testDbs().api.db,
      assistantConsent,
      { version: ASSISTANT_CONSENT_VERSION },
      { type: 'human', userId: u.id, email: u.email, claims: u.claims },
      { correlationId: randomUUID(), channel: 'test' },
    );
}
