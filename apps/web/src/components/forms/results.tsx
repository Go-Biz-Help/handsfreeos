'use client';
import { ClipboardList } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import type { FormQuestionSummary, FormResultsOut, FormSummary } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { FormResponses } from './responses';

/**
 * What everybody said. A bar per choice, an average for ratings and numbers, and the most recent written
 * answers to read — the three shapes an answer comes in, and nothing else pretending to be a chart.
 */
export function FormResults({
  workspaceId,
  form,
  results,
}: {
  workspaceId: string;
  form: FormSummary;
  results: FormResultsOut;
}) {
  const [tab, setTab] = useState<'summary' | 'each'>('summary');
  if (!results.completions)
    return (
      <Card className="px-6 py-12 text-center">
        <ClipboardList className="mx-auto h-8 w-8 text-text-3" strokeWidth={1.5} />
        <h2 className="mt-3 text-[15px] font-medium text-text">No answers yet</h2>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-2">
          {results.views > 0
            ? `${results.views} ${results.views === 1 ? 'person has' : 'people have'} looked at it. Nobody has finished one.`
            : 'Share the link and the answers will land here.'}
        </p>
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Tile label="Looked" value={results.views} />
        <Tile label="Started" value={results.starts} />
        <Tile label="Finished" value={results.completions} />
        {results.mode === 'quiz' ? (
          <Tile
            label="Average score"
            value={results.averagePercent === null ? '—' : `${results.averagePercent}%`}
          />
        ) : (
          <Tile
            label="Finish rate"
            value={
              results.starts ? `${Math.round((results.completions / results.starts) * 100)}%` : '—'
            }
          />
        )}
      </div>

      <div className="flex gap-1.5">
        {(
          [
            ['summary', 'All together'],
            ['each', 'One at a time'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'rounded-control px-3 py-1.5 text-[13px] transition-colors',
              tab === key ? 'bg-card-2 font-medium text-text' : 'text-text-2 hover:bg-card-2',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'summary' ? (
        <div className="space-y-3">
          {results.questions.map((question) => (
            <QuestionSummary key={question.questionId} question={question} />
          ))}
        </div>
      ) : (
        <FormResponses workspaceId={workspaceId} formId={form.formId} />
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <p className="text-[12px] uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tracking-tight text-text">{value}</p>
    </Card>
  );
}

function QuestionSummary({ question }: { question: FormQuestionSummary }) {
  const total = question.choices.reduce((sum, c) => sum + c.count, 0);
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-medium text-text">{question.title}</h3>
        <span className="shrink-0 text-[12.5px] text-text-3">
          {question.answered === 1 ? '1 answer' : `${question.answered} answers`}
        </span>
      </div>

      {question.choices.length ? (
        <div className="mt-3 space-y-2">
          {question.choices.map((choice) => {
            const share = total ? Math.round((choice.count / total) * 100) : 0;
            return (
              <div key={choice.label}>
                <div className="flex justify-between text-[12.5px] text-text-2">
                  <span className="truncate">{choice.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {choice.count} · {share}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-card-2">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {question.average !== null && !question.choices.length ? (
        <p className="mt-2 text-[13px] text-text-2">
          Average <span className="font-medium text-text">{question.average}</span>
        </p>
      ) : null}

      {question.samples.length ? (
        <ul className="mt-3 space-y-1.5">
          {question.samples.map((sample, i) => (
            <li key={i} className="rounded-card bg-card-2 px-3 py-2 text-[13px] text-text-2">
              “{sample}”
            </li>
          ))}
        </ul>
      ) : null}

      {!question.choices.length && question.average === null && !question.samples.length ? (
        <p className="mt-2 text-[12.5px] text-text-3">Nothing to add up for this one.</p>
      ) : null}
    </Card>
  );
}
