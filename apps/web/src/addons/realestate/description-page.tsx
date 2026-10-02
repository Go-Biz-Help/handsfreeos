'use client';
/**
 * A listing's description (board 35, design/realestate/ListingDescription.dc.html). Chris decided (2026-10-01): the
 * AI drafts it from the home's confirmed facts, both fair housing checks read every version, the agent edits it,
 * and the seller signs off these exact words in their portal. An owner or admin can let it through without the
 * portal, with a reason that's kept.
 */
import { fmtMonthDay, localDayOf as dateOf } from '@hfos/core';
import { Check, Circle, Clock, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { CardHead, dealHref } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { ListingView } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();

type Working = NonNullable<ListingView['description']['working']>;

/** The words, with each flagged phrase marked. */
function Marked({ words, phrases }: { words: string; phrases: readonly string[] }) {
  const found = phrases.filter((p) => p && words.toLowerCase().includes(p.toLowerCase()));
  if (!found.length) return <>{words}</>;
  const pattern = new RegExp(
    `(${found.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  return (
    <>
      {words.split(pattern).map((part, i) =>
        found.some((p) => p.toLowerCase() === part.toLowerCase()) ? (
          <mark key={i} className="rounded-[3px] bg-warning-soft px-0.5 text-text">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Step({
  done,
  waiting,
  children,
}: {
  done: boolean;
  waiting?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-[13.5px]">
      {done ? (
        <Check className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={2} />
      ) : waiting ? (
        <Clock className="mt-0.5 h-4 w-4 flex-none text-warning-text" strokeWidth={1.75} />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
      )}
      <span className={cn(!done && 'text-text-2')}>{children}</span>
    </li>
  );
}

export function DescriptionPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  listing: l,
  sellers,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  listing: ListingView;
  sellers: readonly string[];
  live: boolean;
}) {
  const router = useRouter();
  const seller = firstNames(sellers) || 'the seller';
  const { inUse, working: w, history } = l.description;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(w?.words ?? inUse?.words ?? '');
  const [dialog, setDialog] = useState<'keep' | 'through' | null>(null);
  const { busy, errors, act } = useAct();
  const day = (iso: string) => fmtMonthDay(dateOf(iso, timeZone), thisYear());
  const checking = !!w && w.state === 'ready' && !(w.checked.words && w.checked.model);
  const drafting = w?.state === 'drafting';
  // The worker drafts and the model reads a moment later: look again until both have.
  useEffect(() => {
    if (!drafting && !checking) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [drafting, checking, router]);
  const flags = w?.flags ?? [];
  const clear = !!w && w.checked.words && w.checked.model && (!flags.length || !!w.acknowledged);
  const sent = w?.state === 'sent';
  const canSend = !!w && (w.state === 'ready' || w.state === 'failed') && !w.blocked;

  const request = () =>
    act(
      'request',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.listing.description.request', {
            body: { workspaceId, dealId },
          }),
        ),
      'Drafting it from the home’s confirmed facts.',
    );

  return (
    <div data-testid="realestate-description">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Description" />
      <PageHeader
        title="Description"
        description={
          w
            ? `Version ${w.version} · ${w.source === 'ai' ? 'drafted by the AI' : 'written by your team'}${inUse ? ` · version ${inUse.version} in use` : ''}`
            : inUse
              ? `Version ${inUse.version} in use · signed off ${day(inUse.signedAt)}`
              : 'No description yet'
        }
        actions={
          live ? (
            <>
              <Button
                variant="secondary"
                onClick={() => void request()}
                loading={busy === 'request'}
                disabled={!l.factsConfirmedAt || drafting}
                data-testid="description-request"
              >
                {w || inUse ? 'Ask the AI for another' : 'Ask the AI to draft it'}
              </Button>
              {w && !sent ? (
                <Button
                  disabled={!canSend}
                  loading={busy === 'send'}
                  onClick={() =>
                    void act(
                      'send',
                      async () =>
                        unwrap(
                          await apiBrowser().POST(
                            '/v1/commands/realestate.listing.description.send',
                            {
                              body: { workspaceId, descriptionId: w.id },
                            },
                          ),
                        ),
                      `Sent. It’s on ${seller}’s to-do in their portal.`,
                    )
                  }
                  data-testid="description-send"
                >
                  Send to {seller} to sign off
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      {!l.factsConfirmedAt ? (
        <Callout tone="neutral" className="mb-4">
          The AI drafts only from the home’s confirmed facts.{' '}
          <Link
            href={dealHref(workspaceId, dealId, 'facts')}
            className="font-semibold text-accent-text hover:underline"
          >
            Confirm them first
          </Link>
          .
        </Callout>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5">
        <div className="min-w-0 space-y-4">
          {w ? (
            <Card className="p-4 md:p-5" data-testid="description-working">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                  Version {w.version} ·{' '}
                  {w.source === 'ai' ? 'drafted by the AI' : 'written by your team'}
                </span>
                <WorkingBadge w={w} seller={seller} />
              </div>
              {editing ? (
                <>
                  <Textarea
                    rows={9}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    data-testid="description-text"
                  />
                  {errors.words ? (
                    <p className="mt-1 text-[12.5px] text-danger-text">{errors.words}</p>
                  ) : null}
                  <div className="mt-3 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button
                      loading={busy === 'save'}
                      disabled={!text.trim()}
                      onClick={() =>
                        void act(
                          'save',
                          async () => {
                            unwrap(
                              await apiBrowser().POST(
                                '/v1/commands/realestate.listing.description.save',
                                { body: { workspaceId, dealId, words: text } },
                              ),
                            );
                            setEditing(false);
                          },
                          'Saved as a new version. Both checks read it again.',
                        )
                      }
                      data-testid="description-save"
                    >
                      Save as a new version
                    </Button>
                  </div>
                </>
              ) : drafting ? (
                <p className="flex items-center gap-2 text-[13.5px] text-text-2" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                  Drafting it from the home’s confirmed facts…
                </p>
              ) : w.words ? (
                <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
                  <Marked words={w.words} phrases={flags.map((f) => f.phrase)} />
                </p>
              ) : (
                <p className="text-[13.5px] text-text-2">
                  {w.failure ?? 'It couldn’t be drafted. Ask again, or write it yourself.'}
                </p>
              )}
              {flags.length && !editing ? (
                <ul className="mt-3 space-y-2" data-testid="description-flags">
                  {flags.map((f, i) => (
                    <li
                      key={i}
                      className="rounded-menu border-l-[3px] border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger-text"
                    >
                      <span className="font-semibold">Fair housing: “{f.phrase}”.</span> {f.reason}{' '}
                      {f.safer}
                    </li>
                  ))}
                </ul>
              ) : null}
              {w.acknowledged ? (
                <p className="mt-2 text-[13px] text-text-2">
                  Kept as written: {w.acknowledged.reason}
                </p>
              ) : null}
              {live && !editing && !drafting && !sent ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setText(w.words ?? inUse?.words ?? '');
                      setEditing(true);
                    }}
                    data-testid="description-edit"
                  >
                    {w.words ? 'Edit' : 'Write it yourself'}
                  </Button>
                  {flags.length && !w.acknowledged && w.checked.words && w.checked.model ? (
                    <Button size="sm" variant="ghost" onClick={() => setDialog('keep')}>
                      Keep it as it is, with a reason
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ) : null}
          {inUse ? (
            <Card className="p-4 md:p-5" data-testid="description-in-use">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                  Version {inUse.version} · in use
                </span>
                <Badge variant="ok">
                  {inUse.how === 'portal'
                    ? `Signed off by ${seller} ${day(inUse.signedAt)}`
                    : `Used without the portal ${day(inUse.signedAt)}`}
                </Badge>
              </div>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{inUse.words}</p>
              {inUse.reason ? (
                <p className="mt-2 text-[13px] text-text-2">Why: {inUse.reason}</p>
              ) : null}
            </Card>
          ) : null}
          {!w && !inUse ? (
            <Card className="p-5 text-[13.5px] text-text-2">
              No description yet. The AI drafts one from the home’s confirmed facts and your
              highlights; both fair housing checks read it; you edit it; {seller} signs it off.
            </Card>
          ) : null}
          {history.filter((h) => h.id !== w?.id && h.id !== inUse?.id).length ? (
            <Card className="p-4 md:p-5">
              <CardHead title="Earlier versions" />
              <ul className="space-y-3">
                {history
                  .filter((h) => h.id !== w?.id && h.id !== inUse?.id)
                  .map((h) => (
                    <li key={h.id} className="text-[13px]">
                      <div className="font-medium">
                        Version {h.version} · {h.source === 'ai' ? 'the AI’s draft' : 'your team’s'}{' '}
                        · {day(h.at)}
                      </div>
                      {h.words ? <p className="line-clamp-3 text-text-2">{h.words}</p> : null}
                    </li>
                  ))}
              </ul>
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card className="p-4 md:p-5" data-testid="description-signoff">
            <CardHead title="Sign-off" />
            <ul className="space-y-2">
              <Step done={!!l.factsConfirmedAt && (!!w || !!inUse)}>
                Drafted from the confirmed facts
              </Step>
              <Step done={clear || (!w && !!inUse)} waiting={checking}>
                Checked by fair housing’s word list and the AI’s own read
              </Step>
              <Step done={!!inUse && !w} waiting={sent}>
                Signed off by {seller} in their portal
              </Step>
            </ul>
            <p className="mt-3 text-[12.5px] text-text-3">
              {w?.blocked && !sent
                ? w.blocked.words
                : sent
                  ? `These exact words are in ${seller}’s portal. Once they sign, it’s the description in use.`
                  : `${seller.replace(/^./, (m) => m.toUpperCase())} gets these exact words to approve. Sending is refused while a flag is open.`}
            </p>
          </Card>
          {l.can.letThrough && w && live ? (
            <Card className="p-4 md:p-5">
              <CardHead title="Signed on paper?" />
              <p className="mb-3 text-[13.5px] text-text-2">
                An owner or admin can use it without the portal sign-off, with a reason that’s kept
                on the deal.
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={drafting || checking}
                onClick={() => setDialog('through')}
                data-testid="description-let-through"
              >
                Use it with a reason
              </Button>
            </Card>
          ) : null}
        </div>
      </div>
      <ReasonDialog
        open={dialog === 'keep'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Keep the words as they are?"
        description="Say why the words flagged are fine here. It’s kept with your name."
        submit="Keep them"
        done="Kept, with your reason."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST(
              '/v1/commands/realestate.listing.description.acknowledge_flags',
              {
                body: { workspaceId, descriptionId: w!.id, reason },
              },
            ),
          )
        }
      />
      <ReasonDialog
        open={dialog === 'through'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Use it without the portal sign-off?"
        description={`Say how ${seller} approved it, like “signed it on paper at the office”. It’s kept on the deal.`}
        submit="Use it"
        done="It’s in use."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.listing.description.let_through', {
              body: { workspaceId, descriptionId: w!.id, reason },
            }),
          )
        }
      />
    </div>
  );
}

function WorkingBadge({ w, seller }: { w: Working; seller: string }) {
  if (w.state === 'drafting') return <Badge variant="gray">Drafting…</Badge>;
  if (w.state === 'failed') return <Badge variant="danger">Couldn’t draft</Badge>;
  if (w.state === 'sent') return <Badge variant="pending">Waiting on {seller}’s sign-off</Badge>;
  if (!(w.checked.words && w.checked.model)) return <Badge variant="gray">Checking…</Badge>;
  if (w.flags.length && !w.acknowledged)
    return <Badge variant="danger">{`${w.flags.length} flagged`}</Badge>;
  return <Badge variant="ok">Both checks clear</Badge>;
}
