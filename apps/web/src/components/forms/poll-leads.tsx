'use client';
/**
 * A live poll's follow-up in the forms editor (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 5; the owner's 21 to
 * 23): what staying to the end is worth, where Hot and Warm start, and what happens to the hot ones. Each answer's
 * points are on its question; the AI can suggest them all at once. Every change is an ordinary edit to the draft.
 */
import {
  allQuestions,
  LEAD_FOLLOW_UP_WORDS,
  LEAD_FOLLOW_UPS,
  LEAD_WORDS,
  mostPoints,
  POLL_MAX_POINTS,
  pollLeadsOf,
  type FormDefinition,
  type FormOp,
  type PollLeads,
} from '@hfos/core';
import { Flame, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Hint } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { pollAiErrorMessage, suggestPoints } from '@/lib/forms/poll-leads';

export function PollLeadsCard({
  workspaceId,
  definition,
  apply,
  readOnly,
}: {
  workspaceId: string;
  definition: FormDefinition;
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
}) {
  const leads = pollLeadsOf(definition);
  const questions = allQuestions(definition);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PollLeads>) =>
    apply([{ op: 'set_form', patch: { leads: { ...leads, ...patch } } }]);
  const number = (value: string, min: number, max: number): number | null => {
    const n = Math.round(Number(value));
    return value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
  };

  const suggest = async () => {
    setBusy(true);
    try {
      const ops = await suggestPoints(workspaceId, definition, questions);
      if (!ops.length) toast('The AI didn’t suggest anything. Try again, or set them yourself.');
      else {
        apply(ops);
        toast.success('Points suggested for every answer. Check them, then publish.');
      }
    } catch (e) {
      toast.error(
        pollAiErrorMessage(
          e,
          'The AI couldn’t suggest points this time. Try again, or set them yourself.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-3" data-testid="poll-leads">
      <div className="flex items-start gap-3">
        <Flame className="mt-0.5 h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">{LEAD_WORDS.title}</p>
          <p className="text-[12.5px] text-text-3">{LEAD_WORDS.editorHelp}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={LEAD_WORDS.stayedLabel} htmlFor="poll-leads-stayed">
          <Input
            id="poll-leads-stayed"
            type="number"
            min={0}
            max={POLL_MAX_POINTS}
            className="w-24"
            value={String(leads.stayed)}
            disabled={readOnly}
            onChange={(e) => {
              const n = number(e.target.value, 0, POLL_MAX_POINTS);
              if (n !== null) set({ stayed: n });
            }}
            data-testid="poll-leads-stayed"
          />
        </Field>
        <Field
          label={`${LEAD_WORDS.hotFrom} (${LEAD_WORDS.pointsSuffix})`}
          htmlFor="poll-leads-hot"
        >
          <Input
            id="poll-leads-hot"
            type="number"
            min={1}
            max={10_000}
            className="w-24"
            value={String(leads.hot)}
            disabled={readOnly}
            onChange={(e) => {
              const n = number(e.target.value, 1, 10_000);
              if (n !== null) set({ hot: n });
            }}
            data-testid="poll-leads-hot"
          />
        </Field>
        <Field
          label={`${LEAD_WORDS.warmFrom} (${LEAD_WORDS.pointsSuffix})`}
          htmlFor="poll-leads-warm"
        >
          <Input
            id="poll-leads-warm"
            type="number"
            min={0}
            max={10_000}
            className="w-24"
            value={String(leads.warm)}
            disabled={readOnly}
            onChange={(e) => {
              const n = number(e.target.value, 0, 10_000);
              if (n !== null) set({ warm: n });
            }}
            data-testid="poll-leads-warm"
          />
        </Field>
      </div>
      {questions.length ? <Hint>{LEAD_WORDS.most(mostPoints(definition))}</Hint> : null}
      <div className="space-y-2">
        <p className="text-[13px] font-medium">{LEAD_WORDS.hotAction}</p>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={LEAD_WORDS.hotAction}>
          {LEAD_FOLLOW_UPS.map((action) => (
            <RadioCard
              key={action}
              selected={leads.hotAction === action}
              onSelect={() => {
                if (!readOnly && leads.hotAction !== action) set({ hotAction: action });
              }}
              title={LEAD_FOLLOW_UP_WORDS[action].label}
              description={LEAD_FOLLOW_UP_WORDS[action].help}
              testId={`poll-leads-action-${action}`}
            />
          ))}
        </div>
        <Hint>
          {`Whichever you pick, “${LEAD_WORDS.workflowTrigger}” starts your workflows, so you can add a tag or a task from the rating.`}
        </Hint>
      </div>
      {!readOnly && questions.length ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <p className="min-w-0 flex-1 text-[12.5px] text-text-3">{LEAD_WORDS.answerPointsHelp}</p>
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() => void suggest()}
            data-testid="poll-leads-suggest"
          >
            <Sparkles size={14} aria-hidden /> {LEAD_WORDS.suggest}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
