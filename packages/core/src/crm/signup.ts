/**
 * Someone who leaves their details on one of the business's own pages, signed in to nothing: a form, or an add-on's
 * public page (Real Estate round three: "Ask about this home", an open house's sign-in), or the same sign-in on a
 * teammate's phone handed to them (round six). Found or made as a customer
 * the way a form's answers are, a lead opened where Settings → Lead intake says, and their yes to texts kept with
 * where it came from, unless they told the business to stop before.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { people } from '@hfos/db/schema';
import type { Tx } from '@hfos/db/client';
import { workspaceZone } from '../calendar/load';
import { leadCreate } from '../commands/lead.create';
import type { CommandContext } from '../kernel/types';
import { LeadCreateInput } from '../schemas/lead';
import { findOrCreateCustomer, intakeSourceOf, takeIntakeSlot } from './intake';

/** The events a sign-up can cause: a command that calls `signUpFromPage` lists them in its `emits`. */
export const SIGN_UP_EVENTS = ['person.created', 'lead.created'] as const;

/** A yes to texts from a page of the business's, kept with its source. Someone who said stop stays stopped. */
export async function recordSmsConsent(tx: Tx, personId: string, source: string): Promise<void> {
  await tx
    .update(people)
    .set({ smsConsent: 'opted_in', smsConsentAt: dsql`now()`, smsConsentSource: source })
    .where(and(eq(people.id, personId), dsql`sms_consent <> 'opted_out'`));
}

export interface PageSignUp {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly phone: string | null;
  /** Where they came from, on the customer, the lead and their consent: "Open house: 2207 Juniper Trail". */
  readonly source: string;
  /** They ticked "Text me…". */
  readonly smsConsent: boolean;
  /** Open a lead for them with this title, when Lead intake opens one for the business's forms; null opens none. */
  readonly lead: { readonly title: string; readonly assigneeUserId?: string | null } | null;
}

/** The customer they are (found or made), and the lead opened for them, if one was. */
export async function signUpFromPage(
  ctx: CommandContext,
  s: PageSignUp,
): Promise<{ personId: string; created: boolean; leadId: string | null }> {
  const ws = ctx.scope.workspaceId!;
  const found = await findOrCreateCustomer(
    ctx,
    { firstName: s.firstName, lastName: s.lastName, phone: s.phone, email: s.email },
    s.source,
  );
  let leadId: string | null = null;
  if (s.lead) {
    // The business's switch for what arrives from its own pages: the one its forms use.
    const intake = await intakeSourceOf(ctx.tx, ws, 'website_form');
    if (intake.active && intake.createLead) {
      const created = await leadCreate.handler(
        ctx,
        LeadCreateInput.parse({
          workspaceId: ws,
          personId: found.personId,
          ...(intake.pipelineId && intake.stageId
            ? { pipelineId: intake.pipelineId, stageId: intake.stageId }
            : {}),
          title: s.lead.title.slice(0, 160),
          source: s.source,
          ...(s.lead.assigneeUserId ? { assigneeUserId: s.lead.assigneeUserId } : {}),
        }),
      );
      leadId = created.leadId;
      // The day's count is the worker's (0072): it measures what arrives on its own, and a visitor signing in on
      // a teammate's phone handed to them (Real Estate's open house, round six) is not that, as form_response.record.
      if (ctx.actor.type !== 'human')
        await takeIntakeSlot(
          ctx.tx,
          ws,
          intake,
          await workspaceZone(ctx.tx, ws),
          new Date(),
          false,
        );
    }
  }
  if (s.smsConsent) await recordSmsConsent(ctx.tx, found.personId, s.source);
  return { personId: found.personId, created: found.created, leadId };
}
