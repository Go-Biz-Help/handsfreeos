'use client';
/**
 * The guided email setup on the web (the owner, 22 Nov 2026): five questions on a page of their own (which email,
 * the addresses, who reads each one, the one customers hear from, where the mail arrives), then Check it over, where
 * Set it up does everything at once (email_setup.apply). Nothing changes before that. Every answer is saved as it is
 * given (guided_setup.save_draft), so leaving and coming back opens on the same question with the same answers.
 *
 * After Set it up comes the website name's last step (guided-last.tsx): the records to add where it is looked after
 * and the old mail records to delete, then Done. A business that comes back with that step still open lands on it.
 *
 * Which questions a path asks, what an answer still needs and every word are core's (messaging/email-guided.ts),
 * shared with the phone.
 */
import {
  EMAIL_GUIDED_WORDS as W,
  EMAIL_PLAN_ADDRESSES_MAX,
  EmailSetupApplyOutput,
  EmailSetupGetOutput,
  emailGuidedAnswersFrom,
  emailGuidedDnsLabel,
  emailGuidedDomain,
  emailGuidedFirstProblemScreen,
  emailGuidedFound,
  emailGuidedIdeas,
  emailGuidedLeft,
  emailGuidedLookupName,
  emailGuidedMailLabel,
  emailGuidedOpenDomain,
  emailGuidedProblems,
  emailGuidedQuestionOf,
  emailGuidedReaderPick,
  emailGuidedReceive,
  emailGuidedReviewLine,
  emailGuidedRows,
  emailGuidedScreensFor,
  emailGuidedSender,
  emailGuidedSoFar,
  emailGuidedStep,
  emailSetupDomainOf,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  onboardingSetupProblemsOf,
  startingEmailGuidedAnswers,
  type EmailGuidedAddress,
  type EmailGuidedAnswers,
  type EmailGuidedRow,
  type EmailGuidedScreen,
  type EmailSetupState,
} from '@hfos/core';
import { AtSign, Check, CircleAlert, Info, Inbox, Lock, Mail, Plus, Users, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { EmailGuidedDone, EmailGuidedLast } from './guided-last';

const LIVE = ['email_domain', 'email_address'];
/** How often the look-up's answer is asked for, and how many times, before the question carries on without it. */
const LOOK_EVERY_MS = 1_200;
const LOOKS = 8;

const byPath = (found: readonly { path: string; message: string }[]) =>
  Object.fromEntries(found.map((p) => [p.path, p.message]));

/** "a", "a, and b", "a, b, and c": the clauses of one sentence. */
const clauses = (parts: readonly string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;

export function EmailGuidedFlow({
  workspaceId,
  businessName,
  email,
  firstName,
  got,
  draft,
  at,
  done,
  from,
}: {
  workspaceId: string;
  /** The business's name, for when the email setup has none of its own yet. */
  businessName: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  got: { readonly state: EmailSetupState; readonly guided?: EmailGuidedAnswers | undefined };
  /** The answers as they were left (guided_setup.get_draft). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
  /** `?at=records`: straight to the website name's last step, when one is still open. */
  at: 'records' | null;
  /** `?done=1`: back on the page after everything was set up. */
  done: boolean;
  /** Where Finish later goes back to: Settings → Email when they came from there, else Home. */
  from: 'settings' | 'home';
}) {
  const router = useRouter();
  const home = `/app/w/${workspaceId}`;
  const settings = `${home}/settings/email`;
  /** This page with a view in its address, keeping where Finish later goes back to. */
  const here = (view: 'done=1' | 'at=records') =>
    `/onboarding/${workspaceId}/email?${view}${from === 'settings' ? '&from=settings' : ''}`;
  const [state, setState] = useState(got.state);
  const name = state.businessName || businessName;

  // What the answers start from, and the saved ones over them when this person was the one answering.
  const [first] = useState(() => {
    const start = got.guided ?? startingEmailGuidedAnswers(got.state);
    const kept = emailGuidedAnswersFrom(draft.answers, got.state.myUserId);
    return { start, kept, open: emailGuidedOpenDomain(got.state) };
  });
  const [answers, setAnswers] = useState<EmailGuidedAnswers>(first.kept ?? first.start);
  const [screen, setScreen] = useState<EmailGuidedScreen>(() => {
    const was = first.kept?.at ?? 'which';
    return emailGuidedScreensFor(first.kept ?? first.start).includes(was) ? was : 'which';
  });
  const [view, setView] = useState<'questions' | 'last' | 'done'>(
    done ? 'done' : first.open && (at === 'records' || !first.kept) ? 'last' : 'questions',
  );
  /** The website name the last step and Done are about; null on Done for a free address. */
  const [shownId, setShownId] = useState<string | null>(
    done
      ? (emailSetupDomainOf(got.state, { domain: got.state.sender?.domain ?? '' })?.id ?? null)
      : (first.open?.id ?? null),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** Where Next goes back to after Check it over's Change: not through every question again. */
  const [returnTo, setReturnTo] = useState<'review' | null>(null);
  /** Something was answered here: only then is there anything worth saving. */
  const [touched, setTouched] = useState(false);
  const [welcome, setWelcome] = useState(
    () =>
      !!first.kept &&
      !!draft.savedAt &&
      Date.now() - Date.parse(draft.savedAt) > 10 * 60_000 &&
      view === 'questions',
  );
  const [startingOver, setStartingOver] = useState(false);
  const [looking, setLooking] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (): Promise<EmailSetupState | null> => {
    try {
      const fresh = EmailSetupGetOutput.parse(
        unwrap(await apiBrowser().POST('/v1/queries/email_setup.get', { body: { workspaceId } })),
      );
      setState(fresh.state);
      return fresh.state;
    } catch {
      // The next change or the next look tries again.
      return null;
    }
  }, [workspaceId]);
  // The records being made and found, an address made, mail starting to arrive: as they happen.
  const version = useLiveVersion(LIVE, 1_000);
  useEffect(() => {
    if (version) void refresh();
  }, [version, refresh]);

  // Saved as they are given, with the screen they were left on and who was answering.
  const saving = useGuidedDraft(
    workspaceId,
    'email',
    view === 'questions' && (touched || first.kept)
      ? { ...answers, at: screen, by: state.myUserId }
      : null,
    { hadDraft: !!first.kept },
  );

  const set = (patch: Partial<EmailGuidedAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setTouched(true);
    setProblems({});
    setError(null);
  };
  const go = (to: EmailGuidedScreen) => {
    setScreen(to);
    setTouched(true);
    setProblems({});
    setError(null);
    setWelcome(false);
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Question 1 looks the website name up while it's typed: where it's looked after and where its mail goes today.
  const lookup = view === 'questions' && screen === 'which' ? emailGuidedLookupName(answers) : null;
  const found = emailGuidedFound(state, answers);
  const known = !!found;
  useEffect(() => {
    if (!lookup || known) return;
    let alive = true;
    const timer = setTimeout(() => {
      setLooking(lookup);
      void (async () => {
        try {
          unwrap(
            await apiBrowser().POST('/v1/commands/email_setup.look_up', {
              body: { workspaceId, domain: lookup },
            }),
          );
          for (let n = 0; n < LOOKS && alive; n += 1) {
            await new Promise((r) => setTimeout(r, LOOK_EVERY_MS));
            if (!alive) return;
            const fresh = await refresh();
            if (fresh?.lookup?.domain === lookup) break;
          }
        } catch {
          // Looked up too often, or offline: the questions carry on without it, and the last step still knows.
        } finally {
          if (alive) setLooking(null);
        }
      })();
    }, 700);
    return () => {
      alive = false;
      clearTimeout(timer);
      setLooking(null);
    };
  }, [lookup, known, workspaceId, refresh]);

  // The last step's website name, as it stands now. Nothing left on it: Done.
  const shown = state.domains.find((d) => d.id === shownId) ?? null;
  const left = shown ? emailGuidedLeft(shown) : 'done';
  useEffect(() => {
    if (view !== 'last' || left !== 'done') return;
    setView('done');
    router.replace(here('done=1'), { scroll: false });
    // `here` only reads where they came from, which doesn't change while the page is open.
  }, [view, left, router]);

  function next() {
    if (screen === 'review') return;
    const wrong = emailGuidedProblems(screen, answers, state);
    if (wrong.length) {
      setProblems(byPath(wrong));
      return;
    }
    if (returnTo) {
      setReturnTo(null);
      // A changed answer can leave an earlier question wanting (a name change drops the address customers hear
      // from): that one comes first, then Check it over.
      go(emailGuidedFirstProblemScreen(answers, state) ?? 'review');
      return;
    }
    const after = emailGuidedStep(screen, answers, 1);
    if (after) go(after);
  }
  const back = () => {
    setReturnTo(null);
    const before = emailGuidedStep(screen, answers, -1);
    if (before) go(before);
  };

  async function finish() {
    const wrong = emailGuidedProblems('review', answers, state);
    if (wrong.length) {
      const at = emailGuidedFirstProblemScreen(answers, state);
      if (at) {
        go(at);
        setProblems(byPath(emailGuidedProblems(at, answers, state)));
      } else setProblems(byPath(wrong));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saving.flush();
      const out = EmailSetupApplyOutput.parse(
        unwrap(
          await apiBrowser().POST('/v1/commands/email_setup.apply', {
            body: { workspaceId, email: { ...answers, at: 'review', by: state.myUserId } },
          }),
        ),
      );
      await saving.clear();
      await refresh();
      setShownId(out.emailDomainId);
      setView(out.left === 'done' ? 'done' : 'last');
      router.replace(here(out.left === 'done' ? 'done=1' : 'at=records'), { scroll: false });
      top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      const said = e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {};
      setProblems(said);
      setError(Object.keys(said).length ? null : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setLeaving(true);
    if (view === 'questions') await saving.flush();
    router.push(from === 'settings' ? settings : home);
    router.refresh();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(startingEmailGuidedAnswers(state));
    setTouched(false);
    setStartingOver(false);
    setReturnTo(null);
    setScreen('which');
    setProblems({});
    setError(null);
    setWelcome(false);
  }

  const page = (children: ReactNode, leaveLabel?: string) => (
    <GuidedPage
      business={{ name, home }}
      email={email}
      settingUp={`${W.settingUp} ${name}`}
      saved={view === 'questions' ? saving.state : 'idle'}
      onLeave={() => void leave()}
      leaving={leaving}
      {...(leaveLabel ? { leaveLabel } : {})}
    >
      <div ref={top} className="w-full scroll-mt-20">
        {children}
      </div>
    </GuidedPage>
  );

  if (view === 'done')
    return page(<EmailGuidedDone workspaceId={workspaceId} state={state} d={shown} />, G.close);
  if (view === 'last' && shown)
    return page(
      <EmailGuidedLast
        workspaceId={workspaceId}
        state={state}
        d={shown}
        refresh={refresh}
        onLater={() => void leave()}
        leaving={leaving}
      />,
    );

  const domain = emailGuidedDomain(answers.domain);
  const ai = state.aiTeammate?.name ?? null;
  const aiOn = state.aiTeammate?.on ? ai : null;
  const rows = emailGuidedRows(answers, state);
  const sender = emailGuidedSender(answers, state);
  const receive = emailGuidedReceive(answers, state);
  const where = emailGuidedMailLabel(found);
  const hostLabel = emailGuidedDnsLabel(found);
  /** Mail to the name goes to a mailbox somewhere today, as far as anyone could tell. */
  const elsewhere =
    !!found?.mailHost && found.mailHost !== 'none' && found.mailHost !== 'handsfreeos';
  const freeAddress = `${answers.freeLocal.trim().toLowerCase() || 'yourbusiness'}@${state.sharedDomain}`;

  const asked = emailGuidedScreensFor(answers).filter(
    (s): s is Exclude<EmailGuidedScreen, 'review'> => s !== 'review',
  );
  const i = screen === 'review' ? asked.length : Math.max(0, asked.indexOf(screen));
  const soFar = emailGuidedSoFar(answers, state);
  const steps: GuidedStep[] = asked.map((s, n) => ({
    key: s,
    label: W.steps[s],
    value: soFar[s]?.join(' · ') ?? null,
    state: n < i ? 'done' : n === i ? 'now' : 'todo',
  }));
  const q = emailGuidedQuestionOf(screen, answers);
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
          line={`${G.welcomeBack(firstName, when)} ${
            screen === 'review' ? W.stoppedAtReview : i > 0 ? G.stoppedAt(i + 1) : ''
          }`.trim()}
          onStartOver={() => setStartingOver(true)}
        />
      )
    ) : null;

  const setRow = (index: number, patch: Partial<EmailGuidedAddress>) =>
    set({ addresses: answers.addresses.map((a, n) => (n === index ? { ...a, ...patch } : a)) });
  /** A new address by name, read by whoever its name suggests until the person picks. */
  const named = (local: string): EmailGuidedAddress => ({
    local,
    reader: emailGuidedReaderPick(local, state),
    aiReads: false,
    picked: false,
  });

  const card = (
    title: string,
    hint: string | undefined,
    children: ReactNode,
    opts: { nextLabel?: string } = {},
  ) =>
    page(
      <GuidedCard
        screen={screen}
        testId="email-guided"
        kicker={`${q ? G.question(q.n, q.of) : W.reviewKicker} · ${W.kicker}`}
        title={title}
        {...(hint ? { hint } : {})}
        banner={banner}
        steps={steps}
        stepsTitle={W.soFar}
        footer={
          <GuidedFooter
            onBack={i > 0 ? back : undefined}
            onNext={next}
            busy={busy}
            error={error}
            testId="email-guided"
            nextLabel={
              opts.nextLabel ??
              (returnTo || emailGuidedStep(screen, answers, 1) === 'review'
                ? G.checkItOver
                : G.next)
            }
          />
        }
      >
        {children}
      </GuidedCard>,
    );

  switch (screen) {
    case 'which': {
      const example = `${sender?.local ?? rows[0]?.local ?? 'hello'}@${domain || W.domainPlaceholder}`;
      return card(
        W.whichTitle,
        W.whichHint,
        <>
          <Choices label={W.whichTitle}>
            <ChoiceTile
              selected={answers.with === 'domain'}
              onSelect={() => set({ with: 'domain' })}
              title={W.own}
              hint={W.ownHint(example)}
              best={W.best}
              testId="email-guided-own"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email-guided-domain">{W.domainLabel}</Label>
                <Input
                  id="email-guided-domain"
                  value={answers.domain}
                  onChange={(e) => set({ domain: e.target.value })}
                  placeholder={W.domainPlaceholder}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  invalid={!!problems['email.domain']}
                  className="max-w-[26rem] bg-card"
                  data-testid="email-guided-domain"
                />
                {problems['email.domain'] ? (
                  <Problem>{problems['email.domain']}</Problem>
                ) : looking === lookup && lookup ? (
                  <FoundLine tone="quiet" testId="email-guided-looking">
                    {W.looking}
                  </FoundLine>
                ) : found?.missing ? (
                  <FoundLine tone="warn" testId="email-guided-not-found">
                    {W.notFound(found.domain)}
                  </FoundLine>
                ) : found && lookup === found.domain ? (
                  <FoundLine tone="ok" testId="email-guided-found">
                    {found.mailHost === 'handsfreeos' ? W.foundHere : W.foundAt(hostLabel, where)}
                  </FoundLine>
                ) : null}
              </div>
            </ChoiceTile>
            <ChoiceTile
              selected={answers.with === 'free'}
              onSelect={() => set({ with: 'free' })}
              title={W.free}
              hint={W.freeHint(freeAddress)}
              testId="email-guided-free"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email-guided-free-local">{W.freeLabel}</Label>
                <NameBox
                  id="email-guided-free-local"
                  value={answers.freeLocal}
                  domain={state.sharedDomain}
                  invalid={!!problems['email.freeLocal']}
                  onChange={(v) => set({ freeLocal: v })}
                  testId="email-guided-free-local"
                />
                {problems['email.freeLocal'] ? (
                  <Problem>{problems['email.freeLocal']}</Problem>
                ) : null}
              </div>
            </ChoiceTile>
          </Choices>
          {problems['email.with'] ? <Problem>{problems['email.with']}</Problem> : null}
        </>,
      );
    }

    case 'addresses': {
      const ideas = emailGuidedIdeas(answers, state);
      const full = rows.filter((r) => !r.existingId).length >= EMAIL_PLAN_ADDRESSES_MAX;
      const add = (local: string) => {
        const empty = answers.addresses.findIndex((a) => !a.local.trim());
        if (local && empty >= 0) setRow(empty, named(local));
        else set({ addresses: [...answers.addresses, named(local)] });
      };
      return card(
        W.addressesTitle,
        W.addressesHint(domain),
        <>
          <div className="flex flex-col gap-2.5">
            {rows
              .filter((r) => r.existingId)
              .map((r) => (
                <div
                  key={r.existingId}
                  className="flex min-h-11 items-center gap-2 rounded-control border border-border bg-card-2 px-3"
                  data-testid={`email-guided-existing-${r.local}`}
                >
                  <span className="text-[14.5px]">{r.local}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-2">
                    @{domain}
                  </span>
                  <Badge variant="gray">{W.setUpAlready}</Badge>
                </div>
              ))}
            {answers.addresses.map((a, n) => {
              const problem = problems[`email.addresses.${n}.local`];
              return (
                // Rows have no id of their own, and one is only ever added at the end or taken out whole.
                <div key={n} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <NameBox
                      value={a.local}
                      domain={domain}
                      invalid={!!problem}
                      onChange={(v) =>
                        setRow(n, {
                          local: v,
                          ...(a.picked ? {} : { reader: emailGuidedReaderPick(v, state) }),
                        })
                      }
                      label={`Address ${n + 1}, the name before @${domain}`}
                      testId={`email-guided-address-${n}`}
                      wide
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={a.local.trim() ? `${W.remove} ${a.local.trim()}@` : W.remove}
                      onClick={() =>
                        set({ addresses: answers.addresses.filter((_, m) => m !== n) })
                      }
                      data-testid={`email-guided-remove-${n}`}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </div>
                  {problem ? <Problem>{problem}</Problem> : null}
                </div>
              );
            })}
          </div>
          {full ? (
            <p className="text-[13.5px] text-text-2">{W.tooMany}</p>
          ) : (
            <div>
              <Button variant="secondary" onClick={() => add('')} data-testid="email-guided-add">
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                {W.addAnother}
              </Button>
            </div>
          )}
          {ideas.length && !full ? (
            <div className="flex flex-col gap-2">
              <div className="text-[13px] font-medium">{W.ideas}</div>
              <div className="flex flex-wrap gap-2">
                {ideas.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    onClick={() => add(idea)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 text-[13px] hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                    data-testid={`email-guided-idea-${idea}`}
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {idea}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {problems['email.addresses'] ? <Problem>{problems['email.addresses']}</Problem> : null}
          {found?.mailHost === 'none' ? null : (
            <GuidedNote>
              <span className="flex items-start gap-2.5">
                <Mail className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
                <span>
                  <b className="font-semibold text-text">{W.anyoneElse(domain)}</b>{' '}
                  {W.anyoneElseHint}
                </span>
              </span>
            </GuidedNote>
          )}
        </>,
      );
    }

    case 'readers': {
      const unpicked = rows.filter((r) => r.index !== null && !answers.addresses[r.index]?.picked);
      return card(
        W.readersTitle,
        W.readersHint,
        <>
          <div className="flex flex-col gap-3">
            {rows.map((r) => (
              <ReaderCard
                key={r.address}
                row={r}
                ai={ai}
                aiOn={aiOn}
                line={emailGuidedReviewLine(r, state)}
                onReader={(reader) =>
                  r.index !== null &&
                  setRow(r.index, {
                    reader,
                    picked: true,
                    ...(reader === 'team' ? { aiReads: false } : {}),
                  })
                }
                onAiReads={(on) => r.index !== null && setRow(r.index, { aiReads: on })}
              />
            ))}
          </div>
          {problems['email.readers'] ? <Problem>{problems['email.readers']}</Problem> : null}
          <div className="flex flex-col gap-2 text-[13.5px] leading-snug text-text-2">
            {unpicked.length ? (
              <p data-testid="email-guided-picked-from-names">
                {W.pickedFromNames}{' '}
                {clauses(
                  unpicked.map((r) =>
                    r.reader === 'me' ? W.pickedMine(r.local) : W.pickedShared(r.local),
                  ),
                )}
                . {W.changeEither}
              </p>
            ) : null}
            <p className="flex items-start gap-2">
              <Lock className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              {W.changeLater(ai)}
            </p>
          </div>
        </>,
      );
    }

    case 'sender':
      return card(
        W.senderTitle,
        W.senderHint(aiOn),
        <>
          <Choices label={W.senderTitle}>
            {rows.map((r) => (
              <ChoiceTile
                key={r.address}
                selected={sender?.local === r.local}
                onSelect={() => set({ sender: r.local })}
                title={r.address}
                hint={
                  r.reader === 'team'
                    ? W.senderTeam
                    : r.reader === 'me'
                      ? W.senderMine
                      : W.senderTheirs
                }
                disabled={r.reader !== 'team'}
                {...(sender?.local === r.local && !answers.sender.trim()
                  ? { best: W.pickedForYou }
                  : {})}
                testId={`email-guided-sender-${r.local}`}
              />
            ))}
          </Choices>
          {problems['email.readers'] ? <Problem>{problems['email.readers']}</Problem> : null}
          {sender ? (
            <div
              className="flex flex-col gap-3 rounded-menu border border-border p-4"
              data-testid="email-guided-preview"
            >
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {W.preview}
              </div>
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent text-[15px] font-semibold text-white"
                >
                  {(answers.name.trim()[0] ?? name[0] ?? 'B').toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">
                    <b className="font-semibold">{answers.name.trim() || name}</b>{' '}
                    <span className="font-mono text-[13px] text-text-2">
                      &lt;{sender.address}&gt;
                    </span>
                  </span>
                  <span className="text-[13.5px] text-text-2">{W.previewSubject}</span>
                </span>
              </div>
            </div>
          ) : null}
        </>,
      );

    case 'receive': {
      const today = receive.fixed
        ? W.hereAlready(domain)
        : !found?.mailHost
          ? W.unknownToday(domain)
          : found.mailHost === 'none'
            ? W.nobodyToday(domain)
            : found.mailHost === 'handsfreeos'
              ? W.pointsHere(domain)
              : W.goesToday(domain, where);
      const shows = (
        <ul className="flex flex-col gap-2 text-[13.5px] text-text">
          {rows.map((r) => (
            <li key={r.address} className="flex items-start gap-2.5">
              {r.reader === 'team' ? (
                <Users className="mt-0.5 h-4 w-4 flex-none text-text-2" strokeWidth={1.75} />
              ) : (
                <Lock className="mt-0.5 h-4 w-4 flex-none text-text-2" strokeWidth={1.75} />
              )}
              {r.reader === 'me'
                ? W.showsOnlyYou(r.local)
                : r.reader === 'team'
                  ? W.showsTeam(r.local)
                  : W.showsTheirs(r.local)}
            </li>
          ))}
          <li className="flex items-start gap-2.5">
            <Inbox className="mt-0.5 h-4 w-4 flex-none text-text-2" strokeWidth={1.75} />
            {W.anyOther(domain)}
          </li>
        </ul>
      );
      return card(
        W.receiveTitle,
        today,
        receive.fixed ? (
          <GuidedNote>{shows}</GuidedNote>
        ) : (
          <>
            <Choices label={W.receiveTitle}>
              <ChoiceTile
                selected={receive.value === true}
                onSelect={() => set({ receive: true })}
                title={W.inHfos}
                hint={W.inHfosHint(domain)}
                testId="email-guided-receive-here"
              >
                {shows}
                {found?.mailHost === 'handsfreeos' ? null : elsewhere || !found?.mailHost ? (
                  <Callout tone="warning" icon={CircleAlert} data-testid="email-guided-old-stays">
                    <span>
                      <b className="font-semibold">{W.oldStays(where)}</b> {W.onlyNew}
                    </span>
                  </Callout>
                ) : (
                  <p className="text-[13.5px] text-text-2">{W.onlyNewNone}</p>
                )}
              </ChoiceTile>
              <ChoiceTile
                selected={receive.value === false}
                onSelect={() => set({ receive: false })}
                title={elsewhere ? W.keepAt(where) : W.notYet}
                hint={elsewhere ? W.keepAtHint : W.notYetHint}
                testId="email-guided-receive-keep"
              />
            </Choices>
            {problems['email.receive'] ? <Problem>{problems['email.receive']}</Problem> : null}
          </>
        ),
      );
    }

    case 'review': {
      const own = answers.with === 'domain';
      const d = own ? emailSetupDomainOf(state, { domain }) : null;
      const verified = d?.status === 'verified';
      // Until the website name's records are found, mail goes out from the free address; with a free one, at once.
      const note = !own
        ? W.freeNow(freeAddress)
        : !verified && state.free
          ? W.backupStays(state.free.address)
          : null;
      const change = (to: EmailGuidedScreen) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-accent-text"
          onClick={() => {
            setReturnTo('review');
            go(to);
          }}
          data-testid={`email-guided-change-${to}`}
        >
          {W.change}
        </Button>
      );
      return page(
        <GuidedCard
          screen="review"
          testId="email-guided"
          kicker={`${W.reviewKicker} · ${W.kicker}`}
          title={W.reviewTitle}
          hint={W.reviewHint}
          banner={banner}
          steps={steps}
          stepsTitle={W.soFar}
          footer={
            <GuidedFooter
              onBack={back}
              onNext={() => void finish()}
              busy={busy}
              error={error}
              nextLabel={W.setItUp}
              testId="email-guided"
            />
          }
        >
          <div className="overflow-hidden rounded-menu border border-border">
            <ReviewRow label={W.reviewEmail} action={change('which')} testId="email">
              <div className="break-words">
                {own ? W.soFarOwn(domain) : W.soFarFree}
                {own ? null : (
                  <div className="font-mono text-[13px] text-text-2">{freeAddress}</div>
                )}
              </div>
            </ReviewRow>
            {own ? (
              <ReviewRow label={W.reviewAddresses} action={change('addresses')} testId="addresses">
                <div className="flex flex-col gap-3">
                  {rows.map((r) => (
                    <div key={r.address} className="flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-[14px]">{r.address}</span>
                        {sender?.local === r.local ? (
                          <Badge variant="accent">{W.hearFrom}</Badge>
                        ) : null}
                        {!r.existingId && rows.some((x) => x.existingId) ? (
                          <Badge variant="ok">{W.reviewNew}</Badge>
                        ) : null}
                      </div>
                      <div className="flex items-start gap-1.5 text-[13px] text-text-2">
                        {r.reader === 'team' ? (
                          <Users className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                        ) : (
                          <Lock className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                        )}
                        {emailGuidedReviewLine(r, state)}
                      </div>
                    </div>
                  ))}
                </div>
              </ReviewRow>
            ) : null}
            {own ? (
              <ReviewRow
                label={W.reviewWhere}
                action={receive.fixed ? null : change('receive')}
                testId="receive"
              >
                <div>{receive.value ? W.inHfos : elsewhere ? W.keepAt(where) : W.notYet}</div>
                {!verified ? (
                  <div className="text-[13px] text-text-2">{W.reviewRecords(hostLabel)}</div>
                ) : receive.value && !receive.fixed ? (
                  <div className="text-[13px] text-text-2">{W.reviewOneRecord(hostLabel)}</div>
                ) : null}
              </ReviewRow>
            ) : null}
            <ReviewRow label={W.nameLabel} action={null} testId="name" htmlFor="email-guided-name">
              <Input
                id="email-guided-name"
                value={answers.name}
                onChange={(e) => set({ name: e.target.value })}
                invalid={!!problems['email.name']}
                className="max-w-[24rem]"
                data-testid="email-guided-name"
              />
              {problems['email.name'] ? <Problem>{problems['email.name']}</Problem> : null}
            </ReviewRow>
          </div>
          {note ? (
            <p className="flex items-start gap-2 text-[13.5px] leading-snug text-text-2">
              <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
              <span data-testid="email-guided-review-note">{note}</span>
            </p>
          ) : null}
        </GuidedCard>,
      );
    }
  }
}

const Problem = ({ children }: { children: ReactNode }) => (
  <p className="text-[13.5px] font-medium text-danger-text" role="alert">
    {children}
  </p>
);

/** What the look-up found, under the website name. */
function FoundLine({
  tone,
  testId,
  children,
}: {
  tone: 'ok' | 'warn' | 'quiet';
  testId: string;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 text-[13.5px] leading-snug',
        tone === 'warn' ? 'text-warning-text' : 'text-text-2',
      )}
      role="status"
      data-testid={testId}
    >
      {tone === 'ok' ? (
        <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-success" strokeWidth={2.5} />
      ) : tone === 'warn' ? (
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={2} />
      ) : (
        <span className="mt-1 h-3 w-3 flex-none animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
      )}
      {children}
    </p>
  );
}

/** A name box with the website name after it: [office]@burroughs.digital. */
function NameBox({
  id,
  value,
  domain,
  invalid,
  onChange,
  label,
  testId,
  wide = false,
}: {
  id?: string;
  value: string;
  domain: string;
  invalid: boolean;
  onChange: (v: string) => void;
  /** Its name for a screen reader, when no label points at it. */
  label?: string;
  testId: string;
  /** The whole row's width, as on the addresses question. */
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex h-11 min-w-0 items-center overflow-hidden rounded-control border bg-card focus-within:ring-[3px] focus-within:ring-ring',
        invalid ? 'border-danger' : 'border-border-strong',
        wide ? 'flex-1' : 'max-w-[26rem]',
      )}
    >
      <input
        {...(id ? { id } : {})}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        {...(label ? { 'aria-label': label } : {})}
        className="h-full w-[10rem] min-w-0 flex-none bg-transparent px-3 text-[14.5px] outline-none max-sm:w-[7rem]"
        data-testid={testId}
      />
      <span className="min-w-0 truncate pr-3 font-mono text-[12.5px] text-text-2">@{domain}</span>
    </div>
  );
}

/** One address on "Who reads each one?": Only me or The team, and the AI teammate's switch on one that is theirs. */
function ReaderCard({
  row,
  ai,
  aiOn,
  line,
  onReader,
  onAiReads,
}: {
  row: EmailGuidedRow;
  /** The AI teammate's name, when the business has one. */
  ai: string | null;
  /** Its name while it's working: only then is it one of the team's readers. */
  aiOn: string | null;
  /** Who reads one that is already set up. */
  line: string;
  onReader: (reader: 'me' | 'team') => void;
  onAiReads: (on: boolean) => void;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-menu border border-border p-4"
      data-testid={`email-guided-reader-${row.local}`}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent-soft text-accent-text"
        >
          <AtSign className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <span className="break-all font-mono text-[14px]">{row.address}</span>
      </div>
      {row.existingId ? (
        <p className="text-[13.5px] leading-snug text-text-2">
          {line} {W.existingReader}
        </p>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label={W.whoReads(row.address)}
            className="grid gap-2.5 sm:grid-cols-2"
          >
            <ChoiceTile
              selected={row.reader === 'me'}
              onSelect={() => onReader('me')}
              title={W.onlyMe}
              hint={W.onlyMeHint}
              testId={`email-guided-reader-${row.local}-me`}
            />
            <ChoiceTile
              selected={row.reader === 'team'}
              onSelect={() => onReader('team')}
              title={W.theTeam}
              hint={W.theTeamHint(aiOn)}
              testId={`email-guided-reader-${row.local}-team`}
            />
          </div>
          {row.reader === 'me' && ai ? (
            <div className="flex items-start gap-3 rounded-menu bg-card-2 px-3.5 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-semibold">{W.letAiRead(ai)}</span>
                <span className="text-[13px] leading-snug text-text-2">{W.letAiReadHint(ai)}</span>
              </div>
              <span className="flex flex-none items-center gap-2 pt-0.5">
                <span className="text-[13px] text-text-2" aria-hidden>
                  {row.aiReads ? W.on : W.off}
                </span>
                <Switch
                  checked={row.aiReads}
                  onChange={onAiReads}
                  label={`${W.letAiRead(ai)}: ${row.address}`}
                  testId={`email-guided-ai-${row.local}`}
                />
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One line of Check it over: what it is, what was answered, and Change. */
function ReviewRow({
  label,
  action,
  testId,
  htmlFor,
  children,
}: {
  label: string;
  action: ReactNode;
  testId: string;
  /** The box this line's label names, when it holds one. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const name = 'text-[13px] font-medium text-text-2 sm:w-[10.5rem] sm:flex-none sm:pt-0.5';
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-border px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
      data-testid={`email-guided-review-${testId}`}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className={name}>
          {label}
        </label>
      ) : (
        <div className={name}>{label}</div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {action ? <div className="flex-none max-sm:-ml-2.5">{action}</div> : null}
    </div>
  );
}
