/**
 * What a website form or a connected app sends (M14 slice B). The worker has already checked the key, the
 * site it was posted from and its rate limits; this is the business's own part, and it is the same path a
 * text from a stranger goes through: the daily limit, the matching, the lead, the note on the timeline.
 *
 * The system actor only. A sender that retries gets the answer it got the first time.
 */
import { createHash } from 'node:crypto';
import { workspaceZone } from '../calendar/load';
import { indeedLeadTitle } from '../crm/indeed';
import { ensureIntakeSource, intakeContact, intakeSourceById, submitIntake } from '../crm/intake';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  IndeedApplicantReceiveInput,
  IntakeSubmitInput,
  IntakeSubmitOutput,
} from '../schemas/intake';

export const intakeSubmit = defineCommand({
  name: 'intake.submit',
  description:
    'Worker: a lead arrived from a website form or a connected app. Opens the customer and their lead, under the source’s own settings and its limit for the day.',
  risk: 1,
  input: IntakeSubmitInput,
  output: IntakeSubmitOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['person.created', 'lead.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const source = await intakeSourceById(ctx.tx, ws, input.sourceId);
    if (!source || (source.kind !== 'website_form' && source.kind !== 'api'))
      throw HfosError.notFound(
        'This form or key isn’t in use anymore, so nothing was sent. Contact the business another way.',
      );
    const result = await submitIntake(ctx, {
      source,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      at: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      zone: await workspaceZone(ctx.tx, ws),
    });
    return result;
  },
});

/**
 * Somebody applied on Indeed, and Indeed emailed the business (funnels). The worker read the email; this files the
 * applicant under Lead intake's "Indeed" row, which is off until the business turns it on. Indeed gives no OK to
 * text, so the first touch is an email with the funnel's link, and the funnel's contact step asks.
 *
 * The system actor only. The same email read twice (a mailbox and its forward, a retry) opens one lead.
 */
export const indeedApplicantReceive = defineCommand({
  name: 'indeed_applicant.receive',
  description:
    'Worker: Indeed emailed the business about somebody who applied to its job. Opens the applicant as a customer and a lead under Lead intake’s “Indeed” settings, once per email.',
  risk: 1,
  input: IndeedApplicantReceiveInput,
  output: IntakeSubmitOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['person.created', 'lead.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const a = input.applicant;
    const contact = intakeContact({ name: a.name, email: a.email, phone: a.phone });
    const who = fullName(contact.firstName, contact.lastName) || 'An applicant';
    return submitIntake(ctx, {
      source: await ensureIntakeSource(ctx.tx, ws, 'indeed'),
      payload: {
        name: a.name,
        email: a.email,
        phone: a.phone,
        title: indeedLeadTitle(a, who),
        extra: {
          ...(a.job ? { 'Applied for': a.job } : {}),
          ...(a.location ? { Location: a.location } : {}),
        },
      },
      // A Message-ID can be long; the key is its hash.
      dedupeKey: `indeed:${createHash('sha256').update(input.emailKey).digest('hex').slice(0, 40)}`,
      at: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      zone: await workspaceZone(ctx.tx, ws),
    });
  },
});
