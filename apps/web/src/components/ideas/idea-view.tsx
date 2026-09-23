'use client';
import {
  IDEA_STATUS_MEANING,
  IDEA_STATUS_WORDS,
  relativeTimeAgo,
  type IdeaStatus,
} from '@hfos/core';
import { ArrowLeft, BellRing, EyeOff, GitMerge, PackageCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea, IdeaGet } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { areaNames, dayWords, PlainText, StatusPill } from './idea-bits';
import { VoteButton } from './vote-button';

type Update = IdeaGet['updates'][number];

/** One line of an idea's story, in words. */
function updateWords(u: Update): string {
  if (u.kind === 'merged') return `Merged into #${u.other?.number ?? '?'}`;
  if (u.kind === 'merged_in') return `#${u.other?.number ?? '?'} was merged into this idea`;
  if (u.toStatus === 'done' && u.whatsNew) return 'Shipped';
  if (u.fromStatus === u.toStatus)
    return `Still ${IDEA_STATUS_WORDS[u.toStatus as IdeaStatus].toLowerCase()}`;
  return `Moved to ${IDEA_STATUS_WORDS[u.toStatus as IdeaStatus]}`;
}

/**
 * One idea, as everybody who takes part sees it: the vote, where it stands and what that means, what the team
 * has said about it, and the conversation under it. Its author can still fix their words until the team has
 * answered; anybody can stop the emails about it.
 */
export function IdeaView({
  workspaceId,
  data,
  areas,
}: {
  workspaceId: string;
  data: IdeaGet;
  areas: readonly IdeaArea[];
}) {
  const router = useRouter();
  const { idea, comments, updates, shipped } = data;
  const names = areaNames(areas);
  const base = `/app/w/${workspaceId}/ideas`;
  const [following, setFollowing] = useState(idea.following);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [areaId, setAreaId] = useState(idea.areaId);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const follow = (next: boolean) => {
    setFollowing(next);
    void run(
      'follow',
      async () => {
        try {
          unwrap(
            await apiBrowser().POST('/v1/commands/idea.follow', {
              body: { ideaId: idea.id, following: next },
            }),
          );
        } catch (e) {
          setFollowing(!next);
          throw e;
        }
      },
      next ? 'You’ll get an email when this moves.' : 'No more emails about this idea.',
    );
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      'edit',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/idea.edit', {
            body: { ideaId: idea.id, title: title.trim(), body: body.trim(), areaId },
          }),
        ),
      'Saved.',
    );
    if (ok) setEditing(false);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = comment.trim();
    if (!text) return;
    const ok = await run('comment', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/idea.comment', {
          body: { ideaId: idea.id, body: text },
        }),
      ),
    );
    if (ok) setComment('');
  };

  const takeDown = (commentId: string) =>
    run(
      `hide-${commentId}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/idea.set_comment_hidden', {
            body: { commentId, hidden: true },
          }),
        ),
      'Comment deleted.',
    );

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0">
        <Link
          href={base}
          className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          All ideas
        </Link>

        {idea.mergedInto ? (
          <div
            className="mb-4 flex items-start gap-2.5 rounded-card border border-border bg-card-2 px-4 py-3 text-[13px]"
            data-testid="idea-merged"
          >
            <GitMerge className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
            <p>
              This idea asks for the same thing as{' '}
              <Link href={`${base}/${idea.mergedInto.id}`} className="font-medium underline">
                #{idea.mergedInto.number} {idea.mergedInto.title}
              </Link>
              . Its votes and followers went there, so vote and comment there.
            </p>
          </div>
        ) : null}
        {idea.hidden ? (
          <div className="mb-4 flex items-start gap-2.5 rounded-card border border-border bg-warning-soft px-4 py-3 text-[13px] text-warning-text">
            <EyeOff className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.5} />
            <p>The HandsFreeOS team took this idea off the board. Only you can see it.</p>
          </div>
        ) : null}

        <Card className="p-5">
          {editing ? (
            <form onSubmit={save} className="flex flex-col gap-4">
              <Field label="Your idea, in a few words" htmlFor="edit-title">
                <Input
                  id="edit-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={140}
                />
              </Field>
              <Field label="Tell us more" htmlFor="edit-body">
                <Textarea
                  id="edit-body"
                  rows={6}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={5000}
                />
              </Field>
              <Field label="What is it about?" htmlFor="edit-area">
                <Select id="edit-area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                  {areas
                    .filter((a) => !a.archived || a.id === idea.areaId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </Field>
              {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
              <div className="flex gap-2">
                <Button type="submit" loading={busy === 'edit'}>
                  Save
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setTitle(idea.title);
                    setBody(idea.body);
                    setAreaId(idea.areaId);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex gap-4">
              <VoteButton
                ideaId={idea.id}
                workspaceId={workspaceId}
                voted={idea.voted}
                count={idea.voteCount}
                open={idea.votingOpen}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <h2
                  className="text-xl font-semibold leading-snug tracking-[-0.01em]"
                  data-testid="idea-title-shown"
                >
                  {idea.title}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-3">
                  <StatusPill status={idea.status} />
                  <span>{names.get(idea.areaId) ?? 'Something else'}</span>
                  <span>#{idea.number}</span>
                  <span suppressHydrationWarning>
                    {idea.author.you
                      ? 'Shared by you'
                      : `Shared by ${idea.author.name || 'someone'}`}{' '}
                    · {relativeTimeAgo(idea.createdAt)}
                  </span>
                </div>
                {idea.body ? <PlainText text={idea.body} className="mt-4 text-[14.5px]" /> : null}
                {idea.canEdit ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-2 mt-3"
                    onClick={() => setEditing(true)}
                    data-testid="idea-edit"
                  >
                    Edit your idea
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </Card>

        {shipped.length ? (
          <div className="mt-4 flex flex-col gap-2">
            {shipped.map((s) => (
              <Link
                key={s.id}
                href={`${base}/whats-new#${s.id}`}
                className="flex items-center gap-2.5 rounded-card border border-border bg-success-soft px-4 py-3 text-[13px] text-success-text hover:underline"
              >
                <PackageCheck className="h-4 w-4 flex-none" strokeWidth={1.5} />
                In What’s new: {s.title} · {dayWords(s.publishedAt)}
              </Link>
            ))}
          </div>
        ) : null}

        {updates.length ? (
          <section className="mt-6" aria-label="What happened">
            <h3 className="text-sm font-semibold">What happened</h3>
            <ol
              className="mt-3 flex flex-col gap-3 border-l border-border pl-4"
              data-testid="idea-updates"
            >
              {updates.map((u) => (
                <li key={u.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-accent" />
                  <p className="text-[13px]">
                    <span className="font-medium">{updateWords(u)}</span>
                    {u.other && u.kind !== 'status' ? (
                      <>
                        {' '}
                        <Link href={`${base}/${u.other.id}`} className="underline">
                          {u.other.title}
                        </Link>
                      </>
                    ) : null}
                    {u.whatsNew ? (
                      <>
                        {' '}
                        in{' '}
                        <Link href={`${base}/whats-new#${u.whatsNew.id}`} className="underline">
                          {u.whatsNew.title}
                        </Link>
                      </>
                    ) : null}
                    <span className="text-text-3">
                      {' '}
                      · {u.by} · {dayWords(u.createdAt)}
                    </span>
                  </p>
                  {u.note ? (
                    <div className="mt-1.5 rounded-control bg-accent-soft px-3 py-2 text-[13px] text-accent-text">
                      {u.note}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="mt-6" aria-label="Comments">
          <h3 className="text-sm font-semibold">
            Comments{comments.length ? ` (${comments.length})` : ''}
          </h3>
          {comments.length ? (
            <ul className="mt-3 flex flex-col gap-3" data-testid="idea-comments">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    'rounded-card border px-4 py-3',
                    c.author.team ? 'border-accent/30 bg-accent-soft/50' : 'border-border bg-card',
                    c.hidden && 'opacity-60',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">
                      {c.author.you ? 'You' : c.author.name || 'Someone'}
                    </span>
                    {c.author.team ? (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                        HandsFreeOS team
                      </span>
                    ) : null}
                    <span className="text-text-3" suppressHydrationWarning>
                      {relativeTimeAgo(c.createdAt)}
                    </span>
                    {c.author.you && !c.hidden ? (
                      <button
                        type="button"
                        onClick={() => void takeDown(c.id)}
                        disabled={busy === `hide-${c.id}`}
                        className="ml-auto text-xs text-text-3 hover:text-danger-text"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed">{c.body}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-text-3">
              No comments yet. How would you use it? What does it need to do?
            </p>
          )}
          {idea.mergedInto ? null : (
            <form onSubmit={send} className="mt-4 flex flex-col gap-2">
              <label htmlFor="idea-comment" className="sr-only">
                Add a comment
              </label>
              <Textarea
                id="idea-comment"
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment: how you would use it, or what it needs to do"
                maxLength={5000}
                data-testid="idea-comment-body"
              />
              {error && !editing ? <p className="text-[13px] text-danger-text">{error}</p> : null}
              <div>
                <Button
                  type="submit"
                  size="sm"
                  loading={busy === 'comment'}
                  disabled={!comment.trim()}
                  data-testid="idea-comment-send"
                >
                  Comment
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>

      <aside className="flex flex-col gap-4 md:pt-9">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-3">Where it stands</p>
          <div className="mt-2">
            <StatusPill status={idea.status} />
          </div>
          <p className="mt-2 text-[13px] text-text-2">{IDEA_STATUS_MEANING[idea.status]}</p>
          <p className="mt-3 text-[13px] text-text-2">
            {idea.voteCount === 1 ? '1 vote' : `${idea.voteCount} votes`}
            {idea.voted ? ', yours among them' : ''}.
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <BellRing className="h-4 w-4 text-text-3" strokeWidth={1.5} aria-hidden />
                Email me updates
              </p>
              <p className="mt-1 text-[13px] text-text-2">
                When the team moves it along the roadmap, or ships it.
              </p>
            </div>
            <Switch
              checked={following}
              onChange={follow}
              label="Email me updates about this idea"
              disabled={busy === 'follow'}
              testId="idea-follow"
            />
          </div>
        </Card>
      </aside>
    </div>
  );
}
