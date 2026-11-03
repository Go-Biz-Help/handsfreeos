/**
 * Where a business's privacy policy and terms are, and what the ones HandsFreeOS hosts say (M17): read by the pages
 * at `/legal/<site>/…`, by the website chat's agreement box, and by the review before a registration goes.
 *
 * **They follow the registration as it is now.** That's the answers being got ready in the wizard (its draft,
 * saved as they're typed) when they're newer than the last send, or else what went to the carriers. Before
 * anything is sent the draft is all there is, and a page that waited for the send would show a policy with no way
 * to reach the business, and a chat that kept linking to our policy after the business chose its own. The draft
 * is cleared when it's sent, so once it has gone this is exactly what the carriers were told.
 *
 * **How customers reach the business** is asked for beside the policy and terms (`policyContact`): the contact on
 * the registration is the person the carriers write to, which may be nobody's to publish. A registration sent
 * before that was asked falls back to it, and to the number it's for.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { phoneNumbers, registrationDrafts, telephonyRegistrations } from '@hfos/db/schema';
import { formatPhone } from '../crm/phone';
import type { PolicyBusiness } from './policies';
import { sendsOffers } from './consent';

export interface LegalSource {
  /** The business's own privacy policy, when it points at one instead of ours. */
  readonly policyUrl: string | null;
  /** The same for its terms. */
  readonly termsUrl: string | null;
  /** What ours are written from, less the name customers know (the site's, or the business's). */
  readonly business: Omit<PolicyBusiness, 'name'>;
}

type Address = { line1?: string; city?: string; state?: string; postalCode?: string };

/** What a registration sent to the carriers says (`telephony_registrations.submission`). */
type Submission = {
  legalName?: string;
  policyUrl?: string | null;
  termsUrl?: string | null;
  useCase?: string;
  forNumber?: string;
  website?: string;
  contact?: { email?: string };
  policyContact?: { email?: string; phone?: string };
  address?: Address;
};

/** The wizard's answers as it saves them (`registration_drafts.answers.form`): plain strings, '' when not given. */
type DraftForm = Partial<
  Record<
    | 'legalName'
    | 'website'
    | 'line1'
    | 'city'
    | 'state'
    | 'postalCode'
    | 'contactEmail'
    | 'policyEmail'
    | 'policyPhone'
    | 'useCase'
    | 'ownPolicyUrl'
    | 'ownTermsUrl',
    unknown
  >
>;

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const withScheme = (v: unknown): string | null => {
  const url = text(v);
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};

export async function legalSourceOf(tx: Tx, workspaceId: string): Promise<LegalSource> {
  const [sent] = await tx
    .select({
      submission: telephonyRegistrations.submission,
      at: telephonyRegistrations.submittedAt,
    })
    .from(telephonyRegistrations)
    .where(
      and(
        eq(telephonyRegistrations.workspaceId, workspaceId),
        isNotNull(telephonyRegistrations.submission),
      ),
    )
    // The most recent thing we told a carrier, whatever step it was for.
    .orderBy(desc(telephonyRegistrations.submittedAt), desc(telephonyRegistrations.createdAt))
    .limit(1);
  const [draft] = await tx
    .select({ answers: registrationDrafts.answers, at: registrationDrafts.updatedAt })
    .from(registrationDrafts)
    .where(eq(registrationDrafts.workspaceId, workspaceId));
  const form = (draft?.answers as { form?: unknown } | null)?.form;
  const preparing =
    !!form && typeof form === 'object' && (!sent?.at || (draft!.at && draft!.at > sent.at));

  if (preparing) {
    const f = form as DraftForm;
    // Nothing sent yet says which number: the one the business has now.
    const [number] = text(f.policyPhone)
      ? []
      : await tx
          .select({ e164: phoneNumbers.e164 })
          .from(phoneNumbers)
          .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')))
          .orderBy(desc(phoneNumbers.createdAt))
          .limit(1);
    const phone = text(f.policyPhone) ?? (number ? formatPhone(number.e164) : undefined);
    return {
      policyUrl: withScheme(f.ownPolicyUrl),
      termsUrl: withScheme(f.ownTermsUrl),
      business: {
        legalName: text(f.legalName),
        website: withScheme(f.website) ?? undefined,
        email: text(f.policyEmail) ?? text(f.contactEmail),
        phone,
        address: {
          line1: text(f.line1),
          city: text(f.city),
          state: text(f.state),
          postalCode: text(f.postalCode),
        },
        offers: sendsOffers(text(f.useCase)),
      },
    };
  }

  const s = (sent?.submission ?? {}) as Submission;
  const phone = text(s.policyContact?.phone) ?? text(s.forNumber);
  return {
    policyUrl: text(s.policyUrl) ?? null,
    termsUrl: text(s.termsUrl) ?? null,
    business: {
      legalName: s.legalName,
      website: s.website,
      email: text(s.policyContact?.email) ?? s.contact?.email,
      phone: phone ? formatPhone(phone) : undefined,
      address: s.address,
      offers: sendsOffers(s.useCase),
    },
  };
}
