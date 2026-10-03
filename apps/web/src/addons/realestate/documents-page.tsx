'use client';
/**
 * A deal's documents (board 6, design/realestate/Documents.dc.html): each with its kind, its versions and which one
 * counts. A signed document is kept for good: nobody deletes or renames it, owners included; a change is a newer
 * version marked as the one that counts, and the old one stays in the history. Every file's SHA-256 fingerprint is
 * taken as it arrives. A contract, an amendment or an addendum is read as it's added (round four, board 50): its row
 * says when it's being read and how many of its values wait on a person, and opens the reading. Round five (boards
 * 69, 70): a document goes for signing through the brokerage's DocuSign or Dotloop, and its Signing column and panel
 * say where that stands (./esign-bits.tsx).
 */
import { ATTACHMENT_TYPES } from '@hfos/core';
import { DOCUMENT_KINDS, type DocumentKind } from '@hfos/core/addons/realestate/catalog/types';
import { FileText, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFile } from '@/components/files/upload-zone';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { workerPost } from '@/lib/api/worker';
import { supabaseBrowser } from '@/lib/supabase/client';
import { dealHref } from './bits';
import { ReasonDialog } from './deal-dialogs';
import {
  EnvelopePanel,
  SendForSigningDialog,
  signingLine,
  type Envelope,
  type SignerChoice,
} from './esign-bits';
import type { ContractReadRow, DealDocument, EsignList } from './types';
import { useAct } from './use-act';

export interface DealFile {
  readonly id: string;
  readonly name: string;
  readonly bucket: string;
  readonly objectPath: string;
}

const STATUS_WORDS: Readonly<Record<DealDocument['status'], string>> = {
  draft: 'Received',
  sent: 'Sent for signatures',
  signed: 'Signed · kept',
  superseded: 'Superseded',
  void: 'Void',
};

export async function openFile(f: DealFile) {
  const { data, error } = await supabaseBrowser()
    .storage.from(f.bucket)
    .createSignedUrl(f.objectPath, 300);
  if (error || !data) throw new Error('That file couldn’t be opened. Try again in a minute.');
  window.open(data.signedUrl, '_blank', 'noopener');
}

export function DocumentsPage({
  workspaceId,
  dealId,
  dealName,
  documents,
  files,
  reads,
  esign = null,
  people = [],
  back = null,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  documents: readonly DealDocument[];
  files: readonly DealFile[];
  /** Round four: each contract, amendment and addendum read, newest first. */
  reads: readonly ContractReadRow[];
  /** Round five: what's been sent for signing, and the e-signature services connected. */
  esign?: EsignList | null;
  /** The deal's people who might sign, with their emails. */
  people?: readonly SignerChoice[];
  /** Back from the service (`?esign=<envelope>`): it's looked at again and its panel opens. */
  back?: string | null;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  // The newest reading of each document.
  const readOf = useMemo(() => {
    const m = new Map<string, ContractReadRow>();
    for (const r of [...reads].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)))
      m.set(r.documentId, r);
    return m;
  }, [reads]);
  const reading = [...readOf.values()].some((r) => r.state === 'reading');
  // The worker reads it in a minute or so: look again until it has.
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [reading, router]);
  const [adding, setAdding] = useState<{ supersedes?: DealDocument; fileId?: string } | null>(null);
  const [signing, setSigning] = useState<DealDocument | null>(null);
  const [panel, setPanel] = useState<string | null>(back);
  const envelopes = esign?.envelopes ?? [];
  // The newest envelope of each document, for its Signing column.
  const envelopeOf = useMemo(() => {
    const m = new Map<string, Envelope>();
    for (const e of [...envelopes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      m.set(e.documentId, e);
    return m;
  }, [envelopes]);
  const shownEnvelope = envelopes.find((e) => e.id === panel) ?? null;
  // Getting it ready at the service takes a moment: look again until it's ready.
  const preparing = envelopes.some((e) => e.state === 'preparing');
  useEffect(() => {
    if (!preparing) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [preparing, router]);
  // Back from DocuSign or Dotloop: ask the service where it stands now, then show it.
  const checked = useRef(false);
  useEffect(() => {
    if (!back || checked.current) return;
    checked.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    void workerPost('/v1/addons/realestate/actions/realestate.esign.check', {
      workspaceId,
      input: { envelopeId: back },
    })
      .catch(() => null)
      .finally(() => router.refresh());
  }, [back, workspaceId, router]);
  const [voiding, setVoiding] = useState<DealDocument | null>(null);
  const { busy, act } = useAct();
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const versions = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of documents) n.set(d.lineageId, Math.max(n.get(d.lineageId) ?? 0, d.version));
    return n;
  }, [documents]);
  const filed = new Set(documents.map((d) => d.fileId));
  const loose = files.filter((f) => !filed.has(f.id));
  const run = (
    key: string,
    path: 'mark_signed' | 'set_controlling',
    documentId: string,
    done: string,
  ) =>
    act(
      key,
      async () =>
        path === 'mark_signed'
          ? unwrap(
              await apiBrowser().POST('/v1/commands/realestate.document.mark_signed', {
                body: { workspaceId, documentId },
              }),
            )
          : unwrap(
              await apiBrowser().POST('/v1/commands/realestate.document.set_controlling', {
                body: { workspaceId, documentId },
              }),
            ),
      done,
    );

  return (
    <div data-testid="realestate-documents">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={dealHref(workspaceId, dealId)} className="text-accent-text hover:underline">
          {dealName}
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-text-2">Documents</span>
      </div>
      <PageHeader
        title="Documents"
        description={dealName}
        actions={
          <Button onClick={() => setAdding({})} data-testid="add-document">
            Add a document
          </Button>
        }
      />
      <Card className="overflow-x-auto p-0">
        {documents.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-text-2">
            No documents yet. Add the agreement, the contract and what comes after; each keeps its
            versions.
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-[13.5px]" data-testid="documents-table">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-3">
                <th className="px-5 py-2.5 font-semibold">Document</th>
                <th className="px-3 py-2.5 font-semibold">Kind</th>
                <th className="px-3 py-2.5 font-semibold">Version</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                {envelopes.length ? <th className="px-3 py-2.5 font-semibold">Signing</th> : null}
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => {
                const f = fileById.get(d.fileId);
                const of = versions.get(d.lineageId) ?? d.version;
                const closed = d.status === 'void' || d.status === 'superseded';
                return (
                  <tr
                    key={d.documentId}
                    className="border-t border-border align-middle"
                    data-testid={`document-${d.documentId}`}
                  >
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 text-left hover:underline disabled:no-underline"
                        disabled={!f}
                        onClick={() => f && openFile(f).catch((e: Error) => toast.error(e.message))}
                      >
                        <FileText className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                        <span className={closed ? 'text-text-2' : ''}>{d.title}</span>
                      </button>
                    </td>
                    <td className="px-3 py-3">{d.kindLabel}</td>
                    <td className="px-3 py-3 tabular-nums">
                      {of > 1 ? `v${d.version} of ${of}` : `v${d.version}`}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          variant={
                            d.status === 'signed'
                              ? 'ok'
                              : d.status === 'sent'
                                ? 'pending'
                                : d.status === 'void'
                                  ? 'danger'
                                  : 'gray'
                          }
                        >
                          {d.locked ? <Lock className="h-3 w-3" strokeWidth={2} /> : null}
                          {STATUS_WORDS[d.status]}
                        </Badge>
                        {d.controlling && of > 1 ? (
                          <Badge variant="accent">The one that counts</Badge>
                        ) : null}
                        <ReadBadge
                          read={readOf.get(d.documentId)}
                          href={(id) => dealHref(workspaceId, dealId, `contract/${id}`)}
                        />
                      </div>
                      {d.voidReason ? (
                        <div className="mt-1 text-[12px] text-text-3">{d.voidReason}</div>
                      ) : null}
                    </td>
                    {envelopes.length ? (
                      <td className="max-w-[260px] px-3 py-3 text-[12.5px]">
                        {envelopeOf.get(d.documentId) ? (
                          <button
                            type="button"
                            className="text-left text-text-2 hover:text-text hover:underline"
                            onClick={() => setPanel(envelopeOf.get(d.documentId)!.id)}
                            data-testid={`signing-${d.documentId}`}
                          >
                            <span className="font-medium text-text">
                              {envelopeOf.get(d.documentId)!.providerLabel}
                            </span>{' '}
                            · {signingLine(envelopeOf.get(d.documentId)!)}
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      {(d.status === 'draft' || d.status === 'sent') &&
                      // Out at DocuSign or Dotloop: it's signed there, not marked here.
                      !['preparing', 'draft', 'sent'].includes(
                        envelopeOf.get(d.documentId)?.state ?? '',
                      ) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `sign-${d.documentId}`}
                          onClick={() =>
                            confirm(
                              `Mark “${d.title}” signed? It’s then kept for good: nobody can delete or rename it.`,
                            ) &&
                            void run(
                              `sign-${d.documentId}`,
                              'mark_signed',
                              d.documentId,
                              'Marked signed. It’s kept for good.',
                            )
                          }
                          data-testid={`sign-${d.documentId}`}
                        >
                          Mark signed
                        </Button>
                      ) : null}
                      {!closed ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" aria-label={`More for ${d.title}`}>
                              More
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {esign && (d.status === 'draft' || d.status === 'sent') ? (
                              <DropdownMenuItem
                                onSelect={() => setSigning(d)}
                                data-testid={`send-signing-${d.documentId}`}
                              >
                                Send for signing…
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onSelect={() => setAdding({ supersedes: d })}>
                              Add a newer version…
                            </DropdownMenuItem>
                            {READ_KINDS.has(d.kind) ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  void act(
                                    `read-${d.documentId}`,
                                    async () =>
                                      unwrap(
                                        await apiBrowser().POST(
                                          '/v1/commands/realestate.document.read',
                                          { body: { workspaceId, documentId: d.documentId } },
                                        ),
                                      ),
                                    'Reading it again. Its values show here in a minute or two.',
                                  )
                                }
                                data-testid={`read-again-${d.documentId}`}
                              >
                                Read it again
                              </DropdownMenuItem>
                            ) : null}
                            {!d.controlling ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  void run(
                                    `ctl-${d.documentId}`,
                                    'set_controlling',
                                    d.documentId,
                                    'Marked as the one that counts.',
                                  )
                                }
                              >
                                Make it the one that counts
                              </DropdownMenuItem>
                            ) : null}
                            {d.status !== 'signed' ? (
                              <DropdownMenuItem danger onSelect={() => setVoiding(d)}>
                                Void…
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {loose.length ? (
        <Card className="mt-4 p-4 md:p-5">
          <h2 className="mb-2 text-[15px] font-semibold">Other files on this deal</h2>
          <ul className="space-y-1.5">
            {loose.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 text-[13.5px]">
                <button
                  type="button"
                  className="truncate text-left hover:underline"
                  onClick={() => openFile(f).catch((e: Error) => toast.error(e.message))}
                >
                  {f.name}
                </button>
                <Button size="sm" variant="ghost" onClick={() => setAdding({ fileId: f.id })}>
                  File it as a document
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mt-4 flex items-start gap-3 p-4 md:p-5">
        <Lock className="mt-0.5 h-4 w-4 flex-none text-success" strokeWidth={1.75} />
        <div className="text-[13px] text-text-2">
          <div className="font-semibold text-text">Signed documents are kept for good</div>
          Nobody can delete or rename a signed document, owners included. To change one, add the
          newer version and mark it as the one that counts; the old one stays in the history. Each
          file’s fingerprint (SHA-256) is recorded when it arrives.
        </div>
      </Card>

      <AddDocumentDialog
        open={adding !== null}
        onOpenChange={(o) => !o && setAdding(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        start={adding}
        files={loose}
      />
      {esign ? (
        <SendForSigningDialog
          workspaceId={workspaceId}
          document={signing}
          connected={esign.connected}
          people={people}
          onClose={() => setSigning(null)}
          onPrepared={(id) => {
            setSigning(null);
            setPanel(id);
          }}
        />
      ) : null}
      <EnvelopePanel
        workspaceId={workspaceId}
        envelope={shownEnvelope}
        onClose={() => setPanel(null)}
      />
      <ReasonDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title={voiding ? `Void “${voiding.title}”?` : 'Void'}
        description="It stays in the list, marked void, and stops counting as proof."
        submit="Void it"
        danger
        done="Voided."
        run={async (reason) =>
          voiding &&
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.document.void', {
              body: { workspaceId, documentId: voiding.documentId, reason },
            }),
          )
        }
      />
    </div>
  );
}

/** The kinds read as they're added: a contract, an amendment, an addendum. */
const READ_KINDS: ReadonlySet<string> = new Set(['contract', 'amendment', 'addendum']);

/** Where a document's reading stands: being read, values to confirm, all confirmed, or couldn't be read. */
function ReadBadge({
  read,
  href,
}: {
  read: ContractReadRow | undefined;
  href: (readId: string) => string;
}) {
  if (!read) return null;
  if (read.state === 'reading')
    return (
      <Badge variant="gray" data-testid="document-reading">
        Reading…
      </Badge>
    );
  if (read.state === 'failed')
    return (
      <Link href={href(read.readId)} data-testid="document-read-failed">
        <Badge variant="danger">Couldn’t read it</Badge>
      </Link>
    );
  return (
    <Link href={href(read.readId)} data-testid="document-read">
      {read.waiting ? (
        <Badge variant="pending">
          {read.waiting} {read.waiting === 1 ? 'value' : 'values'} to confirm
        </Badge>
      ) : (
        <Badge variant="ok">Read · all confirmed</Badge>
      )}
    </Link>
  );
}

function AddDocumentDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  start,
  files,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  dealId: string;
  start: { supersedes?: DealDocument; fileId?: string } | null;
  files: readonly DealFile[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState('');
  const [kind, setKind] = useState<DocumentKind>('contract');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<'draft' | 'sent'>('draft');
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setFileId(start?.fileId ?? '');
    setKind((start?.supersedes?.kind as DocumentKind | undefined) ?? 'contract');
    setTitle(start?.supersedes?.title ?? '');
    setStatus('draft');
  }, [open, start]);
  const ready = !!file || !!fileId;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={
          start?.supersedes ? `A newer version of “${start.supersedes.title}”` : 'Add a document'
        }
        description={
          start?.supersedes
            ? 'It becomes the one that counts once it’s signed, or when you say so.'
            : undefined
        }
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'go',
              async () => {
                const id =
                  fileId ||
                  (file ? await uploadFile(workspaceId, 'custom_record', dealId, file) : '');
                if (!id) throw new Error('Pick the file first.');
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.document.add', {
                    body: {
                      workspaceId,
                      dealId,
                      fileId: id,
                      kind,
                      status,
                      ...(title.trim() ? { title: title.trim() } : {}),
                      ...(start?.supersedes ? { supersedesId: start.supersedes.documentId } : {}),
                    },
                  }),
                );
              },
              'Document added.',
            );
          }}
        >
          {start?.fileId ? null : (
            <Field
              label="The file"
              htmlFor="doc-file"
              hint="PDF, a photo or an Office file, up to 25 MB."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => input.current?.click()}>
                  {file ? 'Pick another' : 'Pick a file'}
                </Button>
                <span className="truncate text-[13px] text-text-2">
                  {file?.name ?? (fileId ? files.find((f) => f.id === fileId)?.name : '')}
                </span>
                <input
                  ref={input}
                  id="doc-file"
                  type="file"
                  className="hidden"
                  accept={ATTACHMENT_TYPES.join(',')}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setFileId('');
                    e.target.value = '';
                  }}
                  data-testid="document-file-input"
                />
              </div>
              {files.length && !file ? (
                <Select
                  className="mt-2"
                  value={fileId}
                  onChange={(e) => setFileId(e.target.value)}
                  aria-label="Or a file already on the deal"
                >
                  <option value="">Or a file already on the deal…</option>
                  {files.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              ) : null}
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" htmlFor="doc-kind">
              <Select
                id="doc-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as DocumentKind)}
                data-testid="document-kind"
              >
                {(Object.keys(DOCUMENT_KINDS) as DocumentKind[]).map((k) => (
                  <option key={k} value={k}>
                    {DOCUMENT_KINDS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Where it stands" htmlFor="doc-status">
              <Select
                id="doc-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as 'draft' | 'sent')}
              >
                <option value="draft">Received or drafted</option>
                <option value="sent">Sent for signatures</option>
              </Select>
            </Field>
          </div>
          <Field
            label="Title (optional)"
            htmlFor="doc-title"
            hint="Its kind, unless you name it: “Amendment 1: closing to Oct 14”."
          >
            <Input
              id="doc-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'go'}
              disabled={!ready}
              data-testid="document-save"
            >
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
