'use client';
/**
 * The team's live poll panel in a HandsFreeOS video call (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2; the
 * owner's 14): which poll the call uses, the question up next with Ask now and Skip, the one that's up with its
 * answers coming in and Close, and every question's totals. Only the team sees it. It reads `video_call.polls` every
 * couple of seconds while a question is up, and less often otherwise.
 *
 * Part 3: how far the AI goes with the poll (`video_call.set_poll_ai`), a note when it can't hear (AI notes off), the
 * questions not asked yet in the webinar's last minutes (the owner's 19), and `PollOffer`, the AI's "Ask now?" over
 * the stage, panel open or not.
 */
import {
  POLL_AI_MODES,
  POLL_LAST_MINUTES,
  POLL_PANEL_POLL_MS,
  POLL_SUGGEST_MS,
  POLL_WORDS,
  QUESTION_LABELS,
  VIDEO_CALL_POLLS_TOPIC,
  pollSecondsLeft,
  readPollMessage,
  type PollAiMode,
} from '@hfos/core';
import { useDataChannel } from '@livekit/components-react';
import { ChevronDown, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
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
  const setAi = (ai: PollAiMode) =>
    act('ai', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/video_call.set_poll_ai', { body: { ...body, ai } }),
      ),
    );

  const up = polls?.questions.find((q) => q.state === 'open') ?? null;
  const next = polls?.questions.find((q) => q.state === 'waiting') ?? null;
  const ready = !!polls?.form?.ready;
  const nearlyOver = useNearlyOver(polls?.endsAt ?? null);
  const notYet = nearlyOver
    ? (polls?.questions.filter((q) => q.state === 'waiting' || q.state === 'skipped') ?? [])
    : [];

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
            {polls.form ? (
              <div className="flex flex-col gap-1">
                <label className="text-[12px] text-text-3" htmlFor="call-poll-ai">
                  {POLL_WORDS.aiMode}
                </label>
                <Select
                  id="call-poll-ai"
                  selectSize="sm"
                  value={polls.ai}
                  onChange={(e) => void setAi(e.target.value as PollAiMode)}
                  disabled={busy === 'ai'}
                  data-testid="call-poll-ai"
                >
                  {POLL_AI_MODES.map((m) => (
                    <option key={m} value={m}>
                      {POLL_WORDS.aiModes[m]}
                    </option>
                  ))}
                </Select>
                {polls.ai !== 'off' && !polls.hearing ? (
                  <p className="text-[12px] text-warning-text" data-testid="call-poll-deaf">
                    {POLL_WORDS.aiDeaf}
                  </p>
                ) : null}
              </div>
            ) : null}
            {ready && notYet.length && !up ? (
              <section
                className="rounded-card border border-warning-border p-3"
                data-testid="call-poll-not-yet"
              >
                <p className="text-[11.5px] font-medium uppercase tracking-wide text-warning-text">
                  {POLL_WORDS.notYet}
                </p>
                <p className="text-[12px] text-text-3">{POLL_WORDS.notYetHelp}</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {notYet.map((q) => (
                    <li key={q.questionId} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">{q.title}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === `ask:${q.questionId}`}
                        onClick={() => void ask(q)}
                      >
                        {POLL_WORDS.askNow}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
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

/** Whether the call is in its last few minutes, by the appointment's end; checked every half minute. */
function useNearlyOver(endsAt: string | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [endsAt]);
  return !!endsAt && new Date(endsAt).getTime() - now <= POLL_LAST_MINUTES * 60_000;
}

type Offer = {
  readonly questionId: string;
  readonly title: string;
  readonly why: string;
  readonly until: number;
};

/**
 * The AI's "Ask now?" for the team (part 3, the owner's 12): a question it thinks fits what was just said, over the
 * stage whether the panel is open or not, for half a minute. Ask now pops it up as the person; the AI never sends
 * this to attendees, and only the server's word counts.
 */
export function PollOffer({ team }: { team: TeamSide }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  useDataChannel(VIDEO_CALL_POLLS_TOPIC, (msg) => {
    if (msg.from) return;
    const m = readPollMessage(msg.payload);
    if (m?.t === 'suggest')
      setOffer({
        questionId: m.questionId,
        title: m.title,
        why: m.why,
        until: Math.min(new Date(m.until).getTime(), Date.now() + POLL_SUGGEST_MS),
      });
    // A question went up (asked by anyone): the offer has had its moment.
    else if (m?.t === 'open') setOffer(null);
  });
  useEffect(() => {
    if (!offer) return undefined;
    const t = setTimeout(() => setOffer(null), Math.max(0, offer.until - Date.now()));
    return () => clearTimeout(t);
  }, [offer]);
  if (!offer) return null;
  const ask = async () => {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/video_call.poll_open', {
          body: {
            workspaceId: team.workspaceId,
            callId: team.callId,
            questionId: offer.questionId,
          },
        }),
      );
      setOffer(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="absolute inset-x-2 top-2 z-30 mx-auto max-w-[380px] rounded-card border border-accent bg-card p-3 shadow-3"
      role="dialog"
      aria-label={POLL_WORDS.suggestTitle}
      data-testid="call-poll-offer"
    >
      <div className="flex items-start gap-2">
        <Sparkles size={16} aria-hidden className="mt-0.5 flex-none text-accent-text" />
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-medium uppercase tracking-wide text-accent-text">
            {POLL_WORDS.suggestTitle}
          </p>
          <p className="text-[14px] font-medium">{offer.title}</p>
          <p className="text-[12px] text-text-3">{offer.why || POLL_WORDS.suggestHelp}</p>
        </div>
        <button
          type="button"
          aria-label="Not now"
          onClick={() => setOffer(null)}
          className="rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text"
        >
          <X size={16} />
        </button>
      </div>
      <Button
        size="sm"
        className="mt-2.5 w-full"
        loading={busy}
        onClick={() => void ask()}
        data-testid="call-poll-offer-ask"
      >
        {POLL_WORDS.askNow}
      </Button>
    </div>
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
