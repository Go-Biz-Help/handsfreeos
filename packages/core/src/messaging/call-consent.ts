/**
 * A customer's yes to calls from the "OK to call" box on the business's own pages (Settings → Automations → AI calls,
 * Ask for an OK to call). Server-only: it reads and writes in the caller's transaction.
 *
 * Kept the way the customer page's "Agreed in writing" is, with where ("Form: Get a quote") and when, so campaign
 * calls can go to them. Three things keep a tick from meaning more than it said:
 *
 *   - the box only shows while the switch is on, so a tick sent while it's off (an old page, a hand-made request)
 *     is a box nobody read, and nothing is kept;
 *   - a number left blank is no yes: there's nothing to call;
 *   - "Doesn't want calls" stays, as a STOP does for texts, until they say otherwise themselves.
 */
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { people, workspaces } from '@hfos/db/schema';
import { automationSettingsOf } from '../automations/settings';

/** The longest "where" a yes keeps: person.set_call_consent's limit. */
const SOURCE_MAX = 120;

/** Whether this business shows the "OK to call" box on its pages. */
export async function callBoxOn(tx: Tx, workspaceId: string): Promise<boolean> {
  const [w] = await tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return automationSettingsOf(w?.settings as Record<string, unknown> | undefined).calls.askConsent;
}

/** Keeps a tick of the "OK to call" box, where it was ticked. True when it was kept. */
export async function recordCallConsent(
  tx: Tx,
  workspaceId: string,
  personId: string,
  source: string,
): Promise<boolean> {
  if (!(await callBoxOn(tx, workspaceId))) return false;
  const kept = await tx
    .update(people)
    .set({
      callConsent: 'opted_in',
      callConsentAt: new Date(),
      callConsentSource: source.trim().slice(0, SOURCE_MAX),
    })
    .where(
      and(
        eq(people.id, personId),
        eq(people.workspaceId, workspaceId),
        isNotNull(people.phoneE164),
        ne(people.callConsent, 'opted_out'),
      ),
    )
    .returning({ id: people.id });
  return kept.length > 0;
}
