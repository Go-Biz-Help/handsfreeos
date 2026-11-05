import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { registrationDrafts, registrationReviews, telephonyRegistrations } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  RegistrationGetDraftInput,
  RegistrationGetDraftOutput,
  RegistrationReviewForStaffInput,
  RegistrationReviewForStaffOutput,
  RegistrationReviewGetInput,
  RegistrationReviewGetOutput,
} from '../schemas/telephony';

/** The texting registration's answers as they were left, for the wizard to pick up where it stopped. */
export const registrationGetDraft = defineQuery({
  name: 'registration.get_draft',
  description:
    'The texting registration’s answers saved while it was being filled in, or nothing when none are saved.',
  input: RegistrationGetDraftInput,
  output: RegistrationGetDraftOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select({ answers: registrationDrafts.answers, updatedAt: registrationDrafts.updatedAt })
      .from(registrationDrafts)
      .where(eq(registrationDrafts.workspaceId, input.workspaceId));
    return {
      answers: row ? (row.answers as Record<string, unknown>) : null,
      savedAt: row ? row.updatedAt.toISOString() : null,
    };
  },
});

/** A review row as the screens show it. */
const reviewOut = (r: {
  id: string;
  status: 'waiting' | 'approved' | 'sent_back' | 'withdrawn';
  kind: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  ticketNumber: number | null;
  sentAt: Date | null;
}) => ({
  reviewId: r.id,
  status: r.status,
  kind: r.kind as 'a2p_10dlc' | 'toll_free_verification',
  requestedAt: r.requestedAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
  decisionNote: r.decisionNote,
  ticketNumber: r.ticketNumber,
  sentAt: r.sentAt?.toISOString() ?? null,
});

/**
 * The business's latest ask for HandsFreeOS to check its texting registration (registration.request_review), for the
 * wizard and the Texting page: waiting, approved and sent, or sent back with what to change. One it withdrew (by
 * sending all green, or asking again) isn't shown.
 */
export const registrationReviewGet = defineQuery({
  name: 'registration.review.get',
  description:
    'Whether HandsFreeOS is checking the texting registration by hand, approved it, or sent it back (and what it said).',
  input: RegistrationReviewGetInput,
  output: RegistrationReviewGetOutput,
  permission: 'channels.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select()
      .from(registrationReviews)
      .where(
        and(
          eq(registrationReviews.workspaceId, input.workspaceId),
          ne(registrationReviews.status, 'withdrawn'),
        ),
      )
      .orderBy(desc(registrationReviews.requestedAt))
      .limit(1);
    if (!row) return { review: null };
    // A decision the registration has moved on from (sent since, by the business or by this approval) is history:
    // the wizard shouldn't greet a fix after a carrier's answer with an old "sent back".
    if (row.status !== 'waiting' && row.decidedAt) {
      const [later] = await ctx.tx
        .select({ id: telephonyRegistrations.id })
        .from(telephonyRegistrations)
        .where(
          and(
            eq(telephonyRegistrations.workspaceId, input.workspaceId),
            gt(telephonyRegistrations.submittedAt, row.decidedAt),
          ),
        )
        .limit(1);
      if (later && (row.status === 'sent_back' || row.sentAt)) return { review: null };
    }
    return { review: reviewOut(row) };
  },
});

/** Staff: the registration a ticket asks them to check (by the check, or by its ticket), with everything it'd send. */
export const registrationReviewForStaff = defineQuery({
  name: 'registration.review.for_staff',
  description:
    'Support: the texting registration a ticket asks HandsFreeOS to check, with what wasn’t green and the details as they’d be sent.',
  input: RegistrationReviewForStaffInput,
  output: RegistrationReviewForStaffOutput,
  permission: 'support.read',
  scope: () => ({ kind: 'platform' }),
  async handler(ctx, input) {
    const [r] = await rows<{
      id: string;
      workspace_id: string;
      business_name: string;
      kind: string;
      status: 'waiting' | 'approved' | 'sent_back' | 'withdrawn';
      submission: Record<string, unknown>;
      not_green: string[];
      note: string | null;
      ticket_number: string | number | null;
      requested_at: Date | string;
      decided_at: Date | string | null;
      decision_note: string | null;
      sent_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select * from private.registration_review_for_staff(${input.reviewId ?? null}::uuid, ${input.ticketId ?? null}::uuid)`,
    );
    if (!r) {
      // A ticket that isn't a registration check has none; a check that's gone is worth saying so.
      if (input.ticketId) return { review: null };
      throw HfosError.notFound('That registration check isn’t there anymore.');
    }
    const at = (v: Date | string | null) => (v ? new Date(v) : null);
    return {
      review: {
        ...reviewOut({
          id: r.id,
          status: r.status,
          kind: r.kind,
          requestedAt: at(r.requested_at)!,
          decidedAt: at(r.decided_at),
          decisionNote: r.decision_note,
          ticketNumber: r.ticket_number === null ? null : Number(r.ticket_number),
          sentAt: at(r.sent_at),
        }),
        workspaceId: r.workspace_id,
        businessName: r.business_name,
        note: r.note,
        notGreen: r.not_green,
        submission: r.submission,
      },
    };
  },
});
