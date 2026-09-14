'use client';
import { Lightbulb, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AssistantMark } from '@/components/assistant/mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AI_TINT } from '@/lib/knowledge/labels';
import { tryErrorMessage, tryKnowledge, type TryAnswer } from '@/lib/knowledge/try';
import { cn } from '@/lib/utils';
import { KindChip, Snippet } from './chips';

const FALLBACK_SAMPLES = [
  'What areas do you serve?',
  'Are you open on Saturdays?',
  'Do you offer financing?',
];

/**
 * "Try it": ask what a customer might and see what the AI would answer, from the same profile and published
 * items AI steps use, and which items it used. A question nothing answers becomes a gap suggestion.
 */
export function TryIt({
  workspaceId,
  canManage,
  samples,
  initial,
}: {
  workspaceId: string;
  canManage: boolean;
  samples: readonly string[];
  initial: string;
}) {
  const base = `/app/w/${workspaceId}/knowledge`;
  const [question, setQuestion] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ asked: string; answer: TryAnswer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chips = [...samples, ...FALLBACK_SAMPLES.filter((s) => !samples.includes(s))].slice(0, 4);

  async function ask(q: string) {
    const asked = q.trim();
    if (!asked || busy) return;
    setQuestion(asked);
    setBusy(true);
    setError(null);
    try {
      setResult({ asked, answer: await tryKnowledge(workspaceId, asked) });
    } catch (e) {
      setResult(null);
      setError(tryErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  return (
    <Card className="flex flex-col gap-3 px-5 py-[18px]" data-testid="try-it">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg',
            AI_TINT,
          )}
        >
          <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.5} />
        </span>
        <span className="flex min-w-0 flex-col">
          <h2 className="text-[15px] font-semibold">Try it</h2>
          <span className="text-xs text-text-3">
            Ask what a customer might. See the answer and what it used.
          </span>
        </span>
      </div>

      {canManage ? (
        <>
          <form onSubmit={submit} className="flex gap-2">
            <Input
              inputSize="sm"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={500}
              placeholder="Do you offer financing?"
              aria-label="A customer’s question"
              data-testid="try-question"
              className="min-w-0 flex-1"
            />
            <Button type="submit" size="sm" loading={busy} data-testid="try-ask">
              Ask
            </Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void ask(s)}
                className={cn(
                  'inline-flex h-7 max-w-full items-center truncate rounded-full border px-3 text-[12.5px] font-medium transition-colors disabled:opacity-60',
                  result?.asked === s
                    ? 'border-transparent bg-accent-soft text-accent-text'
                    : 'border-border-strong bg-card text-text-2 hover:bg-card-2',
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-[10px] bg-card-2 px-3 py-2.5 text-[13px] text-text-2">
          Only owners and admins can try questions. It uses the business’s daily AI limit.
        </p>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-[10px] bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
          data-testid="try-error"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-2.5 border-t border-border pt-3" data-testid="try-result">
          <div className="max-w-[86%] self-end whitespace-pre-wrap rounded-2xl rounded-br-[5px] bg-accent-soft px-3 py-2 text-[13.5px] [overflow-wrap:anywhere]">
            {result.asked}
          </div>
          <div className="flex items-start gap-2.5">
            <AssistantMark size={22} />
            <div
              className="min-w-0 flex-1 whitespace-pre-wrap rounded-xl rounded-bl-[5px] bg-card-2 px-3 py-2.5 text-[13.5px] leading-normal [overflow-wrap:anywhere]"
              data-testid="try-answer"
            >
              {result.answer.answer}
            </div>
          </div>
          <div className="mt-0.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Items it used
          </div>
          {result.answer.items.length ? (
            <ul className="flex flex-col gap-1.5" data-testid="try-used">
              {result.answer.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-2.5 rounded-[9px] border border-border px-2.5 py-2"
                  data-testid="try-used-item"
                >
                  <KindChip kind={item.kind} className="mt-px" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] font-medium">{item.title}</span>
                    {item.snippet ? (
                      <Snippet text={item.snippet} className="line-clamp-2 text-xs text-text-2" />
                    ) : null}
                  </span>
                  <Link
                    href={`${base}/items/${item.id}`}
                    className="text-xs font-medium text-accent-text hover:underline"
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-text-2">
              {result.answer.unanswered
                ? 'None. Nothing published answers this.'
                : 'None. It answered from your business profile.'}
            </p>
          )}
          {result.answer.gap ? (
            <div
              className={cn(
                'flex items-start gap-2 rounded-[9px] px-3 py-2.5 text-[12.5px] leading-[1.45]',
                AI_TINT,
              )}
              data-testid="try-gap"
            >
              <Lightbulb className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              <span>
                Nothing published answers this, so the AI says someone will follow up.{' '}
                {result.answer.gap.grouped
                  ? 'We added it to a similar question in Suggestions.'
                  : 'We added this to Suggestions.'}{' '}
                <Link href={`${base}/suggestions?reason=gap`} className="font-semibold underline">
                  Write the answer
                </Link>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-[12.5px] text-text-3">
        Only published items are used. Try it counts toward the daily AI limit.
      </p>
    </Card>
  );
}
