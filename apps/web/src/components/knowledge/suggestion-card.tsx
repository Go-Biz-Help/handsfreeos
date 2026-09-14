'use client';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/errors';
import type { KnowledgeItemKind, KnowledgeSuggestion } from '@/lib/api/types';
import { acceptSuggestion, rejectSuggestion } from '@/lib/knowledge/actions';
import { KIND_LABEL, shortUrl, suggestionFrom } from '@/lib/knowledge/labels';
import { cn } from '@/lib/utils';
import { KindChip } from './chips';

type WritableKind = Exclude<KnowledgeItemKind, 'document'>;

/** The item a rescan proposes to change, as it reads now. */
export interface CurrentItem {
  readonly id: string;
  readonly kind: KnowledgeItemKind;
  readonly title: string;
  readonly body: string;
}

export type Decision = 'accepted' | 'rejected' | 'drafted';

/**
 * One suggestion, with Accept, Edit and accept, and Reject. A gap asks for the answer (saved as an FAQ, or as
 * a draft); a rescan's change to an existing item shows what it would change.
 */
export function SuggestionCard({
  workspaceId,
  s,
  canManage,
  current,
  onDecided,
  compact,
}: {
  workspaceId: string;
  s: KnowledgeSuggestion;
  canManage: boolean;
  current?: CurrentItem | null;
  onDecided: (s: KnowledgeSuggestion, decision: Decision, message: string) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<WritableKind>(s.kind === 'document' ? 'article' : s.kind);
  const [title, setTitle] = useState(s.proposed.title);
  const [body, setBody] = useState(s.proposed.body);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gap = s.reason === 'gap';
  const change = !!(s.itemId && current);
  const url = typeof s.source.url === 'string' ? s.source.url : null;
  const noun = KIND_LABEL[change && current ? current.kind : s.kind].toLowerCase();

  async function accept(opts: { edited?: boolean; draft?: boolean } = {}) {
    setError(null);
    if (gap && !answer.trim()) return setError('Write the answer first.');
    if (opts.edited && (!title.trim() || !body.trim()))
      return setError('The title and the text both need something.');
    setBusy(opts.draft ? 'draft' : opts.edited ? 'edited' : 'accept');
    try {
      const status = opts.draft ? 'draft' : 'published';
      await acceptSuggestion(workspaceId, s.id, {
        status,
        edits: gap
          ? { body: answer.trim() }
          : opts.edited
            ? { kind, title: title.trim(), body: body.trim() }
            : undefined,
      });
      onDecided(
        s,
        opts.draft ? 'drafted' : 'accepted',
        change
          ? `Updated the ${noun} “${current!.title}”.`
          : opts.draft
            ? 'Saved as a draft FAQ.'
            : `Added “${opts.edited ? title.trim() : s.proposed.title}” and published it.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function reject() {
    setError(null);
    setBusy('reject');
    try {
      await rejectSuggestion(workspaceId, s.id);
      onDecided(s, 'rejected', 'Rejected. Nothing was added.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const headline = gap ? `Customers asked: ${s.proposed.title}` : s.proposed.title;
  const source =
    s.reason === 'scan' && url ? (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 hover:text-text hover:underline"
      >
        From {shortUrl(url)}
        <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
      </a>
    ) : (
      suggestionFrom(s)
    );

  return (
    <div
      className={cn(
        'flex flex-col gap-[7px] rounded-xl border border-border bg-card px-[15px] py-[13px]',
        compact && 'py-3',
      )}
      data-testid="suggestion"
      data-suggestion-id={s.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={gap ? 'gap' : s.kind} />
        <span className="min-w-0 flex-1 text-[13.5px] font-medium">{headline}</span>
        {gap && s.similarCount > 1 ? (
          <Badge className="h-5 text-[11.5px]">{s.similarCount} similar</Badge>
        ) : null}
        {change ? (
          <Badge variant="pending" className="h-5 text-[11.5px]">
            Changes an {noun === 'faq' ? 'FAQ' : noun}
          </Badge>
        ) : null}
      </div>

      {gap ? (
        <p className="text-[13px] text-text-2">
          The AI couldn’t find an answer, so it said someone would follow up. Answer once and it’s
          covered next time.
        </p>
      ) : change && current ? (
        <div className="flex flex-col gap-1" data-testid="suggestion-diff">
          {current.title !== s.proposed.title ? (
            <p className="text-xs text-text-3">
              Now titled <span className="font-medium text-text-2">“{current.title}”</span>
            </p>
          ) : null}
          <div className="flex gap-2 rounded-[7px] bg-danger-soft px-[9px] py-1.5 text-[12.5px] leading-[1.45] text-danger-text">
            <b className="w-2.5 flex-none font-bold" aria-label="Now">
              −
            </b>
            <span className="line-clamp-4 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {current.body}
            </span>
          </div>
          <div className="flex gap-2 rounded-[7px] bg-success-soft px-[9px] py-1.5 text-[12.5px] leading-[1.45] text-success-text">
            <b className="w-2.5 flex-none font-bold" aria-label="From the website">
              +
            </b>
            <span className="line-clamp-4 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {s.proposed.body}
            </span>
          </div>
        </div>
      ) : editing ? null : (
        <p className="line-clamp-4 whitespace-pre-wrap text-[13px] text-text-2 [overflow-wrap:anywhere]">
          {s.proposed.body}
        </p>
      )}
      <span className="text-xs text-text-3">{source}</span>

      {canManage && editing && !gap ? (
        <div className="flex flex-col gap-2.5 rounded-[10px] bg-card-2 p-3">
          {change ? null : (
            <Segmented<WritableKind>
              ariaLabel="Kind"
              value={kind}
              onChange={setKind}
              className="self-start"
              options={[
                { value: 'faq', label: 'FAQ' },
                { value: 'article', label: 'Article' },
                { value: 'fact', label: 'Fact' },
              ]}
            />
          )}
          <Field label={kind === 'faq' ? 'Question' : 'Title'} htmlFor={`sg-title-${s.id}`}>
            <Input
              id={`sg-title-${s.id}`}
              inputSize="sm"
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label={kind === 'faq' ? 'Answer' : 'Text'} htmlFor={`sg-body-${s.id}`}>
            <Textarea
              id={`sg-body-${s.id}`}
              value={body}
              maxLength={20000}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[88px] text-[13.5px]"
            />
          </Field>
        </div>
      ) : null}

      {canManage && gap ? (
        <Field label="Your answer, as an FAQ" htmlFor={`sg-answer-${s.id}`}>
          <Textarea
            id={`sg-answer-${s.id}`}
            value={answer}
            maxLength={5000}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Yes. We install ductless mini splits for garages, additions and older homes."
            className="min-h-[72px] text-[13.5px]"
            data-testid="gap-answer"
          />
        </Field>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {error}
        </p>
      ) : null}

      {canManage ? (
        <div className="mt-[3px] flex flex-wrap items-center gap-2">
          {gap ? (
            <>
              <Button
                size="sm"
                loading={busy === 'accept'}
                disabled={!!busy}
                onClick={() => void accept()}
              >
                Save as an FAQ
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'draft'}
                disabled={!!busy}
                onClick={() => void accept({ draft: true })}
              >
                Save as a draft
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === 'reject'}
                disabled={!!busy}
                onClick={() => void reject()}
              >
                Reject
              </Button>
              {compact ? null : (
                <span className="text-xs text-text-3 sm:ml-auto">
                  Reject it if you don’t do this. The AI keeps saying someone will follow up.
                </span>
              )}
            </>
          ) : editing ? (
            <>
              <Button
                size="sm"
                loading={busy === 'edited'}
                disabled={!!busy}
                onClick={() => void accept({ edited: true })}
              >
                {change ? 'Save and update' : 'Save and accept'}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                loading={busy === 'accept'}
                disabled={!!busy}
                onClick={() => void accept()}
              >
                {change ? `Update the ${noun === 'faq' ? 'FAQ' : noun}` : 'Accept'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!!busy}
                onClick={() => setEditing(true)}
              >
                {change ? 'Edit and update' : 'Edit and accept'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === 'reject'}
                disabled={!!busy}
                onClick={() => void reject()}
              >
                Reject
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Accepts suggestions one after another (published); those already decided are skipped. */
export async function acceptMany(
  workspaceId: string,
  ids: readonly string[],
  onProgress: (done: number) => void,
): Promise<{ accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await acceptSuggestion(workspaceId, id);
      accepted++;
    } catch (e) {
      const decided = (e as { rule?: string; code?: string }).rule === 'suggestion_decided';
      if (!decided) failed++;
    }
    onProgress(accepted + failed);
  }
  return { accepted, failed };
}
