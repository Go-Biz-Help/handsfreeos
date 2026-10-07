'use client';
/**
 * The last screen of quick setup (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, screen 12): what Save
 * couldn't finish, the chat's code when it added one, then a test chat that asks the teammate the questions made from
 * the business (`aiSetupTestQuestions`). Each answer shows as it's written; one that went to a person gets "Add the
 * answer", which saves an answer to Knowledge and asks again. Then "Turn on with training wheels".
 *
 * The test is the builder's console's (POST {worker}/v1/ai-team/test, lib/ai-team/test-stream.ts) with the saved
 * settings: look-ups are real, nothing is sent, and it never counts toward training wheels.
 */
import {
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_MAX,
  AI_SETUP_OUTCOME_WORDS,
  AI_SETUP_TEMPLATE_WORDS as T,
  AI_SETUP_WORDS,
  aiSetupChatSnippet,
  aiSetupWentToPerson,
  withAiName,
  type TestOutcome,
} from '@hfos/core';
import {
  AlertTriangle,
  Building2,
  Check,
  ExternalLink,
  MessageSquare,
  Send,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Callout, Note } from '@/components/ai-team/parts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AiSetupActions } from '@/lib/ai-setup/actions';
import { streamTest, testConsoleMissing } from '@/lib/ai-team/test-stream';
import { errorMessage } from '@/lib/api/client';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';

interface Asked {
  readonly id: number;
  readonly question: string;
  readonly state: 'waiting' | 'asking' | 'done' | 'error';
  readonly reply: string;
  readonly outcome: TestOutcome | null;
  readonly error: string | null;
}

const asked = (id: number, question: string): Asked => ({
  id,
  question,
  state: 'waiting',
  reply: '',
  outcome: null,
  error: null,
});

/** It didn't answer itself: the question is worth an answer in Knowledge. */
const unanswered = (a: Asked) => a.state === 'done' && aiSetupWentToPerson(a.outcome);

export function TryAva({
  workspaceId,
  name,
  questions,
  teammate,
  notes,
  chat,
  brandedOrigin,
  pageUrl = null,
  settingsHref,
  actions,
  onDone,
  saveTo = null,
}: {
  workspaceId: string;
  name: string;
  /** The questions the test starts with. */
  questions: readonly string[];
  teammate: { id: string; status: 'off' | 'training' | 'automatic'; approvals: number };
  /** What Save couldn't finish. */
  notes: readonly string[];
  /** The website chat Save added. */
  chat: { publicKey: string } | null;
  brandedOrigin: string | null;
  /** The business's simple page, when the chat went on it because there's no website: nothing to paste then. */
  pageUrl?: string | null;
  settingsHref: string;
  actions: AiSetupActions;
  /** Turned on, or "Not yet". */
  onDone: (turnedOn: boolean) => void;
  /**
   * "Save these answers for your other businesses", for the agency's owners and admins (§9): its name, and the
   * name the answers start with.
   */
  saveTo?: { organizationId: string; agency: string; suggested: string } | null;
}) {
  const [list, setList] = useState<readonly Asked[]>(() => questions.map((q, i) => asked(i, q)));
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  const [turning, setTurning] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const nextId = useRef(questions.length);
  const abort = useRef<AbortController | null>(null);
  const update = (id: number, patch: Partial<Asked>) =>
    setList((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  /** Asks one question, as a new customer writing in, and shows the answer as it's written. */
  async function ask(a: Pick<Asked, 'id' | 'question'>): Promise<boolean> {
    const stop = new AbortController();
    abort.current = stop;
    update(a.id, { state: 'asking', reply: '', outcome: null, error: null });
    let failed: string | null = null;
    try {
      await streamTest(
        {
          workspaceId,
          channel: 'sms',
          messages: [{ from: 'customer', text: a.question }],
        },
        (e) => {
          if (e.type === 'delta')
            setList((l) => l.map((x) => (x.id === a.id ? { ...x, reply: x.reply + e.text } : x)));
          else if (e.type === 'done')
            update(a.id, { state: 'done', outcome: e.outcome, reply: e.reply ?? '' });
          else if (e.type === 'error') failed = e.message;
        },
        stop.signal,
      );
    } catch (e) {
      failed = testConsoleMissing(e)
        ? 'The test chat isn’t ready on this server yet. Try it later from the AI teammate page.'
        : errorMessage(e);
    }
    if (failed) update(a.id, { state: 'error', error: failed });
    return !failed;
  }

  async function askAll() {
    setBusy(true);
    try {
      for (const a of list.filter((x) => x.state === 'waiting' || x.state === 'error'))
        if (!(await ask(a))) break;
    } finally {
      setBusy(false);
    }
  }

  async function askOwn() {
    const question = own.trim();
    if (!question) return;
    const a = asked(nextId.current++, question);
    setList((l) => [...l, a]);
    setOwn('');
    setBusy(true);
    try {
      await ask(a);
    } finally {
      setBusy(false);
    }
  }

  async function turnOn() {
    setTurning(true);
    setTurnError(null);
    try {
      await actions.turnOn(teammate.id);
      onDone(true);
    } catch (e) {
      setTurnError(errorMessage(e));
      setTurning(false);
    }
  }

  const done = list.filter((a) => a.state === 'done');
  const gaps = done.filter(unanswered);
  const waiting = list.some((a) => a.state === 'waiting' || a.state === 'error');
  const on = teammate.status !== 'off';

  return (
    <div className="flex flex-col gap-5" data-testid="ai-setup-try">
      {notes.map((n) => (
        <Callout key={n} tone="warning" icon={AlertTriangle}>
          {n}
        </Callout>
      ))}
      {chat && pageUrl ? (
        <ChatOnPage name={name} pageUrl={pageUrl} />
      ) : chat ? (
        <ChatCode
          publicKey={chat.publicKey}
          brandedOrigin={brandedOrigin}
          moreHref={`/app/w/${workspaceId}/settings/website-chat`}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-semibold">
            <MessageSquare className="h-4 w-4" strokeWidth={1.75} />
            {withAiName(W.reportTitle, name)}
          </h3>
          {waiting ? (
            <Button
              onClick={() => void askAll()}
              loading={busy}
              disabled={busy}
              data-testid="ai-setup-ask-all"
            >
              {withAiName(W.askThese, name)}
            </Button>
          ) : null}
        </div>
        <ol className="flex flex-col gap-3" data-testid="ai-setup-test">
          {list.map((a) => (
            <TestRow
              key={a.id}
              a={a}
              name={name}
              busy={busy}
              onAnswer={async (answer) => {
                await actions.addAnswer(a.question, answer);
                setBusy(true);
                try {
                  await ask(a);
                } finally {
                  setBusy(false);
                }
              }}
            />
          ))}
        </ol>
        {done.length && !waiting ? (
          <p
            className={cn('text-[13.5px]', gaps.length ? 'text-warning-text' : 'text-success-text')}
            data-testid="ai-setup-report"
          >
            {gaps.length ? W.reportGaps(gaps.length) : withAiName(W.reportAllKnown, name)}
          </p>
        ) : null}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void askOwn();
          }}
        >
          <Input
            aria-label={W.askOwn}
            placeholder={W.askOwn}
            value={own}
            maxLength={2000}
            onChange={(e) => setOwn(e.target.value)}
            data-testid="ai-setup-ask-own"
          />
          <Button type="submit" variant="secondary" disabled={busy || !own.trim()}>
            <Send className="h-4 w-4" strokeWidth={1.75} />
            {W.ask}
          </Button>
        </form>
        <Note>{withAiName(W.textTip, name)}</Note>
      </section>

      {saveTo ? <SaveForOthers saveTo={saveTo} name={name} actions={actions} /> : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        {on ? (
          <>
            <span
              className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] text-success-text"
              data-testid="ai-setup-on"
            >
              <Check className="h-4 w-4 flex-none" strokeWidth={2} />
              {withAiName(W.isOn, name)}
            </span>
            <Button onClick={() => onDone(false)} data-testid="ai-setup-done">
              {AI_SETUP_WORDS.done}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => void turnOn()} loading={turning} data-testid="ai-setup-turn-on">
              {AI_SETUP_WORDS.turnOn}
            </Button>
            <Button variant="ghost" onClick={() => onDone(false)} data-testid="ai-setup-not-yet">
              {AI_SETUP_WORDS.notYet}
            </Button>
          </>
        )}
        <Link
          href={settingsHref}
          className="ml-auto text-[13px] font-medium text-accent-text hover:underline"
          data-testid="ai-setup-more-settings"
        >
          {AI_SETUP_WORDS.moreSettings}
        </Link>
      </div>
      {turnError ? <FieldError>{turnError}</FieldError> : null}
      {!on ? (
        <p className="-mt-3 text-[12.5px] text-text-3">
          {withAiName(W.turnedOn(teammate.approvals), name)}
        </p>
      ) : null}
    </div>
  );
}

/** Keeps these answers for the agency's other businesses to start from. */
function SaveForOthers({
  saveTo,
  name,
  actions,
}: {
  saveTo: NonNullable<Parameters<typeof TryAva>[0]['saveTo']>;
  name: string;
  actions: AiSetupActions;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(saveTo.suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save() {
    const named = title.trim();
    if (!named) return setError('Name these answers.');
    setBusy(true);
    setError(null);
    try {
      const out = await actions.saveForOthers(saveTo.organizationId, named);
      setSaved(out.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (saved)
    return (
      <Callout icon={Check} testId="ai-setup-saved-for-others">
        {T.saved(saved)}
      </Callout>
    );
  if (!open)
    return (
      <div>
        <Button
          variant="secondary"
          onClick={() => setOpen(true)}
          data-testid="ai-setup-save-for-others"
        >
          <Building2 className="h-4 w-4" strokeWidth={1.75} />
          {T.saveTitle}
        </Button>
      </div>
    );
  return (
    <section className="flex flex-col gap-3 rounded-menu border border-border p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        <Building2 className="h-4 w-4" strokeWidth={1.75} />
        {T.saveTitle}
      </h3>
      <p className="text-[13px] text-text-2">{withAiName(T.saveHint(saveTo.agency), name)}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={T.saveName} htmlFor="ai-setup-save-name" className="min-w-[220px] flex-1">
          <Input
            id="ai-setup-save-name"
            value={title}
            maxLength={AI_SETUP_MAX.templateName}
            invalid={!!error}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
            data-testid="ai-setup-save-name"
          />
        </Field>
        <Button type="submit" loading={busy} data-testid="ai-setup-save-for-others-save">
          {T.saveAction}
        </Button>
        <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
          {AI_SETUP_WORDS.cancel}
        </Button>
      </form>
      <FieldError>{error}</FieldError>
    </section>
  );
}

function TestRow({
  a,
  name,
  busy,
  onAnswer,
}: {
  a: Asked;
  name: string;
  busy: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gap = unanswered(a);
  return (
    <li
      className="flex flex-col gap-2 rounded-menu border border-border p-3.5"
      data-testid={`ai-setup-test-${a.id}`}
      data-state={a.state}
      data-outcome={a.outcome ?? ''}
    >
      <div className="flex items-start gap-2">
        <UserRound className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 font-medium">{a.question}</span>
        {a.state === 'done' && a.outcome ? (
          <Badge variant={gap ? 'pending' : 'ok'} className="h-5 flex-none text-[11.5px]">
            {AI_SETUP_OUTCOME_WORDS[a.outcome]}
          </Badge>
        ) : null}
      </div>
      {a.state === 'asking' && !a.reply ? (
        <p className="pl-6 text-[13.5px] text-text-3">{W.asking}</p>
      ) : a.reply ? (
        <p className="whitespace-pre-wrap rounded-[10px] bg-card-2 px-3 py-2 text-[14px] leading-[1.45]">
          <span className="sr-only">{name}: </span>
          {a.reply}
        </p>
      ) : null}
      {a.error ? <FieldError>{a.error}</FieldError> : null}
      {gap && !open ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={() => setOpen(true)}
          data-testid={`ai-setup-test-${a.id}-add`}
        >
          {W.addAnswer}
        </Button>
      ) : null}
      {gap && open ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!answer.trim()) return;
            setSaving(true);
            setError(null);
            try {
              await onAnswer(answer.trim());
              setOpen(false);
              setAnswer('');
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Textarea
            aria-label={W.answer}
            placeholder={withAiName(W.addAnswerHint, name)}
            value={answer}
            maxLength={5000}
            className="min-h-[64px]"
            onChange={(e) => setAnswer(e.target.value)}
            data-testid={`ai-setup-test-${a.id}-answer`}
          />
          <FieldError>{error}</FieldError>
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              loading={saving}
              disabled={!answer.trim()}
              data-testid={`ai-setup-test-${a.id}-save`}
            >
              {W.addAnswer}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {AI_SETUP_WORDS.cancel}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

/** The chat Save put on the business's simple page: it's already there, so only a way to see it. */
function ChatOnPage({ name, pageUrl }: { name: string; pageUrl: string }) {
  return (
    <section
      className="flex flex-col gap-2 rounded-menu border border-border p-4"
      data-testid="ai-setup-chat-on-page"
    >
      <h3 className="font-semibold">{withAiName(W.chatOnPage, name)}</h3>
      <p className="text-[13px] text-text-2">{W.chatOnPageHint}</p>
      <a
        href={pageUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 self-start text-[13px] font-medium text-accent-text hover:underline"
      >
        {W.chatOnPageOpen}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    </section>
  );
}

/** The website chat Save added: the code to paste, and the full instructions one link away. */
function ChatCode({
  publicKey,
  brandedOrigin,
  moreHref,
}: {
  publicKey: string;
  brandedOrigin: string | null;
  /** The chat’s own page: steps for WordPress, Wix and other site builders, the install check and more. */
  moreHref: string;
}) {
  const origin = usePublicOrigin(brandedOrigin);
  const snippet = aiSetupChatSnippet(origin ?? '', publicKey);
  return (
    <section
      className="flex flex-col gap-2 rounded-menu border border-border p-4"
      data-testid="ai-setup-chat-code"
    >
      <h3 className="font-semibold">{W.chatCode}</h3>
      <p className="text-[13px] text-text-2">{W.chatCodeHint}</p>
      {origin ? <CopyField value={snippet} label={W.copy} copied={W.copied} /> : null}
      <Link
        href={moreHref}
        className="self-start text-[13px] font-medium text-accent-text hover:underline"
      >
        {W.chatMoreWays}
      </Link>
    </section>
  );
}
