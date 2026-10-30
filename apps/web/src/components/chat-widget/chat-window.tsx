'use client';
/**
 * The chat window (/chat/<key>): what a visitor sees after clicking the business's chat button. It talks to the page
 * around it only through three messages, each checked against the other side's origin: "open" (from it, with the
 * page's path), "close" and "unread" (to it, a count only). Its token never leaves it.
 *
 * Keyboard alone works: focus starts in the composer, Tab stays inside the window, and Escape closes it. New
 * messages are announced (role="log"). Motion stops for people who ask for less.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { Turnstile } from '@/components/booking/turnstile';
import { widgetColors } from '@/lib/chat/look';
import type { ChatConfig } from '@/lib/chat/lookup';
import {
  INITIAL_SNAPSHOT,
  PreviewChatSession,
  VisitorChatSession,
  type ChatSession,
  type DetailsValues,
  type FieldProblems,
  type LogItem,
} from '@/lib/chat/session';
import { useOrigin } from '@/lib/use-origin';
import {
  AFTER_FIRST_INTRO,
  ChatFooter,
  ChatHeader,
  ChatStyles,
  Composer,
  DetailsDone,
  DetailsForm,
  LogEntry,
  PhasePanel,
  PreviewStrip,
  TestMissing,
  Typing,
} from './chat-parts';

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
const noSubscribe = () => () => {};
const initial = () => INITIAL_SNAPSHOT;
const NONE = { name: false, phone: false, email: false } as const;
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]),select:not([disabled]),iframe,[tabindex="0"]';

export interface ChatWindowProps {
  readonly widgetKey: string;
  readonly config: ChatConfig;
  /** The page around the window, as the browser's frame rule confirmed; null in a preview. */
  readonly origin: string | null;
  readonly path: string | null;
  /** The preview page's workspace: replies come from the teammate's test console. */
  readonly preview: string | null;
}

export function ChatWindow({ widgetKey, config, origin, path, preview }: ChatWindowProps) {
  const self = useOrigin();
  // The page around the window: the business's site, or our own preview page.
  const host = origin ?? (preview && self ? self : null);
  const teammate = config.teammate?.name ?? null;
  // Made on the client only (it reads the window's own storage); the server renders the empty chat.
  const [session] = useState<ChatSession | null>(() => {
    if (typeof window === 'undefined') return null;
    return preview
      ? new PreviewChatSession({ workspaceId: preview, teammateName: teammate, away: config.away })
      : new VisitorChatSession({
          key: widgetKey,
          origin: origin ?? '',
          path,
          teammateName: teammate,
          siteKey: config.humanCheck?.siteKey ?? TURNSTILE_SITE_KEY,
        });
  });
  const snap = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.snapshot ?? initial,
    initial,
  );
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const [dismissed, setDismissed] = useState(false);
  // What they gave, shown in the log where they gave it (`at`: before that many messages).
  const [done, setDone] = useState<{
    name: string | null;
    contact: string | null;
    texts: boolean;
    at: number;
  } | null>(null);

  useEffect(() => {
    if (!session) return;
    session.honeypot = () => honeypot.current?.value ?? '';
    session.attach();
    return () => session.detach();
  }, [session]);

  const post = useCallback(
    (message: Record<string, unknown>) => {
      if (host && window.parent !== window) window.parent.postMessage(message, host);
    },
    [host],
  );

  const focusFirst = useCallback(() => {
    const el = root.current?.querySelector<HTMLElement>(
      '[data-autofocus] input, [data-autofocus] textarea',
    );
    (el ?? composer.current)?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!session || !host) return;
    session.onUnread = (n) => post({ hfos: 'unread', n });
    // Says it's here, so the loader keeps its button (a window the browser refused never says anything).
    post({ hfos: 'unread', n: 0 });
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== host) return;
      const data: unknown = e.data;
      if (typeof data !== 'object' || data === null) return;
      const { hfos, path: at } = data as { hfos?: unknown; path?: unknown };
      if (hfos !== 'open') return;
      session.setOpen(true, typeof at === 'string' ? at : null);
      focusFirst();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session, host, post, focusFirst]);

  const close = useCallback(() => {
    session?.setOpen(false);
    post({ hfos: 'close' });
  }, [session, post]);

  // Focus starts where the visitor types: the first detail asked for, or the composer.
  useEffect(() => {
    if (snap.phase === 'starting' || snap.phase === 'ready') focusFirst();
  }, [snap.phase, focusFirst]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [snap.items, snap.typing, snap.phase, done, dismissed]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && host) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !root.current) return;
    // Focus stays in the window: Tab from the last control goes back to the first.
    const list = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    );
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const colors = widgetColors(config.look.accentColor);
  const vars = {
    '--wacc-l': colors.light.accent,
    '--wacc-on-l': colors.light.on,
    '--wacc-d': colors.dark.accent,
    '--wacc-on-d': colors.dark.on,
  } as CSSProperties;

  const { askFor } = config;
  const show = {
    name: askFor.name !== 'never' && !snap.gave.name,
    phone: askFor.phone !== 'never' && !snap.gave.phone,
    email: askFor.email !== 'never' && !snap.gave.email,
  };
  const before = {
    name: askFor.name === 'before_chat' && !snap.gave.name,
    phone: askFor.phone === 'before_chat' && !snap.gave.phone,
    email: askFor.email === 'before_chat' && !snap.gave.email,
  };
  const ready = snap.phase === 'ready';
  const nothingGiven = !snap.gave.name && !snap.gave.phone && !snap.gave.email;
  // Nobody is answering and they haven't written: the away message and a short form, as in the design.
  const awayForm = ready && config.away && !snap.started && !done;
  // Asked for before the chat starts: the composer waits for it.
  const beforeForm = ready && !awayForm && (before.name || before.phone || before.email);
  // "After their first message": the form comes then, whoever answers (the texting registration's chat, where the
  // box to agree to texts is the point). "When needed": the AI teammate asks when it has to, and with only people
  // answering the form comes after the first message too, so the team can get back to them.
  const afterFirst =
    askFor.name === 'after_first_message' ||
    askFor.phone === 'after_first_message' ||
    askFor.email === 'after_first_message';
  const laterForm =
    ready &&
    !awayForm &&
    !beforeForm &&
    snap.started &&
    nothingGiven &&
    !dismissed &&
    !done &&
    (afterFirst ||
      (!teammate &&
        (askFor.name === 'when_needed' ||
          askFor.phone === 'when_needed' ||
          askFor.email === 'when_needed')));
  const stopped =
    snap.phase === 'paused' ||
    snap.phase === 'blocked' ||
    snap.phase === 'unavailable' ||
    snap.phase === 'unreachable'
      ? snap.phase
      : null;
  const composerOn = !stopped && !awayForm && !beforeForm && snap.phase !== 'test_missing';
  const siteKey = snap.humanCheck?.siteKey ?? config.humanCheck?.siteKey ?? TURNSTILE_SITE_KEY;
  const checking = !preview && !!snap.humanCheck?.required && !!siteKey;

  const subtitle =
    snap.phase === 'paused'
      ? 'Paused right now'
      : config.away
        ? 'We’re away right now'
        : teammate
          ? `${teammate} (AI) and the team`
          : 'Chat with the team';
  const openingText = config.away
    ? (config.awayMessage ??
      'We’re not answering chats right now. Leave your details and we’ll get back to you.')
    : config.greeting;
  const opening: LogItem | null = openingText
    ? { id: 'opening', from: 'business', name: null, body: openingText, at: '', joined: false }
    : null;

  const identify = async (
    values: DetailsValues,
    withMessage: boolean,
  ): Promise<FieldProblems | null> => {
    if (!session) return { form: 'The chat isn’t ready yet. Try again in a moment.' };
    const name = values.name.trim();
    const phone = values.phone.trim();
    const email = values.email.trim();
    if (name || phone || email) {
      const problems = await session.identify(values);
      if (problems) return problems;
      setDone({
        name: name || null,
        contact: phone || email || null,
        texts: !!phone && values.smsConsent,
        at: snap.items.length,
      });
    }
    if (withMessage && values.message.trim()) {
      stick.current = true;
      session.send(values.message);
    }
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
    return null;
  };

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      className="hfos-w hfos-in fixed inset-0 flex flex-col overflow-hidden bg-card text-text"
      style={vars}
      data-testid="chat-window"
      data-phase={snap.phase}
    >
      <ChatStyles />
      <ChatHeader
        business={config.business.name}
        logo={config.business.logo}
        subtitle={subtitle}
        markColor={colors.mark}
        onClose={host ? close : null}
      />
      {preview ? <PreviewStrip /> : null}
      {stopped ? (
        <PhasePanel
          kind={stopped}
          onRetry={stopped === 'unreachable' && session ? () => session.reload() : undefined}
        />
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-bg px-3.5 pb-3 pt-3.5"
        >
          <div className="mt-auto flex flex-col gap-2">
            <div
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Messages"
              className="flex flex-col gap-2"
              data-testid="chat-log"
            >
              {opening ? <LogEntry item={opening} business={config.business.name} /> : null}
              {snap.items.map((item, i) => (
                <Fragment key={item.id}>
                  {done?.at === i ? (
                    <DetailsDone name={done.name} contact={done.contact} texts={done.texts} />
                  ) : null}
                  <LogEntry
                    item={item}
                    prev={i ? snap.items[i - 1] : (opening ?? undefined)}
                    business={config.business.name}
                    onRetry={session ? (id) => session.retry(id) : undefined}
                  />
                </Fragment>
              ))}
              {done && done.at >= snap.items.length ? (
                <DetailsDone name={done.name} contact={done.contact} texts={done.texts} />
              ) : null}
            </div>
            {awayForm ? (
              <div data-autofocus className="contents">
                <DetailsForm
                  testId="chat-away-form"
                  intro={null}
                  show={show}
                  required={before}
                  needContact={show.phone || show.email}
                  consentText={config.smsConsent?.detail ?? config.smsConsent?.text ?? null}
                  consentPolicyUrl={config.smsConsent?.policyUrl ?? null}
                  consentTermsUrl={config.smsConsent?.termsUrl ?? null}
                  offers={config.offersConsent}
                  calls={config.callConsent}
                  withMessage
                  submitLabel="Send"
                  onSubmit={(v) => identify(v, true)}
                />
              </div>
            ) : null}
            {beforeForm ? (
              <div data-autofocus className="contents">
                <DetailsForm
                  testId="chat-details-first"
                  intro="Before we start, how can we reach you?"
                  show={show}
                  required={before}
                  needContact={false}
                  consentText={config.smsConsent?.detail ?? config.smsConsent?.text ?? null}
                  consentPolicyUrl={config.smsConsent?.policyUrl ?? null}
                  consentTermsUrl={config.smsConsent?.termsUrl ?? null}
                  offers={config.offersConsent}
                  calls={config.callConsent}
                  withMessage={false}
                  submitLabel="Start the chat"
                  onSubmit={(v) => identify(v, false)}
                />
              </div>
            ) : null}
            {laterForm ? (
              <DetailsForm
                testId="chat-details"
                intro={
                  afterFirst
                    ? AFTER_FIRST_INTRO
                    : 'Leave your details, so we can get back to you if you leave.'
                }
                show={show}
                required={NONE}
                needContact={false}
                consentText={config.smsConsent?.detail ?? config.smsConsent?.text ?? null}
                consentPolicyUrl={config.smsConsent?.policyUrl ?? null}
                consentTermsUrl={config.smsConsent?.termsUrl ?? null}
                offers={config.offersConsent}
                calls={config.callConsent}
                withMessage={false}
                submitLabel="Send"
                onSubmit={(v) => identify(v, false)}
                onDismiss={() => setDismissed(true)}
              />
            ) : null}
            {ready && !opening && !snap.items.length && !beforeForm ? (
              <p
                className="self-center px-4 py-6 text-center text-[13px] text-text-3"
                data-testid="chat-empty"
              >
                {teammate
                  ? `Ask us anything. ${teammate} (AI) answers right away, and the team can join.`
                  : 'Ask us anything. The team replies right here.'}
              </p>
            ) : null}
            {snap.phase === 'test_missing' ? <TestMissing /> : null}
            {snap.typing ? <Typing name={snap.typing} /> : null}
          </div>
        </div>
      )}
      {checking && siteKey && session ? (
        <div className="flex-none bg-card px-3 pt-2">
          <Turnstile
            invisible
            siteKey={siteKey}
            resetKey={snap.humanReset}
            onToken={(token) => session.humanToken(token)}
          />
        </div>
      ) : null}
      {snap.notice && !stopped ? (
        <p role="alert" className="flex-none bg-card px-4 pt-2 text-xs text-danger-text">
          {snap.notice}
        </p>
      ) : null}
      {composerOn ? (
        <Composer
          inputRef={composer}
          honeypotRef={honeypot}
          maxLength={config.maxMessageLength}
          canSend={ready}
          onSend={(body) => {
            stick.current = true;
            session?.send(body);
          }}
        />
      ) : null}
      <ChatFooter />
    </div>
  );
}
