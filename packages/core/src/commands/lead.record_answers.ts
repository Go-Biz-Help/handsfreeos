/**
 * Qualifying answers (M7): the AI teammate, or a person, records a lead's answers to the business's
 * qualifying questions (the teammate's settings), with each question's text copied in so they still read
 * right after the questions change. `lead.qualified` goes out the moment the answers first qualify the lead.
 */
import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { qualificationOf, type QualifyingQuestion } from '../ai-team/config';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import { assertAiReach, refuseCustomersLeadInChat } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { changedSince, logLaterChange } from '../kernel/later-change';
import { changeMoment } from '../kernel/moment';
import {
  LeadQualification,
  LeadRecordAnswersInput,
  LeadRecordAnswersOutput,
} from '../schemas/ai-team';

type LeadRow = typeof leads.$inferSelect;

/** One answer to save: in the customer's words, and for a file question the files it put on the lead. */
export interface AnswerEntry {
  readonly questionId: string;
  readonly answer: string;
  readonly files?: readonly {
    readonly fileId: string;
    readonly name: string;
    /** The customer's message it came in. */
    readonly messageId: string | null;
  }[];
}

export interface AnswersResult {
  readonly status: LeadQualification['status'];
  readonly missing: string[];
  readonly notAFit: string[];
  readonly qualified: boolean;
  readonly notApplied: string[];
}

/** The lead's answers as stored, or none yet. */
export function storedQualification(lead: Pick<LeadRow, 'qualification'>): LeadQualification {
  const stored = LeadQualification.safeParse(lead.qualification);
  return stored.success ? stored.data : LeadQualification.parse({});
}

/**
 * Saves answers on the lead, works out where it stands, and sends `lead.answers_recorded` (and `lead.qualified` the
 * first time it qualifies). Shared by `lead.record_answers` and a file arriving for a file question
 * (20261018000400). The lead is the caller's to have found and checked; every answer's question is in `questions`.
 */
export async function saveAnswers(
  ctx: CommandContext,
  lead: LeadRow,
  questions: readonly QualifyingQuestion[],
  entries: readonly AnswerEntry[],
): Promise<AnswersResult> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const before = storedQualification(lead);
  // Answered when they were recorded: on a phone, perhaps well before it had signal.
  const at = changeMoment(ctx.meta).toISOString();
  const by = ctx.actor.type === 'human' ? ('person' as const) : ('ai' as const);
  const answers = { ...before.answers };
  const notApplied: string[] = [];
  let newer = 0;
  for (const a of entries) {
    const stored = answers[a.questionId];
    const question = byId.get(a.questionId)!.question;
    // A newer answer to the same question (recorded after this one was, on a phone perhaps long before it had
    // signal) stands.
    if (stored && changedSince(ctx.meta, stored.answeredAt)) {
      newer += 1;
      if (stored.answer === a.answer) continue;
      notApplied.push(`answers.${a.questionId}`);
      await logLaterChange(
        ctx,
        {
          key: `answers.${a.questionId}`,
          tried: `answer “${question}” with “${a.answer}”`,
          because: `a newer answer, “${stored.answer}”, was kept`,
          changedAt: stored.answeredAt,
        },
        { type: 'lead', id: lead.id },
        { leadId: lead.id, personId: lead.personId, companyId: lead.companyId },
      );
      continue;
    }
    answers[a.questionId] = {
      question,
      answer: a.answer,
      answeredAt: at,
      by,
      files: [...(a.files ?? [])],
    };
  }
  if (newer === entries.length)
    return {
      status: before.status,
      missing: [...before.missing],
      notAFit: [...before.notAFit],
      qualified: false,
      notApplied,
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
      questionIds: entries.map((a) => a.questionId),
      status: result.status,
    },
    before: { status: before.status },
    after: { title: lead.title, status: result.status, answers: entries.length },
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
    status: result.status,
    missing: [...result.missing],
    notAFit: [...result.notAFit],
    qualified,
    notApplied,
  };
}

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
    if (!lead)
      throw HfosError.notFound(
        'That lead isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    if (lead.archivedAt)
      throw HfosError.rule(
        'lead_archived',
        409,
        'This lead is archived. Restore it, then record the answers.',
      );
    await refuseCustomersLeadInChat(ctx, lead);
    const teammate = await loadTeammate(ctx.tx, ws);
    if (!teammate)
      throw HfosError.rule(
        'no_teammate',
        409,
        'This business has no AI teammate yet, and the qualifying questions live in its settings. Set one up on the AI teammate page first.',
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
        unknown.length === 1
          ? 'One of those questions isn’t in the AI teammate’s qualifying questions anymore. Refresh to see the current ones, then answer again.'
          : `${unknown.length} of those questions aren’t in the AI teammate’s qualifying questions anymore. Refresh to see the current ones, then answer again.`,
      );
    // A file question is answered by the file itself (20261018000400). A person may still write down how it came
    // (“Dropped it at the office”); the teammate saves the file instead, so it never says one came that didn’t.
    const files = input.answers.filter((a) => byId.get(a.questionId)!.kind === 'file');
    if (files.length && ctx.actor.type === 'ai_employee')
      throw HfosError.rule(
        'file_question',
        400,
        `“${byId.get(files[0]!.questionId)!.question}” asks for a file. Ask them to send it with ask_for_file, or save the one they sent with save_file.`,
      );
    const result = await saveAnswers(ctx, lead, questions, input.answers);
    return { leadId: lead.id, ...result };
  },
});
