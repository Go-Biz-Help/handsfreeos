/**
 * Qualifying answers (M7): the AI teammate, or a person, records a lead's answers to the business's
 * qualifying questions (the teammate's settings), with each question's text copied in so they still read
 * right after the questions change. `lead.qualified` goes out the moment the answers first qualify the lead.
 */
import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { qualificationOf } from '../ai-team/config';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { assertAiReach } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import {
  LeadQualification,
  LeadRecordAnswersInput,
  LeadRecordAnswersOutput,
} from '../schemas/ai-team';

export const leadRecordAnswers = defineCommand({
  name: 'lead.record_answers',
  description:
    'Record a lead’s answers to the business’s qualifying questions, in the customer’s words. When they qualify the lead, lead.qualified goes out.',
  risk: 1,
  input: LeadRecordAnswersInput,
  output: LeadRecordAnswersOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.answers_recorded', 'lead.qualified'],
  actors: ['human', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    await assertAiReach(ctx, { leadId: input.leadId });
    const [lead] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ws)));
    if (!lead) throw HfosError.notFound('Lead not found.');
    if (lead.archivedAt)
      throw HfosError.rule('lead_archived', 409, 'Restore the lead before recording answers.');
    const teammate = await loadTeammate(ctx.tx, ws);
    if (!teammate)
      throw HfosError.rule(
        'no_teammate',
        409,
        'Qualifying questions live in the AI teammate’s settings. Set it up first.',
      );
    const questions = teammateConfigOf(teammate).qualify.questions;
    const byId = new Map(questions.map((q) => [q.id, q]));
    const unknown = input.answers.filter((a) => !byId.has(a.questionId));
    if (unknown.length)
      throw HfosError.validation(
        unknown.map((a) => ({
          path: 'answers',
          message: `There’s no question “${a.questionId}”.`,
        })),
      );
    const stored = LeadQualification.safeParse(lead.qualification);
    const before = stored.success ? stored.data : LeadQualification.parse({});
    // Answered when they were recorded: on a phone, perhaps well before it had signal.
    const at = changeMoment(ctx.meta).toISOString();
    const by = ctx.actor.type === 'ai_employee' ? ('ai' as const) : ('person' as const);
    const answers = { ...before.answers };
    for (const a of input.answers)
      answers[a.questionId] = {
        question: byId.get(a.questionId)!.question,
        answer: a.answer,
        answeredAt: at,
        by,
      };
    const result = qualificationOf(
      questions,
      Object.fromEntries(Object.entries(answers).map(([id, x]) => [id, x.answer])),
    );
    const qualified = result.status === 'qualified' && before.status !== 'qualified';
    const next: LeadQualification = {
      answers,
      status: result.status,
      missing: [...result.missing],
      notAFit: [...result.notAFit],
      qualifiedAt: qualified ? at : before.qualifiedAt,
      updatedAt: at,
    };
    await ctx.tx.update(leads).set({ qualification: next }).where(eq(leads.id, lead.id));
    await ctx.emit({
      type: 'lead.answers_recorded',
      entityType: 'lead',
      entityId: lead.id,
      payload: {
        leadId: lead.id,
        personId: lead.personId,
        title: lead.title,
        questionIds: input.answers.map((a) => a.questionId),
        status: result.status,
      },
      before: { status: before.status },
      after: { title: lead.title, status: result.status, answers: input.answers.length },
    });
    if (qualified) {
      const eventId = await ctx.emit({
        type: 'lead.qualified',
        entityType: 'lead',
        entityId: lead.id,
        payload: { leadId: lead.id, personId: lead.personId, title: lead.title },
        after: { title: lead.title, status: 'qualified' },
      });
      await logSystemActivity(ctx, {
        subtype: 'lead_qualified',
        leadId: lead.id,
        personId: lead.personId,
        companyId: lead.companyId,
        body: lead.title,
        meta: { title: lead.title },
        eventId,
      });
    }
    return {
      leadId: lead.id,
      status: result.status,
      missing: [...result.missing],
      notAFit: [...result.notAFit],
      qualified,
    };
  },
});
