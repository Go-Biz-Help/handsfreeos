'use client';
/**
 * The guided website chat setup on the web (the owner, 23 Nov 2026: W1 a, W2 b, W3 a, W4 b): Settings → Website chat
 * opens it (Start, Change, Go through the questions again). Six questions on a page of their own (which website shows
 * the chat, who answers, what happens while nobody is answering, what it asks visitors for, how it looks, where its
 * button sits), then Check it over, where Turn on website chat makes the chat with all of them (chat_setup.save), and
 * picking the AI teammate turns on its Website chat too (W1). A new chat goes on to "Put it on your site"
 * (ChatSetupInstall), then Done. Every answer is saved as it's given (guided_setup.save_draft), so leaving and coming
 * back opens on the same question with the same answers.
 *
 * Where the answers start, what is wrong with one, the lines beside the questions and what Turn on website chat sends
 * are core's (guided-setup/chat.ts), shared with the phone.
 */
import {
  CHAT_SETUP_LIFTS,
  CHAT_SETUP_QUESTIONS,
  CHAT_SETUP_WORDS as W,
  chatDoneChips,
  chatSetupAnswersFromWidget,
  chatSetupAnswersOf,
  chatSetupFirstProblem,
  chatSetupLines,
  chatSetupProblems,
  chatSetupQuestionOf,
  chatSetupScreen,
  chatSetupStart,
  chatSetupSwatches,
  chatSetupTeammateChange,
  chatSiteShown,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  logoBox,
  MAX_CHAT_ORIGINS,
  normalizeChatOrigin,
  normalizeChatOrigins,
  readableTextOn,
  type ChatSetupAnswers,
  type ChatSetupContext,
  type ChatSetupQuestion,
  type ChatSetupScreen,
} from '@hfos/core';
import { Bot, Check, Copy, ExternalLink, Globe, MessageCircle, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ChoiceTile,
  Choices,
  GuidedCard,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
  type GuidedStep,
} from '@/components/guided-setup/frame';
import {
  InstallCheck,
  PlatformSteps,
  SnippetCode,
  snippetOf,
  snippetSrc,
} from '@/components/settings/chat-install';
import { WebPersonButton } from '@/components/settings/web-person';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { copyText } from '@/components/ui/copy-field';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { ChatWidget } from '@/lib/api/types';
import { markOf } from '@/lib/chat/look';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';

/** Where the setup was opened from, and so where Finish later and Done go back to. */
export type ChatSetupFrom = 'setup' | 'settings';

export const chatSetupHome = (workspaceId: string, from: ChatSetupFrom): string =>
  from === 'setup' ? `/app/w/${workspaceId}` : `/app/w/${workspaceId}/settings/website-chat`;

const setupHref = (workspaceId: string, from: ChatSetupFrom, query: string) =>
  `/onboarding/${workspaceId}/chat?${query}${from === 'setup' ? '&from=setup' : ''}`;

/** The business's logo as the chat draws it, and its name, for the preview. */
export interface ChatSetupBrand {
  readonly businessName: string;
  readonly logo: { readonly url: string; readonly width: number; readonly height: number } | null;
}

type Problems = Partial<Record<keyof ChatSetupAnswers, string>>;

const problemsOf = (q: ChatSetupScreen, a: ChatSetupAnswers, ctx: ChatSetupContext): Problems =>
  Object.fromEntries(chatSetupProblems(q, a, ctx).map((p) => [p.path, p.message]));

export function ChatSetupFlow({
  workspaceId,
  email,
  firstName,
  ctx,
  brand,
  draft,
  at,
  from,
}: {
  workspaceId: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  ctx: ChatSetupContext;
  brand: ChatSetupBrand;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
  /** `?at=`: Settings → Website chat's Change opens that question, and Next goes to Check it over. */
  at: ChatSetupScreen | null;
  from: ChatSetupFrom;
}) {
  const router = useRouter();
  const businessName = brand.businessName;
  const home = chatSetupHome(workspaceId, from);
  const widgetId = ctx.widget?.id ?? null;
  const [first] = useState(() => {
    const start = chatSetupStart(ctx);
    // A Change from Settings starts from the chat as it is; a draft for another chat (or for none, now there's one)
    // is for questions this one doesn't ask.
    const usable =
      !at &&
      draft.answers &&
      draft.answers['mode'] === ctx.mode &&
      (draft.answers['widgetId'] ?? null) === widgetId;
    const kept = usable ? chatSetupAnswersOf(draft.answers, start) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = useState<ChatSetupAnswers>(first.answers);
  const questions = CHAT_SETUP_QUESTIONS;
  const [screen, setScreen] = useState<ChatSetupScreen>(() => {
    const saved = chatSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : at);
    return saved.success ? saved.data : questions[0];
  });
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState(false);
  /** Check it over's Change (and Settings'): Next goes straight back there, not through every question again. */
  const [returnTo, setReturnTo] = useState<ChatSetupScreen | null>(at ? 'review' : null);
  const [welcome, setWelcome] = useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const [startingOver, setStartingOver] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const saving = useGuidedDraft(
    workspaceId,
    'chat',
    done ? null : { ...answers, at: screen, mode: ctx.mode, widgetId },
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<ChatSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
  };

  const go = (to: ChatSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setWelcome(false);
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));
  const teammate = ctx.teammate;
  const aiName = answers.who === 'ai' && teammate ? teammate.name : null;

  function next() {
    if (screen === 'review') return;
    const found = problemsOf(screen, answers, ctx);
    if (Object.keys(found).length) return setProblems(found);
    const after = questions[i + 1];
    if (returnTo || !after) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(after);
  }

  const back = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  async function finish() {
    const wrong = chatSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(problemsOf(wrong, answers, ctx));
      return;
    }
    setBusy(true);
    setError(null);
    let out: { widgetId: string; created: boolean; teammateChat: string };
    try {
      await saving.flush();
      out = unwrap(
        await apiBrowser().POST('/v1/commands/chat_setup.save', {
          body: { workspaceId, widgetId, answers },
        }),
      );
    } catch (e) {
      setBusy(false);
      // A refusal about one answer opens that question with the words under it.
      const hit = e instanceof ApiError ? refusalOf(e) : null;
      if (hit) {
        go(hit.question);
        setProblems({ [hit.field]: hit.message });
        return;
      }
      setError(errorMessage(e));
      return;
    }
    setDone(true);
    await saving.clear();
    if (out.teammateChat === 'not_allowed' && teammate)
      toast.warning(W.review.notAllowedTeammate(teammate.name));
    if (!out.created) {
      toast.success(W.review.saved);
      router.push(home);
      router.refresh();
      return;
    }
    router.push(setupHref(workspaceId, from, 'step=install&new=1'));
  }

  async function leave(to = home) {
    setLeaving(true);
    await saving.flush();
    router.push(to);
    router.refresh();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(chatSetupStart(ctx));
    setStartingOver(false);
    setReturnTo(null);
    go(questions[0]);
  }

  const page = (children: ReactNode) => (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
    >
      <div ref={top} className="w-full scroll-mt-20">
        {children}
      </div>
    </GuidedPage>
  );

  const lines = chatSetupLines(answers, ctx);
  const steps: GuidedStep[] = lines.map((l, n) => ({
    key: l.key,
    label: l.label,
    value: l.value,
    state: n < i ? 'done' : n === i ? 'now' : 'todo',
  }));
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      startingOver ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-menu bg-card-2 px-3.5 py-3 text-[13.5px]"
          role="alertdialog"
          aria-label={G.startOver}
        >
          <span>{G.startOverConfirm}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setStartingOver(false)}>
              Keep my answers
            </Button>
            <Button size="sm" onClick={() => void startOver()} data-testid="guided-start-over-yes">
              {G.startOver}
            </Button>
          </span>
        </div>
      ) : (
        <WelcomeBack
          line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
          onStartOver={() => setStartingOver(true)}
        />
      )
    ) : null;

  const card = (q: ChatSetupQuestion, title: string, hint: string, children: ReactNode) =>
    page(
      <GuidedCard
        screen={q}
        testId="chat-setup"
        kicker={G.question(i + 1, questions.length)}
        title={title}
        hint={hint}
        banner={banner}
        steps={steps}
        stepsTitle={W.soFar}
        stepsNote={
          ctx.mode === 'new' && !first.kept ? (
            <p className="px-2.5 text-[12.5px] text-text-3" data-testid="chat-setup-started-from">
              {W.startedFrom}
            </p>
          ) : null
        }
        footer={
          <GuidedFooter
            onBack={i > 0 ? back : undefined}
            onNext={next}
            busy={busy}
            error={error}
            testId="chat-setup"
            nextLabel={
              returnTo === 'review' || (!returnTo && i === questions.length - 1)
                ? G.checkItOver
                : G.next
            }
          />
        }
      >
        {children}
      </GuidedCard>,
    );

  if (screen === 'review') {
    const change = chatSetupTeammateChange(answers, { teammate, widget: ctx.widget });
    const whatNext =
      ctx.mode === 'again'
        ? [W.review.nextSave]
        : [
            W.review.nextOn,
            ...(aiName && (change === 'turn_on' || change === 'move')
              ? [W.review.nextAi(aiName)]
              : []),
            W.review.nextCode,
          ];
    return page(
      <GuidedCard
        screen="review"
        testId="chat-setup"
        kicker={G.checkKicker}
        title={W.review.title}
        hint={`${ctx.mode === 'new' ? W.review.hintNew : W.review.hintAgain} ${G.answersKept}`}
        banner={banner}
        aside={
          <>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {W.review.next}
            </div>
            <ol className="flex flex-col gap-3">
              {whatNext.map((line, n) => (
                <li key={line} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-border-strong text-[11px] font-semibold text-text-2"
                  >
                    {n + 1}
                  </span>
                  <span className="text-[13px] text-text-2">{line}</span>
                </li>
              ))}
            </ol>
          </>
        }
        footer={
          <GuidedFooter
            onBack={back}
            onNext={() => void finish()}
            busy={busy}
            error={error}
            nextIcon={false}
            nextLabel={ctx.mode === 'new' ? W.review.turnOn : W.review.save}
            testId="chat-setup"
          />
        }
      >
        <div className="overflow-hidden rounded-menu border border-border">
          {lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
              data-testid={`chat-review-${l.key}`}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
                  {l.label}
                </div>
                <div className="break-words font-semibold">{l.value}</div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReturnTo('review');
                  go(l.key);
                }}
                data-testid={`chat-review-change-${l.key}`}
              >
                {G.change}
              </Button>
            </div>
          ))}
        </div>
        <LookPreview answers={answers} brand={brand} />
      </GuidedCard>,
    );
  }

  switch (screen) {
    case 'sites':
      return card(
        'sites',
        W.sites.title,
        W.sites.hint,
        <SitesQuestion
          sites={answers.sites}
          website={ctx.website}
          problem={problems.sites ?? null}
          onChange={(sites) => set({ sites })}
        />,
      );

    case 'who': {
      const change = chatSetupTeammateChange(answers, { teammate, widget: ctx.widget });
      return card(
        'who',
        W.who.title,
        W.who.hint,
        <>
          <Choices label={W.who.title}>
            {teammate ? (
              <ChoiceTile
                selected={answers.who === 'ai'}
                onSelect={() => set({ who: 'ai' })}
                title={W.who.ai(teammate.name)}
                best={W.who.aiBest}
                hint={W.who.aiHint(teammate.name)}
                testId="chat-setup-who-ai"
              >
                {teammate.status === 'off' ? (
                  <p className="text-[13px] text-text-2" data-testid="chat-setup-who-off">
                    {W.who.off(teammate.name)}
                  </p>
                ) : null}
                {change === 'turn_on' || change === 'move' ? (
                  <p className="text-[13px] text-text-2" data-testid="chat-setup-who-turn-on">
                    {change === 'move' ? W.who.move(teammate.name) : W.who.turnOn(teammate.name)}
                  </p>
                ) : null}
              </ChoiceTile>
            ) : null}
            <ChoiceTile
              selected={answers.who === 'team'}
              onSelect={() => set({ who: 'team' })}
              title={W.who.team}
              best={teammate ? undefined : W.who.aiBest}
              hint={W.who.teamHint}
              testId="chat-setup-who-team"
            />
          </Choices>
          {problems.who ? <FieldError>{problems.who}</FieldError> : null}
          {!teammate ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-menu border border-dashed border-border-strong px-3.5 py-3"
              data-testid="chat-setup-no-teammate"
            >
              <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-accent-soft text-accent-text">
                <Bot className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-semibold">{W.who.noTeammate}</span>
                <span className="text-[13px] text-text-2">{W.who.noTeammateHint}</span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void leave(`/app/w/${workspaceId}/ai-team`)}
                data-testid="chat-setup-set-up-teammate"
              >
                {W.who.setUpTeammate}
              </Button>
            </div>
          ) : null}
        </>,
      );
    }

    case 'away':
      return card(
        'away',
        W.away.title,
        aiName ? W.away.hintAi(aiName) : W.away.hintTeam,
        <>
          <Choices label={W.away.title}>
            <ChoiceTile
              selected={answers.whenAway === 'chat'}
              onSelect={() => set({ whenAway: 'chat' })}
              title={W.away.chat}
              hint={W.away.chatHint}
              testId="chat-setup-away-chat"
            />
            <ChoiceTile
              selected={answers.whenAway === 'away_form'}
              onSelect={() => set({ whenAway: 'away_form' })}
              title={W.away.form}
              hint={W.away.formHint}
              testId="chat-setup-away-form"
            />
          </Choices>
          <div>
            <Label htmlFor="chat-setup-away-message">{W.away.messageLabel}</Label>
            <Textarea
              id="chat-setup-away-message"
              rows={3}
              value={answers.awayMessage}
              onChange={(e) => set({ awayMessage: e.target.value })}
              placeholder={
                answers.whenAway === 'chat' ? W.away.chatPlaceholder : W.away.formPlaceholder
              }
              data-testid="chat-setup-away-message"
            />
            {problems.awayMessage ? (
              <FieldError>{problems.awayMessage}</FieldError>
            ) : (
              <Hint>
                {answers.whenAway === 'chat' ? W.away.chatMessageHint : W.away.formMessageHint}
              </Hint>
            )}
          </div>
        </>,
      );

    case 'ask':
      return card(
        'ask',
        W.ask.title,
        W.ask.hint,
        <>
          <div className="overflow-hidden rounded-menu border border-border">
            {W.ask.rows.map((row) => (
              <div
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span className="font-semibold">{row.label}</span>
                <Select
                  selectSize="sm"
                  className="w-[230px]"
                  value={answers[row.key]}
                  onChange={(e) =>
                    set({ [row.key]: e.target.value as ChatSetupAnswers['askName'] })
                  }
                  aria-label={W.ask.askLabel(row.label)}
                  data-testid={`chat-setup-${row.key}`}
                >
                  {W.ask.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
          <GuidedNote>{aiName ? W.ask.explainAi(aiName) : W.ask.explainTeam}</GuidedNote>
          <div className="flex flex-col gap-1.5">
            <Checkbox
              label={<span className="font-semibold">{W.ask.textsBox}</span>}
              checked={answers.smsConsent}
              onChange={(e) => set({ smsConsent: e.target.checked })}
              data-testid="chat-setup-texts-box"
            />
            {answers.smsConsent ? (
              <p className="ml-7 rounded-menu border border-border bg-card-2 px-3 py-2 text-[12.5px] text-text-2">
                {W.ask.textsWords}
              </p>
            ) : null}
            <Hint className="ml-7">{W.ask.textsHint}</Hint>
          </div>
        </>,
      );

    case 'look':
      return card(
        'look',
        W.look.title,
        W.look.hint,
        <LookQuestion answers={answers} ctx={ctx} brand={brand} problems={problems} set={set} />,
      );

    case 'place':
      return card(
        'place',
        W.place.title,
        W.place.hint,
        <PlaceQuestion answers={answers} problems={problems} set={set} />,
      );
  }
}

/** A refusal from Turn on website chat about one answer: its question, its field and its words. */
function refusalOf(
  e: ApiError,
): { question: ChatSetupQuestion; field: keyof ChatSetupAnswers; message: string } | null {
  if (e.code !== 'validation' || !Array.isArray(e.details)) return null;
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const path = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const hit = chatSetupQuestionOf(path);
    if (hit && typeof d.message === 'string') return { ...hit, message: d.message };
  }
  return null;
}

// ---------- the questions ----------

function SitesQuestion({
  sites,
  website,
  problem,
  onChange,
}: {
  sites: readonly string[];
  website: string | null;
  problem: string | null;
  onChange: (sites: string[]) => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const listed = normalizeChatOrigins(sites, { allowNone: true }).origins;
  const check = value.trim() ? normalizeChatOrigin(value) : null;
  const already = !!check?.ok && listed.includes(check.origin);
  const tooMany =
    !!check?.ok &&
    listed.length + 1 + (check.twin && !listed.includes(check.twin) ? 1 : 0) > MAX_CHAT_ORIGINS;
  const typedProblem = !check
    ? null
    : !check.ok
      ? check.message
      : already
        ? W.sites.already
        : tooMany
          ? W.sites.limit
          : null;
  const note =
    check?.ok && !typedProblem
      ? W.sites.adds(
          chatSiteShown(check.origin),
          check.twin && !listed.includes(check.twin) ? chatSiteShown(check.twin) : null,
        )
      : null;
  const fromSignUp = website ? normalizeChatOrigin(website) : null;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!check?.ok || typedProblem) return;
    onChange([...sites, value.trim()]);
    setValue('');
  };
  return (
    <>
      {sites.length ? (
        <ul
          className="overflow-hidden rounded-menu border border-border"
          aria-label={W.sites.label}
        >
          {sites.map((s, n) => {
            const r = normalizeChatOrigin(s);
            const shown = r.ok ? chatSiteShown(r.origin) : s;
            const signUp = r.ok && fromSignUp?.ok && fromSignUp.origin === r.origin;
            return (
              <li
                key={`${s}-${n}`}
                className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                data-testid="chat-setup-site"
              >
                <Globe className="h-4 w-4 flex-none text-text-3" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    <span className="truncate">{shown}</span>
                    {signUp ? <Badge variant="gray">{W.sites.fromSignUp}</Badge> : null}
                  </span>
                  {r.ok && r.twin ? (
                    <span className="truncate text-[12.5px] text-text-3">
                      {W.sites.twin(chatSiteShown(r.twin))}
                    </span>
                  ) : !r.ok ? (
                    <span className="text-[12.5px] text-danger-text">{r.message}</span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onChange(sites.filter((_, k) => k !== n))}
                  aria-label={W.sites.remove(shown)}
                  title={W.sites.remove(shown)}
                  data-testid="chat-setup-site-remove"
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form onSubmit={add} data-testid="chat-setup-site-add">
        <Label htmlFor={id}>{sites.length ? W.sites.addLabel : W.sites.label}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={W.sites.addPlaceholder}
            autoComplete="off"
            spellCheck={false}
            invalid={!!typedProblem}
            aria-describedby={`${id}-note`}
            data-testid="chat-setup-site-input"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!check?.ok || !!typedProblem}
            data-testid="chat-setup-site-submit"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {W.sites.add}
          </Button>
        </div>
        <p
          id={`${id}-note`}
          role={typedProblem ? 'alert' : undefined}
          className={cn('mt-1.5 text-[12.5px]', typedProblem ? 'text-danger-text' : 'text-text-3')}
          data-testid="chat-setup-site-note"
        >
          {typedProblem ?? note ?? W.sites.limit}
        </p>
      </form>
      {problem ? <FieldError>{problem}</FieldError> : null}
      {!sites.length ? <GuidedNote>{W.sites.noWebsite}</GuidedNote> : null}
    </>
  );
}

function LookQuestion({
  answers,
  ctx,
  brand,
  problems,
  set,
}: {
  answers: ChatSetupAnswers;
  ctx: ChatSetupContext;
  brand: ChatSetupBrand;
  problems: Problems;
  set: (patch: Partial<ChatSetupAnswers>) => void;
}) {
  const swatches = chatSetupSwatches(ctx, answers.accentColor);
  const picked = answers.accentColor.toLowerCase();
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_250px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <Label htmlFor="chat-setup-greeting">{W.look.greeting}</Label>
          <Textarea
            id="chat-setup-greeting"
            rows={3}
            value={answers.greeting}
            onChange={(e) => set({ greeting: e.target.value })}
            data-testid="chat-setup-greeting"
          />
          {problems.greeting ? (
            <FieldError>{problems.greeting}</FieldError>
          ) : (
            <Hint>{W.look.greetingHint}</Hint>
          )}
        </div>
        <div>
          <Label htmlFor="chat-setup-label">{W.look.label}</Label>
          <Input
            id="chat-setup-label"
            value={answers.launcherLabel}
            onChange={(e) => set({ launcherLabel: e.target.value })}
            invalid={!!problems.launcherLabel}
            data-testid="chat-setup-label"
          />
          {problems.launcherLabel ? <FieldError>{problems.launcherLabel}</FieldError> : null}
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium" id="chat-setup-colour">
            {W.look.colour}
          </p>
          <div
            role="radiogroup"
            aria-labelledby="chat-setup-colour"
            className="flex flex-wrap items-center gap-2.5"
          >
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={picked === c}
                aria-label={c === ctx.brandColor ? W.look.yourColour : (W.look.colourNames[c] ?? c)}
                title={c === ctx.brandColor ? W.look.yourColour : (W.look.colourNames[c] ?? c)}
                onClick={() => set({ accentColor: c })}
                className={cn(
                  'h-8 w-8 rounded-full border border-[color-mix(in_oklab,var(--text)_16%,transparent)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                  picked === c && 'ring-2 ring-text ring-offset-2 ring-offset-card',
                )}
                style={{ background: c }}
                data-testid={`chat-setup-colour-${c.slice(1)}`}
              />
            ))}
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text">
              <span
                className="relative inline-flex h-8 w-8 rounded-full border border-dashed border-border-strong"
                style={{
                  background: swatches.includes(picked) ? undefined : picked,
                }}
              >
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/.test(picked) ? picked : '#2d69d8'}
                  onChange={(e) => set({ accentColor: e.target.value.toLowerCase() })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label={W.look.anyColour}
                  data-testid="chat-setup-colour-any"
                />
              </span>
              {W.look.anyColour}
            </label>
          </div>
          {problems.accentColor ? (
            <FieldError>{problems.accentColor}</FieldError>
          ) : (
            <Hint>
              {ctx.brandColor && picked === ctx.brandColor
                ? W.look.colourHintBrand(W.look.yourColour)
                : W.look.colourHint}
            </Hint>
          )}
        </div>
        <div className="flex items-start justify-between gap-4 rounded-menu border border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold">{W.look.logo}</span>
            <span className="text-[13px] text-text-2">
              {ctx.hasLogo ? W.look.logoHint : W.look.noLogoHint}
            </span>
          </div>
          <Switch
            checked={answers.showLogo && ctx.hasLogo}
            onChange={(showLogo) => set({ showLogo })}
            label={W.look.logo}
            disabled={!ctx.hasLogo}
            testId="chat-setup-logo"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
          {W.look.preview}
        </span>
        <LookPreview answers={answers} brand={brand} stacked />
      </div>
    </div>
  );
}

function PlaceQuestion({
  answers,
  problems,
  set,
}: {
  answers: ChatSetupAnswers;
  problems: Problems;
  set: (patch: Partial<ChatSetupAnswers>) => void;
}) {
  const lifts: number[] = [...CHAT_SETUP_LIFTS];
  const own = !lifts.includes(answers.mobileLift) ? answers.mobileLift : null;
  return (
    <>
      <div className="flex flex-col gap-3 rounded-menu border border-border p-4">
        <span className="font-semibold">{W.place.computers}</span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-2">{W.place.corner}</span>
            <Segmented
              ariaLabel={`${W.place.computers}: ${W.place.corner}`}
              value={answers.position}
              onChange={(position) => set({ position })}
              options={[
                { value: 'left', label: W.place.left, testId: 'chat-setup-corner-left' },
                { value: 'right', label: W.place.right, testId: 'chat-setup-corner-right' },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-2">{W.place.button}</span>
            <Segmented
              ariaLabel={`${W.place.computers}: ${W.place.button}`}
              value={answers.desktopButton}
              onChange={(desktopButton) => set({ desktopButton })}
              options={[
                { value: 'label', label: W.place.label, testId: 'chat-setup-desktop-label' },
                { value: 'icon', label: W.place.icon, testId: 'chat-setup-desktop-icon' },
              ]}
            />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <span className="font-semibold">{W.place.phones}</span>
        <span className="text-[13.5px] text-text-2">{W.place.barQuestion}</span>
        <Choices label={W.place.barQuestion}>
          <ChoiceTile
            selected={answers.phone === 'same'}
            onSelect={() => set({ phone: 'same' })}
            title={W.place.same}
            testId="chat-setup-phone-same"
          />
          <ChoiceTile
            selected={answers.phone === 'lift'}
            onSelect={() => set({ phone: 'lift' })}
            title={W.place.lift}
            testId="chat-setup-phone-lift"
          >
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={W.place.lift}>
              {[...(own ? [own] : []), ...lifts].map((px) => (
                <button
                  key={px}
                  type="button"
                  role="radio"
                  aria-checked={answers.mobileLift === px}
                  onClick={() => set({ mobileLift: px })}
                  className={cn(
                    'h-[30px] rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                    answers.mobileLift === px
                      ? 'border-transparent bg-accent text-white'
                      : 'border-border-strong bg-card text-text-2 hover:text-text',
                  )}
                  data-testid={`chat-setup-lift-${px}`}
                >
                  {px === own ? W.place.ownLift(px) : (W.place.lifts[px] ?? `${px} px`)}
                </button>
              ))}
            </div>
            {problems.mobileLift ? <FieldError>{problems.mobileLift}</FieldError> : null}
          </ChoiceTile>
          <ChoiceTile
            selected={answers.phone === 'hidden'}
            onSelect={() => set({ phone: 'hidden' })}
            title={W.place.hidden}
            hint={W.place.hiddenHint}
            testId="chat-setup-phone-hidden"
          />
        </Choices>
        {answers.phone !== 'hidden' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-text-2">{W.place.button}</span>
            <Segmented
              ariaLabel={`${W.place.phones}: ${W.place.button}`}
              value={answers.mobileButton}
              onChange={(mobileButton) => set({ mobileButton })}
              options={[
                { value: 'label', label: W.place.label, testId: 'chat-setup-mobile-label' },
                { value: 'icon', label: W.place.icon, testId: 'chat-setup-mobile-icon' },
              ]}
            />
          </div>
        ) : null}
      </div>
      <GuidedNote>{W.place.note}</GuidedNote>
    </>
  );
}

/** What visitors see: the top of the chat with the logo or initials, the greeting, and the button. */
function LookPreview({
  answers,
  brand,
  stacked = false,
}: {
  answers: ChatSetupAnswers;
  brand: ChatSetupBrand;
  /** Beside the look question: the window above the button. */
  stacked?: boolean;
}) {
  const accent = /^#[0-9a-fA-F]{6}$/.test(answers.accentColor) ? answers.accentColor : '#2d69d8';
  const text = readableTextOn(accent);
  const logo = answers.showLogo ? brand.logo : null;
  const box = logo ? logoBox(logo, 26) : null;
  const business = brand.businessName;
  return (
    <div
      className={cn(
        'flex gap-3.5 rounded-xl bg-card-2 p-4',
        stacked
          ? 'flex-col items-end'
          : cn(
              'flex-wrap items-end',
              answers.position === 'left' ? 'flex-row-reverse justify-end' : 'justify-end',
            ),
        stacked && answers.position === 'left' && 'items-start',
      )}
      aria-hidden
      data-testid="chat-setup-preview"
    >
      <div className="w-full max-w-[230px] overflow-hidden rounded-[14px] border border-border bg-card shadow-2">
        <div
          className="flex items-center gap-2 px-2.5 py-2"
          style={{ background: accent, color: text }}
        >
          <span className="inline-flex h-[26px] min-w-[26px] flex-none items-center justify-center rounded-[8px] bg-white px-[3px] text-[10px] font-bold text-[#191d25]">
            {logo && box ? (
              <img
                src={logo.url}
                alt=""
                width={box.width}
                height={box.height}
                style={{ width: box.width, height: box.height }}
              />
            ) : (
              markOf(business || 'Chat')
            )}
          </span>
          <span className="min-w-0 truncate text-[12.5px] font-semibold">
            {business || 'Your business'}
          </span>
        </div>
        {answers.greeting.trim() ? (
          <p className="px-3 py-2.5 text-[12.5px] leading-[1.45] text-text">{answers.greeting}</p>
        ) : null}
        <p className="border-t border-border px-3 py-2 text-[12px] text-text-3">
          {W.look.typeHere}
        </p>
      </div>
      <span
        className="inline-flex h-[50px] flex-none items-center gap-2 whitespace-nowrap rounded-full pl-[15px] pr-[18px] text-[14.5px] font-semibold shadow-[0_8px_24px_rgba(25,29,37,0.28)]"
        style={{ background: accent, color: text }}
        data-testid="chat-setup-preview-button"
      >
        <MessageCircle className="h-[20px] w-[20px]" />
        {answers.desktopButton === 'icon'
          ? null
          : answers.launcherLabel.trim() || W.look.labelDefault}
      </span>
    </div>
  );
}

// ---------- after Turn on website chat ----------

/**
 * Put it on your site (`?step=install`): the code to paste with Copy, the steps for each site builder, Email your web
 * person, Try it first, and the check that turns green once the chat is seen there. Right after Turn on website chat
 * (`&new=1`) it says the chat is on; Settings → Website chat's Put it on your site opens it too.
 */
export function ChatSetupInstall({
  workspaceId,
  businessName,
  email,
  widget,
  website,
  brandedOrigin,
  fresh,
  from,
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  widget: ChatWidget;
  /** The business's website, for Email your web person. */
  website: string | null;
  brandedOrigin: string | null;
  /** Just turned on. */
  fresh: boolean;
  from: ChatSetupFrom;
}) {
  const router = useRouter();
  const home = chatSetupHome(workspaceId, from);
  const origin = usePublicOrigin(brandedOrigin);
  const src = snippetSrc(origin, widget.publicKey);
  const [copied, setCopied] = useState(false);
  const firstSite = widget.allowedOrigins[0] ? chatSiteShown(widget.allowedOrigins[0]) : null;
  return (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved="idle"
      onLeave={() => router.push(home)}
      leaveLabel={G.close}
    >
      <Card
        className="mx-auto flex w-full max-w-[820px] flex-col gap-5 rounded-dialog p-6 sm:p-8"
        data-testid="chat-setup-install"
      >
        {fresh ? (
          <div
            className="flex items-center gap-2.5 rounded-menu bg-success-soft px-3.5 py-3 text-[13.5px] font-semibold text-success-text"
            role="status"
            data-testid="chat-setup-on"
          >
            <Check className="h-4 w-4 flex-none" strokeWidth={2.5} />
            {W.install.on}
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">
            {firstSite ? W.install.title(firstSite) : W.install.titleAny}
          </h1>
          <p className="text-[15px] leading-normal text-text-2">{W.install.hint}</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium">{W.install.code}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!origin}
              onClick={async () => {
                await copyText(snippetOf(src), W.install.copiedToast);
                setCopied(true);
              }}
              data-testid="chat-snippet-copy"
            >
              <Copy className="h-4 w-4" aria-hidden />
              {copied ? W.install.copied : W.install.copy}
            </Button>
          </div>
          <SnippetCode src={src} />
        </div>
        <PlatformSteps label={W.install.builtWith} />
        <div className="flex flex-wrap items-center gap-3 rounded-menu border border-border px-4 py-3.5">
          <span className="flex min-w-[220px] flex-1 flex-col gap-0.5">
            <span className="font-semibold">{W.install.webPerson}</span>
            <span className="text-[13px] text-text-2">{W.install.webPersonHint}</span>
          </span>
          <WebPersonButton
            workspaceId={workspaceId}
            website={website}
            forms={[]}
            chats={[widget]}
            suggested={['chat']}
            label={W.install.webPersonButton}
          />
        </div>
        <InstallCheck workspaceId={workspaceId} widget={widget} className="" />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <a
            href={`/chat-preview/${widget.publicKey}?w=${workspaceId}`}
            target="_blank"
            rel="noopener"
            className={buttonClassName({ variant: 'ghost' })}
            data-testid="chat-setup-try"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {W.install.tryIt}
          </a>
          <span className="flex flex-wrap gap-2">
            <ButtonLink href={home} variant="secondary" data-testid="chat-setup-later">
              {W.install.later}
            </ButtonLink>
            <ButtonLink
              href={setupHref(workspaceId, from, 'done=1')}
              variant="primary"
              size="lg"
              data-testid="chat-setup-install-done"
            >
              {W.install.done}
            </ButtonLink>
          </span>
        </div>
      </Card>
    </GuidedPage>
  );
}

/** Done (`?done=1`): the chat's answers as chips, whether it's been seen on the site yet, and Try it. */
export function ChatSetupDone({
  workspaceId,
  businessName,
  email,
  widget,
  ctx,
  from,
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  widget: ChatWidget;
  ctx: ChatSetupContext;
  from: ChatSetupFrom;
}) {
  const router = useRouter();
  const home = chatSetupHome(workspaceId, from);
  const answers = chatSetupAnswersFromWidget(widget);
  const chips = chatDoneChips(answers, ctx);
  const ai = answers.who === 'ai' && ctx.teammate ? ctx.teammate.name : null;
  return (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved="idle"
      onLeave={() => router.push(home)}
      leaveLabel={G.close}
    >
      <Card
        className="mx-auto flex w-full max-w-[760px] flex-col gap-6 rounded-dialog p-6 sm:p-8"
        data-testid="chat-setup-done"
        data-seen={widget.install.seen ? 'yes' : 'no'}
      >
        <div className="flex flex-col gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-success-soft text-success-text">
            <Check className="h-5 w-5" strokeWidth={2.5} />
          </span>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">
            {widget.install.seen ? W.done.titleSeen : W.done.title}
          </h1>
          <p className="text-[15px] text-text-2">{ai ? W.done.hintAi(ai) : W.done.hint}</p>
          <div className="flex flex-wrap gap-1.5" data-testid="chat-setup-done-chips">
            {chips.map((c) => (
              <Badge key={c} variant="ok">
                {c}
              </Badge>
            ))}
          </div>
        </div>
        <InstallCheck workspaceId={workspaceId} widget={widget} className="" />
        <p className="text-[13.5px] text-text-2">{W.done.change}</p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <a
            href={`/chat-preview/${widget.publicKey}?w=${workspaceId}`}
            target="_blank"
            rel="noopener"
            className={buttonClassName({ variant: 'secondary', size: 'lg' })}
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            {W.done.tryIt}
          </a>
          <ButtonLink href={home} variant="primary" size="lg" data-testid="chat-setup-done-close">
            {from === 'setup' ? W.done.backToSetup : W.done.backToSettings}
          </ButtonLink>
        </div>
      </Card>
    </GuidedPage>
  );
}
