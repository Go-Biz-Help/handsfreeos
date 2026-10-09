'use client';
/**
 * AI help on one of a playbook's parts, in the builder: Improve rewrites what's written, Suggest offers more. What
 * comes back is only offered: words to use in place of what's there, lines to add one by one (or a rewritten list to
 * use instead), or questions to add. The worker asks the AI (`outreach.playbook.assist`, apps/worker/src/addons/
 * outreach/assist.ts) with the whole playbook as it stands, so the help fits the rest of it.
 */
import {
  PLAYBOOK_ASSIST_PARTS,
  type AssistDraft,
  type AssistQuestion,
  type PlaybookAssistMode,
  type PlaybookAssistOutput,
  type PlaybookAssistPart,
} from '@hfos/core/addons/outreach/playbook-assist';
import { ANSWER_NEXTS } from '@hfos/core/addons/outreach/playbooks';
import { Loader2, Plus, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { cn } from '@/lib/utils';

export function AiHelp({
  workspaceId,
  part,
  draft,
  written,
  onWords,
  onAdd,
  onReplace,
  onQuestion,
  className,
}: {
  workspaceId: string;
  part: PlaybookAssistPart;
  /** The whole playbook as it stands, what's typed and not added yet included. */
  draft: AssistDraft;
  /** Whether anything's written in the part yet: Improve needs something to improve. */
  written: boolean;
  /** Words: use these in place of what's there. */
  onWords?: (words: string) => void;
  /** A list: add this line. Whether it went in. */
  onAdd?: (line: string) => boolean;
  /** A list: use these lines instead. */
  onReplace?: (lines: string[]) => void;
  /** The conversation: add this question. */
  onQuestion?: (q: AssistQuestion) => void;
  className?: string;
}) {
  const { kind, label } = PLAYBOOK_ASSIST_PARTS[part];
  const [busy, setBusy] = useState<PlaybookAssistMode | null>(null);
  const [got, setGot] = useState<(PlaybookAssistOutput & { mode: PlaybookAssistMode }) | null>(
    null,
  );
  const [used, setUsed] = useState<Set<string>>(new Set());

  const ask = async (mode: PlaybookAssistMode) => {
    setBusy(mode);
    try {
      const out = await workerPost<PlaybookAssistOutput>(
        '/v1/addons/outreach/actions/outreach.playbook.assist',
        { workspaceId, input: { part, mode, draft } },
      );
      if (!out.options.length && !out.questions.length)
        toast.message('The AI had nothing new to add here. Try again, or write more first.');
      setGot({ ...out, mode });
      setUsed(new Set());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const take = (key: string) => setUsed((u) => new Set(u).add(key));

  const suggestWord = kind === 'words' && !written ? 'Write it for me' : 'Suggest more';
  const shown = got && (got.options.length || got.questions.length) ? got : null;
  return (
    <div className={cn('mt-2', className)} data-testid={`ai-help-${part}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[12.5px] text-text-3">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          AI help
        </span>
        {written ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void ask('improve')}
            aria-label={`Improve ${label} with AI`}
            data-testid={`ai-improve-${part}`}
          >
            {busy === 'improve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Improve
          </Button>
        ) : null}
        {kind === 'words' && written ? null : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void ask('suggest')}
            aria-label={`${kind === 'words' ? 'Write' : 'Suggest more'} ${label} with AI`}
            data-testid={`ai-suggest-${part}`}
          >
            {busy === 'suggest' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {kind === 'questions' ? 'Suggest questions' : suggestWord}
          </Button>
        )}
      </div>

      {shown ? (
        <div
          className="mt-2 rounded-card border border-accent-soft bg-card-2 p-3"
          data-testid={`ai-help-${part}-options`}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-text-2">
              {kind === 'words'
                ? 'Pick one to use, then change it as you like'
                : kind === 'questions'
                  ? 'Add the ones that fit'
                  : shown.mode === 'improve'
                    ? 'Your list, rewritten'
                    : 'Tap to add'}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close the AI’s ideas"
              onClick={() => setGot(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {kind === 'words' ? (
            <ul className="space-y-1.5">
              {shown.options.map((o) => (
                <li key={o}>
                  <button
                    type="button"
                    onClick={() => {
                      onWords?.(o);
                      setGot(null);
                    }}
                    className="w-full rounded-menu border border-border bg-card px-3 py-2 text-left text-[13px] hover:border-accent"
                  >
                    {o}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {kind === 'list' && shown.mode === 'suggest' ? (
            <div className="flex flex-wrap gap-1.5">
              {shown.options
                .filter((o) => !used.has(o))
                .map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => {
                      if (onAdd?.(o) !== false) take(o);
                    }}
                    className={cn(
                      'inline-flex min-h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 py-0.5 text-left text-[12.5px] text-text-2 hover:bg-card hover:text-text',
                      part === 'samples' && 'rounded-menu',
                    )}
                  >
                    <Plus className="h-3 w-3 flex-none" aria-hidden />
                    {o}
                  </button>
                ))}
            </div>
          ) : null}

          {kind === 'list' && shown.mode === 'improve' ? (
            <div>
              <ul className="mb-2 list-disc space-y-0.5 pl-5 text-[13px]">
                {shown.options.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
              <Button
                size="sm"
                onClick={() => {
                  onReplace?.(shown.options);
                  setGot(null);
                }}
                data-testid={`ai-replace-${part}`}
              >
                Use these instead
              </Button>
            </div>
          ) : null}

          {kind === 'questions' ? (
            <ul className="space-y-2">
              {shown.questions
                .filter((q) => !used.has(q.text))
                .map((q) => (
                  <li key={q.text} className="rounded-menu border border-border bg-card p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium">{q.text}</div>
                        {q.answers.length ? (
                          <ul className="mt-1 space-y-0.5 text-[12.5px] text-text-2">
                            {q.answers.map((a) => (
                              <li key={a.label}>
                                “{a.label}” · {ANSWER_NEXTS[a.next]}
                                {a.tag ? ` · tags ${a.tag}` : ''}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          onQuestion?.(q);
                          take(q.text);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add
                      </Button>
                    </div>
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
