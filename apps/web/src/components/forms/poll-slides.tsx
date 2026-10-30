'use client';
/**
 * A live poll's slides in the forms editor (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 4): the presentation as
 * a PDF, added, replaced or taken off, and read by the AI to tie each question to the slide it goes with and write its
 * when-to-ask phrases from what the slides say. Each is an ordinary edit to the draft, saved, undone and published
 * like any other; the team shows the published slides in the call.
 */
import { allQuestions, SLIDE_WORDS, type FormDefinition, type FormOp } from '@hfos/core';
import { Presentation, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api/errors';
import { cueErrorMessage, writeCues } from '@/lib/forms/poll-cues';
import { uploadSlides } from '@/lib/forms/slides';

export function PollSlidesCard({
  workspaceId,
  formId,
  definition,
  apply,
  readOnly,
}: {
  workspaceId: string;
  formId: string;
  definition: FormDefinition;
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
}) {
  const slides = definition.slides ?? null;
  const questions = allQuestions(definition);
  const [adding, setAdding] = useState(false);
  const [reading, setReading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const add = async (file: File) => {
    setAdding(true);
    try {
      const added = await uploadSlides(workspaceId, formId, file);
      apply([{ op: 'set_form', patch: { slides: added } }]);
      toast.success(
        `${added.name} added, ${SLIDE_WORDS.count(added.pages).toLowerCase()}. Publish the poll to show them in calls.`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAdding(false);
      if (picker.current) picker.current.value = '';
    }
  };

  const read = async () => {
    setReading(true);
    try {
      const ops = await writeCues(workspaceId, definition, questions);
      if (!ops.length)
        toast('The AI didn’t find anything to add. Try again, or pick them yourself.');
      else {
        apply(ops);
        toast.success(
          ops.length === 1
            ? '1 question has its slide and phrases. Check it, then publish.'
            : `${ops.length} questions have their slides and phrases. Check them, then publish.`,
        );
      }
    } catch (e) {
      toast.error(cueErrorMessage(e));
    } finally {
      setReading(false);
    }
  };

  return (
    <Card className="space-y-3 p-3" data-testid="poll-slides">
      <div className="flex items-center gap-3">
        <Presentation className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">{SLIDE_WORDS.title}</p>
          <p
            className={slides ? 'truncate text-[12.5px] text-text-3' : 'text-[12.5px] text-text-3'}
            data-testid="poll-slides-name"
          >
            {slides ? `${slides.name} · ${SLIDE_WORDS.count(slides.pages)}` : SLIDE_WORDS.addHelp}
          </p>
        </div>
        {readOnly ? null : slides ? (
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              loading={adding}
              onClick={() => picker.current?.click()}
              data-testid="poll-slides-replace"
            >
              {SLIDE_WORDS.replace}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={adding}
              onClick={() => apply([{ op: 'set_form', patch: { slides: null } }])}
              data-testid="poll-slides-remove"
            >
              {SLIDE_WORDS.remove}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={adding}
            onClick={() => picker.current?.click()}
            data-testid="poll-slides-add"
          >
            {adding ? SLIDE_WORDS.adding : SLIDE_WORDS.add}
          </Button>
        )}
      </div>
      {slides && !readOnly && questions.length ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <p className="min-w-0 flex-1 text-[12.5px] text-text-3">{SLIDE_WORDS.readHelp}</p>
          <Button
            size="sm"
            variant="secondary"
            loading={reading}
            onClick={() => void read()}
            data-testid="poll-slides-read"
          >
            <Sparkles size={14} aria-hidden /> {SLIDE_WORDS.readThem}
          </Button>
        </div>
      ) : null}
      <input
        ref={picker}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void add(file);
        }}
        data-testid="poll-slides-file"
      />
    </Card>
  );
}
