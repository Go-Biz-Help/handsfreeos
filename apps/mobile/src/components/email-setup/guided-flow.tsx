import {
  EMAIL_GUIDED_WORDS as W,
  EMAIL_PLAN_ADDRESSES_MAX,
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
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, View, type ScrollView } from 'react-native';

import {
  ChoiceTile,
  Choices,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
} from '@/components/guided-setup/frame';
import { Check, CircleAlert, Inbox, Info, Lock, Mail, Plus, Users, X } from '@/components/icons';
import { Note } from '@/components/onboarding-setup/screens';
import { businessHref } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import type { EmailGuidedDraft, EmailSetupCalls, EmailSetupGot } from '@/email-setup/calls';
import { EMAIL_GUIDED_PHONE_WORDS as PW } from '@/email-setup/words';
import { ApiError, errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

import { EmailGuidedDone, EmailGuidedLast } from './guided-last';

/**
 * The guided email setup on the phone (the owner, 22 Nov 2026), as the web's components/email-setup/guided-flow.tsx
 * at phone size: five questions, one a screen (which email, the addresses, who reads each one, the one customers
 * hear from, where the mail arrives), then Check it over, where Set it up does everything at once
 * (email_setup.apply). Nothing changes before that. Every answer is saved as it is given (guided_setup.save_draft),
 * so leaving and coming back, here or on the web, opens on the same question with the same answers.
 *
 * After Set it up comes the website name's last step (guided-last.tsx), then Done. A business that comes back with
 * that step still open lands on it.
 *
 * Which questions a path asks, what an answer still needs and every word are core's (messaging/email-guided.ts),
 * shared with the web. The phone has no live updates for email, so it asks again as it goes and when the app comes
 * back to the front.
 */

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
  got,
  draft,
  at,
  domainId,
  again,
  calls,
}: {
  workspaceId: string;
  got: EmailSetupGot;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: EmailGuidedDraft;
  /** `?at=records`: straight to the website name's last step, when one is still open. */
  at: string | null;
  /** `&d=`: which website name's last step, when it was asked for by name. */
  domainId: string | null;
  /** `?again=1`: the questions open even with a last step still left. */
  again: boolean;
  calls: EmailSetupCalls;
}) {
  const { online } = useNetwork();
  const [state, setState] = React.useState(got.state);

  // What the answers start from, and the saved ones over them when this person was the one answering.
  const [first] = React.useState(() => {
    const start = got.guided ?? startingEmailGuidedAnswers(got.state);
    const kept = emailGuidedAnswersFrom(draft.answers, got.state.myUserId);
    const asked = domainId
      ? got.state.domains.find((d) => d.id === domainId && emailGuidedLeft(d) !== 'done')
      : null;
    return { start, kept, open: asked ?? emailGuidedOpenDomain(got.state) };
  });
  const [answers, setAnswers] = React.useState<EmailGuidedAnswers>(first.kept ?? first.start);
  const [screen, setScreen] = React.useState<EmailGuidedScreen>(() => {
    const was = first.kept?.at ?? 'which';
    return emailGuidedScreensFor(first.kept ?? first.start).includes(was) ? was : 'which';
  });
  const [view, setView] = React.useState<'questions' | 'last' | 'done'>(
    first.open && !again && (at === 'records' || !first.kept) ? 'last' : 'questions',
  );
  /** The website name the last step and Done are about; null on Done for a free address. */
  const [shownId, setShownId] = React.useState<string | null>(first.open?.id ?? null);
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  /** Where Next goes back to after Check it over's Change: not through every question again. */
  const [returnTo, setReturnTo] = React.useState<'review' | null>(null);
  /** Something was answered here: only then is there anything worth saving. */
  const [touched, setTouched] = React.useState(false);
  const [welcome, setWelcome] = React.useState(
    () =>
      !!first.kept &&
      !!draft.savedAt &&
      Date.now() - Date.parse(draft.savedAt) > 10 * 60_000 &&
      view === 'questions',
  );
  const [looking, setLooking] = React.useState<string | null>(null);
  const scroller = React.useRef<ScrollView>(null);

  const refresh = React.useCallback(async (): Promise<EmailSetupState | null> => {
    try {
      const fresh = await calls.get();
      setState(fresh.state);
      return fresh.state;
    } catch {
      // The next change or the next look tries again.
      return null;
    }
  }, [calls]);
  // Back in the app, after adding the records on a computer: as it stands now.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

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
    scroller.current?.scrollTo({ y: 0, animated: false });
  };

  // Question 1 looks the website name up while it's typed: where it's looked after and where its mail goes today.
  const lookup = view === 'questions' && screen === 'which' ? emailGuidedLookupName(answers) : null;
  const found = emailGuidedFound(state, answers);
  const known = !!found;
  React.useEffect(() => {
    if (!lookup || known || !online) return;
    let alive = true;
    const timer = setTimeout(() => {
      setLooking(lookup);
      void (async () => {
        try {
          await calls.lookUp(lookup);
          for (let n = 0; n < LOOKS && alive; n += 1) {
            await new Promise((r) => setTimeout(r, LOOK_EVERY_MS));
            if (!alive) return;
            const fresh = await refresh();
            if (fresh?.lookup?.domain === lookup) break;
          }
        } catch {
          // Looked up too often, or no signal: the questions carry on without it, and the last step still knows.
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
  }, [lookup, known, online, calls, refresh]);

  // The last step's website name, as it stands now. Nothing left on it: Done.
  const shown = state.domains.find((d) => d.id === shownId) ?? null;
  const left = shown ? emailGuidedLeft(shown) : 'done';
  React.useEffect(() => {
    if (view === 'last' && left === 'done') setView('done');
  }, [view, left]);

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
      const where = emailGuidedFirstProblemScreen(answers, state);
      if (where) {
        go(where);
        setProblems(byPath(emailGuidedProblems(where, answers, state)));
      } else setProblems(byPath(wrong));
      return;
    }
    if (!online) {
      setError(P.needsSignal);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saving.flush();
      const out = await calls.apply({ ...answers, at: 'review', by: state.myUserId });
      await saving.clear();
      await refresh();
      setShownId(out.emailDomainId);
      setView(out.left === 'done' ? 'done' : 'last');
      scroller.current?.scrollTo({ y: 0, animated: false });
    } catch (e) {
      const said = e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {};
      setProblems(said);
      setError(Object.keys(said).length ? null : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  };
  async function leave() {
    setLeaving(true);
    if (view === 'questions') await saving.flush();
    close();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(startingEmailGuidedAnswers(state));
    setTouched(false);
    setReturnTo(null);
    setScreen('which');
    setProblems({});
    setError(null);
    setWelcome(false);
  }

  if (view === 'done')
    return (
      <EmailGuidedDone
        workspaceId={workspaceId}
        state={state}
        d={shown}
        onClose={close}
        onInbox={() => router.replace(businessHref(workspaceId, 'inbox') as Href)}
      />
    );
  if (view === 'last' && shown)
    return (
      <EmailGuidedLast
        state={state}
        d={shown}
        calls={calls}
        refresh={refresh}
        onLater={() => void leave()}
        leaving={leaving}
      />
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
  const name = state.businessName;

  const asked = emailGuidedScreensFor(answers).filter(
    (s): s is Exclude<EmailGuidedScreen, 'review'> => s !== 'review',
  );
  const i = screen === 'review' ? asked.length : Math.max(0, asked.indexOf(screen));
  const q = emailGuidedQuestionOf(screen, answers);
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      <WelcomeBack
        line={`${G.welcomeBack(state.myFirstName, when)} ${
          screen === 'review' ? W.stoppedAtReview : i > 0 ? G.stoppedAt(i + 1) : ''
        }`.trim()}
        onStartOver={() => void startOver()}
      />
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

  const page = (
    title: string,
    hint: string | undefined,
    children: React.ReactNode,
    footer: React.ReactNode,
  ) => (
    <GuidedPage
      screen={screen}
      testID="email-guided"
      kicker={q ? G.question(q.n, q.of) : W.reviewKicker}
      settingUp={W.kicker}
      progress={{ at: i + 1, of: asked.length + 1 }}
      title={title}
      hint={hint}
      banner={banner}
      footer={footer}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
      scroller={scroller}
    >
      {children}
    </GuidedPage>
  );
  const question = (title: string, hint: string | undefined, children: React.ReactNode) =>
    page(
      title,
      hint,
      children,
      <GuidedFooter
        onBack={i > 0 ? back : undefined}
        onNext={next}
        busy={busy}
        error={error}
        testID="email-guided"
        nextLabel={
          returnTo || emailGuidedStep(screen, answers, 1) === 'review' ? G.checkItOver : G.next
        }
      />,
    );

  switch (screen) {
    case 'which': {
      const example = `${sender?.local ?? rows[0]?.local ?? 'hello'}@${domain || W.domainPlaceholder}`;
      return question(
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
              testID="email-guided-own"
            >
              <View className="gap-1.5">
                <Label>{W.domainLabel}</Label>
                <Input
                  value={answers.domain}
                  onChangeText={(v) => set({ domain: v })}
                  placeholder={W.domainPlaceholder}
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  invalid={!!problems['email.domain']}
                  accessibilityLabel={W.domainLabel}
                  testID="email-guided-domain"
                />
                {problems['email.domain'] ? (
                  <FieldError>{problems['email.domain']}</FieldError>
                ) : looking === lookup && lookup ? (
                  <FoundLine tone="quiet" testID="email-guided-looking">
                    {W.looking}
                  </FoundLine>
                ) : found?.missing ? (
                  <FoundLine tone="warn" testID="email-guided-not-found">
                    {W.notFound(found.domain)}
                  </FoundLine>
                ) : found && lookup === found.domain ? (
                  <FoundLine tone="ok" testID="email-guided-found">
                    {found.mailHost === 'handsfreeos' ? W.foundHere : W.foundAt(hostLabel, where)}
                  </FoundLine>
                ) : null}
              </View>
            </ChoiceTile>
            <ChoiceTile
              selected={answers.with === 'free'}
              onSelect={() => set({ with: 'free' })}
              title={W.free}
              hint={W.freeHint(freeAddress)}
              testID="email-guided-free"
            >
              <View className="gap-1.5">
                <Label>{W.freeLabel}</Label>
                <NameBox
                  value={answers.freeLocal}
                  domain={state.sharedDomain}
                  invalid={!!problems['email.freeLocal']}
                  onChange={(v) => set({ freeLocal: v })}
                  label={W.freeLabel}
                  testID="email-guided-free-local"
                />
                <FieldError>{problems['email.freeLocal']}</FieldError>
              </View>
            </ChoiceTile>
          </Choices>
          <FieldError>{problems['email.with']}</FieldError>
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
      return question(
        W.addressesTitle,
        W.addressesHint(domain),
        <>
          <View className="gap-2.5">
            {rows
              .filter((r) => r.existingId)
              .map((r) => (
                <View
                  key={r.existingId}
                  className="min-h-12 flex-row items-center gap-2 rounded-menu border border-border bg-card-2 px-3.5"
                  testID={`email-guided-existing-${r.local}`}
                >
                  <Text className="text-[15px]">{r.local}</Text>
                  <Text
                    className="min-w-0 flex-1 font-mono text-[13px] text-text-2"
                    numberOfLines={1}
                  >
                    @{domain}
                  </Text>
                  <Badge variant="gray">{W.setUpAlready}</Badge>
                </View>
              ))}
            {answers.addresses.map((a, n) => {
              const problem = problems[`email.addresses.${n}.local`];
              return (
                // Rows have no id of their own, and one is only ever added at the end or taken out whole.
                <View key={n} className="gap-1">
                  <View className="flex-row items-center gap-1">
                    <View className="min-w-0 flex-1">
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
                        testID={`email-guided-address-${n}`}
                      />
                    </View>
                    <Pressable
                      role="button"
                      accessibilityLabel={
                        a.local.trim() ? `${W.remove} ${a.local.trim()}@` : W.remove
                      }
                      onPress={() =>
                        set({ addresses: answers.addresses.filter((_, m) => m !== n) })
                      }
                      className="size-11 items-center justify-center rounded-menu active:bg-card-2"
                      testID={`email-guided-remove-${n}`}
                    >
                      <Icon as={X} className="size-[18px] text-text-2" />
                    </Pressable>
                  </View>
                  <FieldError>{problem}</FieldError>
                </View>
              );
            })}
          </View>
          {full ? (
            <Text className="text-[13.5px] leading-[19px] text-text-2">{W.tooMany}</Text>
          ) : (
            <Button
              variant="secondary"
              icon={Plus}
              className="self-start"
              onPress={() => add('')}
              testID="email-guided-add"
            >
              {W.addAnother}
            </Button>
          )}
          {ideas.length && !full ? (
            <View className="gap-2">
              <Text className="text-[13px] font-medium">{W.ideas}</Text>
              <View className="flex-row flex-wrap gap-2">
                {ideas.map((idea) => (
                  <Pressable
                    key={idea}
                    role="button"
                    accessibilityLabel={`${W.addAnother}: ${idea}`}
                    onPress={() => add(idea)}
                    hitSlop={{ top: 6, bottom: 6 }}
                    className="h-8 flex-row items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 active:bg-card-2"
                    testID={`email-guided-idea-${idea}`}
                  >
                    <Icon as={Plus} className="size-3.5 text-text-2" />
                    <Text className="text-[13px]">{idea}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          <FieldError>{problems['email.addresses']}</FieldError>
          {found?.mailHost === 'none' ? null : (
            <GuidedNote>
              <View className="flex-row items-start gap-2.5">
                <Icon as={Mail} className="mt-0.5 size-4 text-text-2" />
                <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
                  <Text className="text-[13.5px] font-semibold leading-[19px] text-text">
                    {W.anyoneElse(domain)}
                  </Text>{' '}
                  {W.anyoneElseHint}
                </Text>
              </View>
            </GuidedNote>
          )}
        </>,
      );
    }

    case 'readers': {
      const unpicked = rows.filter((r) => r.index !== null && !answers.addresses[r.index]?.picked);
      return question(
        W.readersTitle,
        W.readersHint,
        <>
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
          <FieldError>{problems['email.readers']}</FieldError>
          <View className="gap-2">
            {unpicked.length ? (
              <Text
                className="text-[13.5px] leading-[19px] text-text-2"
                testID="email-guided-picked-from-names"
              >
                {`${W.pickedFromNames} ${clauses(
                  unpicked.map((r) =>
                    r.reader === 'me' ? W.pickedMine(r.local) : W.pickedShared(r.local),
                  ),
                )}. ${W.changeEither}`}
              </Text>
            ) : null}
            <View className="flex-row items-start gap-2">
              <Icon as={Lock} className="mt-0.5 size-3.5 text-text-2" />
              <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2">
                {W.changeLater(ai)}
              </Text>
            </View>
          </View>
        </>,
      );
    }

    case 'sender':
      return question(
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
                best={
                  sender?.local === r.local && !answers.sender.trim() ? W.pickedForYou : undefined
                }
                testID={`email-guided-sender-${r.local}`}
              />
            ))}
          </Choices>
          <FieldError>{problems['email.readers']}</FieldError>
          {sender ? (
            <View
              className="gap-3 rounded-menu border border-border bg-card p-4"
              testID="email-guided-preview"
            >
              <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
                {W.preview}
              </Text>
              <View
                className="flex-row items-center gap-3"
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
              >
                <View className="size-10 items-center justify-center rounded-full bg-accent">
                  <Text className="text-[15px] font-semibold text-white">
                    {(answers.name.trim() || name || 'B').charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-[14px] font-semibold" numberOfLines={1}>
                    {answers.name.trim() || name}
                  </Text>
                  <Text className="font-mono text-[12px] text-text-2" numberOfLines={1}>
                    {sender.address}
                  </Text>
                  <Text className="text-[13px] text-text-2" numberOfLines={1}>
                    {W.previewSubject}
                  </Text>
                </View>
              </View>
            </View>
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
        <View className="gap-2">
          {rows.map((r) => (
            <ShowsLine key={r.address} icon={r.reader === 'team' ? Users : Lock}>
              {r.reader === 'me'
                ? W.showsOnlyYou(r.local)
                : r.reader === 'team'
                  ? W.showsTeam(r.local)
                  : W.showsTheirs(r.local)}
            </ShowsLine>
          ))}
          <ShowsLine icon={Inbox}>{W.anyOther(domain)}</ShowsLine>
        </View>
      );
      return question(
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
                testID="email-guided-receive-here"
              >
                {shows}
                {found?.mailHost === 'handsfreeos' ? null : elsewhere || !found?.mailHost ? (
                  <Note tone="warning" icon={CircleAlert} testID="email-guided-old-stays">
                    {`${W.oldStays(where)} ${W.onlyNew}`}
                  </Note>
                ) : (
                  <Text className="text-[13.5px] leading-[19px] text-text-2">{W.onlyNewNone}</Text>
                )}
              </ChoiceTile>
              <ChoiceTile
                selected={receive.value === false}
                onSelect={() => set({ receive: false })}
                title={elsewhere ? W.keepAt(where) : W.notYet}
                hint={elsewhere ? W.keepAtHint : W.notYetHint}
                testID="email-guided-receive-keep"
              />
            </Choices>
            <FieldError>{problems['email.receive']}</FieldError>
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
        ? PW.freeNow(freeAddress)
        : !verified && state.free
          ? W.backupStays(state.free.address)
          : null;
      const change = (to: EmailGuidedScreen) => (
        <Pressable
          role="button"
          accessibilityLabel={`${W.change}: ${to === 'which' ? W.reviewEmail : to === 'addresses' ? W.reviewAddresses : W.reviewWhere}`}
          onPress={() => {
            setReturnTo('review');
            go(to);
          }}
          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          testID={`email-guided-change-${to}`}
        >
          <Text className="text-[14px] font-medium text-accent-text">{W.change}</Text>
        </Pressable>
      );
      return page(
        W.reviewTitle,
        PW.reviewHint,
        <>
          <View className="overflow-hidden rounded-menu border border-border bg-card">
            <ReviewRow label={W.reviewEmail} action={change('which')} testID="email" first>
              <Text className="text-[15px]">{own ? W.soFarOwn(domain) : W.soFarFree}</Text>
              {own ? null : (
                <Text className="font-mono text-[13px] text-text-2">{freeAddress}</Text>
              )}
            </ReviewRow>
            {own ? (
              <ReviewRow label={W.reviewAddresses} action={change('addresses')} testID="addresses">
                <View className="gap-3">
                  {rows.map((r) => (
                    <View key={r.address} className="gap-1">
                      <Text className="font-mono text-[14px]">{r.address}</Text>
                      <View className="flex-row items-start gap-1.5">
                        <Icon
                          as={r.reader === 'team' ? Users : Lock}
                          className="mt-0.5 size-3.5 text-text-2"
                        />
                        <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-text-2">
                          {emailGuidedReviewLine(r, state)}
                        </Text>
                      </View>
                      {sender?.local === r.local ||
                      (!r.existingId && rows.some((x) => x.existingId)) ? (
                        <View className="flex-row flex-wrap gap-1.5">
                          {sender?.local === r.local ? (
                            <Badge variant="accent">{W.hearFrom}</Badge>
                          ) : null}
                          {!r.existingId && rows.some((x) => x.existingId) ? (
                            <Badge variant="ok">{W.reviewNew}</Badge>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              </ReviewRow>
            ) : null}
            {own ? (
              <ReviewRow
                label={W.reviewWhere}
                action={receive.fixed ? null : change('receive')}
                testID="receive"
              >
                <Text className="text-[15px]">
                  {receive.value ? W.inHfos : elsewhere ? W.keepAt(where) : W.notYet}
                </Text>
                {!verified ? (
                  <Text className="text-[13px] leading-[18px] text-text-2">
                    {W.reviewRecords(hostLabel)}
                  </Text>
                ) : receive.value && !receive.fixed ? (
                  <Text className="text-[13px] leading-[18px] text-text-2">
                    {W.reviewOneRecord(hostLabel)}
                  </Text>
                ) : null}
              </ReviewRow>
            ) : null}
            <ReviewRow label={W.nameLabel} action={null} testID="name">
              <Input
                value={answers.name}
                maxLength={120}
                onChangeText={(v) => set({ name: v })}
                invalid={!!problems['email.name']}
                accessibilityLabel={W.nameLabel}
                testID="email-guided-name"
              />
              <FieldError>{problems['email.name']}</FieldError>
            </ReviewRow>
          </View>
          {note ? (
            <View className="flex-row items-start gap-2">
              <Icon as={Info} className="mt-0.5 size-4 text-text-2" />
              <Text
                className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-text-2"
                testID="email-guided-review-note"
              >
                {note}
              </Text>
            </View>
          ) : null}
        </>,
        <GuidedFooter
          onBack={back}
          onNext={() => void finish()}
          busy={busy}
          error={error}
          nextLabel={W.setItUp}
          testID="email-guided"
        />,
      );
    }
  }
}

/** What the look-up found, under the website name. */
function FoundLine({
  tone,
  testID,
  children,
}: {
  tone: 'ok' | 'warn' | 'quiet';
  testID: string;
  children: string;
}) {
  const colors = useColors();
  return (
    <View className="flex-row items-start gap-2" role="status" testID={testID}>
      {tone === 'quiet' ? (
        <ActivityIndicator size="small" color={colors.text3} />
      ) : (
        <Icon
          as={tone === 'ok' ? Check : CircleAlert}
          className={cn('mt-0.5 size-3.5', tone === 'ok' ? 'text-success' : 'text-warning-text')}
          strokeWidth={tone === 'ok' ? 2.5 : 2}
        />
      )}
      <Text
        className={cn(
          'min-w-0 flex-1 text-[13.5px] leading-[19px]',
          tone === 'warn' ? 'text-warning-text' : 'text-text-2',
        )}
      >
        {children}
      </Text>
    </View>
  );
}

/** A name box with the website name after it: [office]@burroughs.digital. */
function NameBox({
  value,
  domain,
  invalid,
  onChange,
  label,
  testID,
}: {
  value: string;
  domain: string;
  invalid: boolean;
  onChange: (v: string) => void;
  /** Its name for a screen reader. */
  label: string;
  testID: string;
}) {
  return (
    <Input
      value={value}
      onChangeText={onChange}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      invalid={invalid}
      accessibilityLabel={label}
      trailing={
        <Text className="max-w-[60%] pr-3.5 font-mono text-[13px] text-text-2" numberOfLines={1}>
          @{domain}
        </Text>
      }
      testID={testID}
    />
  );
}

/** One line of what shows where, once mail comes here. */
function ShowsLine({ icon, children }: { icon: typeof Lock; children: string }) {
  return (
    <View className="flex-row items-start gap-2.5">
      <Icon as={icon} className="mt-0.5 size-4 text-text-2" />
      <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px]">{children}</Text>
    </View>
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
    <View className="gap-2.5" testID={`email-guided-reader-${row.local}`}>
      <Text className="font-mono text-[14px]">{row.address}</Text>
      {row.existingId ? (
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {`${line} ${PW.existingReader}`}
        </Text>
      ) : (
        <>
          <Choices label={W.whoReads(row.address)}>
            <ChoiceTile
              selected={row.reader === 'me'}
              onSelect={() => onReader('me')}
              title={W.onlyMe}
              icon={Lock}
              hint={W.onlyMeHint}
              testID={`email-guided-reader-${row.local}-me`}
            />
            <ChoiceTile
              selected={row.reader === 'team'}
              onSelect={() => onReader('team')}
              title={W.theTeam}
              icon={Users}
              hint={W.theTeamHint(aiOn)}
              testID={`email-guided-reader-${row.local}-team`}
            />
          </Choices>
          {row.reader === 'me' && ai ? (
            <View className="flex-row items-center gap-3 rounded-menu bg-card-2 px-3.5 py-3">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[14.5px] font-semibold">{W.letAiRead(ai)}</Text>
                <Text className="text-[13px] leading-[18px] text-text-2">
                  {W.letAiReadHint(ai)}
                </Text>
              </View>
              <Switch
                checked={row.aiReads}
                onCheckedChange={onAiReads}
                label={`${W.letAiRead(ai)}: ${row.address}`}
                testID={`email-guided-ai-${row.local}`}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/** One line of Check it over: what it is, what was answered, and Change. */
function ReviewRow({
  label,
  action,
  testID,
  first = false,
  children,
}: {
  label: string;
  action: React.ReactNode;
  testID: string;
  /** The top line: no rule over it. */
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View
      className={cn('gap-1.5 px-4 py-3.5', !first && 'border-t border-border')}
      testID={`email-guided-review-${testID}`}
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
          {label}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}
