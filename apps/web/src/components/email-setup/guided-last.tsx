'use client';
/**
 * The guided email setup's last step and its Done screen (the owner, 22 Nov 2026). After Set it up, a website name
 * still needs its records where it is looked after: the ones that let HandsFreeOS send as it, our mail record when
 * its mail is to arrive here, and the old mail records to delete, each said to be found or still there. "Where things
 * stand" sits beside them. It looks again on its own, and Check now asks at once.
 *
 * What is left, which records and every word are core's (emailGuidedLastStep, emailGuidedDone), shared with the phone.
 */
import {
  EMAIL_GUIDED_WORDS as W,
  EMAIL_SETUP_WORDS,
  emailGuidedDone,
  emailGuidedLastStep,
  type EmailSetupDomain,
  type EmailSetupRecord,
  type EmailSetupState,
} from '@hfos/core';
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock,
  ExternalLink,
  Info,
  RefreshCw,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { GuidedCard, GuidedNote } from '@/components/guided-setup/frame';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyField } from '@/components/ui/copy-field';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** How often the step looks again on its own while something is still missing, and how many times. */
const LOOK_AGAIN_MS = 60_000;
const LOOKS = 10;

export function EmailGuidedLast({
  workspaceId,
  state,
  d,
  refresh,
  onLater,
  leaving,
}: {
  workspaceId: string;
  state: EmailSetupState;
  /** The website name being set up, as it stands now. */
  d: EmailSetupDomain;
  /** Asks for the state again; kept the same between draws. */
  refresh: () => Promise<unknown>;
  onLater: () => void;
  leaving: boolean;
}) {
  const step = emailGuidedLastStep(d, state);
  const [checking, setChecking] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const looks = useRef(0);
  const free = state.sender?.address ?? state.free?.address ?? '';

  async function check(quiet = false) {
    setChecking(!quiet);
    try {
      // Its sending records are checked by one command, its mail record by asking for the mail again.
      unwrap(
        await apiBrowser().POST(
          step.left === 'records'
            ? '/v1/commands/email_domain.verify'
            : '/v1/commands/email_domain.receive',
          { body: { workspaceId, emailDomainId: d.id } },
        ),
      );
      // The worker answers in a moment; the live update brings it, and this asks again in case it doesn't.
      setTimeout(() => void refresh(), 4_000);
    } catch (e) {
      if (!quiet) toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    if (step.left === 'done') return;
    const timer = setInterval(() => {
      if (looks.current >= LOOKS) return;
      looks.current += 1;
      void checkRef.current(true);
    }, LOOK_AGAIN_MS);
    return () => clearInterval(timer);
  }, [step.left, d.id]);
  // Its records are still being made (a few seconds): ask again until they're there.
  const making = step.left === 'records' && !step.sending.length;
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [making, refresh]);

  async function send() {
    const email = to.trim();
    setSending(true);
    setSendError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/email_domain.send_steps', {
          body: { workspaceId, emailDomainId: d.id, to: email },
        }),
      );
      toast.success(W.sentTo(email));
      setTo('');
      setSendOpen(false);
    } catch (e) {
      setSendError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  const host = step.host;
  const sendingFound = step.sending.length > 0 && step.sending.every((r) => r.found);
  // The things to do, in order: opening the records, then whichever of the three this name still needs.
  const order = [
    'open',
    ...(step.left === 'records' ? ['sending'] : []),
    ...(step.ours ? ['ours'] : []),
    ...(step.old.length ? ['old'] : []),
  ];
  const n = (key: string) => order.indexOf(key) + 1;
  return (
    <GuidedCard
      screen={`last_${step.left}`}
      testId="email-guided"
      kicker={W.lastStepAt(host?.label ?? null)}
      title={step.left === 'records' ? W.recordsTitle(host?.label ?? null) : W.mailTitle}
      hint={
        step.left === 'records' ? W.recordsHint(d.domain, free) : W.mailHint(d.domain, step.where)
      }
      aside={
        <>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {W.stand}
          </div>
          <ul className="flex flex-col gap-1">
            {step.stand.map((l) => (
              <li
                key={l.key}
                className={cn(
                  'flex items-start gap-2.5 rounded-menu px-2.5 py-2',
                  !l.done && 'bg-card shadow-1',
                )}
                data-testid={`email-guided-stand-${l.key}`}
                data-done={l.done}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full',
                    l.done ? 'bg-success-soft text-success-text' : 'text-warning-text',
                  )}
                >
                  {l.done ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : (
                    <CircleAlert className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium">{l.label}</span>
                  <span className="break-words text-[13px] text-text-2">{l.value}</span>
                </span>
              </li>
            ))}
          </ul>
          {step.wantsMail ? (
            <div className="mt-2 flex flex-col gap-1 rounded-menu border border-border bg-card p-3.5">
              <div className="text-[13px] font-semibold">{W.nothingLost}</div>
              <p className="text-[13px] leading-snug text-text-2">
                {W.nothingLostBody(step.where)}
              </p>
            </div>
          ) : null}
        </>
      }
      footer={
        <div className="mt-auto flex flex-wrap-reverse items-center justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="ghost"
            onClick={onLater}
            loading={leaving}
            data-testid="email-guided-later"
          >
            {W.later}
          </Button>
          <Button
            size="lg"
            onClick={() => void check()}
            loading={checking}
            data-testid="email-guided-check"
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
            {W.checkNow}
          </Button>
        </div>
      }
    >
      <ol className="flex flex-col gap-6">
        <Step n={n('open')} done={false} title={W.openRecords(host?.label ?? null)}>
          <p className="text-[14px] leading-normal text-text-2">
            {host
              ? W.openRecordsHow(d.domain, host.label, host.where)
              : W.openRecordsAnywhere(d.domain)}
          </p>
          {host?.note ? <GuidedNote>{host.note}</GuidedNote> : null}
          {host ? (
            <div>
              <ButtonLink
                href={host.url}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                data-testid="email-guided-open-host"
              >
                {W.openHost(host.label)}
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              </ButtonLink>
            </div>
          ) : null}
        </Step>

        {step.left === 'records' ? (
          <Step
            n={n('sending')}
            done={sendingFound}
            title={W.addSending(Math.max(1, step.sending.length))}
            testId="sending"
          >
            <p className="text-[14px] leading-normal text-text-2">
              {W.addSendingHow(host?.add ?? null)}
            </p>
            {step.sending.length ? (
              <div className="flex flex-col gap-2.5">
                {step.sending.map((r) => (
                  <SendingRecord key={`${r.type}-${r.host}`} r={r} />
                ))}
              </div>
            ) : (
              <Callout tone="neutral" icon={Clock} data-testid="email-guided-records-making">
                {EMAIL_SETUP_WORDS.recordsMaking}
              </Callout>
            )}
          </Step>
        ) : null}

        {step.ours ? (
          <Step n={n('ours')} done={step.ours.found} title={W.addMail} testId="ours">
            <p className="text-[14px] leading-normal text-text-2">
              {W.addMailHow(host?.add ?? null)}
            </p>
            <RecordTable>
              <MailRow
                host={step.ours.host}
                priority={step.ours.priority}
                copy
                badge={
                  <Badge variant={step.ours.found ? 'ok' : 'pending'}>
                    {step.ours.found ? W.found : W.waiting}
                  </Badge>
                }
              />
            </RecordTable>
          </Step>
        ) : null}

        {step.old.length ? (
          <Step n={n('old')} done={false} title={W.deleteOld(step.old.length)} testId="old">
            <p className="text-[14px] leading-normal text-text-2">
              {W.deleteOldHow(step.old.length, step.where)}
            </p>
            <RecordTable>
              {step.old.map((r) => (
                <MailRow
                  key={`${r.host}-${r.priority}`}
                  host={r.host}
                  priority={r.priority}
                  badge={<Badge variant="pending">{W.stillThere}</Badge>}
                />
              ))}
            </RecordTable>
          </Step>
        ) : null}
      </ol>

      {step.notDone ? (
        <Callout tone="warning" icon={Clock} data-testid="email-guided-not-done">
          <span>
            <b className="font-semibold">{W.notDone}</b> {step.notDone}
          </span>
        </Callout>
      ) : null}

      {sendOpen ? (
        <div className="flex flex-col gap-2 rounded-menu bg-card-2 p-4">
          <span className="text-[14px] font-semibold">{W.sendSteps}</span>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label={W.sendStepsTo}
              placeholder={W.sendStepsTo}
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="min-w-[12rem] flex-1 bg-card"
              data-testid="email-guided-send-to"
            />
            <Button
              variant="secondary"
              loading={sending}
              disabled={!to.trim()}
              onClick={() => void send()}
              data-testid="email-guided-send"
            >
              <Send className="h-4 w-4" strokeWidth={1.75} />
              {W.sendStepsSend}
            </Button>
          </div>
          {sendError ? <FieldError>{sendError}</FieldError> : null}
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setSendOpen(true)}
            className="inline-flex items-center gap-2 text-left text-[14px] font-medium text-accent-text hover:underline"
            data-testid="email-guided-send-open"
          >
            <Send className="h-4 w-4 flex-none" strokeWidth={1.75} />
            {W.sendSteps}
          </button>
        </div>
      )}
    </GuidedCard>
  );
}

/** One thing to do where the website name is looked after: its number, or a tick once it's found. */
function Step({
  n,
  done,
  title,
  testId,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <li
      className="flex items-start gap-3.5"
      data-testid={testId ? `email-guided-step-${testId}` : undefined}
      data-done={done}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-[13px] font-semibold',
          done ? 'bg-success text-white' : 'border-[1.5px] border-accent text-accent-text',
        )}
      >
        {done ? <Check className="h-4 w-4" strokeWidth={3} /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h2 className="pt-0.5 text-[16px] font-semibold leading-snug">{title}</h2>
        {children}
      </div>
    </li>
  );
}

/** A record that lets HandsFreeOS send as the website name: its name and value to copy, and whether it's found. */
function SendingRecord({ r }: { r: EmailSetupRecord }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-menu border border-border bg-card px-3.5 py-3"
      data-testid={`email-guided-record-${r.type.toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[13px] font-medium">{r.type}</span>
        <Badge variant={r.found ? 'ok' : 'pending'}>{r.found ? W.found : W.waiting}</Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <div className="min-w-0">
          <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {W.host}
          </div>
          <CopyField value={r.host} label="Copy the name" copied="Copied the name" />
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {W.value}
          </div>
          <CopyField value={r.value} label="Copy the value" copied="Copied the value" />
        </div>
      </div>
    </div>
  );
}

/** Where each mail record's parts sit on a wide screen: Type, Points to, Priority, and where it stands. */
const MAIL_COLUMNS = 'sm:grid-cols-[3.5rem_minmax(0,1fr)_4.5rem_6.5rem]';

/**
 * Mail records, one a row. On a wide screen it reads as a table, under its headings; on a phone each record stacks
 * (its type, priority and where it stands, then where it points), so nothing runs off the side.
 */
function RecordTable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-menu border border-border text-[13.5px]">
      <div
        aria-hidden
        className={cn(
          'hidden gap-x-3 bg-card-2 px-3.5 py-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3 sm:grid',
          MAIL_COLUMNS,
        )}
      >
        <span>{W.type}</span>
        <span>{W.pointsTo}</span>
        <span>{W.priority}</span>
      </div>
      <ul className="divide-y divide-border sm:border-t sm:border-border">{children}</ul>
    </div>
  );
}

function MailRow({
  host,
  priority,
  copy = false,
  badge,
}: {
  host: string;
  priority: number;
  /** Ours is copied out; an old one is only found and deleted. */
  copy?: boolean;
  badge: ReactNode;
}) {
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3.5 py-2.5',
        MAIL_COLUMNS,
      )}
      data-testid="email-guided-mx"
      data-host={host}
    >
      <div className="font-mono">
        <span className="sr-only">{W.type}: </span>MX
        <span className="font-sans text-text-3 sm:hidden">
          {' · '}
          {W.priority} <span className="font-mono text-text">{priority}</span>
        </span>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <span className="sr-only">{W.pointsTo}: </span>
        {copy ? (
          <CopyField value={host} label="Copy where it points" copied="Copied where it points" />
        ) : (
          <span className="break-all font-mono">{host}</span>
        )}
      </div>
      <div className="hidden font-mono sm:block">
        <span className="sr-only">{W.priority}: </span>
        {priority}
      </div>
      <div className="col-start-2 row-start-1 text-right sm:col-start-4">{badge}</div>
    </li>
  );
}

/** "Your email is ready": each address with who reads it, and where to go next. */
export function EmailGuidedDone({
  workspaceId,
  state,
  d,
}: {
  workspaceId: string;
  state: EmailSetupState;
  /** The website name that was set up; null with a free address. */
  d: EmailSetupDomain | null;
}) {
  const done = emailGuidedDone(state, d);
  const home = `/app/w/${workspaceId}`;
  return (
    <Card
      className="mx-auto flex w-full max-w-[720px] flex-col gap-6 rounded-dialog p-6 sm:p-9"
      data-testid="email-guided-done"
    >
      <div className="flex flex-col gap-3">
        <span
          aria-hidden
          className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success-text"
        >
          <Check className="h-6 w-6" strokeWidth={2.5} />
        </span>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">
          {W.doneTitle}
        </h1>
        <p className="text-[15px] leading-normal text-text-2" data-testid="email-guided-done-line">
          {done.line}
        </p>
      </div>
      {done.rows.length ? (
        <ul className="overflow-hidden rounded-menu border border-border">
          {done.rows.map((r) => (
            <li
              key={r.address}
              className="flex items-start gap-3 border-b border-border px-4 py-3.5 last:border-b-0"
              data-testid="email-guided-done-row"
            >
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success text-white"
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-[14px]">{r.address}</span>
                  {r.isDefault ? <Badge variant="accent">{W.hearFrom}</Badge> : null}
                </span>
                <span className="text-[13.5px] leading-snug text-text-2">{r.line}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="flex items-start gap-2 text-[13.5px] leading-snug text-text-2">
        <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
        <span>
          {W.changeLaterLead}{' '}
          <Link
            href={`${home}/settings/email`}
            className="font-medium text-accent-text hover:underline"
          >
            {W.settingsEmail}
          </Link>
          .
        </span>
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <ButtonLink
          href={`${home}/settings/email`}
          variant="ghost"
          size="lg"
          data-testid="email-guided-to-settings"
        >
          {W.emailSettings}
        </ButtonLink>
        <ButtonLink
          href={`${home}/inbox`}
          variant="primary"
          size="lg"
          data-testid="email-guided-to-inbox"
        >
          {W.goToInbox}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </ButtonLink>
      </div>
    </Card>
  );
}
