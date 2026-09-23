'use client';
import { IDEA_STATUS_WORDS, IDEA_STATUSES, relativeTimeAgo, type IdeaStatus } from '@hfos/core';
import { ArrowLeft, ChevronUp, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { dayWords, PlainText, StatusPill } from '@/components/ideas/idea-bits';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea, IdeaGet, IdeaTeamView } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type Similar = { id: string; number: number; title: string; status: IdeaStatus; voteCount: number };

/**
 * One idea, for the team: everything a business sees, plus who is behind it, and the things only the team does —
 * move it along the roadmap with a note the followers are emailed, answer it, fix its words, merge a duplicate,
 * and take down what is not an idea at all.
 */
export function IdeaTeamViewPage({
  data,
  team,
  areas,
  can,
}: {
  data: IdeaGet;
  team: IdeaTeamView;
  areas: readonly IdeaArea[];
  can: { manage: boolean };
}) {
  const router = useRouter();
  const { idea, comments, updates } = data;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<IdeaStatus>(idea.status);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [answer, setAnswer] = useState('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [areaId, setAreaId] = useState(idea.areaId);
  const [dupSearch, setDupSearch] = useState(idea.title);
  const [matches, setMatches] = useState<Similar[]>([]);
  const [mergeNote, setMergeNote] = useState('');
  const asked = useRef(0);
  const names = new Map(areas.map((a) => [a.id, a.name]));

  // The generated client's types go several thousand paths deep; one cast here keeps the compiler sane.
  const command = (path: string, input: object) =>
    (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
      body: input,
    }).then(unwrap);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      router.refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Other ideas that sound like this one, for "this is a duplicate of…".
  useEffect(() => {
    const text = dupSearch.trim();
    if (text.length < 3 || idea.mergedInto) {
      setMatches([]);
      return;
    }
    const n = ++asked.current;
    const t = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/idea.similar', {
            body: { text, excludeIdeaId: idea.id },
          }),
        );
        if (n === asked.current) setMatches(out.ideas as Similar[]);
      } catch {
        // Not finding matches is no reason to shout.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [dupSearch, idea.id, idea.mergedInto]);

  const saveStatus = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run('status', () =>
      command('/v1/commands/idea.set_status', {
        ideaId: idea.id,
        status,
        note: note.trim(),
        notify,
      }),
    );
    if (ok) setNote('');
  };
  const sendAnswer = async (e: FormEvent) => {
    e.preventDefault();
    if (!answer.trim()) return;
    const ok = await run('answer', () =>
      command('/v1/commands/idea.comment', { ideaId: idea.id, body: answer.trim() }),
    );
    if (ok) setAnswer('');
  };
  const saveWords = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run('edit', () =>
      command('/v1/commands/idea.edit', {
        ideaId: idea.id,
        title: title.trim(),
        body: body.trim(),
        areaId,
      }),
    );
    if (ok) setEditing(false);
  };
  const merge = (intoIdeaId: string) =>
    run('merge', () =>
      command('/v1/commands/idea.merge', {
        ideaId: idea.id,
        intoIdeaId,
        note: mergeNote.trim(),
        notify: true,
      }),
    );
  const setHidden = (hidden: boolean) =>
    run('hide', () => command('/v1/commands/idea.set_hidden', { ideaId: idea.id, hidden }));
  const setCommentHidden = (commentId: string, hidden: boolean) =>
    run(`comment-${commentId}`, () =>
      command('/v1/commands/idea.set_comment_hidden', { commentId, hidden }),
    );

  const statusChanged = status !== idea.status;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Link
        href="/admin/ideas"
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Ideas
      </Link>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="rounded-card border border-border bg-card p-5">
            {editing ? (
              <form onSubmit={saveWords} className="flex flex-col gap-4">
                <Field label="Title" htmlFor="team-title">
                  <Input
                    id="team-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={140}
                  />
                </Field>
                <Field label="Details" htmlFor="team-body">
                  <Textarea
                    id="team-body"
                    rows={6}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    maxLength={5000}
                  />
                </Field>
                <Field label="Area" htmlFor="team-area">
                  <Select id="team-area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.archived ? ' (archived)' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" loading={busy === 'edit'}>
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex gap-4">
                <span className="flex h-16 w-14 flex-none flex-col items-center justify-center rounded-control border border-border text-base font-semibold tabular-nums">
                  <ChevronUp className="h-4 w-4 text-text-3" strokeWidth={1.75} aria-hidden />
                  {idea.voteCount}
                </span>
                <div className="min-w-0 flex-1">
                  <h1 className="text-xl font-semibold leading-snug">{idea.title}</h1>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-3">
                    <StatusPill status={idea.status} />
                    <span>{names.get(idea.areaId) ?? idea.areaId}</span>
                    <span>#{idea.number}</span>
                    <span suppressHydrationWarning>{relativeTimeAgo(idea.createdAt)}</span>
                    {idea.hidden ? (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-text">
                        Taken down
                      </span>
                    ) : null}
                  </div>
                  {idea.mergedInto ? (
                    <p className="mt-3 text-[13px]">
                      Merged into{' '}
                      <Link href={`/admin/ideas/${idea.mergedInto.id}`} className="underline">
                        #{idea.mergedInto.number} {idea.mergedInto.title}
                      </Link>
                      .
                    </p>
                  ) : null}
                  {idea.body ? (
                    <PlainText text={idea.body} className="mt-4 text-[14.5px]" />
                  ) : (
                    <p className="mt-4 text-[13px] text-text-3">No details.</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-ml-2"
                      onClick={() => setEditing(true)}
                    >
                      Tidy the words
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === 'hide'}
                      onClick={() => void setHidden(!idea.hidden)}
                      data-testid="idea-hide"
                    >
                      {idea.hidden ? 'Put it back on the board' : 'Take it off the board'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

          {updates.length ? (
            <section className="mt-6">
              <h2 className="text-sm font-semibold">What happened</h2>
              <ol className="mt-2 flex flex-col gap-2 text-[13px]">
                {updates.map((u) => (
                  <li key={u.id} className="rounded-control border border-border bg-card px-3 py-2">
                    <span className="font-medium">
                      {u.kind === 'status'
                        ? u.fromStatus === u.toStatus
                          ? `Update while ${IDEA_STATUS_WORDS[u.toStatus as IdeaStatus]}`
                          : `${IDEA_STATUS_WORDS[u.fromStatus as IdeaStatus]} → ${IDEA_STATUS_WORDS[u.toStatus as IdeaStatus]}`
                        : u.kind === 'merged'
                          ? `Merged into #${u.other?.number ?? '?'}`
                          : `#${u.other?.number ?? '?'} merged in`}
                    </span>
                    <span className="text-text-3">
                      {' '}
                      · {u.by} · {dayWords(u.createdAt)}
                    </span>
                    {u.note ? <p className="mt-1 text-text-2">{u.note}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section className="mt-6">
            <h2 className="text-sm font-semibold">Comments</h2>
            {comments.length ? (
              <ul className="mt-2 flex flex-col gap-2">
                {comments.map((c) => (
                  <li
                    key={c.id}
                    className={cn(
                      'rounded-card border px-4 py-3',
                      c.author.team
                        ? 'border-accent/30 bg-accent-soft/50'
                        : 'border-border bg-card',
                      c.hidden && 'opacity-60',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="font-medium">{c.author.name || 'Someone'}</span>
                      {c.author.team ? (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                          Team
                        </span>
                      ) : null}
                      {c.hidden ? <span className="text-warning-text">Taken down</span> : null}
                      <span className="text-text-3" suppressHydrationWarning>
                        {relativeTimeAgo(c.createdAt)}
                      </span>
                      <button
                        type="button"
                        className="ml-auto text-xs text-text-3 hover:text-text"
                        disabled={busy === `comment-${c.id}`}
                        onClick={() => void setCommentHidden(c.id, !c.hidden)}
                      >
                        {c.hidden ? 'Put back' : 'Take down'}
                      </button>
                    </div>
                    <p className="mt-1 whitespace-pre-line text-[14px]">{c.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-text-3">No comments yet.</p>
            )}
            {idea.mergedInto ? null : (
              <form onSubmit={sendAnswer} className="mt-3 flex flex-col gap-2">
                <label htmlFor="team-answer" className="text-[13px] font-medium">
                  Answer as the team
                </label>
                <Textarea
                  id="team-answer"
                  rows={3}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Everybody sees this with the HandsFreeOS badge, and whoever shared the idea is emailed."
                  data-testid="team-answer"
                />
                <div>
                  <Button
                    type="submit"
                    size="sm"
                    loading={busy === 'answer'}
                    disabled={!answer.trim()}
                  >
                    Post answer
                  </Button>
                </div>
              </form>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          {can.manage && !idea.mergedInto ? (
            <form
              onSubmit={saveStatus}
              className="rounded-card border border-border bg-card p-4"
              data-testid="idea-status-form"
            >
              <h2 className="text-sm font-semibold">Where it stands</h2>
              <Select
                className="mt-2"
                value={status}
                onChange={(e) => setStatus(e.target.value as IdeaStatus)}
                aria-label="Status"
                data-testid="idea-status-select"
              >
                {IDEA_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {IDEA_STATUS_WORDS[s]}
                  </option>
                ))}
              </Select>
              <Textarea
                className="mt-2"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  statusChanged
                    ? 'A note for the people following it (optional)'
                    : 'Or post an update without moving it'
                }
                maxLength={2000}
                aria-label="Note for followers"
                data-testid="idea-status-note"
              />
              <Checkbox
                className="mt-2"
                label={`Email the ${team.followerCount === 1 ? 'one person' : `${team.followerCount} people`} following it`}
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
              <Button
                type="submit"
                className="mt-3 w-full"
                loading={busy === 'status'}
                disabled={!statusChanged && !note.trim()}
                data-testid="idea-status-save"
              >
                {statusChanged ? `Move to ${IDEA_STATUS_WORDS[status]}` : 'Post the update'}
              </Button>
            </form>
          ) : null}

          <section className="rounded-card border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Who is behind it</h2>
            {team.author ? (
              <p className="mt-2 text-[13px]">
                Shared by{' '}
                <span className="font-medium">{team.author.name || team.author.email}</span>
                <br />
                <span className="text-text-3">{team.author.email}</span>
                {team.business ? (
                  <>
                    <br />
                    <Link
                      href={`/admin/businesses/${team.business.id}`}
                      className="inline-flex items-center gap-1 text-accent-text hover:underline"
                    >
                      {team.business.name}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </Link>
                  </>
                ) : null}
              </p>
            ) : (
              <p className="mt-2 text-[13px] text-text-3">Shared by someone who has since left.</p>
            )}
            <p className="mt-3 text-[13px]">
              {team.voters.length === 1 ? '1 vote' : `${team.voters.length} votes`} from{' '}
              {team.businessCount === 1 ? '1 business' : `${team.businessCount} businesses`} ·{' '}
              {team.followerCount} following
            </p>
            {team.voters.length ? (
              <ul className="mt-2 max-h-72 divide-y divide-border overflow-y-auto rounded-control border border-border text-[13px]">
                {team.voters.map((v) => (
                  <li key={v.userId} className="px-3 py-2">
                    <span className="font-medium">{v.name || v.email}</span>
                    <span className="block truncate text-xs text-text-3">
                      {v.business?.name ?? 'No business'} · {dayWords(v.votedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {idea.mergedInto ? null : (
            <section className="rounded-card border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Is it a duplicate?</h2>
              <p className="mt-1 text-xs text-text-3">
                Merging moves its votes and followers to the other idea and tells them where it
                went.
              </p>
              <Input
                className="mt-2"
                inputSize="sm"
                value={dupSearch}
                onChange={(e) => setDupSearch(e.target.value)}
                aria-label="Find the idea it repeats"
                placeholder="Find the idea it repeats"
              />
              {matches.length ? (
                <>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {matches.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-[13px]">
                        <span className="min-w-0 flex-1 truncate">
                          #{m.number} {m.title} <span className="text-text-3">· {m.voteCount}</span>
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === 'merge'}
                          onClick={() => {
                            if (window.confirm(`Merge #${idea.number} into #${m.number}?`))
                              void merge(m.id);
                          }}
                        >
                          Merge into
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Input
                    className="mt-2"
                    inputSize="sm"
                    value={mergeNote}
                    onChange={(e) => setMergeNote(e.target.value)}
                    placeholder="A note for its followers (optional)"
                    aria-label="Note for followers"
                  />
                </>
              ) : (
                <p className="mt-2 text-xs text-text-3">No other idea sounds like it.</p>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
