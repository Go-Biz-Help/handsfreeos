'use client';
/**
 * The team's live poll panel in a HandsFreeOS video call (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2; the
 * owner's 14): which poll the call uses, the question up next with Ask now and Skip, the one that's up with its
 * answers coming in and Close, and every question's totals. Only the team sees it. It reads `video_call.polls` every
 * couple of seconds while a question is up, and less often otherwise.
 */
import { POLL_PANEL_POLL_MS, POLL_WORDS, QUESTION_LABELS, pollSecondsLeft } from '@hfos/core';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { Panel } from './call-panels';
import { toast } from './toast';
import type { TeamSide } from './types';

const readPolls = (team: TeamSide) =>
  apiBrowser()
    .POST('/v1/queries/video_call.polls', {
      body: { workspaceId: team.workspaceId, callId: team.callId },
    })
    .then(unwrap);

type Polls = Awaited<ReturnType<typeof readPolls>>;
type PollQuestion = Polls['questions'][number];

/** Less often while nothing is up: someone else on the team may ask one. */
const QUIET_POLL_MS = 6_000;

/** The call's live poll as the team sees it, kept fresh while the panel is open. */
function usePolls(team: TeamSide): { polls: Polls | null; reload: () => void } {
  const [polls, setPolls] = useState<Polls | null>(null);
  const live = useRef(true);
  const reload = useCallback(() => {
    void readPolls(team)
      .then((p) => {
        if (live.current) setPolls(p);
      })
      // A missed read is caught up by the next one.
      .catch(() => undefined);
  }, [team]);
  const open = polls?.questions.some((q) => q.state === 'open') ?? false;
  useEffect(() => {
    live.current = true;
    reload();
    const t = setInterval(reload, open ? POLL_PANEL_POLL_MS : QUIET_POLL_MS);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [reload, open]);
  return { polls, reload };
}

export function PollPanel({ team, onClose }: { team: TeamSide; onClose: () => void }) {
  const { polls, reload } = usePolls(team);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await run();
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const body = { workspaceId: team.workspaceId, callId: team.callId };
  const ask = (q: PollQuestion) =>
    act(`ask:${q.questionId}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/video_call.poll_open', {
          body: { ...body, questionId: q.questionId },
        }),
      ),
    );
  const skip = (q: PollQuestion) =>
    act(`skip:${q.questionId}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/video_call.poll_skip', {
          body: { ...body, questionId: q.questionId },
        }),
      ),
    );
  const close = (q: PollQuestion) =>
    act(`close:${q.questionId}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/video_call.poll_close', {
          body: { ...body, pollId: q.pollId! },
        }),
      ),
    );
  const pick = (formId: string | null) =>
    act('pick', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/video_call.set_poll', { body: { ...body, formId } }),
      ),
    );

  const up = polls?.questions.find((q) => q.state === 'open') ?? null;
  const next = polls?.questions.find((q) => q.state === 'waiting') ?? null;
  const ready = !!polls?.form?.ready;

  return (
    <Panel title={POLL_WORDS.panel} onClose={onClose} testId="call-poll-panel">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {polls === null ? (
          <p className="text-[13px] text-text-3">Loading…</p>
        ) : (
          <>
            <PollPicker
              workspaceId={team.workspaceId}
              current={polls.form}
              locked={!!up}
              busy={busy === 'pick'}
              onPick={(id) => void pick(id)}
            />
            {polls.form && !ready ? (
              <p className="text-[13px] text-text-2" data-testid="call-poll-unpublished">
                {POLL_WORDS.unpublished(polls.form.name)}
              </p>
            ) : null}
            {up ? (
              <UpNow
                q={up}
                watching={polls.watching}
                busy={busy === `close:${up.questionId}`}
                onClose={() => void close(up)}
              />
            ) : null}
            {ready && next && !up ? (
              <section
                className="rounded-card border border-border p-3"
                data-testid="call-poll-next"
              >
                <p className="text-[11.5px] font-medium uppercase tracking-wide text-text-3">
                  {POLL_WORDS.upNext}
                </p>
                <p className="mt-1 text-[14px] font-medium">{next.title}</p>
                <p className="text-[12px] text-text-3">
                  {QUESTION_LABELS[next.type as keyof typeof QUESTION_LABELS] ?? next.type} ·{' '}
                  {next.seconds}s
                </p>
                <div className="mt-2.5 flex gap-2">
                  <Button
                    size="sm"
                    loading={busy === `ask:${next.questionId}`}
                    onClick={() => void ask(next)}
                    data-testid="call-poll-ask-next"
                  >
                    {POLL_WORDS.askNow}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `skip:${next.questionId}`}
                    onClick={() => void skip(next)}
                    data-testid="call-poll-skip"
                  >
                    {POLL_WORDS.skip}
                  </Button>
                </div>
              </section>
            ) : null}
            {ready && !up && !next && polls.questions.length ? (
              <p className="text-[13px] text-text-3">{POLL_WORDS.allAsked}</p>
            ) : null}
            {polls.questions.length ? (
              <ul className="flex flex-col gap-2" data-testid="call-poll-questions">
                {polls.questions.map((q) => (
                  <QuestionRow
                    key={q.questionId}
                    q={q}
                    canAsk={ready && q.state !== 'open' && q.state !== 'closed'}
                    busy={busy === `ask:${q.questionId}`}
                    onAsk={() => void ask(q)}
                  />
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

/** Which live poll the call uses, and changing it while nothing is up. */
function PollPicker({
  workspaceId,
  current,
  locked,
  busy,
  onPick,
}: {
  workspaceId: string;
  current: Polls['form'];
  locked: boolean;
  busy: boolean;
  onPick: (formId: string | null) => void;
}) {
  const [choices, setChoices] = useState<{ formId: string; name: string }[] | null>(null);
  const load = () => {
    if (choices) return;
    void apiBrowser()
      .POST('/v1/queries/form.list', { body: { workspaceId, mode: ['poll'] } })
      .then(unwrap)
      .then((r) => setChoices(r.items.map((f) => ({ formId: f.formId, name: f.name }))))
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };
  return (
    <div className="flex flex-col gap-1">
      <DropdownMenu onOpenChange={(open) => open && load()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={locked || busy}
            className="flex items-center justify-between gap-2 rounded-control border border-border bg-card-2 px-3 py-2 text-left text-[13.5px] disabled:opacity-60"
            data-testid="call-poll-pick"
          >
            <span className="truncate">{current ? current.name : POLL_WORDS.pick}</span>
            <ChevronDown size={14} aria-hidden className="flex-none text-text-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" data-theme="dark" className="min-w-[260px]">
          {choices === null ? (
            <p className="px-2 py-1.5 text-[12.5px] text-text-3">Loading…</p>
          ) : choices.length === 0 ? (
            <p className="max-w-[260px] px-2 py-1.5 text-[12.5px] text-text-3">
              {POLL_WORDS.pickHelp}
            </p>
          ) : (
            choices.map((c) => (
              <DropdownMenuItem
                key={c.formId}
                onSelect={() => onPick(c.formId)}
                data-testid={`call-poll-choice-${c.formId}`}
              >
                {c.name}
              </DropdownMenuItem>
            ))
          )}
          {current ? (
            <DropdownMenuItem onSelect={() => onPick(null)}>{POLL_WORDS.none}</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {!current ? <p className="text-[12px] text-text-3">{POLL_WORDS.pickHelp}</p> : null}
    </div>
  );
}

/** The question that's up: its time left, the answers coming in, and Close. */
function UpNow({
  q,
  watching,
  busy,
  onClose,
}: {
  q: PollQuestion;
  watching: number;
  busy: boolean;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = q.closesAt ? pollSecondsLeft(q.closesAt, now) : 0;
  return (
    <section className="rounded-card border border-accent p-3" data-testid="call-poll-up">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] font-medium uppercase tracking-wide text-accent-text">
          {q.openedBy === 'ai' ? (
            <span className="inline-flex items-center gap-1">
              <Sparkles size={12} aria-hidden /> {POLL_WORDS.byAi}
            </span>
          ) : (
            'Up now'
          )}
        </p>
        <span className="text-[12px] tabular-nums text-text-3">{POLL_WORDS.secondsLeft(left)}</span>
      </div>
      <p className="mt-1 text-[14px] font-medium">{q.title}</p>
      <p className="text-[12px] text-text-3" data-testid="call-poll-answered">
        {q.type === 'button'
          ? POLL_WORDS.pressed(q.totals.answered)
          : POLL_WORDS.answered(q.totals.answered, watching)}
      </p>
      <Answers q={q} />
      <Button
        size="sm"
        variant="secondary"
        className="mt-2.5"
        loading={busy}
        onClick={onClose}
        data-testid="call-poll-close"
      >
        {POLL_WORDS.close}
      </Button>
    </section>
  );
}

/** One question in the list: how it stands, its totals once asked, and Ask now while it can be. */
function QuestionRow({
  q,
  canAsk,
  busy,
  onAsk,
}: {
  q: PollQuestion;
  canAsk: boolean;
  busy: boolean;
  onAsk: () => void;
}) {
  const [open, setOpen] = useState(false);
  const state =
    q.state === 'closed'
      ? POLL_WORDS.asked
      : q.state === 'skipped'
        ? POLL_WORDS.skipped
        : q.state === 'open'
          ? 'Up now'
          : null;
  return (
    <li
      className="rounded-card border border-border px-3 py-2"
      data-testid="call-poll-question"
      data-state={q.state}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="block text-[13.5px] font-medium">{q.title}</span>
          <span className="block text-[12px] text-text-3">
            {state ? `${state} · ` : ''}
            {q.state === 'closed' || q.state === 'open'
              ? q.type === 'button'
                ? POLL_WORDS.pressed(q.totals.answered)
                : POLL_WORDS.answered(q.totals.answered, 0)
              : q.showResults
                ? POLL_WORDS.everyoneSees
                : POLL_WORDS.teamSees}
          </span>
        </button>
        {canAsk ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={onAsk}
            data-testid="call-poll-ask"
          >
            {POLL_WORDS.askNow}
          </Button>
        ) : null}
      </div>
      {open && (q.state === 'closed' || q.state === 'open') ? <Answers q={q} /> : null}
    </li>
  );
}

/** The totals as bars, the average, what people typed, or who pressed the button. */
export function Answers({ q }: { q: Pick<PollQuestion, 'totals' | 'texts' | 'pressed'> }) {
  const most = Math.max(1, ...q.totals.bars.map((b) => b.count));
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {q.totals.average !== null ? (
        <p className="text-[12.5px] text-text-2">Average {q.totals.average}</p>
      ) : null}
      {q.totals.bars.map((b) => (
        <div key={b.id} className="flex items-center gap-2 text-[12.5px]">
          <span className="w-24 flex-none truncate text-text-2">{b.label}</span>
          <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-card-2">
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full bg-accent')}
              style={{ width: `${(b.count / most) * 100}%` }}
            />
          </span>
          <span className="w-8 flex-none text-right tabular-nums text-text-3">{b.count}</span>
        </div>
      ))}
      {q.texts.map((t, i) => (
        <p key={i} className="text-[12.5px]">
          <span className="text-text-3">{t.name}: </span>
          {t.text}
        </p>
      ))}
      {q.pressed.length ? (
        <p className="text-[12.5px] text-text-2">{q.pressed.map((p) => p.name).join(', ')}</p>
      ) : null}
    </div>
  );
}
