'use client';
import { IDEA_STATUS_WORDS, IDEAS_WORDS, OPEN_IDEA_STATUSES, type IdeaStatus } from '@hfos/core';
import { Lightbulb } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea } from '@/lib/api/types';
import { VoteButton } from './vote-button';

type Similar = {
  id: string;
  number: number;
  title: string;
  status: IdeaStatus;
  voteCount: number;
  voted: boolean;
};

/**
 * Sharing an idea. While somebody types a title, the ideas already on the board that sound like it come up
 * underneath with a vote button, because a vote on the idea that exists counts for more than a second copy of
 * it. They can still share theirs: sometimes it only sounds the same.
 */
export function ShareIdea({
  workspaceId,
  areas,
  label = IDEAS_WORDS.share,
}: {
  workspaceId: string;
  areas: readonly IdeaArea[];
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [areaId, setAreaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Similar[]>([]);
  const asked = useRef(0);

  // "Is it one of these?", a moment after they stop typing, and only the latest answer counts.
  useEffect(() => {
    if (!open) return;
    const text = title.trim();
    if (text.length < 4) {
      setSimilar([]);
      return;
    }
    const n = ++asked.current;
    const t = setTimeout(async () => {
      try {
        const out = unwrap(await apiBrowser().POST('/v1/queries/idea.similar', { body: { text } }));
        if (n === asked.current) setSimilar(out.ideas as Similar[]);
      } catch {
        // Suggestions are a help, not a step: without them the form still works.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [title, open]);

  const choosable = areas.filter((a) => !a.archived);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3) return setError(IDEAS_WORDS.needsTitle);
    if (!areaId) return setError(IDEAS_WORDS.needsArea);
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/idea.share', {
          body: { workspaceId, title: title.trim(), body: body.trim(), areaId },
        }),
      );
      toast.success(IDEAS_WORDS.shared(out.number));
      setOpen(false);
      setTitle('');
      setBody('');
      setAreaId('');
      router.push(`/app/w/${workspaceId}/ideas/${out.ideaId}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)} data-testid="share-idea">
        <Lightbulb className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        {label}
      </Button>
      <DialogContent
        title={IDEAS_WORDS.share}
        description={IDEAS_WORDS.shareIntro}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
          <Field label={IDEAS_WORDS.titleLabel} htmlFor="idea-title">
            <Input
              id="idea-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={IDEAS_WORDS.titlePlaceholder}
              maxLength={140}
              autoComplete="off"
              data-testid="idea-title"
            />
          </Field>
          {similar.length ? (
            <div
              className="rounded-card border border-border bg-card-2 p-3"
              data-testid="idea-similar"
            >
              <p className="text-[13px] font-medium">{IDEAS_WORDS.similar}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {similar.map((s) => (
                  <li key={s.id} className="flex items-center gap-3">
                    <VoteButton
                      ideaId={s.id}
                      workspaceId={workspaceId}
                      voted={s.voted}
                      count={s.voteCount}
                      open={OPEN_IDEA_STATUSES.includes(s.status)}
                    />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/app/w/${workspaceId}/ideas/${s.id}`}
                        className="line-clamp-2 text-sm font-medium hover:underline"
                        onClick={() => setOpen(false)}
                      >
                        {s.title}
                      </Link>
                      <p className="text-xs text-text-3">
                        #{s.number} · {IDEA_STATUS_WORDS[s.status]}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Field label={IDEAS_WORDS.bodyLabel} htmlFor="idea-body" hint={IDEAS_WORDS.bodyHint}>
            <Textarea
              id="idea-body"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={5000}
              data-testid="idea-body"
            />
          </Field>
          <Field label={IDEAS_WORDS.areaLabel} htmlFor="idea-area">
            <Select
              id="idea-area"
              value={areaId}
              onChange={(e) => setAreaId(e.target.value)}
              data-testid="idea-area"
            >
              <option value="">{IDEAS_WORDS.pickArea}</option>
              {choosable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" loading={busy} data-testid="idea-submit">
              {IDEAS_WORDS.shareButton}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {IDEAS_WORDS.cancel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
