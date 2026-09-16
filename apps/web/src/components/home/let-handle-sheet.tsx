'use client';
import { clockLabel } from '@hfos/core';
import {
  CalendarPlus,
  Check,
  ChevronRight,
  CircleAlert,
  Info,
  Mail,
  MessageCircle,
  Send,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet, SheetClose, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { errorMessage } from '@/lib/api/client';
import type {
  AttentionAskOption,
  AttentionAutoPlan,
  AttentionItem,
  AttentionPreview,
} from '@/lib/api/types';
import { toLocalInputValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import { handleLook } from './attention-actions';
import { KindTile, ModeChip } from './attention-bits';
import { useAttentionEnv } from './attention-context';
import { chipsOf, customerOf, firstNameOf, KIND_LABEL, splitTitle } from './attention-words';
import { attentionCommands } from './use-attention';

type Ask = AttentionAskOption['action'];
const SECL = 'text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3';

function InfoRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
      <Info className="mt-px h-4 w-4 flex-none" strokeWidth={1.5} />
      <span>{children}</span>
    </div>
  );
}

function WarnRow({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      data-testid="let-handle-blocked"
      className="flex items-start gap-2.5 rounded-[10px] bg-warning-soft px-3 py-2.5 text-[13px] leading-[1.45] text-warning-text"
    >
      <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
      <span>{children}</span>
    </div>
  );
}

function TextPreview({ text }: { text: string }) {
  return (
    <div className="flex flex-col rounded-card border border-border bg-card-2 px-4 py-3.5">
      <p
        data-testid="let-handle-text"
        className="max-w-[92%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-2.5 text-sm leading-[1.45] text-white"
      >
        {text}
      </p>
    </div>
  );
}

function MailPreview({ plan }: { plan: AttentionAutoPlan }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-card">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-[13px]">
        <dt className="text-text-3">To</dt>
        <dd className="truncate">{plan.to}</dd>
        {plan.subject ? (
          <>
            <dt className="text-text-3">Subject</dt>
            <dd className="truncate font-medium">{plan.subject}</dd>
          </>
        ) : null}
      </dl>
      <p
        data-testid="let-handle-text"
        className="whitespace-pre-wrap break-words px-[18px] py-4 text-[13.5px] leading-[1.5]"
      >
        {plan.text}
      </p>
    </div>
  );
}

function Goes({ at, onCancel, busy }: { at: string; onCancel: () => void; busy: boolean }) {
  return (
    <div
      data-testid="let-handle-goes"
      className="flex items-center gap-2.5 rounded-[10px] bg-accent-soft px-3.5 py-[11px] text-[13.5px] text-accent-text"
    >
      <Zap className="h-4 w-4 flex-none" strokeWidth={1.75} />
      <span className="flex-1">
        <b className="font-semibold">Goes out at {at}</b> ·{' '}
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="font-semibold underline disabled:opacity-50"
          data-testid="let-handle-cancel"
        >
          Cancel
        </button>
      </span>
    </div>
  );
}

/**
 * Let HandsFreeOS Handle: exactly what will happen, before it does (`attention.preview_handle`).
 * - On its own (a confirmation request, a follow-up): the words as they'd go out, the channel, why not if it can't,
 *   and "Goes out at 10:40 · Cancel" once it's waiting.
 * - Asks first: the choices (hand to the AI teammate, a reply, a next action), each run as this person.
 * - Never (approvals, tasks): why.
 */
export function LetHandleSheet({
  item,
  open,
  onOpenChange,
  onDone,
}: {
  item: AttentionItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After it acted: `ask` actions clear the item (it resolves as the worker catches up). */
  onDone: (how: 'auto' | 'ask') => void;
}) {
  const env = useAttentionEnv();
  const [preview, setPreview] = useState<AttentionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Ask | null>(null);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [nextText, setNextText] = useState('');
  const [nextAt, setNextAt] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    attentionCommands(env.workspaceId)
      .preview(item.id)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setChoice((p.options.find((o) => o.available) ?? p.options[0])?.action ?? null);
        const suggestion = p.options.find((o) => o.action === 'set_next_action')?.suggestion;
        setNextText(suggestion?.text ?? '');
        setNextAt(suggestion?.dueAt ? toLocalInputValue(new Date(suggestion.dueAt)) : '');
        setScheduledFor(p.auto?.scheduledFor ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [env.workspaceId, item.id]);

  const cmd = attentionCommands(env.workspaceId);
  const name = customerOf(item) ?? item.title;
  const first = firstNameOf(name);
  const ai = env.teammateName ?? 'your AI teammate';
  const mode = preview?.mode ?? item.letHandleMode;
  const plan = preview?.auto ?? null;
  const option = preview?.options.find((o) => o.action === choice) ?? null;
  const confirm = (plan?.action ?? item.auto.action) === 'confirm_request';
  const clock = (iso: string) => clockLabel(Date.parse(iso), env.timeZone);

  const title =
    mode === 'auto'
      ? confirm
        ? `Ask ${name} to confirm`
        : `Follow up with ${name}`
      : mode === 'ask'
        ? choice === 'hand_to_ai'
          ? `Hand ${name} to ${ai}?`
          : choice === 'reply'
            ? `Reply to ${name}`
            : choice === 'set_next_action'
              ? `Set a next action for ${name}`
              : name
        : `${KIND_LABEL[item.kind]}: ${name}`;
  const sub = [
    splitTitle(item.title).rest,
    ...chipsOf(item, env.now, env.timeZone)
      .slice(0, 2)
      .map((c) =>
        c.tone === 'money' || c.tone === 'est'
          ? c.text
          : c.text.charAt(0).toLowerCase() + c.text.slice(1),
      ),
  ]
    .filter(Boolean)
    .join(' · ');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const sendAuto = () =>
    run(async () => {
      const out = await cmd.letHandle({ itemId: item.id });
      const at = out.scheduledFor ?? plan?.sendAt ?? null;
      setScheduledFor(at);
      const what = confirm
        ? `${plan?.channel === 'email' ? 'email' : 'text'} ${first} to confirm`
        : `follow up with ${first}`;
      toast.success(
        at
          ? `HandsFreeOS will ${what} at ${clock(at)}. You can cancel until then.`
          : `HandsFreeOS will ${what}.`,
      );
      onDone('auto');
    });
  const cancelAuto = () =>
    run(async () => {
      await cmd.cancelAuto(item.id);
      setScheduledFor(null);
      toast(`Cancelled. ${first} won’t get ${confirm ? 'a confirmation request' : 'a follow-up'}.`);
      onDone('auto');
    });
  const runAsk = () =>
    run(async () => {
      if (!option?.available) return;
      setFormError(null);
      if (option.action === 'reply') {
        if (!body.trim()) return setFormError('Write a message.');
        await cmd.letHandle({
          itemId: item.id,
          action: 'reply',
          body: body.trim(),
          ...(option.channel ? { channel: option.channel } : {}),
          ...(option.channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}),
        });
        toast.success(`Sent to ${first}.`);
      } else if (option.action === 'set_next_action') {
        if (!nextText.trim()) return setFormError('Say what to do next.');
        await cmd.letHandle({
          itemId: item.id,
          action: 'set_next_action',
          text: nextText.trim(),
          dueAt: nextAt ? new Date(nextAt).toISOString() : null,
        });
        toast.success('Next action set.');
      } else {
        await cmd.letHandle({ itemId: item.id, action: 'hand_to_ai' });
        toast.success(`Handed to ${ai}. ${ai} answers ${first} now.`);
      }
      onOpenChange(false);
      onDone('ask');
    });
  const doItMyself = () => {
    onOpenChange(false);
    env.act.handle(item);
  };

  let content: ReactNode;
  let footer: ReactNode = null;
  if (error) {
    content = (
      <p role="alert" className="text-[13px] text-danger-text">
        {error}
      </p>
    );
  } else if (!preview) {
    content = <p className="text-[13px] text-text-3">Working out what HandsFreeOS would do…</p>;
  } else if (mode === 'auto' && plan) {
    content = (
      <>
        {plan.blocked ? <WarnRow>{plan.blocked.message}</WarnRow> : null}
        {plan.notes.map((n) => (
          <InfoRow key={n}>{n}</InfoRow>
        ))}
        {plan.text ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className={cn(SECL, 'flex-1')}>What it sends</span>
              {plan.to ? (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-3">
                  {plan.channel === 'email' ? (
                    <Mail className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                  ) : (
                    <MessageCircle className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                  )}
                  <span className="truncate">
                    {plan.channel === 'email' ? `Email to ${plan.to}` : `Text to ${plan.to}`}
                  </span>
                </span>
              ) : null}
            </div>
            {plan.channel === 'email' ? (
              <MailPreview plan={plan} />
            ) : (
              <TextPreview text={plan.text} />
            )}
            <span className="text-xs text-text-3">
              {confirm
                ? plan.channel === 'email'
                  ? 'Confirm is a button on their booking page, so email scanners can’t confirm by accident.'
                  : 'A reply of C, or the Confirm button on their booking page, confirms it.'
                : 'Your wording from Settings, Action Center. It never adds prices or links.'}
            </span>
          </section>
        ) : null}
        {plan.checks.length ? (
          <div className="flex flex-col gap-1.5">
            <span className={SECL}>Checked just now</span>
            <ul className="flex flex-col gap-1.5" data-testid="let-handle-checks">
              {plan.checks.map((c) => (
                <li key={c.code} className="flex items-start gap-2 text-[13px] text-text-2">
                  {c.ok ? (
                    <Check className="mt-px h-4 w-4 flex-none text-success-text" strokeWidth={2} />
                  ) : (
                    <CircleAlert
                      className="mt-px h-4 w-4 flex-none text-warning-text"
                      strokeWidth={1.75}
                    />
                  )}
                  {c.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {scheduledFor ? <Goes at={clock(scheduledFor)} onCancel={cancelAuto} busy={busy} /> : null}
        {plan.blocked ? null : (
          <span className="text-xs text-text-3">
            It stops on its own if {first} writes first
            {plan.channel === 'sms' ? ', or replies STOP' : ''}.
          </span>
        )}
      </>
    );
    const myself = confirm
      ? env.callsAvailable && item.personId
        ? `Call ${first} instead`
        : null
      : `${handleLook(item, env.callsAvailable).label} myself`;
    footer = (
      <>
        {!plan.blocked && !scheduledFor ? (
          <Button size="sm" loading={busy} onClick={sendAuto} data-testid="let-handle-confirm">
            {busy ? null : <Zap className="h-4 w-4" strokeWidth={1.75} />}
            {confirm ? 'Ask to confirm' : 'Follow up'}
            {plan.sendAt ? ` at ${clock(plan.sendAt)}` : ''}
          </Button>
        ) : null}
        {myself ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={confirm ? () => (onOpenChange(false), env.act.call(item)) : doItMyself}
          >
            {myself}
          </Button>
        ) : null}
      </>
    );
  } else if (mode === 'ask') {
    const options = preview.options;
    const channelVerb =
      option?.channel === 'email'
        ? `Emails ${first} now`
        : option?.channel === 'chat'
          ? `Answers ${first} in the chat now`
          : option?.channel === 'sms'
            ? `Texts ${first} now`
            : `Writes to ${first} now`;
    content = (
      <>
        {options.length > 1 && choice ? (
          <Segmented
            fill
            value={choice}
            onChange={(v) => {
              setChoice(v);
              setFormError(null);
            }}
            ariaLabel="What HandsFreeOS does"
            options={options.map((o) => ({
              value: o.action,
              label: o.label,
              disabled: !o.available,
              title: o.reason ?? undefined,
              testId: `let-handle-option-${o.action}`,
            }))}
          />
        ) : null}
        {option?.action === 'hand_to_ai' ? (
          <>
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'inline-flex h-8 w-8 flex-none items-center justify-center rounded-full',
                  AI_SOFT,
                  AI_TEXT,
                )}
              >
                <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.75} />
              </span>
              <span className="flex flex-col">
                <span className="text-[13px] font-medium">{ai} (AI) will</span>
                <span className="text-xs text-text-3">As it’s set up in AI teammate</span>
              </span>
            </div>
            <ul className="flex flex-col gap-2 pl-1">
              {[
                `${channelVerb} and answers their questions from your Knowledge`,
                'Offers times on your calendar if they want a visit',
                'Hands them to a person if they ask for one, or if it can’t help',
              ].map((b) => (
                <li key={b} className="flex items-start gap-2 text-[13px]">
                  <ChevronRight
                    className="mt-0.5 h-4 w-4 flex-none text-text-3"
                    strokeWidth={1.75}
                  />
                  {b}
                </li>
              ))}
            </ul>
            <InfoRow>
              {first} stays{' '}
              {item.assignee ? `with ${firstNameOf(item.assignee.fullName)}` : 'unassigned'}. If
              they need a person, {ai} hands them over, like any hand-off.
            </InfoRow>
          </>
        ) : option?.action === 'reply' ? (
          <div className="flex flex-col gap-2.5">
            <span className="text-xs text-text-3">
              {option.channel === 'email'
                ? 'By email'
                : option.channel === 'chat'
                  ? 'In the website chat'
                  : 'By text'}
            </span>
            {option.channel === 'email' ? (
              <Field label="Subject" htmlFor="lh-subject">
                <Input
                  id="lh-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Message" htmlFor="lh-body" error={formError}>
              <Textarea
                id="lh-body"
                value={body}
                rows={4}
                autoFocus
                invalid={!!formError}
                placeholder={`Hi ${first}, …`}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
          </div>
        ) : option?.action === 'set_next_action' ? (
          <div className="flex flex-col gap-2.5">
            <Field label="Next action" htmlFor="lh-next" error={formError}>
              <Input
                id="lh-next"
                value={nextText}
                invalid={!!formError}
                onChange={(e) => setNextText(e.target.value)}
              />
            </Field>
            <Field label="When" htmlFor="lh-when" hint="Optional.">
              <Input
                id="lh-when"
                type="datetime-local"
                value={nextAt}
                onChange={(e) => setNextAt(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        {options
          .filter((o) => !o.available && o.reason)
          .map((o) => (
            <InfoRow key={o.action}>
              <strong className="font-semibold">{o.label}:</strong> {o.reason}
            </InfoRow>
          ))}
      </>
    );
    const PrimaryIcon =
      option?.action === 'reply'
        ? Send
        : option?.action === 'set_next_action'
          ? CalendarPlus
          : Sparkles;
    footer = (
      <>
        <Button
          size="sm"
          loading={busy}
          disabled={!option?.available}
          onClick={runAsk}
          data-testid="let-handle-confirm"
        >
          {busy ? null : <PrimaryIcon className="h-4 w-4" strokeWidth={1.75} />}
          {option?.action === 'reply'
            ? 'Send'
            : option?.action === 'set_next_action'
              ? 'Add next action'
              : `Hand to ${ai}`}
        </Button>
        {option?.action === 'hand_to_ai' && item.actions.handle ? (
          <Button variant="secondary" size="sm" onClick={doItMyself}>
            {item.kind === 'hot_lead' && env.callsAvailable
              ? `Call ${first} myself`
              : 'I’ll reply myself'}
          </Button>
        ) : null}
      </>
    );
  } else {
    content = (
      <InfoRow>
        {preview.reason ??
          (item.kind === 'ai_approval'
            ? 'Approvals always need a person.'
            : 'HandsFreeOS can’t do a task for you. Snooze moves it to later.')}
      </InfoRow>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={title} hideHeader className="p-0 pt-3 sm:p-0">
        <div
          data-testid="let-handle-sheet"
          data-mode={mode}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pt-[18px] max-sm:pt-1">
            <KindTile kind={item.kind} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className={SECL}>Let HandsFreeOS Handle</span>
              <h2
                className="text-[17px] font-semibold leading-[1.3]"
                data-testid="let-handle-title"
              >
                {title}
              </h2>
              {sub ? <span className="text-xs text-text-3">{sub}</span> : null}
              <span className="mt-1">
                <ModeChip mode={mode} />
              </span>
            </div>
            <SheetClose
              aria-label="Close"
              className="-mr-2 -mt-1 rounded-control p-1.5 text-text-2 hover:bg-card-2 hover:text-text"
            >
              <X className="h-[18px] w-[18px]" />
            </SheetClose>
          </div>
          <div className="flex flex-1 flex-col gap-3.5 px-5 py-4">{content}</div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card px-5 py-3.5">
            {footer}
            <span className="flex-1" />
            <SheetClose asChild>
              <Button variant="ghost" size="sm">
                {mode === 'ask' ? 'Cancel' : 'Close'}
              </Button>
            </SheetClose>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
