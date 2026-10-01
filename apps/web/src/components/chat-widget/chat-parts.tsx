'use client';
/**
 * The chat window's pieces (design/m7/WidgetDesktop and WidgetPhone): the accent header, bubbles with "Ava · AI
 * assistant" and "Dale joined", "typing", the details form with the booking page's texts-box wording, the composer
 * (16 px on phones, so they don't zoom in), and "Powered by HandsFreeOS". Colours come from the widget's accent
 * through --wacc and --wacc-on, which follow the visitor's light or dark setting.
 */
import {
  CircleAlert,
  CircleCheck,
  FlaskConical,
  RefreshCw,
  SendHorizontal,
  UserPlus,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { TeammateMark } from '@/components/ai-team/mark';
import { BrandMark } from '@/components/ui/brand';
import type { DetailsValues, FieldProblems, LogItem } from '@/lib/chat/session';
import { markOf } from '@/lib/chat/look';
import { cn } from '@/lib/utils';

const CSS = `html,body{height:100%;overflow:hidden}
.hfos-w{--wacc:var(--wacc-l);--wacc-on:var(--wacc-on-l)}
[data-theme='dark'] .hfos-w{--wacc:var(--wacc-d);--wacc-on:var(--wacc-on-d)}
@media (prefers-color-scheme:dark){:root:not([data-theme='light']) .hfos-w{--wacc:var(--wacc-d);--wacc-on:var(--wacc-on-d)}}
.hfos-dots i{display:block;width:7px;height:7px;border-radius:99px;background:var(--text-3);animation:hfos-dot 1.2s ease-in-out infinite}
.hfos-dots i:nth-child(2){animation-delay:.15s}
.hfos-dots i:nth-child(3){animation-delay:.3s}
@keyframes hfos-dot{0%,80%,100%{opacity:.35}40%{opacity:1}}
.hfos-in{animation:hfos-in .18s ease-out}
@keyframes hfos-in{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:reduce){.hfos-dots i{animation:none;opacity:.6}.hfos-in{animation:none}}`;

/** The window's own rules: the accent in light and dark, the typing dots, and nothing moving for reduced motion. */
export function ChatStyles() {
  return (
    <style href="hfos-chat-window" precedence="default">
      {CSS}
    </style>
  );
}

const TEXT = {
  missing: [
    'This chat isn’t available',
    'It may have been replaced. Refresh the page and try again.',
  ],
  refused: [
    'This chat opens from the business’s website',
    'Visit their website and use the chat button there.',
  ],
  unavailable: [
    'This chat isn’t available here',
    'Refresh the page and try again, or contact the business another way.',
  ],
  unreachable: ['We couldn’t reach the chat', 'Check your connection and try again in a minute.'],
  paused: [
    'This chat is paused right now',
    'Please try again later, or contact the business another way.',
  ],
  blocked: ['This chat isn’t available right now', 'Please contact the business another way.'],
} as const;
export type UnavailableKind = keyof typeof TEXT;

/** The whole window when there's nothing to chat in: opened on its own, an old key, the worker down. */
export function ChatUnavailable({ kind }: { kind: UnavailableKind }) {
  const [title, text] = TEXT[kind];
  return (
    <main
      className="flex h-dvh flex-col items-center justify-center gap-2 bg-bg px-6 text-center text-text"
      data-testid="chat-unavailable"
    >
      <ChatStyles />
      <CircleAlert className="h-6 w-6 text-text-3" aria-hidden />
      <h1 className="text-[15px] font-semibold">{title}</h1>
      <p className="max-w-[300px] text-[13px] text-text-2">{text}</p>
    </main>
  );
}

/** In place of the messages once the chat can't carry on (paused, blocked, unreachable). */
export function PhasePanel({ kind, onRetry }: { kind: UnavailableKind; onRetry?: () => void }) {
  const [title, text] = TEXT[kind];
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-bg px-6 text-center"
      data-testid={`chat-phase-${kind}`}
    >
      <CircleAlert className="h-6 w-6 text-text-3" aria-hidden />
      <p className="text-[15px] font-semibold">{title}</p>
      <p className="max-w-[280px] text-[13px] text-text-2">{text}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-control border border-border-strong bg-card px-3.5 text-sm font-medium hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function ChatHeader({
  business,
  subtitle,
  markColor,
  onClose,
}: {
  business: string;
  subtitle: string;
  markColor: string;
  onClose: (() => void) | null;
}) {
  return (
    <header className="flex flex-none items-center gap-2.5 bg-[var(--wacc)] py-3 pl-3.5 pr-2 text-[var(--wacc-on)]">
      <span
        aria-hidden
        className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-white text-[12.5px] font-bold tracking-[0.02em]"
        style={{ color: markColor }}
      >
        {markOf(business)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-[15px] font-semibold leading-[1.25]">{business}</h1>
        <p className="truncate text-xs opacity-90" data-testid="chat-subtitle">
          {subtitle}
        </p>
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the chat"
          className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wacc-on)]"
          data-testid="chat-close"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      ) : null}
    </header>
  );
}

export function PreviewStrip() {
  return (
    <p
      className="flex flex-none items-center gap-1.5 bg-warning-soft px-3.5 py-1.5 text-xs text-warning-text"
      data-testid="chat-preview-strip"
    >
      <FlaskConical className="h-3.5 w-3.5 flex-none" aria-hidden />
      Preview. Nothing here is sent or saved.
    </p>
  );
}

const LINK = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'’”]/g;

/** Plain text with its web addresses as links that open in a new tab. */
function Linked({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <a
        key={at}
        href={m[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
      >
        {m[0]}
      </a>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const timeOf = (at: string) =>
  at
    ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : undefined;

/** Whose it is, as the log shows it: "Ava", "Dale", the business, or "You". */
function whoOf(item: LogItem, business: string): string {
  if (item.from === 'teammate') return item.name ?? 'Assistant';
  if (item.from === 'person') return item.name ?? 'The team';
  if (item.from === 'business') return business;
  return 'You';
}

/** One line of the log: a message (with its sender when it changes, and "Dale joined"), or a HandsFreeOS note. */
export function LogEntry({
  item,
  prev,
  business,
  onRetry,
}: {
  item: LogItem;
  prev?: LogItem;
  business: string;
  onRetry?: (id: string) => void;
}) {
  if (item.from === 'note')
    return (
      <p
        className="my-1 flex max-w-[92%] items-start gap-1.5 self-center text-center text-xs leading-[1.45] text-text-3"
        data-testid="chat-note"
      >
        <FlaskConical className="mt-px h-3.5 w-3.5 flex-none" aria-hidden />
        {item.body}
      </p>
    );
  const mine = item.from === 'visitor';
  const joined = item.from === 'person' && item.joined;
  const grouped = !!prev && prev.from === item.from && prev.name === item.name && !joined;
  const who = whoOf(item, business);
  return (
    <>
      {joined ? (
        <p
          className="my-1 flex items-center gap-1.5 self-center text-xs text-text-3"
          data-testid="chat-joined"
        >
          <UserPlus className="h-[13px] w-[13px]" aria-hidden />
          {who} joined
        </p>
      ) : null}
      <div
        className={cn(
          'flex max-w-[84%] flex-col gap-[3px]',
          mine ? 'items-end self-end' : 'self-start',
        )}
        data-testid={`chat-message-${item.from}`}
      >
        {!mine && !grouped ? (
          <div className="flex items-center gap-[5px] whitespace-nowrap px-1 text-[11.5px] text-text-3">
            {item.from === 'teammate' ? (
              <TeammateMark size="xs" className="h-4 w-4 shadow-none" />
            ) : null}
            <b className="font-semibold text-text-2">{who}</b>
            {item.from === 'teammate' ? <span>· AI assistant</span> : null}
          </div>
        ) : null}
        <div
          title={timeOf(item.at)}
          className={cn(
            'whitespace-pre-wrap rounded-2xl px-3 py-[9px] text-sm leading-[1.45] [overflow-wrap:anywhere]',
            mine
              ? 'rounded-br-[5px] bg-[var(--wacc)] text-[var(--wacc-on)]'
              : 'rounded-bl-[5px] border border-border bg-card text-text',
            item.status === 'sending' && 'opacity-70',
          )}
        >
          {mine || grouped ? <span className="sr-only">{`${who}: `}</span> : null}
          <Linked text={item.body} />
        </div>
        {item.status === 'failed' ? (
          <p
            role="alert"
            className="flex flex-wrap items-center justify-end gap-x-2 px-1 text-xs text-danger-text"
          >
            <span>{item.error ?? 'Not sent.'}</span>
            {onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(item.id)}
                className="font-semibold underline underline-offset-2"
              >
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** "Ava is typing": only while the AI teammate writes. */
export function Typing({ name }: { name: string }) {
  return (
    <div
      role="status"
      aria-label={`${name} is typing`}
      className="flex flex-col gap-[3px] self-start"
      data-testid="chat-typing"
    >
      <div className="flex items-center gap-[5px] px-1 text-[11.5px] text-text-3">
        <TeammateMark size="xs" className="h-4 w-4 shadow-none" />
        <b className="font-semibold text-text-2">{name}</b>
      </div>
      <div className="hfos-dots inline-flex items-center gap-1 self-start rounded-2xl rounded-bl-[5px] border border-border bg-card px-3.5 py-3">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

/** Preview only: the teammate's test console hasn't arrived yet. */
export function TestMissing() {
  return (
    <div
      role="status"
      className="my-2 flex flex-col items-center gap-1.5 self-center rounded-[14px] border border-dashed border-border-strong bg-card px-4 py-4 text-center"
      data-testid="chat-test-missing"
    >
      <FlaskConical className="h-5 w-5 text-text-3" aria-hidden />
      <p className="text-[13px] font-medium">
        The test console arrives with the teammate’s runtime.
      </p>
      <p className="max-w-[260px] text-xs text-text-3">
        Until then, the preview shows your chat as visitors see it, without replies.
      </p>
    </div>
  );
}

const FIELD =
  'h-11 w-full rounded-control border border-border-strong bg-card px-3 text-[16px] text-text placeholder:text-placeholder focus:border-[var(--wacc)] focus:outline-none focus:ring-[3px] focus:ring-[color-mix(in_oklab,var(--wacc)_28%,transparent)] aria-[invalid=true]:border-danger [@media(hover:hover)_and_(pointer:fine)]:h-10 [@media(hover:hover)_and_(pointer:fine)]:text-sm';

type Fields = { readonly name: boolean; readonly phone: boolean; readonly email: boolean };

export interface DetailsFormProps {
  /** The details it asks for. */
  readonly show: Fields;
  /** The ones asked for before the chat starts. */
  readonly required: Fields;
  /** A mobile number or an email is needed, so the team can get back to them. */
  readonly needContact: boolean;
  /** The texts box's wording, shown with the mobile number; null when the widget doesn't offer it. */
  readonly consentText: string | null;
  /** The business's privacy policy, when it has a public site. Linked, never inside the label. */
  readonly consentPolicyUrl?: string | null;
  /** Its terms, linked beside the policy. */
  readonly consentTermsUrl?: string | null;
  /** The away form: "How can we help?" too. */
  readonly withMessage: boolean;
  readonly intro: string | null;
  readonly submitLabel: string;
  /** Problems to show, or null when it went through. */
  readonly onSubmit: (values: DetailsValues) => Promise<FieldProblems | null>;
  readonly onDismiss?: () => void;
  readonly testId: string;
}

/** Name, mobile and email as the widget asks for them, with the booking page's texts box. */
export function DetailsForm(p: DetailsFormProps) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<DetailsValues>({
    name: '',
    phone: '',
    email: '',
    smsConsent: false,
    message: '',
  });
  const [problems, setProblems] = useState<FieldProblems>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<DetailsValues>) => setValues((v) => ({ ...v, ...patch }));

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [problems]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found: FieldProblems = {};
    if (p.required.name && !values.name.trim()) found.name = 'Tell us your name.';
    if (p.required.phone && !values.phone.trim()) found.phone = 'Add your mobile number.';
    if (p.required.email && !values.email.trim()) found.email = 'Add your email.';
    const contact = (p.show.phone && values.phone.trim()) || (p.show.email && values.email.trim());
    if (p.needContact && !contact && !found.phone && !found.email)
      found[p.show.phone ? 'phone' : 'email'] =
        'Leave a mobile number or email so we can get back to you.';
    const anyRequired = p.required.name || p.required.phone || p.required.email;
    if (
      !anyRequired &&
      !p.withMessage &&
      !p.needContact &&
      !values.name.trim() &&
      !values.phone.trim() &&
      !values.email.trim()
    )
      found.form = p.onDismiss
        ? 'Fill in at least one, or choose Not now.'
        : 'Fill in at least one.';
    if (p.withMessage && !values.message.trim()) found.message = 'Tell us how we can help.';
    if (Object.keys(found).length) {
      setProblems(found);
      return;
    }
    setBusy(true);
    setProblems({});
    const result = await p.onSubmit(values);
    setBusy(false);
    if (result) setProblems(result);
  };

  const field = (
    key: 'name' | 'phone' | 'email',
    label: string,
    input: { type: string; autoComplete: string; inputMode?: 'tel' | 'email' },
    optional: boolean,
  ) =>
    p.show[key] ? (
      <div>
        <label htmlFor={`${id}-${key}`} className="mb-1 block text-[13px] font-medium">
          {label}
          {optional ? <span className="font-normal text-text-3"> Optional</span> : null}
        </label>
        <input
          id={`${id}-${key}`}
          type={input.type}
          autoComplete={input.autoComplete}
          inputMode={input.inputMode}
          value={values[key]}
          onChange={(e) => set({ [key]: e.target.value })}
          aria-invalid={problems[key] ? true : undefined}
          aria-describedby={problems[key] ? `${id}-${key}-problem` : undefined}
          className={FIELD}
          data-testid={`${p.testId}-${key}`}
        />
        {problems[key] ? (
          <p id={`${id}-${key}-problem`} className="mt-1 text-xs text-danger-text">
            {problems[key]}
          </p>
        ) : null}
      </div>
    ) : null;

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-2.5 self-stretch rounded-[14px] border border-border bg-card p-3"
      data-testid={p.testId}
    >
      {p.intro ? <p className="text-[13px] font-medium leading-[1.4]">{p.intro}</p> : null}
      {field('name', 'Name', { type: 'text', autoComplete: 'name' }, false)}
      {field('phone', 'Mobile', { type: 'tel', autoComplete: 'tel', inputMode: 'tel' }, false)}
      {field(
        'email',
        'Email',
        { type: 'email', autoComplete: 'email', inputMode: 'email' },
        p.show.phone && !p.required.email,
      )}
      {p.withMessage ? (
        <div>
          <label htmlFor={`${id}-message`} className="mb-1 block text-[13px] font-medium">
            How can we help?
          </label>
          <textarea
            id={`${id}-message`}
            value={values.message}
            onChange={(e) => set({ message: e.target.value })}
            rows={3}
            maxLength={1000}
            aria-invalid={problems.message ? true : undefined}
            className={cn(FIELD, 'h-auto min-h-[72px] resize-none py-2.5 leading-[1.45]')}
            data-testid={`${p.testId}-message`}
          />
          {problems.message ? (
            <p className="mt-1 text-xs text-danger-text">{problems.message}</p>
          ) : null}
        </div>
      ) : null}
      {p.consentText && p.show.phone ? (
        <>
          <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-[1.5] text-text-2">
            <input
              type="checkbox"
              checked={values.smsConsent}
              onChange={(e) => set({ smsConsent: e.target.checked })}
              className="mt-0.5 h-[18px] w-[18px] flex-none cursor-pointer accent-[var(--wacc)]"
              data-testid={`${p.testId}-texts`}
            />
            <span>{p.consentText}</span>
          </label>
          {/* Outside the label on purpose: a link inside one toggles the box when it is followed. */}
          {p.consentPolicyUrl || p.consentTermsUrl ? (
            <span className="ml-[28px] text-xs text-text-3">
              {p.consentPolicyUrl ? (
                <a className="underline" href={p.consentPolicyUrl} target="_blank" rel="noreferrer">
                  Privacy policy
                </a>
              ) : null}
              {p.consentPolicyUrl && p.consentTermsUrl ? ' · ' : null}
              {p.consentTermsUrl ? (
                <a className="underline" href={p.consentTermsUrl} target="_blank" rel="noreferrer">
                  Terms
                </a>
              ) : null}
            </span>
          ) : null}
        </>
      ) : null}
      {problems.form ? (
        <p role="alert" className="text-xs text-danger-text">
          {problems.form}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-11 flex-1 items-center justify-center rounded-control bg-[var(--wacc)] text-[15px] font-semibold text-[var(--wacc-on)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_oklab,var(--wacc)_35%,transparent)] disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:h-10 [@media(hover:hover)_and_(pointer:fine)]:text-sm"
          data-testid={`${p.testId}-submit`}
        >
          {busy ? 'Sending…' : p.submitLabel}
        </button>
        {p.onDismiss ? (
          <button
            type="button"
            onClick={p.onDismiss}
            className="h-11 rounded-control px-3 text-sm font-medium text-text-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            Not now
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** After the details went in: what they gave, as the design's "Linda Park · (832) 555-0126". */
export function DetailsDone({
  name,
  contact,
  texts,
}: {
  name: string | null;
  contact: string | null;
  texts: boolean;
}) {
  const said = [name, contact].filter(Boolean).join(' · ');
  return (
    <div
      className="flex items-center gap-2.5 self-stretch rounded-[14px] bg-card-2 px-3 py-2.5 text-xs leading-[1.4]"
      data-testid="chat-details-done"
    >
      <CircleCheck className="h-4 w-4 flex-none text-success" aria-hidden />
      <span>
        <strong className="font-semibold">{said || 'Thanks. The team has your details.'}</strong>
        {texts ? (
          <>
            <br />
            Texts about this request: yes
          </>
        ) : null}
      </span>
    </div>
  );
}

export function Composer({
  onSend,
  canSend,
  maxLength,
  inputRef,
  honeypotRef,
}: {
  onSend: (body: string) => void;
  /** The chat is ready: typing works before, sending waits. */
  canSend: boolean;
  maxLength: number;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  honeypotRef: RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState('');
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  const submit = () => {
    const body = text.trim();
    if (!body || !canSend) return;
    onSend(body);
    setText('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative flex flex-none items-end gap-2 border-t border-border bg-card pb-2 pl-3 pr-2.5 pt-2.5"
      data-testid="chat-composer"
    >
      <label htmlFor="hfos-chat-input" className="sr-only">
        Write a message
      </label>
      <textarea
        id="hfos-chat-input"
        ref={inputRef}
        rows={1}
        value={text}
        maxLength={maxLength}
        placeholder="Write a message…"
        onChange={(e) => {
          setText(e.target.value);
          fit(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="max-h-[120px] min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-border-strong bg-card px-3.5 py-[10px] text-[16px] leading-[1.4] text-text placeholder:text-placeholder focus:border-[var(--wacc)] focus:outline-none focus:ring-[3px] focus:ring-[color-mix(in_oklab,var(--wacc)_28%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:min-h-[42px] [@media(hover:hover)_and_(pointer:fine)]:py-[9px] [@media(hover:hover)_and_(pointer:fine)]:text-[15px]"
        data-testid="chat-input"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!canSend || !text.trim()}
        className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-full bg-[var(--wacc)] text-[var(--wacc-on)] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_oklab,var(--wacc)_35%,transparent)] disabled:bg-card-3 disabled:text-text-3 [@media(hover:hover)_and_(pointer:fine)]:h-[42px] [@media(hover:hover)_and_(pointer:fine)]:w-[42px]"
        data-testid="chat-send"
      >
        <SendHorizontal className="h-[18px] w-[18px]" aria-hidden />
      </button>
      {/* A field only bots fill in. */}
      <input
        ref={honeypotRef}
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        className="pointer-events-none absolute -left-[9999px] top-0 h-px w-px opacity-0"
      />
    </form>
  );
}

export function ChatFooter() {
  return (
    <p className="flex flex-none items-center justify-center gap-[5px] bg-card pb-[9px] pt-0.5 text-[11px] text-text-3">
      <BrandMark size={12} />
      Powered by HandsFreeOS
    </p>
  );
}
