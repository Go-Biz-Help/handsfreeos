import type { LeadQualification } from '@hfos/core';
import { CircleAlert, CircleCheck, ClipboardList, Clock } from 'lucide-react';
import { TeammateMark } from '@/components/ai-team/mark';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { aiName } from '@/lib/ai-team/inbox-words';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS = {
  qualified: { variant: 'ok', label: 'Qualified', icon: CircleCheck },
  not_a_fit: { variant: 'danger', label: 'Not a fit', icon: CircleAlert },
  incomplete: { variant: 'pending', label: 'Incomplete', icon: Clock },
} as const;

const joinAnd = (list: readonly string[]) =>
  list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

/**
 * The lead's qualifying answers: each under the question as it was asked (the text is copied in, so it still
 * reads right after the questions change), where the lead stands (qualified, not a fit, or incomplete), and
 * what's still missing.
 */
export function QualificationCard({
  qualification: q,
  teammateName,
  questions,
}: {
  qualification: LeadQualification;
  /** The business's AI teammate, for "by Ava (AI)". */
  teammateName: string | null;
  /** The teammate's questions now, to name the ones still missing. */
  questions: readonly { readonly id: string; readonly question: string }[];
}) {
  const s = STATUS[q.status];
  const Icon = s.icon;
  const answers = Object.entries(q.answers).sort(
    ([, a], [, b]) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt),
  );
  const by = (who: 'ai' | 'person') =>
    who === 'ai' ? `by ${teammateName ? aiName(teammateName) : 'the AI teammate'}` : 'by a person';
  const asked = answers.find(([, a]) => a.by === 'ai')?.[1];
  const questionText = (id: string) =>
    q.answers[id]?.question ?? questions.find((x) => x.id === id)?.question ?? null;
  const missing = q.missing.map(questionText).filter((t): t is string => !!t);
  const ruledOut = q.notAFit
    .map((id) => {
      const a = q.answers[id];
      return a ? `${a.question} “${a.answer}”` : questionText(id);
    })
    .filter((t): t is string => !!t);
  return (
    <Card className="px-[18px] py-4" data-testid="qualification-card" data-status={q.status}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            'inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px]',
            AI_SOFT,
            AI_TEXT,
          )}
        >
          <ClipboardList className="h-[13px] w-[13px]" strokeWidth={1.75} />
        </span>
        <h3 className="text-[15px] font-semibold">Qualification</h3>
        <Badge variant={s.variant} data-testid="qualification-status">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
          {s.label}
        </Badge>
      </div>
      {asked ? (
        <div className="mb-1.5 mt-2 flex items-center gap-1.5 text-xs text-text-3">
          <TeammateMark size="xs" />
          <span>
            Asked {by('ai')} · {formatDate(asked.answeredAt, { time: true })}
          </span>
        </div>
      ) : null}
      {answers.length ? (
        <dl className="mt-1">
          {answers.map(([id, a]) => (
            <div
              key={id}
              className="grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-border py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
              data-testid={`qualification-answer-${id}`}
            >
              <dt className="text-[13px] text-text-2">{a.question}</dt>
              <dd className="flex min-w-0 flex-col gap-px">
                <span className="text-[13px] font-medium [overflow-wrap:anywhere]">{a.answer}</span>
                <span className="text-xs text-text-3">{by(a.by)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-[13px] text-text-2">No answers yet.</p>
      )}
      <div
        className={cn(
          'mt-1 flex items-start gap-2 border-t border-border pt-2.5 text-[13px]',
          q.status === 'qualified'
            ? 'text-success-text'
            : q.status === 'not_a_fit'
              ? 'text-danger-text'
              : 'text-text-2',
        )}
        data-testid="qualification-summary"
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <span>
          {q.status === 'qualified'
            ? `All ${answers.length} answered, and nothing is marked not a fit.`
            : q.status === 'not_a_fit'
              ? `Not a fit: ${joinAnd(ruledOut) || 'an answer rules them out'}. A person decides whether to mark the lead lost.`
              : missing.length
                ? `Still to ask: ${joinAnd(missing)}.`
                : `${q.missing.length} ${q.missing.length === 1 ? 'question' : 'questions'} still to ask.`}
        </span>
      </div>
      <p className="mt-2 text-xs text-text-3">
        Each answer keeps the question as it was asked, so this still reads right if the questions
        change later.
      </p>
    </Card>
  );
}
