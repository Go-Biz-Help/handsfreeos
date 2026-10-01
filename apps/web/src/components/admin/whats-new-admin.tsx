'use client';
import {
  IDEA_STATUS_WORDS,
  IDEAS_WORDS,
  WHATS_NEW_KIND_WORDS,
  WHATS_NEW_TEAM_WORDS,
  type IdeaStatus,
  type WhatsNewKind,
} from '@hfos/core';
import { ArrowLeft, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { dayWords, KindPill, PlainText } from '@/components/ideas/idea-bits';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea, WhatsNewEntry } from '@/lib/api/types';

type LinkedIdea = { id: string; number: number; title: string; status: IdeaStatus };

interface Draft {
  readonly id: string | null;
  readonly title: string;
  readonly body: string;
  readonly kind: WhatsNewKind;
  readonly areaId: string;
  readonly ideas: readonly LinkedIdea[];
}

const blank: Draft = { id: null, title: '', body: '', kind: 'new', areaId: '', ideas: [] };

/**
 * Writing What's new. An entry is a draft only the team sees until it is published; publishing marks the ideas
 * it delivers Done (unless told not to) and emails everybody following them — the moment a person who asked for
 * something hears that it is here.
 */
export function WhatsNewAdmin({
  entries,
  areas,
  canManage,
}: {
  entries: readonly WhatsNewEntry[];
  areas: readonly IdeaArea[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<LinkedIdea[]>([]);
  const [markDone, setMarkDone] = useState(true);
  const asked = useRef(0);
  const names = new Map(areas.map((a) => [a.id, a.name]));

  // The generated client's types go several thousand paths deep; one cast here keeps the compiler sane.
  const command = (path: string, input: object) =>
    (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
      body: input,
    }).then(unwrap);

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

  useEffect(() => {
    const text = find.trim();
    if (!draft || text.length < 3) {
      setFound([]);
      return;
    }
    const n = ++asked.current;
    const t = setTimeout(async () => {
      try {
        const out = unwrap(await apiBrowser().POST('/v1/queries/idea.similar', { body: { text } }));
        if (n === asked.current) setFound(out.ideas as LinkedIdea[]);
      } catch {
        // Finding nothing is fine.
      }
    }, 300);
    return () => clearTimeout(t);
  }, [find, draft]);

  const edit = (e: WhatsNewEntry) =>
    setDraft({
      id: e.id,
      title: e.title,
      body: e.body,
      kind: e.kind,
      areaId: e.areaId ?? '',
      ideas: e.ideas.map((i) => ({ id: i.id, number: i.number, title: i.title, status: i.status })),
    });

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!draft) return;
    const ok = await run(
      'save',
      () =>
        command('/v1/commands/whats_new.save', {
          ...(draft.id ? { id: draft.id } : {}),
          title: draft.title.trim(),
          body: draft.body.trim(),
          kind: draft.kind,
          areaId: draft.areaId || null,
          ideaIds: draft.ideas.map((i) => i.id),
        }),
      WHATS_NEW_TEAM_WORDS.savedDraft,
    );
    if (ok) {
      setDraft(null);
      setFind('');
    }
  };

  const publish = (e: WhatsNewEntry) => {
    const linked = e.ideas.filter((i) => i.status !== 'done').length;
    if (!window.confirm(WHATS_NEW_TEAM_WORDS.publishQuestion(e.title, linked, markDone))) return;
    void run(
      `publish-${e.id}`,
      () => command('/v1/commands/whats_new.publish', { id: e.id, markIdeasDone: markDone }),
      WHATS_NEW_TEAM_WORDS.publishedToast,
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link
        href="/admin/ideas"
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        {IDEAS_WORDS.title}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">{IDEAS_WORDS.tabs.whatsNew}</h1>
        {canManage && !draft ? (
          <Button onClick={() => setDraft(blank)} data-testid="whats-new-add">
            {WHATS_NEW_TEAM_WORDS.write}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-text-3">{WHATS_NEW_TEAM_WORDS.intro}</p>
      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      {draft ? (
        <form
          onSubmit={save}
          className="mt-4 flex flex-col gap-4 rounded-card border border-border bg-card p-5"
          data-testid="whats-new-editor"
        >
          <Field label={WHATS_NEW_TEAM_WORDS.titleLabel} htmlFor="wn-title">
            <Input
              id="wn-title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              maxLength={140}
              placeholder={WHATS_NEW_TEAM_WORDS.titlePlaceholder}
              data-testid="wn-title"
            />
          </Field>
          <div className="flex flex-wrap gap-4">
            <div>
              <p className="mb-1.5 text-[13px] font-medium">{WHATS_NEW_TEAM_WORDS.kindLabel}</p>
              <Segmented
                value={draft.kind}
                onChange={(kind) => setDraft({ ...draft, kind })}
                ariaLabel={WHATS_NEW_TEAM_WORDS.kindLabel}
                options={(['new', 'improved', 'fixed'] as const).map((k) => ({
                  value: k,
                  label: WHATS_NEW_KIND_WORDS[k],
                }))}
              />
            </div>
            <Field
              label={WHATS_NEW_TEAM_WORDS.areaLabel}
              htmlFor="wn-area"
              className="min-w-[220px] flex-1"
            >
              <Select
                id="wn-area"
                value={draft.areaId}
                onChange={(e) => setDraft({ ...draft, areaId: e.target.value })}
              >
                <option value="">{WHATS_NEW_TEAM_WORDS.noArea}</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label={WHATS_NEW_TEAM_WORDS.bodyLabel}
            htmlFor="wn-body"
            hint={WHATS_NEW_TEAM_WORDS.bodyHint}
          >
            <Textarea
              id="wn-body"
              rows={7}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              maxLength={20000}
              data-testid="wn-body"
            />
          </Field>
          <div>
            <p className="text-[13px] font-medium">{WHATS_NEW_TEAM_WORDS.ideasLabel}</p>
            <p className="text-xs text-text-3">{WHATS_NEW_TEAM_WORDS.ideasHint}</p>
            {draft.ideas.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {draft.ideas.map((i) => (
                  <li
                    key={i.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card-2 py-1 pl-3 pr-1 text-[13px]"
                  >
                    #{i.number} {i.title}
                    <button
                      type="button"
                      aria-label={WHATS_NEW_TEAM_WORDS.removeIdea(i.number)}
                      className="rounded-full p-0.5 text-text-3 hover:bg-card-3 hover:text-text"
                      onClick={() =>
                        setDraft({ ...draft, ideas: draft.ideas.filter((x) => x.id !== i.id) })
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Input
              className="mt-2"
              inputSize="sm"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={WHATS_NEW_TEAM_WORDS.findIdea}
              aria-label={WHATS_NEW_TEAM_WORDS.findIdea}
              data-testid="wn-find"
            />
            {found.length ? (
              <ul className="mt-1.5 flex flex-col gap-1">
                {found
                  .filter((f) => !draft.ideas.some((i) => i.id === f.id))
                  .map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        className="w-full truncate rounded-control px-2 py-1.5 text-left text-[13px] hover:bg-card-2"
                        onClick={() => {
                          setDraft({ ...draft, ideas: [...draft.ideas, f] });
                          setFind('');
                        }}
                      >
                        #{f.number} {f.title}{' '}
                        <span className="text-text-3">· {IDEA_STATUS_WORDS[f.status]}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="submit" loading={busy === 'save'} data-testid="wn-save">
              {WHATS_NEW_TEAM_WORDS.saveDraft}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {WHATS_NEW_TEAM_WORDS.cancel}
            </Button>
          </div>
        </form>
      ) : null}

      {canManage ? (
        <Checkbox
          className="mt-4"
          label={WHATS_NEW_TEAM_WORDS.markDone}
          checked={markDone}
          onChange={(e) => setMarkDone(e.target.checked)}
        />
      ) : null}

      <ul className="mt-4 flex flex-col gap-3">
        {entries.map((e) => (
          <li
            key={e.id}
            className="rounded-card border border-border bg-card p-5"
            data-testid="wn-entry"
          >
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-3">
              <KindPill kind={e.kind} />
              {e.publishedAt ? (
                <span>{WHATS_NEW_TEAM_WORDS.published(dayWords(e.publishedAt))}</span>
              ) : (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-text">
                  {WHATS_NEW_TEAM_WORDS.draft}
                </span>
              )}
              {e.areaId ? <span>· {names.get(e.areaId) ?? e.areaId}</span> : null}
            </div>
            <h2 className="mt-2 text-lg font-semibold">{e.title}</h2>
            {e.body ? <PlainText text={e.body} className="mt-1 text-[14px]" /> : null}
            {e.ideas.length ? (
              <p className="mt-3 text-[13px] text-text-2">
                {WHATS_NEW_TEAM_WORDS.delivers}{' '}
                {e.ideas.map((i, n) => (
                  <span key={i.id}>
                    {n ? ', ' : ''}
                    <Link href={`/admin/ideas/${i.id}`} className="underline">
                      #{i.number} {i.title}
                    </Link>{' '}
                    ({IDEA_STATUS_WORDS[i.status]})
                  </span>
                ))}
              </p>
            ) : null}
            {canManage ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => edit(e)}>
                  {WHATS_NEW_TEAM_WORDS.edit}
                </Button>
                {e.publishedAt ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `unpublish-${e.id}`}
                    onClick={() =>
                      void run(
                        `unpublish-${e.id}`,
                        () => command('/v1/commands/whats_new.unpublish', { id: e.id }),
                        WHATS_NEW_TEAM_WORDS.unpublished,
                      )
                    }
                  >
                    {WHATS_NEW_TEAM_WORDS.unpublish}
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      loading={busy === `publish-${e.id}`}
                      onClick={() => publish(e)}
                      data-testid="wn-publish"
                    >
                      {WHATS_NEW_TEAM_WORDS.publish}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `delete-${e.id}`}
                      onClick={() => {
                        if (window.confirm(WHATS_NEW_TEAM_WORDS.deleteQuestion(e.title)))
                          void run(
                            `delete-${e.id}`,
                            () => command('/v1/commands/whats_new.delete', { id: e.id }),
                            WHATS_NEW_TEAM_WORDS.deleted,
                          );
                      }}
                    >
                      {WHATS_NEW_TEAM_WORDS.delete}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
