'use client';
/**
 * A contract, amendment or addendum as the Assistant read it (boards 50 and 51, design/realestate/ContractRead.dc.html
 * and AmendmentChanges.dc.html). The PDF sits beside each value, with the clause, the page and the words it came
 * from. Nothing counts until a person confirms it (Chris, 2026-10-02): a value waits on Key dates, and the duties
 * on its date start, or move, once it's confirmed. A value read from a scan says so, to be checked closely.
 */
import { fmtMonthDay, localDayOf } from '@hfos/core';
import { Check, Circle, ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { CardHead, dealHref } from './bits';
import { DealCrumb } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { DealFile } from './documents-page';
import type { ContractRead, ReadValue } from './types';
import { useAct } from './use-act';

const thisYear = new Date().getFullYear();

export function ContractPage({
  workspaceId,
  timeZone,
  read,
  file,
}: {
  workspaceId: string;
  timeZone: string;
  read: ContractRead;
  file: DealFile | null;
}) {
  const router = useRouter();
  const { busy, act } = useAct();
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<ReadValue | null>(null);
  const dealId = read.dealId;
  const amendment = read.kind !== 'contract';
  const waiting = read.values.filter((v) => v.state === 'waiting');
  const reading = read.state === 'reading';
  const api = apiBrowser();

  // The worker reads it in a minute or so: look again until it has.
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [reading, router]);

  const confirm = (valueIds?: string[]) =>
    act(
      valueIds ? `confirm-${valueIds[0]}` : 'confirm',
      async () =>
        unwrap(
          await api.POST('/v1/commands/realestate.contract.confirm', {
            body: { workspaceId, readId: read.readId, ...(valueIds ? { valueIds } : {}) },
          }),
        ),
      amendment
        ? 'Confirmed. The duties on these dates moved.'
        : 'Confirmed. The duties on these dates start now.',
    );

  const readAgain = () =>
    act(
      'again',
      async () =>
        unwrap(
          await api.POST('/v1/commands/realestate.document.read', {
            body: { workspaceId, documentId: read.documentId },
          }),
        ),
      'Reading it again. Its values show here in a minute or two.',
    );

  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), thisYear);
  const name = read.kind === 'contract' ? 'The contract' : read.documentTitle;
  const title = reading
    ? `Reading ${read.kind === 'contract' ? 'the contract' : read.documentTitle}…`
    : read.state === 'failed'
      ? `${name}: it couldn’t be read`
      : amendment
        ? `${name}: what it changes`
        : waiting.length
          ? `${name}: ${waiting.length} ${waiting.length === 1 ? 'value' : 'values'} to confirm`
          : `${name}: every value confirmed`;
  const description = [
    file?.name ?? read.documentTitle,
    read.readAt ? `read from ${read.scan ? 'a scan' : 'its text'} ${day(read.readAt)}` : null,
    read.pages ? `${read.pages} ${read.pages === 1 ? 'page' : 'pages'}` : null,
    amendment && read.moves.length
      ? `${read.moves.length} ${read.moves.length === 1 ? 'duty moves' : 'duties move'}`
      : null,
    waiting.length
      ? 'nothing counts until a person confirms it; the duties on these dates start then'
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div data-testid="realestate-contract">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={read.dealName}
        here={amendment ? read.documentTitle : 'Contract'}
        middle={{ label: 'Documents', path: 'documents' }}
      />
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {!reading ? (
              <Button variant="ghost" onClick={() => void readAgain()} loading={busy === 'again'}>
                Read it again
              </Button>
            ) : null}
            {waiting.length ? (
              <Button
                onClick={() => void confirm()}
                loading={busy === 'confirm'}
                data-testid="contract-confirm-all"
              >
                {amendment && read.moves.length
                  ? `Confirm and move ${read.moves.length} ${read.moves.length === 1 ? 'duty' : 'duties'}`
                  : `Confirm ${waiting.length} ${waiting.length === 1 ? 'value' : 'values'}`}
              </Button>
            ) : null}
          </>
        }
      />

      {read.newerReadId ? (
        <Callout
          tone="info"
          className="mb-4"
          action={
            <Link
              href={dealHref(workspaceId, dealId, `contract/${read.newerReadId}`)}
              className="text-[13px] font-medium text-accent-text hover:underline"
            >
              Open it
            </Link>
          }
        >
          This document was read again since. The newer reading is the one to check.
        </Callout>
      ) : null}
      {reading ? (
        <Callout tone="neutral" className="mb-4" data-testid="contract-reading">
          The Assistant is reading it. Each value shows here, with the words it came from, in a
          minute or two.
        </Callout>
      ) : read.state === 'failed' ? (
        <Callout tone="danger" className="mb-4" data-testid="contract-failed">
          <div className="font-medium">{read.failure ?? 'It couldn’t be read.'}</div>
          <div>
            Read it again, or type its dates under{' '}
            <Link href={dealHref(workspaceId, dealId, 'dates')} className="underline">
              Key dates
            </Link>
            .
          </div>
        </Callout>
      ) : null}
      {read.problems.map((p) => (
        <Callout key={p.check} tone="warning" className="mb-4" data-testid="contract-problem">
          {p.words}
        </Callout>
      ))}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-5">
        <PdfView file={file} page={page} title={read.documentTitle} />
        <div className="min-w-0 space-y-4 lg:space-y-5">
          {read.values.length ? (
            <Card className="p-0" data-testid="contract-values">
              <div className="px-4 pt-4 md:px-5">
                <CardHead
                  title={amendment ? 'What it says' : 'Values'}
                  action={
                    <span className="text-[12.5px] text-text-3">
                      {waiting.length ? `${waiting.length} to confirm` : 'All confirmed'}
                    </span>
                  }
                />
              </div>
              <ul className="divide-y divide-border">
                {read.values.map((v) => (
                  <ValueRow
                    key={v.id}
                    v={v}
                    amendment={amendment}
                    scan={read.scan}
                    busy={busy}
                    onPage={setPage}
                    onConfirm={() => void confirm([v.id])}
                    onReject={() => setRejecting(v)}
                  />
                ))}
              </ul>
            </Card>
          ) : null}

          {amendment && read.moves.length ? (
            <Card className="p-4 md:p-5" data-testid="contract-moves">
              <CardHead
                title={`What moves · ${read.moves.length} ${read.moves.length === 1 ? 'duty' : 'duties'}`}
              />
              <ul className="divide-y divide-border text-[13.5px]">
                {read.moves.map((m) => (
                  <li key={m.dutyId} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">{m.title}</div>
                      <div className="text-[12.5px] text-text-3">
                        {[m.accountableName, m.why].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="flex-none text-right tabular-nums">
                      <span className="text-text-3 line-through">{m.from ?? '—'}</span>
                      <span className="mx-1.5 text-text-3">→</span>
                      <span className="font-medium">{m.to ?? '—'}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12.5px] text-text-3">
                They move when the values are confirmed, and each one’s history says why.
              </p>
            </Card>
          ) : null}

          {read.unclear.length ? (
            <Card className="p-4 md:p-5" data-testid="contract-unclear">
              <CardHead
                title={`${read.unclear.length} to look at`}
                action={
                  <Link
                    href={dealHref(workspaceId, dealId, 'dates')}
                    className="text-[13px] text-accent-text hover:underline"
                  >
                    Type a date
                  </Link>
                }
              />
              <ul className="space-y-2.5 text-[13.5px]">
                {read.unclear.map((u, i) => (
                  <li key={i}>
                    <div>{u.what}</div>
                    {u.quote ? (
                      <blockquote className="mt-1 border-l-2 border-border pl-2.5 text-[12.5px] text-text-2">
                        “{u.quote}”
                      </blockquote>
                    ) : null}
                    <Where clause={u.clause} page={u.page} onPage={setPage} />
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 text-[12.5px] text-text-3">
                These weren’t entered: they don’t give a value plainly enough. Type one under Key
                dates, or leave it.
              </p>
            </Card>
          ) : null}
          {read.dropped ? (
            <p className="text-[12.5px] text-text-3">
              {read.dropped} more {read.dropped === 1 ? 'value was' : 'values were'} left out: the
              words quoted for {read.dropped === 1 ? 'it' : 'them'} weren’t in the document.
            </p>
          ) : null}
        </div>
      </div>

      <ReasonDialog
        open={rejecting !== null}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={rejecting ? `Not right: ${rejecting.label}` : 'Not right'}
        description="It’s set aside and never counts. Type the right value under Key dates."
        label="What’s wrong with it"
        submit="Set it aside"
        done="Set aside. Type the right one under Key dates."
        run={async (reason) =>
          rejecting &&
          unwrap(
            await api.POST('/v1/commands/realestate.contract.reject_value', {
              body: { workspaceId, readId: read.readId, valueId: rejecting.id, reason },
            }),
          )
        }
      />
    </div>
  );
}

/** "§5B · p. 2", the page opening the PDF there. */
function Where({
  clause,
  page,
  onPage,
}: {
  clause: string | null;
  page: number | null;
  onPage: (page: number) => void;
}) {
  if (!clause && !page) return null;
  return (
    <div className="mt-0.5 text-[12px] text-text-3">
      {clause}
      {clause && page ? ' · ' : ''}
      {page ? (
        <button
          type="button"
          className="text-accent-text hover:underline"
          onClick={() => onPage(page)}
        >
          p. {page}
        </button>
      ) : null}
    </div>
  );
}

function ValueRow({
  v,
  amendment,
  scan,
  busy,
  onPage,
  onConfirm,
  onReject,
}: {
  v: ReadValue;
  amendment: boolean;
  scan: boolean;
  busy: string | null;
  onPage: (page: number) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const waiting = v.state === 'waiting';
  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-3 md:px-5',
        v.state === 'rejected' && 'opacity-70',
      )}
      data-testid="contract-value"
      data-key={v.key}
      data-state={v.state}
    >
      {v.state === 'confirmed' ? (
        <span className="mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-success text-on-solid">
          <Check className="h-3 w-3" strokeWidth={2.5} />
        </span>
      ) : v.state === 'rejected' ? (
        <X className="mt-0.5 h-[18px] w-[18px] flex-none text-danger" strokeWidth={2} />
      ) : (
        <Circle
          className="mt-0.5 h-[18px] w-[18px] flex-none text-border-strong"
          strokeWidth={1.75}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <div className="font-medium">{v.label}</div>
          <div className={cn('font-semibold', v.state === 'rejected' && 'line-through')}>
            {v.value}
          </div>
        </div>
        {v.worked ? <div className="text-[12.5px] text-text-2">{v.worked}</div> : null}
        <blockquote className="mt-1 border-l-2 border-border pl-2.5 text-[12.5px] text-text-2">
          “{v.quote}”
        </blockquote>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Where clause={v.clause} page={v.page} onPage={onPage} />
          {scan ? <Badge variant="pending">Read from a scan</Badge> : null}
        </div>
        {v.now !== null && !v.same ? (
          <div className={cn('mt-1 text-[12.5px]', waiting ? 'text-warning-text' : 'text-text-3')}>
            {amendment ? 'Was' : 'Now'}: {v.now}
            {v.nowFrom ? ` · ${v.nowFrom}` : ''}
            {waiting && !amendment ? ' · confirming this replaces it' : ''}
          </div>
        ) : v.now !== null && waiting ? (
          <div className="mt-1 text-[12.5px] text-text-3">
            Same as now{v.nowFrom ? ` · ${v.nowFrom}` : ''}
          </div>
        ) : null}
        {v.state === 'confirmed' && v.decidedByName ? (
          <div className="mt-1 text-[12px] text-text-3">Confirmed by {v.decidedByName}</div>
        ) : v.state === 'rejected' ? (
          <div className="mt-1 text-[12px] text-text-3">
            Set aside{v.decidedByName ? ` by ${v.decidedByName}` : ''}
            {v.reason ? `: ${v.reason}` : ''}
          </div>
        ) : null}
        {waiting ? (
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === `confirm-${v.id}`}
              onClick={onConfirm}
              data-testid="contract-confirm"
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={onReject} data-testid="contract-reject">
              Not right…
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The PDF itself, at the page a value came from. Signed for ten minutes with the person's own session, so storage
 * decides they may see it. Where the browser can't show a PDF inline (most phones), it's a link that opens it.
 */
function PdfView({ file, page, title }: { file: DealFile | null; page: number; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  useEffect(() => {
    setInline(typeof navigator !== 'undefined' && navigator.pdfViewerEnabled === true);
    if (!file) return;
    let gone = false;
    void supabaseBrowser()
      .storage.from(file.bucket)
      .createSignedUrl(file.objectPath, 600)
      .then(({ data, error }) => {
        if (gone) return;
        if (error || !data) toast.error('The PDF couldn’t be opened. Try again in a minute.');
        else setUrl(data.signedUrl);
      });
    return () => {
      gone = true;
    };
  }, [file]);

  if (!file)
    return (
      <Card className="p-4 text-[13.5px] text-text-2 md:p-5">
        Its file isn’t on this deal anymore, so only the values read from it are here.
      </Card>
    );
  return (
    <Card
      className="overflow-hidden p-0 lg:sticky lg:top-4 lg:self-start"
      data-testid="contract-pdf"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-[13px]">
        <span className="truncate text-text-2">
          {file.name}
          {page > 1 ? ` · page ${page}` : ''}
        </span>
        {url ? (
          <a
            href={`${url}#page=${page}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex flex-none items-center gap-1 text-accent-text hover:underline"
          >
            Open the PDF
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          </a>
        ) : null}
      </div>
      {url && inline ? (
        <iframe
          key={page}
          src={`${url}#page=${page}`}
          title={title}
          className="hidden h-[72vh] w-full bg-card-2 lg:block"
        />
      ) : null}
      {url && inline ? (
        <p className="px-4 py-3 text-[13px] text-text-2 lg:hidden">
          Open the PDF to check each value against its page.
        </p>
      ) : (
        <p className="px-4 py-6 text-[13.5px] text-text-2">
          {url
            ? 'This browser opens PDFs on their own: use Open the PDF, and check each value against its page.'
            : 'Opening the PDF…'}
        </p>
      )}
    </Card>
  );
}
