/**
 * Automations' "Referral mentioned": the card's one press. Somebody a customer said needs the business becomes a
 * customer (or the customer they already are, found by phone or email) and a lead whose source says who sent
 * them ("Referred by Maria Lopez"). The referral records what it made, which is what clears the card.
 */
import { and, eq } from 'drizzle-orm';
import { people, referrals } from '@hfos/db/schema';
import { findMatches } from '../crm/matching';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { ReferralCreateLeadInput, ReferralCreateLeadOutput } from '../schemas/referral';
import { leadCreate } from './lead.create';
import { personCreate } from './person.create';

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Jan Novak" → Jan / Novak; no name → "Neighbour" / "of Maria", so the list still says who they are. */
export function referredNameParts(
  name: string | null | undefined,
  relation: string | null,
  referrerFirst: string | null,
): { firstName: string; lastName: string } {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length)
    return { firstName: clip(words[0]!, 80), lastName: clip(words.slice(1).join(' '), 80) };
  return {
    firstName: clip(capital(relation?.trim() || 'Referral'), 80),
    lastName: referrerFirst ? clip(`of ${referrerFirst}`, 80) : '',
  };
}

export const referralCreateLead = defineCommand({
  name: 'referral.create_lead',
  description:
    'Turn somebody a customer mentioned into a customer and a lead, with the customer who mentioned them as its source. Finds them first if their phone or email is already here.',
  risk: 1,
  input: ReferralCreateLeadInput,
  output: ReferralCreateLeadOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['referral.lead_created'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [r] = await ctx.tx
      .select()
      .from(referrals)
      .where(and(eq(referrals.workspaceId, ws), eq(referrals.id, input.referralId)))
      .for('update');
    if (!r) throw HfosError.notFound('That referral isn’t here any more.');
    // Pressed twice, or on two devices: the lead it already made.
    if (r.status === 'lead_created' && r.leadId && r.personId)
      return { referralId: r.id, personId: r.personId, leadId: r.leadId, existingPerson: false };
    const [referrer] = await ctx.tx
      .select({ firstName: people.firstName, lastName: people.lastName })
      .from(people)
      .where(eq(people.id, r.referrerPersonId));
    const referrerName = `${referrer?.firstName ?? ''} ${referrer?.lastName ?? ''}`.trim() || null;
    const source = clip(referrerName ? `Referred by ${referrerName}` : 'Referral', 80);

    const phone = input.phone === undefined ? r.referredPhoneE164 : input.phone;
    const email = input.email === undefined ? r.referredEmail : input.email;
    const [match] = await findMatches(ctx.tx, ws, 'person', { email, phoneE164: phone });
    let personId: string;
    if (match) personId = match.id;
    else {
      const { firstName, lastName } = referredNameParts(
        input.name ?? r.referredName,
        r.relation,
        referrer?.firstName?.trim() || null,
      );
      const made = await executeCommandWithin(ctx, personCreate, {
        workspaceId: ws,
        firstName,
        lastName,
        phone,
        email,
        source,
        notes: r.quote ? clip(`${referrerName ?? 'A customer'} said: “${r.quote}”`, 2000) : null,
        ignoreDuplicates: true,
      });
      personId = made.output.personId;
    }
    const title = clip(input.title?.trim() || (r.need ? capital(r.need.trim()) : 'Referral'), 160);
    const lead = await executeCommandWithin(ctx, leadCreate, {
      workspaceId: ws,
      title,
      personId,
      source,
    });
    await ctx.tx
      .update(referrals)
      .set({
        status: 'lead_created',
        personId,
        leadId: lead.output.leadId,
        decidedBy: userIdOf(ctx.actor),
        decidedAt: new Date(),
      })
      .where(eq(referrals.id, r.id));
    await ctx.emit({
      type: 'referral.lead_created',
      entityType: 'referral',
      entityId: r.id,
      payload: { leadId: lead.output.leadId, personId, referrerPersonId: r.referrerPersonId },
      before: { status: r.status },
      after: { status: 'lead_created', lead: title, source },
    });
    return {
      referralId: r.id,
      personId,
      leadId: lead.output.leadId,
      existingPerson: !!match,
    };
  },
});
