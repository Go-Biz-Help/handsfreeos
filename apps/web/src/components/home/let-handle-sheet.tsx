'use client';
import {
  ATTENTION_WORDS,
  clockLabel,
  handToAiBullets,
  handToAiStays,
  letHandleAskButton,
  letHandleAutoButton,
  letHandleAutoToast,
  letHandleFootnote,
  letHandleNoneFallback,
  letHandleReplyBy,
  letHandleStops,
  letHandleSubOf,
  letHandleTitleOf,
  letHandleTo,
} from '@hfos/core';
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
import { customerOf, firstNameOf } from './attention-words';
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
        <b className="font-semibold">{ATTENTION_WORDS.goesOutAt(at)}</b> ·{' '}
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="font-semibold underline disabled:opacity-50"
          data-testid="let-handle-cancel"
        >
          {ATTENTION_WORDS.cancel}
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
        const first = p.options.find((o) => o.available) ?? p.options[0];
        setChoice(first?.action ?? null);
        const suggestion = p.options.find((o) => o.action === 'set_next_action')?.suggestion;
        setNextText(suggestion?.text ?? '');
        setNextAt(suggestion?.dueAt ? toLocalInputValue(new Date(suggestion.dueAt)) : '');
        // A money card's follow-up comes already written, from the document's own figures.
        setBody(first?.draft?.body ?? '');
        setSubject(first?.draft?.subject ?? '');
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
  const mode = preview?.mode ?? item.letHandleMode;
  const plan = preview?.auto ?? null;
  const option = preview?.options.find((o) => o.action === choice) ?? null;
  const confirm = (plan?.action ?? item.auto.action) === 'confirm_request';
  const clock = (iso: string) => clockLabel(Date.parse(iso), env.timeZone);

  const title = letHandleTitleOf({
    item,
    mode,
    choice,
    confirm,
    teammateName: env.teammateName,
  });
  const sub = letHandleSubOf(item, env.now, env.timeZone);

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
      toast.success(
        letHandleAutoToast({ confirm, channel: plan?.channel, first, at: at ? clock(at) : null }),
      );
      onDone('auto');
    });
  const cancelAuto = () =>
    run(async () => {
      await cmd.cancelAuto(item.id);
      setScheduledFor(null);
      toast(ATTENTION_WORDS.cancelledAutoToast(confirm, first));
      onDone('auto');
    });
  const runAsk = () =>
    run(async () => {
      if (!option?.available) return;
      setFormError(null);
      if (option.action === 'reply') {
        if (!body.trim()) return setFormError(ATTENTION_WORDS.writeMessage);
        await cmd.letHandle({
          itemId: item.id,
          action: 'reply',
          body: body.trim(),
          ...(option.channel ? { channel: option.channel } : {}),
          ...(option.channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}),
        });
        toast.success(ATTENTION_WORDS.sentToast(first));
      } else if (option.action === 'set_next_action') {
        if (!nextText.trim()) return setFormError(ATTENTION_WORDS.sayNext);
        await cmd.letHandle({
          itemId: item.id,
          action: 'set_next_action',
          text: nextText.trim(),
          dueAt: nextAt ? new Date(nextAt).toISOString() : null,
        });
        toast.success(ATTENTION_WORDS.nextActionSetToast);
      } else {
        await cmd.letHandle({ itemId: item.id, action: 'hand_to_ai' });
        toast.success(ATTENTION_WORDS.handedToast(env.teammateName, first));
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
    content = <p className="text-[13px] text-text-3">{ATTENTION_WORDS.workingOut}</p>;
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
              <span className={cn(SECL, 'flex-1')}>{ATTENTION_WORDS.whatItSends}</span>
              {plan.to ? (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-3">
                  {plan.channel === 'email' ? (
                    <Mail className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                  ) : (
                    <MessageCircle className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                  )}
                  <span className="truncate">{letHandleTo(plan.channel, plan.to)}</span>
                </span>
              ) : null}
            </div>
            {plan.channel === 'email' ? (
              <MailPreview plan={plan} />
            ) : (
              <TextPreview text={plan.text} />
            )}
            <span className="text-xs text-text-3">{letHandleFootnote(confirm, plan.channel)}</span>
          </section>
        ) : null}
        {plan.checks.length ? (
          <div className="flex flex-col gap-1.5">
            <span className={SECL}>{ATTENTION_WORDS.checkedJustNow}</span>
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
          <span className="text-xs text-text-3">{letHandleStops(first, plan.channel)}</span>
        )}
      </>
    );
    const myself = confirm
      ? env.callsAvailable && item.personId
        ? ATTENTION_WORDS.callInstead(first)
        : null
      : ATTENTION_WORDS.myself(handleLook(item, env.callsAvailable).label);
    footer = (
      <>
        {!plan.blocked && !scheduledFor ? (
          <Button size="sm" loading={busy} onClick={sendAuto} data-testid="let-handle-confirm">
            {busy ? null : <Zap className="h-4 w-4" strokeWidth={1.75} />}
            {letHandleAutoButton(confirm, plan.sendAt ? clock(plan.sendAt) : null)}
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
                <span className="text-[13px] font-medium">
                  {ATTENTION_WORDS.aiWill(env.teammateName)}
                </span>
                <span className="text-xs text-text-3">{ATTENTION_WORDS.asSetUp}</span>
              </span>
            </div>
            <ul className="flex flex-col gap-2 pl-1">
              {handToAiBullets(option.channel, first).map((b) => (
                <li key={b} className="flex items-start gap-2 text-[13px]">
                  <ChevronRight
                    className="mt-0.5 h-4 w-4 flex-none text-text-3"
                    strokeWidth={1.75}
                  />
                  {b}
                </li>
              ))}
            </ul>
            <InfoRow>{handToAiStays(first, item.assignee, env.teammateName)}</InfoRow>
          </>
        ) : option?.action === 'reply' ? (
          <div className="flex flex-col gap-2.5">
            <span className="text-xs text-text-3">{letHandleReplyBy(option.channel)}</span>
            {option.channel === 'email' ? (
              <Field label={ATTENTION_WORDS.subject} htmlFor="lh-subject">
                <Input
                  id="lh-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
            ) : null}
            <Field label={ATTENTION_WORDS.message} htmlFor="lh-body" error={formError}>
              <Textarea
                id="lh-body"
                value={body}
                rows={4}
                autoFocus
                invalid={!!formError}
                placeholder={ATTENTION_WORDS.replyPlaceholder(first)}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
          </div>
        ) : option?.action === 'set_next_action' ? (
          <div className="flex flex-col gap-2.5">
            <Field label={ATTENTION_WORDS.nextAction} htmlFor="lh-next" error={formError}>
              <Input
                id="lh-next"
                value={nextText}
                invalid={!!formError}
                onChange={(e) => setNextText(e.target.value)}
              />
            </Field>
            <Field label={ATTENTION_WORDS.when} htmlFor="lh-when" hint="Optional.">
              <Input
                id="lh-when"
                type="datetime-local"
                value={nextAt}
                onChange={(e) => setNextAt(e.target.value)}
              />
            </Field>
          </div>
        ) : null}
        {/* What the business's own reminders have already said to this customer about this document. */}
        {option?.note ? <InfoRow>{option.note}</InfoRow> : null}
        {options
          .filter((o) => !o.available && o.reason)
          .map((o) =>
            // A reminder went out today: that isn't a choice being unavailable, it's a reason to leave it.
            o.action === 'reply' && options.length === 1 ? (
              <WarnRow key={o.action}>{o.reason}</WarnRow>
            ) : (
              <InfoRow key={o.action}>
                <strong className="font-semibold">{o.label}:</strong> {o.reason}
              </InfoRow>
            ),
          )}
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
          {letHandleAskButton(option?.action ?? null, env.teammateName)}
        </Button>
        {option?.action === 'hand_to_ai' && item.actions.handle ? (
          <Button variant="secondary" size="sm" onClick={doItMyself}>
            {item.kind === 'hot_lead' && env.callsAvailable
              ? ATTENTION_WORDS.callMyself(first)
              : ATTENTION_WORDS.replyMyself}
          </Button>
        ) : null}
      </>
    );
  } else {
    content = <InfoRow>{preview.reason ?? letHandleNoneFallback(item.kind)}</InfoRow>;
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
              <span className={SECL}>{ATTENTION_WORDS.letHandle}</span>
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
                {mode === 'ask' ? ATTENTION_WORDS.cancel : ATTENTION_WORDS.close}
              </Button>
            </SheetClose>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
