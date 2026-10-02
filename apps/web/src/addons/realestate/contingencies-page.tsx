'use client';
/**
 * A deal's contingencies (board 52, design/realestate/Contingencies.dc.html): each with the date it ends, where it
 * stands, and how it ended. They come from the accepted offer and the contract, or the agent adds one; each ends on
 * its key date, so moving the date moves it. The agent records how one ended with the signed form (Chris,
 * 2026-10-02); an owner or admin may record it without the form, with a reason that's kept. The client sees each
 * one, and how it ended, in their portal.
 */
import { fmtMonthDay } from '@hfos/core';
import {
  CONTINGENCY_KINDS,
  inSentence,
  type ContingencyEnding,
  type ContingencyKind,
} from '@hfos/core/addons/realestate/contingencies';
import { FileText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { uploadFile } from '@/components/files/upload-zone';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { DealCrumb, firstNames } from './buyer-bits';
import { openFile, type DealFile } from './documents-page';
import type { Contingencies, Contingency, DealDocument, DealGet } from './types';
import { useAct } from './use-act';

const thisYear = new Date().getFullYear();

const SOURCE_WORDS: Readonly<Record<Contingency['source'], string>> = {
  offer: 'From the accepted offer',
  contract: 'From the contract',
  typed: 'Added on this deal',
};

const ENDINGS: readonly { readonly how: ContingencyEnding; readonly label: string }[] = [
  { how: 'satisfied', label: 'Satisfied' },
  { how: 'waived', label: 'Waived' },
  { how: 'expired', label: 'Expired' },
];

export function ContingenciesPage({
  workspaceId,
  deal,
  list,
  documents,
  files,
}: {
  workspaceId: string;
  deal: DealGet;
  list: Contingencies;
  documents: readonly DealDocument[];
  files: readonly DealFile[];
}) {
  useLiveRefresh(['custom_record']);
  const [recording, setRecording] = useState<Contingency | null>(null);
  const [adding, setAdding] = useState(false);
  const d = deal.deal;
  const dealId = d.dealId;
  const live = !d.outcome && !d.archived;
  const items = list.contingencies;
  const open = items.filter((c) => c.state === 'open');
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const docById = useMemo(() => new Map(documents.map((x) => [x.documentId, x])), [documents]);
  const clients = firstNames(deal.parties.filter((p) => p.role === 'client').map((p) => p.name));
  // The one to act on first: past its end, then ending soonest.
  const urgent =
    open.find((c) => c.clock === 'passed') ??
    open
      .filter((c) => c.clock === 'ending')
      .sort((a, b) => (a.endsOn ?? '').localeCompare(b.endsOn ?? ''))[0];

  return (
    <div data-testid="realestate-contingencies">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={d.name} here="Contingencies" />
      <PageHeader
        title="Contingencies"
        description={[
          deal.property?.address,
          `${open.length} open`,
          items.length - open.length ? `${items.length - open.length} ended` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          live ? (
            <Button
              variant="secondary"
              onClick={() => setAdding(true)}
              data-testid="contingency-add"
            >
              Add a contingency
            </Button>
          ) : null
        }
      />

      {urgent && live ? (
        <Callout
          tone={urgent.clock === 'passed' ? 'danger' : 'warning'}
          className="mb-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => setRecording(urgent)}>
              Record it
            </Button>
          }
        >
          <div className="font-medium">
            {urgent.clock === 'passed'
              ? `The ${inSentence(urgent.label)} contingency ended ${urgent.endsOn ? fmtMonthDay(urgent.endsOn, thisYear) : ''}, and nothing is recorded`
              : `The ${inSentence(urgent.label)} contingency ${urgent.stateWords.replace(/^Open · /, '').toLowerCase()}`}
          </div>
          <div>
            {urgent.clock === 'passed'
              ? 'Record whether it was satisfied, waived or expired, with the signed form. It’s red on the deal until you do.'
              : `Record whether ${clients || 'the clients'} keep going, with the signed form, before it ends. After that it’s red on the deal until you do.`}
          </div>
        </Callout>
      ) : null}

      <Card className="overflow-x-auto p-0">
        {items.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-text-2">
            None yet. They come from the accepted offer and the contract once their end dates are
            in, or add one.
          </p>
        ) : (
          <table className="w-full min-w-[680px] text-[13.5px]" data-testid="contingencies-table">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-3">
                <th className="px-5 py-2.5 font-semibold">Contingency</th>
                <th className="px-3 py-2.5 font-semibold">End</th>
                <th className="px-3 py-2.5 font-semibold">Where it stands</th>
                <th className="px-3 py-2.5 font-semibold">Proof</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const doc = c.document ? docById.get(c.document.id) : undefined;
                const file = doc ? fileById.get(doc.fileId) : undefined;
                return (
                  <tr
                    key={c.id}
                    className="border-t border-border align-top"
                    data-testid="contingency-row"
                    data-kind={c.kind}
                    data-state={c.state}
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium">{c.label}</div>
                      <div className="text-[12.5px] text-text-3">
                        {c.note && c.state !== 'open' ? c.note : SOURCE_WORDS[c.source]}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                      {c.endsOn ? fmtMonthDay(c.endsOn, thisYear) : '—'}
                      {c.endsOn && !c.endConfirmed ? (
                        <div className="text-[12px] text-text-3">not confirmed</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <Badge
                        variant={
                          c.state === 'open'
                            ? c.clock === 'passed'
                              ? 'danger'
                              : c.clock === 'ending'
                                ? 'pending'
                                : 'gray'
                            : c.state === 'expired'
                              ? 'gray'
                              : 'ok'
                        }
                      >
                        {c.stateWords}
                      </Badge>
                      {c.resolvedByName ? (
                        <div className="mt-1 text-[12px] text-text-3">by {c.resolvedByName}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      {c.document ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 text-left hover:underline disabled:no-underline"
                          disabled={!file}
                          onClick={() =>
                            file && openFile(file).catch((e: Error) => toast.error(e.message))
                          }
                        >
                          <FileText className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                          {c.document.title}
                        </button>
                      ) : c.overrideReason ? (
                        <span className="text-text-2">Without the form: {c.overrideReason}</span>
                      ) : (
                        <span className="text-text-3">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      {c.state === 'open' && live ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setRecording(c)}
                          data-testid="contingency-record"
                        >
                          Record how it ended
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-[12.5px] text-text-3">
        Each ends on its date under Key dates, so moving the date moves it.{' '}
        {clients ? `${clients} see` : 'The clients see'} each one, and how it ended, in their
        portal.
      </p>

      <RecordDialog
        open={recording !== null}
        onOpenChange={(o) => !o && setRecording(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        contingency={recording}
        documents={documents.filter((x) => x.status !== 'void' && x.status !== 'superseded')}
        canExcept={list.can.except}
      />
      <AddDialog
        open={adding}
        onOpenChange={setAdding}
        workspaceId={workspaceId}
        dealId={dealId}
        have={items}
      />
    </div>
  );
}

/** How it ended: satisfied, waived or expired, with the signed form, or (owners and admins) a reason instead. */
function RecordDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  contingency,
  documents,
  canExcept,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  contingency: Contingency | null;
  documents: readonly DealDocument[];
  canExcept: boolean;
}) {
  const [how, setHow] = useState<ContingencyEnding>('satisfied');
  const [documentId, setDocumentId] = useState('');
  const [note, setNote] = useState('');
  const [without, setWithout] = useState(false);
  const [reason, setReason] = useState('');
  const [added, setAdded] = useState<{ id: string; title: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  const upload = useAct();
  useEffect(() => {
    if (!open) return;
    setHow('satisfied');
    setDocumentId('');
    setNote('');
    setWithout(false);
    setReason('');
    setAdded(null);
  }, [open]);
  if (!contingency) return null;
  const label = contingency.label;
  const api = apiBrowser();

  // The signed form, added to the deal's documents and kept for good.
  const addForm = (file: File) =>
    upload.act(
      'upload',
      async () => {
        const fileId = await uploadFile(workspaceId, 'custom_record', dealId, file);
        const made = unwrap(
          await api.POST('/v1/commands/realestate.document.add', {
            body: {
              workspaceId,
              dealId,
              fileId,
              kind: 'other',
              title: `${label}: signed form`,
              status: 'sent',
            },
          }),
        );
        unwrap(
          await api.POST('/v1/commands/realestate.document.mark_signed', {
            body: { workspaceId, documentId: made.documentId },
          }),
        );
        setAdded({ id: made.documentId, title: `${label}: signed form` });
        setDocumentId(made.documentId);
      },
      'Added to Documents, signed and kept.',
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record how it ended"
        description={`The ${inSentence(label)} contingency. The clients see how it ended in their portal.`}
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'record',
              async () =>
                unwrap(
                  await api.POST('/v1/commands/realestate.contingency.resolve', {
                    body: {
                      workspaceId,
                      contingencyId: contingency.id,
                      how,
                      ...(without ? { reason: reason.trim() } : { documentId }),
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                  }),
                ),
              'Recorded.',
            );
          }}
          data-testid="contingency-record-form"
        >
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">What happened</legend>
            <div className="flex flex-wrap gap-2">
              {ENDINGS.map((e) => (
                <label
                  key={e.how}
                  className={cn(
                    'inline-flex cursor-pointer items-center rounded-control border px-3 py-1.5 text-[13px]',
                    how === e.how
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-border text-text-2',
                  )}
                >
                  <input
                    type="radio"
                    name="contingency-how"
                    className="sr-only"
                    checked={how === e.how}
                    onChange={() => setHow(e.how)}
                    data-testid={`contingency-how-${e.how}`}
                  />
                  {e.label}
                </label>
              ))}
            </div>
          </fieldset>
          {without ? (
            <Field
              label="Why there’s no form"
              htmlFor="contingency-reason"
              hint="Kept with your name in the deal’s history."
              error={errors.reason}
            >
              <Textarea
                id="contingency-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="min-h-[72px]"
              />
            </Field>
          ) : (
            <Field
              label="The signed form"
              htmlFor="contingency-doc"
              hint="One of the deal’s documents, or add it here."
              error={errors.documentId}
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  id="contingency-doc"
                  value={documentId}
                  onChange={(e) => setDocumentId(e.target.value)}
                  className="min-w-0 flex-1"
                  data-testid="contingency-doc"
                >
                  <option value="">Pick a document</option>
                  {added && !documents.some((x) => x.documentId === added.id) ? (
                    <option value={added.id}>{added.title} · just added</option>
                  ) : null}
                  {documents.map((x) => (
                    <option key={x.documentId} value={x.documentId}>
                      {x.title} · {x.kindLabel}
                      {x.status === 'signed' ? ' · signed' : ''}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  loading={upload.busy === 'upload'}
                  onClick={() => fileInput.current?.click()}
                >
                  Add the signed form
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept="application/pdf,image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void addForm(f);
                  }}
                  data-testid="contingency-form-file"
                />
              </div>
            </Field>
          )}
          <Field label="Note for the file (optional)" htmlFor="contingency-note">
            <Input id="contingency-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {canExcept ? (
            <button
              type="button"
              className="text-[12.5px] text-text-2 hover:text-text"
              onClick={() => setWithout(!without)}
            >
              {without ? 'Use the signed form instead' : 'No form yet? Record it without the form…'}
            </button>
          ) : (
            <p className="text-[12.5px] text-text-3">
              No form yet? An owner or admin can record it with a reason, and the reason is kept.
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'record'}
              disabled={without ? !reason.trim() : !documentId}
              data-testid="contingency-record-save"
            >
              Record it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ADDABLE = Object.entries(CONTINGENCY_KINDS) as [
  ContingencyKind,
  (typeof CONTINGENCY_KINDS)[ContingencyKind],
][];

/** A contingency the offer and contract didn't bring: one of the kinds, or one the agent names. */
function AddDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  have,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  have: readonly Contingency[];
}) {
  const kinds = ADDABLE.filter(([k]) => k === 'other' || !have.some((c) => c.kind === k));
  const first = kinds[0]?.[0] ?? 'other';
  const [kind, setKind] = useState<ContingencyKind>('other');
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    setKind(first);
    setLabel('');
    setDate('');
  }, [open, first]);
  const other = kind === 'other';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a contingency"
        description="It ends on its date, and turns the deal yellow two business days before."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'add',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.contingency.add', {
                    body: {
                      workspaceId,
                      dealId,
                      kind,
                      ...(other ? { label: label.trim(), endsOn: date } : date ? { date } : {}),
                    },
                  }),
                ),
              'Added.',
            );
          }}
          data-testid="contingency-add-form"
        >
          <Field label="Which" htmlFor="contingency-kind" error={errors.kind}>
            <Select
              id="contingency-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as ContingencyKind)}
              data-testid="contingency-kind"
            >
              {kinds.map(([k, v]) => (
                <option key={k} value={k}>
                  {k === 'other' ? 'Another one, named here' : v.label}
                </option>
              ))}
            </Select>
          </Field>
          {other ? (
            <Field label="What it is" htmlFor="contingency-label" error={errors.label}>
              <Input
                id="contingency-label"
                value={label}
                placeholder="Septic inspection"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          ) : null}
          <Field
            label={other ? 'When it ends' : 'When it ends (if it isn’t under Key dates yet)'}
            htmlFor="contingency-date"
            hint={other ? undefined : 'Entered on Key dates, confirmed. Already there? Leave it.'}
            error={errors.endsOn ?? errors.date}
          >
            <Input
              id="contingency-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'add'}
              disabled={other && (!label.trim() || !date)}
              data-testid="contingency-add-save"
            >
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
