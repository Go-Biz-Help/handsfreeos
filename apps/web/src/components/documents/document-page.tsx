'use client';
/**
 * One sent document (docs/documents.md): where it is, who has signed, every step of its proof trail, and the pages as
 * they stand. From here the team reminds, voids with a reason, copies a signer's link, hands their device to a
 * signer who's with them (Sign now, answer 13a), sends a corrected one again (answer 15a) and opens the signed copy.
 */
import {
  DOCUMENT_SCREEN_WORDS as W,
  DocumentDefinition,
  documentStepText,
  sendAgainQuery,
  SIGNER_STATUS_TONES,
  signerIsUp,
  signerStatusLabel,
  type DocumentValueInput,
} from '@hfos/core';
import {
  ArrowLeft,
  Ban,
  BellRing,
  Download,
  ExternalLink,
  Link2,
  PenLine,
  RotateCcw,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { DocumentGetOut, DocumentSignerRow } from '@/lib/api/types';
import { workerPost } from '@/lib/api/worker';
import { documentFileUrl } from '@/lib/documents/files';
import { aboutHref, documentBadge } from '@/lib/documents/words';
import { formatDate } from '@/lib/format';
import { boxStyle, EditView, PdfPages, ValueView } from './pdf-pages';

export function DocumentPage({ workspaceId, doc }: { workspaceId: string; doc: DocumentGetOut }) {
  const router = useRouter();
  const definition = useMemo(() => DocumentDefinition.parse(doc.definition), [doc.definition]);
  const values = doc.values as Record<string, DocumentValueInput>;
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const badge = documentBadge(doc.status, doc.finishing);
  const names = new Map(doc.signers.map((s) => [s.id, s.name]));

  useEffect(() => {
    if (!doc.source) return;
    let live = true;
    documentFileUrl(doc.source)
      .then((u) => live && setSourceUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [doc.source]);

  async function remind() {
    setBusy('remind');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/document.remind', {
          body: { workspaceId, documentId: doc.id },
        }),
      );
      toast.success(W.reminded);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function voidIt() {
    setBusy('void');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/document.void', {
          body: {
            workspaceId,
            documentId: doc.id,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        }),
      );
      setVoiding(false);
      toast.success(W.voided);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(signer: DocumentSignerRow) {
    setBusy(signer.id);
    try {
      const { url } = await workerPost<{ url: string }>('/v1/documents/link', {
        workspaceId,
        signerId: signer.id,
      });
      await copyText(url, W.linkCopied(signer.name));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Sign now (answer 13a): noted as handed over by this person, then their signing page opens here, saying whose
   * turn it is and how to come back to this page.
   */
  async function signNow(signer: DocumentSignerRow) {
    setBusy(`now:${signer.id}`);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/document.sign_now', {
          body: { workspaceId, signerId: signer.id },
        }),
      );
      const { url } = await workerPost<{ url: string }>('/v1/documents/link', {
        workspaceId,
        signerId: signer.id,
      });
      const hand = new URLSearchParams({
        with: signer.name.split(' ')[0] || signer.name,
        back: `/app/w/${workspaceId}/documents/${doc.id}`,
      });
      window.location.assign(`${new URL(url).pathname}#${hand.toString()}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  async function openSigned(download: boolean) {
    if (!doc.signed) return;
    try {
      const url = await documentFileUrl(doc.signed, { seconds: 300, download });
      if (download) window.location.assign(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const againQuery = doc.canSend ? sendAgainQuery(doc) : null;
  const again = againQuery ? `/app/w/${workspaceId}/documents/send?${againQuery}` : null;

  return (
    <div className="flex flex-col gap-4" data-testid="document-page">
      <div className="flex flex-col gap-2">
        <Link
          href={`/app/w/${workspaceId}/documents`}
          className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-text-3 hover:text-text-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Documents
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1
            className="text-[22px] font-semibold leading-tight tracking-[-0.01em]"
            data-testid="document-name"
          >
            {doc.name}
          </h1>
          <Badge variant={badge.variant} data-testid="document-status">
            {badge.label}
          </Badge>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {doc.status === 'out' && doc.canSend && !doc.finishing ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'remind'}
                  onClick={() => void remind()}
                  data-testid="document-remind"
                >
                  <BellRing className="h-4 w-4" strokeWidth={1.75} />
                  {W.remind}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setVoiding(true)}
                  data-testid="document-void-open"
                >
                  <Ban className="h-4 w-4" strokeWidth={1.75} />
                  {W.void}
                </Button>
              </>
            ) : null}
            {doc.signed ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => void openSigned(false)}>
                  <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
                  {W.openSigned}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void openSigned(true)}
                  data-testid="document-download"
                >
                  <Download className="h-4 w-4" strokeWidth={1.75} />
                  {W.download}
                </Button>
              </>
            ) : null}
            {again ? (
              <ButtonLink
                variant="primary"
                size="sm"
                href={again}
                data-testid="document-send-again"
              >
                <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                {W.sendAgain}
              </ButtonLink>
            ) : null}
          </div>
        </div>
        <p className="text-[13px] text-text-2">
          {doc.about ? (
            <>
              {W.about}{' '}
              <Link
                className="font-medium text-text hover:underline"
                href={aboutHref(workspaceId, doc.about)}
              >
                {doc.about.name}
              </Link>
              {' · '}
            </>
          ) : null}
          {W.sentAt(formatDate(doc.sentAt, { time: true }), doc.sentBy?.fullName ?? null)}
          {doc.status === 'out' ? ` · ${W.outOfTimeOn(formatDate(doc.expiresAt))}` : ''}
          {doc.completedAt
            ? ` · ${W.everyoneSigned(formatDate(doc.completedAt, { time: true }))}`
            : ''}
        </p>
        {doc.status === 'voided' ? (
          <Note>{W.voidedNote(formatDate(doc.voidedAt, { time: true }), doc.voidReason)}</Note>
        ) : doc.status === 'declined' ? (
          <Note>
            {(() => {
              const who = doc.signers.find((s) => s.status === 'declined');
              return W.declinedNote(
                who?.name ?? null,
                formatDate(doc.declinedAt, { time: true }),
                who?.declineReason ?? null,
              );
            })()}
          </Note>
        ) : doc.status === 'expired' ? (
          <Note>{W.expiredNote(formatDate(doc.expiredAt, { time: true }))}</Note>
        ) : doc.status === 'completed' ? (
          <p className="text-[12.5px] text-text-3">{W.completedNote}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <PdfPages
            source={sourceUrl}
            pages={definition.pages}
            testId="document-pages"
            layer={({ index, scale }) => (
              <>
                {definition.edits
                  .filter((e) => e.page === index)
                  .map((e) => (
                    <EditView key={e.id} edit={e} scale={scale} />
                  ))}
                {definition.fields
                  .filter((f) => f.page === index)
                  .map((f) => {
                    const v = values[f.id];
                    return (
                      <div
                        key={f.id}
                        className={
                          v
                            ? 'pointer-events-none absolute'
                            : 'pointer-events-none absolute rounded-[3px] border border-dashed border-border-strong bg-card-2/50'
                        }
                        style={boxStyle(f)}
                      >
                        {v ? (
                          <ValueView value={v} type={f.type} fontSize={f.fontSize} scale={scale} />
                        ) : null}
                      </div>
                    );
                  })}
              </>
            )}
          />
        </div>
        <div className="flex flex-col gap-4 lg:sticky lg:top-4">
          <Card className="p-4">
            <h2 className="mb-2 text-[15px] font-semibold">{W.whoSigns}</h2>
            <ul className="flex flex-col divide-y divide-border">
              {doc.signers.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0"
                  data-testid="document-signer"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                      {s.name}
                    </span>
                    <Badge variant={s.kind === 'copy' ? 'gray' : SIGNER_STATUS_TONES[s.status]}>
                      {s.kind === 'copy' ? W.getsCopy : signerStatusLabel(s, doc.signers)}
                    </Badge>
                  </div>
                  <span className="text-[12px] text-text-3">
                    {[s.roleLabel, s.email, s.phone].filter(Boolean).join(' · ')}
                  </span>
                  {s.signedAt ? (
                    <span className="text-[12px] text-text-2">
                      {W.signedAt(formatDate(s.signedAt, { time: true }))}
                    </span>
                  ) : s.openedAt ? (
                    <span className="text-[12px] text-text-2">
                      {W.openedAt(formatDate(s.openedAt, { time: true }))}
                    </span>
                  ) : s.lastSentAt ? (
                    <span className="text-[12px] text-text-2">
                      {W.linkSentAt(formatDate(s.lastSentAt, { time: true }), s.reminders)}
                    </span>
                  ) : null}
                  {doc.canSend && (doc.status === 'out' || doc.status === 'completed') ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {doc.status === 'out' && !doc.finishing && signerIsUp(s, doc.signers) ? (
                        <Button
                          variant={s.inPerson ? 'secondary' : 'ghost'}
                          size="sm"
                          className="w-fit"
                          loading={busy === `now:${s.id}`}
                          onClick={() => void signNow(s)}
                          data-testid="document-sign-now"
                        >
                          <PenLine className="h-4 w-4" strokeWidth={1.75} />
                          {W.signNow}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-fit"
                        loading={busy === s.id}
                        onClick={() => void copyLink(s)}
                        data-testid="document-copy-link"
                      >
                        <Link2 className="h-4 w-4" strokeWidth={1.75} />
                        {W.copyLink}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4">
            <h2 className="mb-2 text-[15px] font-semibold">{W.whatHappened}</h2>
            <ol className="flex flex-col gap-2" data-testid="document-steps">
              {[...doc.steps].reverse().map((st) => (
                <li key={st.id} className="flex flex-col text-[12.5px]">
                  <span className="text-text">
                    {documentStepText({
                      kind: st.kind,
                      channel: st.channel,
                      detail: st.detail as Record<string, unknown> | null,
                    })}
                    {st.signerId && names.get(st.signerId) ? `: ${names.get(st.signerId)}` : ''}
                  </span>
                  <span className="text-text-3">
                    {formatDate(st.at, { time: true })}
                    {st.ip ? ` · ${st.ip}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Dialog open={voiding} onOpenChange={(o) => busy !== 'void' && setVoiding(o)}>
        <DialogContent title={W.voidTitle(doc.name)} description={W.voidBody}>
          <div className="mt-4 flex flex-col gap-4">
            <Field label={W.voidReason} htmlFor="void-reason">
              <Textarea
                id="void-reason"
                className="min-h-16"
                value={reason}
                maxLength={500}
                placeholder={W.voidReasonExample}
                onChange={(e) => setReason(e.target.value)}
                data-testid="document-void-reason"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setVoiding(false)}>
                {W.keepOut}
              </Button>
              <Button
                variant="danger"
                loading={busy === 'void'}
                onClick={() => void voidIt()}
                data-testid="document-void"
              >
                {W.voidIt}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p
      className="rounded-card bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
      data-testid="document-note"
    >
      {children}
    </p>
  );
}
