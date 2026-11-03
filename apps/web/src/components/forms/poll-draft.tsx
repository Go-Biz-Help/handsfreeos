'use client';
/**
 * The AI drafting a live poll (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's 11: the AI drafts the questions
 * and their points from the slides and a goal, or the business writes them). The business says what the webinar is
 * for; the AI writes the questions and a button, each with its points, when-to-ask phrases and slide, added to the
 * draft as edits to read, change and publish.
 */
import { type FormDefinition, type FormOp } from '@hfos/core';
import { Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { draftPoll, pollAiErrorMessage } from '@/lib/forms/poll-leads';

const COUNTS = [4, 5, 6, 7, 8, 10] as const;

export function PollDraftCard({
  workspaceId,
  definition,
  apply,
}: {
  workspaceId: string;
  definition: FormDefinition;
  apply: (ops: FormOp[]) => void;
}) {
  const asked = definition.pages.some((p) => p.questions.length);
  const [open, setOpen] = useState(!asked);
  const [goal, setGoal] = useState('');
  const [count, setCount] = useState(6);
  const [busy, setBusy] = useState(false);

  const draft = async () => {
    setBusy(true);
    try {
      const ops = await draftPoll(workspaceId, definition, goal.trim(), count);
      const added = ops.filter((o) => o.op === 'add_question').length;
      if (!added)
        toast('The AI didn’t draft any questions. Try again, or say more about the webinar.');
      else {
        apply(ops);
        setOpen(false);
        toast.success(
          `${added === 1 ? '1 question' : `${added} questions`} added, with points and when to ask. Read them, change what you like, then publish.`,
        );
      }
    } catch (e) {
      toast.error(
        pollAiErrorMessage(
          e,
          'The AI couldn’t draft the poll this time. Try again, or write the questions yourself.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(true)}
        data-testid="poll-draft-open"
      >
        <Wand2 size={14} aria-hidden /> Draft more questions with AI
      </Button>
    );

  return (
    <Card className="space-y-3 p-3" data-testid="poll-draft">
      <div>
        <p className="text-[13.5px] font-medium">Draft the questions with AI</p>
        <p className="text-[12.5px] text-text-3">
          {definition.slides
            ? 'Say what the webinar is for. The AI reads your slides and writes questions that show who’s ready to buy, each with its points, when to ask it and its slide.'
            : 'Say what the webinar is for. The AI writes questions that show who’s ready to buy, each with its points and when to ask it. Add your slides first and it reads them too.'}
        </p>
      </div>
      <Field label="What the webinar is for" htmlFor="poll-draft-goal">
        <Textarea
          id="poll-draft-goal"
          rows={3}
          maxLength={500}
          value={goal}
          placeholder="Get roofers to book a demo of our scheduling app"
          onChange={(e) => setGoal(e.target.value)}
          data-testid="poll-draft-goal"
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="How many" htmlFor="poll-draft-count">
          <Select
            id="poll-draft-count"
            selectSize="sm"
            className="w-24"
            value={String(count)}
            onChange={(e) => setCount(Number(e.target.value))}
            data-testid="poll-draft-count"
          >
            {COUNTS.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          size="sm"
          loading={busy}
          disabled={!goal.trim()}
          onClick={() => void draft()}
          data-testid="poll-draft-go"
        >
          <Sparkles size={14} aria-hidden /> Draft the questions
        </Button>
        {asked ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
