'use client';
import { CAMPAIGN_DRAFT_MAX, CAMPAIGN_PER_HOUR_MAX } from '@hfos/core';
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
import { CAMPAIGN_STATUS_BADGE, CAMPAIGN_STATUS_WORDS, people, skipWords } from './words';

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
              {CAMPAIGN_STATUS_WORDS[c.status] ?? c.status}
            </Badge>
            <span className="text-[13px] text-text-2">
              {c.status === 'drafting'
                ? `${c.counts.total - c.counts.drafting - c.counts.skipped} of ${c.counts.total - c.counts.skipped} written`
                : c.status === 'review'
                  ? `${people(c.counts.ready)} to text`
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
                      `Send ${people(c.counts.ready)} these texts, ${c.perHour} an hour while you’re open?`,
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
                  onClick={() => act('cancel', 'Stop this campaign? Texts not sent yet won’t go.')}
                  loading={busy === 'cancel'}
                  data-testid="campaign-cancel"
                >
                  Stop
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="text-[13.5px]">{c.goal}</p>
        {c.offer ? (
          <p className="text-[12.5px] text-text-2" data-testid="campaign-offer-name">
            About the offer {c.offer.name}
          </p>
        ) : null}
        <PaceLine workspaceId={workspaceId} data={data} canManage={canManage} />
      </Card>

      {going.length ? (
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
            aria-label="Texts an hour"
            data-testid="campaign-pace-input"
          />
          <span>texts an hour</span>
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
            {c.perHour} texts an hour, while you’re open and never in quiet hours.
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
        <span className="basis-full">Next text: {timeOf(data.nextSendAt)}</span>
      ) : null}
    </div>
  );
}

function RecipientRow({
  workspaceId,
  r,
  editable,
}: {
  workspaceId: string;
  r: CampaignRecipient;
  editable: boolean;
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
          {r.phone ? <span className="ml-2 font-normal text-text-3">{r.phone}</span> : null}
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
      {editable ? (
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
