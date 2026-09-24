'use client';
import {
  CAMPAIGN_DRAFT_MAX,
  CAMPAIGN_EMAIL_BODY_MAX,
  CAMPAIGN_EMAIL_SUBJECT_MAX,
  CAMPAIGN_PER_HOUR_MAX,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CampaignGet, CampaignRecipient } from '@/lib/api/types';
import {
  CAMPAIGN_STATUS_BADGE,
  PAUSED_REASON_WORDS,
  people,
  skipWords,
  statusWords,
} from './words';

const REFRESH_MS = 5000;

const timeOf = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * One campaign. While the AI writes, it shows how far it has got; then every text, each one editable, and
 * "Approve all and send"; once sending, how many went, when the next one goes, the pace, and pause or stop.
 * An email campaign shows its one email instead (subject and words, editable, with the footer every email
 * gets), and the people it goes to.
 */
export function CampaignView({
  workspaceId,
  data,
  canManage,
}: {
  workspaceId: string;
  data: CampaignGet;
  canManage: boolean;
}) {
  const router = useRouter();
  const { campaign: c, recipients } = data;
  const [busy, setBusy] = useState<string | null>(null);
  const live = c.status === 'drafting' || c.status === 'sending';
  const email = c.channel === 'email';
  const noun = email ? 'email' : 'text';

  // Keeps up with the worker while it writes or sends.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [live, router]);

  async function act(
    what: 'approve' | 'pause' | 'resume' | 'cancel',
    confirmText?: string,
  ): Promise<void> {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(what);
    try {
      unwrap(
        await apiBrowser().POST(`/v1/commands/campaign.${what}`, {
          body: { workspaceId, campaignId: c.id },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const going = recipients.filter((r) =>
    ['ready', 'approved', 'sent', 'failed'].includes(r.status),
  );
  const left = recipients.filter((r) => r.status === 'skipped' || r.status === 'removed');
  const stoppable = ['drafting', 'review', 'sending', 'paused'].includes(c.status);

  return (
    <div className="flex flex-col gap-5" data-testid="campaign-view" data-status={c.status}>
      <Card className="flex flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge
              variant={CAMPAIGN_STATUS_BADGE[c.status] ?? 'gray'}
              data-testid="campaign-status"
            >
              {statusWords(c.status, c.channel)}
            </Badge>
            <span className="text-[13px] text-text-2">
              {c.status === 'drafting'
                ? email
                  ? `To ${people(c.counts.total - c.counts.skipped)}`
                  : `${c.counts.total - c.counts.drafting - c.counts.skipped} of ${c.counts.total - c.counts.skipped} written`
                : c.status === 'review'
                  ? `${people(c.counts.ready)} to ${noun}`
                  : `${c.counts.sent} of ${c.counts.sent + c.counts.approved + c.counts.failed} sent`}
            </span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {c.status === 'review' ? (
                <Button
                  onClick={() =>
                    act(
                      'approve',
                      email
                        ? `Send this email to ${people(c.counts.ready)}, ${c.perHour} an hour while you’re open?`
                        : `Send ${people(c.counts.ready)} these texts, ${c.perHour} an hour while you’re open?`,
                    )
                  }
                  loading={busy === 'approve'}
                  disabled={c.counts.ready === 0}
                  data-testid="campaign-approve"
                >
                  Approve all and send
                </Button>
              ) : null}
              {c.status === 'sending' ? (
                <Button
                  variant="secondary"
                  onClick={() => act('pause')}
                  loading={busy === 'pause'}
                  data-testid="campaign-pause"
                >
                  Pause
                </Button>
              ) : null}
              {c.status === 'paused' ? (
                <Button
                  onClick={() => act('resume')}
                  loading={busy === 'resume'}
                  data-testid="campaign-resume"
                >
                  Resume
                </Button>
              ) : null}
              {stoppable ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    act(
                      'cancel',
                      `Stop this campaign? ${email ? 'Emails' : 'Texts'} not sent yet won’t go.`,
                    )
                  }
                  loading={busy === 'cancel'}
                  data-testid="campaign-cancel"
                >
                  Stop
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {c.status === 'paused' && c.pausedReason ? (
          <p
            className="rounded-control bg-warning-soft px-3 py-2 text-[13px] text-warning-text"
            data-testid="campaign-paused-reason"
          >
            {PAUSED_REASON_WORDS[c.pausedReason] ??
              'Paused: something stopped it sending. Resume to try again.'}
          </p>
        ) : null}
        <p className="text-[13.5px]">{c.goal}</p>
        {c.offer ? (
          <p className="text-[12.5px] text-text-2" data-testid="campaign-offer-name">
            About the offer {c.offer.name}
          </p>
        ) : null}
        <PaceLine workspaceId={workspaceId} data={data} canManage={canManage} />
      </Card>

      {email && c.email ? (
        <EmailCard
          workspaceId={workspaceId}
          campaignId={c.id}
          email={c.email}
          editable={canManage && c.status === 'review'}
        />
      ) : email && c.status === 'drafting' ? (
        <p className="text-[13px] text-text-2">
          The AI is writing the email. This page updates on its own.
        </p>
      ) : null}

      {email && going.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Who gets it
          </h2>
          <Card className="divide-y divide-border">
            {going.map((r) => (
              <RecipientRow
                key={r.id}
                workspaceId={workspaceId}
                r={r}
                editable={canManage && c.status === 'review' && r.status === 'ready'}
                email
              />
            ))}
          </Card>
        </section>
      ) : null}

      {email ? null : going.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {c.status === 'review' ? 'Read each text' : 'Texts'}
          </h2>
          <Card className="divide-y divide-border">
            {going.map((r) => (
              <RecipientRow
                key={r.id}
                workspaceId={workspaceId}
                r={r}
                editable={canManage && c.status === 'review' && r.status === 'ready'}
              />
            ))}
          </Card>
        </section>
      ) : c.status === 'drafting' ? (
        <p className="text-[13px] text-text-2">
          The AI is writing each text. This page updates on its own.
        </p>
      ) : null}

      {left.length ? (
        <details className="flex flex-col gap-2" data-testid="campaign-left-out">
          <summary className="cursor-pointer text-[13px] text-text-2">
            {people(left.length)} left out
          </summary>
          <Card className="mt-2 divide-y divide-border">
            {left.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-[18px] py-2.5">
                <span className="text-[13px]">{r.name}</span>
                <span className="text-[12.5px] text-text-2">
                  {r.status === 'removed' ? 'Taken out' : skipWords(r.skipReason)}
                </span>
              </div>
            ))}
          </Card>
        </details>
      ) : null}
    </div>
  );
}

function PaceLine({
  workspaceId,
  data,
  canManage,
}: {
  workspaceId: string;
  data: CampaignGet;
  canManage: boolean;
}) {
  const router = useRouter();
  const c = data.campaign;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(c.perHour));
  const [busy, setBusy] = useState(false);
  const changeable = canManage && ['review', 'sending', 'paused'].includes(c.status);
  const noun = c.channel === 'email' ? 'emails' : 'texts';

  async function save() {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > CAMPAIGN_PER_HOUR_MAX) {
      toast.error(`Between 1 and ${CAMPAIGN_PER_HOUR_MAX} an hour.`);
      return;
    }
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.set_pace', {
          body: { workspaceId, campaignId: c.id, perHour: n },
        }),
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
      {editing ? (
        <>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={CAMPAIGN_PER_HOUR_MAX}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-20"
            aria-label={`${noun === 'emails' ? 'Emails' : 'Texts'} an hour`}
            data-testid="campaign-pace-input"
          />
          <span>{noun} an hour</span>
          <Button size="sm" onClick={save} loading={busy} data-testid="campaign-pace-save">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span data-testid="campaign-pace">
            {c.perHour} {noun} an hour, while you’re open and never in quiet hours.
          </span>
          {changeable ? (
            <button
              type="button"
              className="font-medium text-accent-text hover:underline"
              onClick={() => {
                setValue(String(c.perHour));
                setEditing(true);
              }}
              data-testid="campaign-pace-edit"
            >
              Change
            </button>
          ) : null}
        </>
      )}
      {c.status === 'sending' && data.nextSendAt ? (
        <span className="basis-full">
          Next {noun === 'emails' ? 'email' : 'text'}: {timeOf(data.nextSendAt)}
        </span>
      ) : null}
    </div>
  );
}

function RecipientRow({
  workspaceId,
  r,
  editable,
  email = false,
}: {
  workspaceId: string;
  r: CampaignRecipient;
  editable: boolean;
  /** An email campaign's row: who and where, no words of their own. */
  email?: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState(r.draft ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(r.draft ?? ''), [r.draft]);

  async function save() {
    const next = text.trim();
    if (!next || next === (r.draft ?? '')) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.update_draft', {
          body: { workspaceId, recipientId: r.id, draft: next },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.remove_recipient', {
          body: { workspaceId, recipientId: r.id },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-3" data-testid={`recipient-${r.id}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] font-medium">
          {r.name}
          {email ? (
            r.email ? (
              <span className="ml-2 font-normal text-text-3">{r.email}</span>
            ) : null
          ) : r.phone ? (
            <span className="ml-2 font-normal text-text-3">{r.phone}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-[12.5px] text-text-2">
          {r.edited ? <span>Edited</span> : null}
          {r.status === 'sent' && r.sentAt ? (
            <Badge variant="ok">Sent {timeOf(r.sentAt)}</Badge>
          ) : null}
          {r.status === 'failed' ? <Badge variant="danger">Didn’t send</Badge> : null}
          {r.status === 'approved' ? <span>Waiting its turn</span> : null}
          {editable ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              data-testid={`recipient-remove-${r.id}`}
            >
              Remove
            </Button>
          ) : null}
        </span>
      </div>
      {email ? null : editable ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          maxLength={CAMPAIGN_DRAFT_MAX}
          disabled={busy}
          className="min-h-[64px] text-[13.5px]"
          aria-label={`Text to ${r.name}`}
          data-testid={`recipient-draft-${r.id}`}
        />
      ) : (
        <p className="whitespace-pre-wrap text-[13px] text-text-2">{r.draft}</p>
      )}
    </div>
  );
}

/** An email campaign's one email: subject and words (saved when a box is left), and the footer it always gets. */
function EmailCard({
  workspaceId,
  campaignId,
  email,
  editable,
}: {
  workspaceId: string;
  campaignId: string;
  email: NonNullable<CampaignGet['campaign']['email']>;
  editable: boolean;
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(email.subject ?? '');
  const [body, setBody] = useState(email.body ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setSubject(email.subject ?? ''), [email.subject]);
  useEffect(() => setBody(email.body ?? ''), [email.body]);

  async function save() {
    const s = subject.trim();
    const b = body.trim();
    if (!s || !b || (s === (email.subject ?? '') && b === (email.body ?? ''))) return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/campaign.update_email', {
          body: { workspaceId, campaignId, subject: s, body: b },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="campaign-email">
      <div className="flex items-center justify-between">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {editable ? 'Read the email' : 'The email'}
        </h2>
        {email.edited ? <span className="text-[12.5px] text-text-2">Edited</span> : null}
      </div>
      <Card className="flex flex-col gap-3 p-[18px]">
        {editable ? (
          <>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onBlur={save}
              maxLength={CAMPAIGN_EMAIL_SUBJECT_MAX}
              disabled={busy}
              aria-label="Subject"
              data-testid="campaign-email-subject"
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={save}
              maxLength={CAMPAIGN_EMAIL_BODY_MAX}
              disabled={busy}
              className="min-h-[200px] text-[13.5px]"
              aria-label="Email"
              data-testid="campaign-email-body"
            />
            <span className="text-[12px] text-text-3">
              {'{first_name}'} becomes each person’s first name (“there” when you don’t have it).
            </span>
          </>
        ) : (
          <>
            <p className="text-[13.5px] font-medium">{email.subject}</p>
            <p className="whitespace-pre-wrap text-[13px] text-text-2">{email.body}</p>
          </>
        )}
        <div
          className="whitespace-pre-wrap border-t border-border pt-3 text-[12px] text-text-3"
          data-testid="campaign-email-footer"
        >
          {`Every email ends with: why they get it, an unsubscribe link, and your address.\n${
            email.postalAddress ?? 'No address yet: add it in Settings → Payments.'
          }`}
        </div>
      </Card>
    </section>
  );
}
