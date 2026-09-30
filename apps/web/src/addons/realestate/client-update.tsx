'use client';
/**
 * A client update (board 7, design/realestate/ClientUpdate.dc.html): an email the Assistant drafted from the deal's
 * own facts, for the agent to check, edit and send. Every version of its words is read for fair-housing risk by the
 * fixed word list at once and by the AI a moment later; it goes only once any flag is fixed or kept with a reason,
 * and every check and choice is kept for the broker.
 */
import { FAIR_HOUSING_CATEGORIES } from '@hfos/core/addons/realestate/fair-housing';
import { MILESTONE_WORDS } from '@hfos/core/addons/realestate/prompts';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { dealHref } from './bits';
import { ReasonDialog } from './deal-dialogs';
import type { DraftGet } from './types';
import { useAct } from './use-act';

export function ClientUpdate({
  workspaceId,
  dealId,
  dealName,
  data,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  data: DraftGet;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const { draft, flags, checking, acknowledged, canSend, checks } = data;
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body ?? '');
  const [keeping, setKeeping] = useState(false);
  const { busy, errors, act } = useAct();
  const edited = subject !== (draft.subject ?? '') || body !== (draft.body ?? '');

  // A teammate's edit, or the worker finishing, redraws the page: take the new words unless these were changed.
  const [seen, setSeen] = useState({ subject: draft.subject, body: draft.body });
  if (seen.subject !== draft.subject || seen.body !== draft.body) {
    setSeen({ subject: draft.subject, body: draft.body });
    if (!edited) {
      setSubject(draft.subject ?? '');
      setBody(draft.body ?? '');
    }
  }

  // While it's being written or read, look again every few seconds besides the live channel.
  const waiting = draft.status === 'drafting' || checking;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [waiting, router]);

  const select = useCallback(
    (phrase: string) => {
      const at = body.toLowerCase().indexOf(phrase.toLowerCase());
      const el = document.getElementById('update-body') as HTMLTextAreaElement | null;
      if (!el || at < 0) return;
      el.focus();
      el.setSelectionRange(at, at + phrase.length);
    },
    [body],
  );

  const ids = { workspaceId, draftId: draft.draftId };
  const save = () =>
    act(
      'save',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.status_email.save', {
            body: { ...ids, subject: subject.trim(), body: body.trim() },
          }),
        ),
      'Saved. Its words are checked again.',
    );

  const to = draft.to
    ? `${draft.to.name}${draft.to.email ? ` <${draft.to.email}>` : ''}`
    : 'the client';
  const words = MILESTONE_WORDS[draft.milestone] ?? 'an update';
  return (
    <div data-testid="realestate-client-update">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={dealHref(workspaceId, dealId)} className="text-accent-text hover:underline">
          {dealName}
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-text-2">Client update</span>
      </div>
      <PageHeader
        title="Client update"
        description={`${dealName} · ${draft.milestone === 'asked' ? 'drafted when asked' : `drafted when ${words}`} · to ${to}`}
        actions={
          draft.status === 'ready' ? (
            <>
              <Button
                variant="ghost"
                loading={busy === 'discard'}
                onClick={() =>
                  confirm('Throw this update away? It isn’t sent.') &&
                  void act(
                    'discard',
                    async () => {
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.status_email.discard', {
                          body: ids,
                        }),
                      );
                      router.push(dealHref(workspaceId, dealId));
                    },
                    'Thrown away.',
                  )
                }
              >
                Discard
              </Button>
              {edited ? (
                <Button
                  loading={busy === 'save'}
                  onClick={() => void save()}
                  data-testid="update-save"
                >
                  Save changes
                </Button>
              ) : (
                <Button
                  loading={busy === 'send'}
                  disabled={!canSend}
                  title={
                    canSend
                      ? undefined
                      : checking
                        ? 'Still being checked'
                        : 'Fix or keep each flag first'
                  }
                  onClick={() =>
                    void act(
                      'send',
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.status_email.send', {
                            body: ids,
                          }),
                        ),
                      'Sent.',
                    )
                  }
                  data-testid="update-send"
                >
                  Send
                </Button>
              )}
            </>
          ) : null
        }
      />

      {draft.status === 'drafting' ? (
        <Card
          className="px-6 py-10 text-center text-[13.5px] text-text-2"
          data-testid="update-drafting"
        >
          The Assistant is writing it from this deal’s confirmed dates and duties. This takes a few
          seconds.
        </Card>
      ) : draft.status === 'failed' ? (
        <Callout tone="warning">
          {draft.failure ?? 'The Assistant couldn’t write this one.'} Ask for another from the
          deal’s page, or write to the client from Inbox.
        </Callout>
      ) : draft.status === 'discarded' ? (
        <Callout tone="neutral">This update was thrown away; it wasn’t sent.</Callout>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5">
          <Card className="space-y-4 p-4 md:p-5">
            {draft.status === 'sent' ? (
              <Callout tone="info">
                Sent
                {draft.sentAt
                  ? ` ${new Date(draft.sentAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                  : ''}{' '}
                to {to}. It’s on the client’s timeline.
              </Callout>
            ) : (
              <p className="text-[12.5px] text-text-3">
                From your own mailbox when it’s connected, otherwise your email address, otherwise
                the team inbox.
              </p>
            )}
            <Field label="Subject" htmlFor="update-subject" error={errors.subject}>
              <Input
                id="update-subject"
                value={subject}
                disabled={draft.status !== 'ready'}
                maxLength={200}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
            <Field label="Message" htmlFor="update-body" error={errors.body}>
              <Textarea
                id="update-body"
                value={body}
                disabled={draft.status !== 'ready'}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-[320px]"
                data-testid="update-body"
              />
            </Field>
            <p className="text-[12.5px] text-text-3">
              Written by AI from this deal’s confirmed dates and duties only. Check it before
              sending.
            </p>
          </Card>

          <div className="space-y-4">
            <Card
              className={cn('p-4 md:p-5', flags.length && !acknowledged && 'border-warning')}
              data-testid="fair-housing"
            >
              <h2 className="mb-2.5 flex items-center gap-2 text-[15px] font-semibold">
                <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
                {checking
                  ? 'Fair housing: checking…'
                  : flags.length
                    ? `Fair housing: ${flags.length === 1 ? '1 flag' : `${flags.length} flags`}`
                    : 'Fair housing: nothing flagged'}
              </h2>
              {flags.map((f) => (
                <div
                  key={f.phrase}
                  className="mb-2.5 rounded-menu bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text"
                >
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => select(f.phrase)}
                  >
                    “{f.phrase}”
                  </button>
                  <div className="text-text">
                    {f.reason} ({FAIR_HOUSING_CATEGORIES[f.category].toLowerCase()})
                  </div>
                  <div className="mt-1 text-text-2">Try: {f.safer}</div>
                </div>
              ))}
              {flags.length && draft.status === 'ready' ? (
                acknowledged ? (
                  <p className="text-[12.5px] text-text-2">
                    Kept, with your reason: “{acknowledged.reason}”
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => select(flags[0]!.phrase)}>
                      Change the words
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setKeeping(true)}
                      data-testid="keep-flags"
                    >
                      Keep it, with a reason
                    </Button>
                  </div>
                )
              ) : null}
              <p className="mt-2.5 text-[12.5px] text-text-3">
                Checked with the word list and the AI.{' '}
                {checks.length > 2 ? `${checks.length} checks so far; ` : ''}
                Every check and your choice are kept for the broker.
              </p>
            </Card>
            <Card className="p-4 md:p-5">
              <h2 className="mb-1.5 text-[15px] font-semibold">What the AI saw</h2>
              <p className="text-[13px] text-text-2">
                The address, the stage, confirmed dates, finished and upcoming duties in plain
                words, your name and the client’s first name. No notes, no documents.
              </p>
            </Card>
          </div>
        </div>
      )}

      <ReasonDialog
        open={keeping}
        onOpenChange={setKeeping}
        title="Keep the flagged words?"
        description="Say why they’re fine here. Your reason is kept with the update for the broker."
        submit="Keep them"
        done="Kept, with your reason."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.status_email.acknowledge_flags', {
              body: { ...ids, reason },
            }),
          )
        }
      />
    </div>
  );
}
