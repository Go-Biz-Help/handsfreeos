'use client';
import {
  addDays,
  dayLabel,
  depositProblem,
  dueDateFor,
  lineSubtotalCents,
  localDateOf,
  localInstant,
  money,
  TERMS_DAYS,
  TERMS_OPTIONS,
  TERMS_WORDS,
  type MoneySettings,
  type PaymentTerms,
} from '@hfos/core';
import { AlertTriangle, Boxes, Info, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow, ProductRow } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { connectionLabel, SendDialog, VoidDialog } from './document-actions';
import {
  accountsFor,
  depositTerms,
  draftBody,
  draftProblem,
  draftTotals,
  firstAccount,
  newLine,
  type DocumentDraft,
  type DraftLine,
} from './draft';
import { unitWord } from './document-view';
import { LineSheet } from './line-sheet';
import { MoneyInput, PercentInput, QuantityInput } from './money-input';
import { PersonPicker } from './person-picker';
import { blankLine, ProductPicker, type PickedProduct } from './product-picker';
import { StatusBadge } from './status-badge';
import { MoneyNote, percentLabel, TotalRow } from './totals';

const GRID = 'grid-cols-[minmax(0,1fr)_78px_104px_44px_96px_32px]';
/** The canvas is drawn at 1440: below that the totals column sits under the lines rather than squeezing them. */
const SPLIT = 'grid grid-cols-1 items-start gap-5 min-[1360px]:grid-cols-[minmax(0,1fr)_340px]';

export interface DocumentEditorProps {
  workspaceId: string;
  kind: 'estimate' | 'invoice';
  /** Null for a document that has not been created yet. */
  documentId: string | null;
  revision: number;
  initial: DocumentDraft;
  settings: MoneySettings;
  products: readonly ProductRow[];
  connections: readonly PaymentConnectionRow[];
  timeZone: string;
  /** What the next number will be, so the editor can show it before the number is taken. */
  nextNumber: string;
  startedBy?: string | null;
  startedAt?: string | null;
}

/**
 * The one editor both documents share. It saves the whole document against the revision it loaded, the way the
 * calendar builder saves a calendar: a save that lands on someone else's work is refused rather than silently
 * winning, and the banner offers their version.
 */
export function DocumentEditor(props: DocumentEditorProps) {
  const {
    workspaceId,
    kind,
    settings,
    products,
    connections,
    timeZone,
    nextNumber,
    revision,
    initial,
  } = props;
  const router = useRouter();
  const [documentId, setDocumentId] = useState(props.documentId);
  const [edit, setEdit] = useState(() => ({ rev: revision, draft: initial }));
  const [draft, setDraft] = useState<DocumentDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [sending, setSending] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [picker, setPicker] = useState(false);
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [openTotals, setOpenTotals] = useState(false);
  const [wantsTheirs, setWantsTheirs] = useState(false);
  /**
   * The phone's sticky totals bar grows when the totals are opened, so a spacer of a fixed height would let
   * it cover the last line of the sheet. It is measured instead, and the spacer is whatever it really is.
   */
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const measure = () => setBarHeight(bar.offsetHeight);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(bar);
    return () => watch.disconnect();
  }, [bar]);

  // The accounts this person may bill into, and the one the invoice was opened with (0102).
  const payable = useMemo(
    () => accountsFor(connections, initial.connectionId),
    [connections, initial.connectionId],
  );
  const theirs = firstAccount(connections);

  const set = (patch: Partial<DocumentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    }));
  const removeLine = (key: string) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }));
  const addLine = (picked: PickedProduct) =>
    setDraft((d) => ({
      ...d,
      lines: [
        ...d.lines,
        newLine({
          productId: picked.productId,
          name: picked.name,
          description: picked.description ?? '',
          unitPriceCents: picked.unitPriceCents,
          unitLabel: picked.unitLabel,
          taxable: picked.taxable,
        }),
      ],
    }));

  const totals = useMemo(() => draftTotals(draft, settings), [draft, settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(edit.draft);
  const problem = draftProblem(draft);
  const depositIssue =
    kind === 'estimate' ? depositProblem(depositTerms(draft), totals.totalCents) : null;
  // Only a document this page was loaded with can go stale: a draft created here has no server props behind it.
  const stale = props.documentId !== null && props.documentId === documentId && revision > edit.rev;
  const taxed = settings.tax.rateBp > 0;
  const today = localDateOf(Date.now(), timeZone);
  const expiresOn = draft.expiresOn ?? addDays(today, settings.estimateGoodForDays);
  const sheetLine = draft.lines.find((l) => l.key === sheetKey) ?? null;

  // "Load their version" waits for the refresh to land rather than adopting whatever was on screen when it
  // was pressed, so the button is honest however slow the round trip is.
  useEffect(() => {
    if (!wantsTheirs || revision <= edit.rev) return;
    setEdit({ rev: revision, draft: initial });
    setDraft(initial);
    setConflict(false);
    setWantsTheirs(false);
  }, [wantsTheirs, revision, edit.rev, initial]);

  /** Creates the document the first time, then updates it whole against the revision it loaded. */
  async function save(): Promise<string | null> {
    if (problem) {
      toast.error(problem);
      return null;
    }
    if (depositIssue) {
      toast.error(depositIssue);
      return null;
    }
    setSaving(true);
    try {
      const header = draftBody(draft, workspaceId);
      if (kind === 'estimate') {
        const ends = { deposit: depositTerms(draft), expiresOn: draft.expiresOn };
        const out = documentId
          ? unwrap(
              await apiBrowser().POST('/v1/commands/estimate.update', {
                body: { ...header, ...ends, estimateId: documentId, baseRevision: edit.rev },
              }),
            )
          : unwrap(
              await apiBrowser().POST('/v1/commands/estimate.create', {
                body: { ...header, ...ends },
              }),
            );
        settle(out.estimateId, out.revision);
        return out.estimateId;
      }
      const ends = {
        connectionId: draft.connectionId,
        dueOn: draft.dueOn,
        terms: draft.terms,
      };
      const out = documentId
        ? unwrap(
            await apiBrowser().POST('/v1/commands/invoice.update', {
              body: { ...header, ...ends, invoiceId: documentId, baseRevision: edit.rev },
            }),
          )
        : unwrap(
            await apiBrowser().POST('/v1/commands/invoice.create', {
              body: { ...header, ...ends },
            }),
          );
      settle(out.invoiceId, out.revision);
      return out.invoiceId;
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'document_conflict') {
        // The banner offers the server's version, which only exists for a document this page was loaded with.
        if (props.documentId === null) toast.error(`${e.message} Reload the page to see them.`);
        else {
          setConflict(true);
          router.refresh();
        }
        return null;
      }
      if (e instanceof ApiError && e.rule === 'money_document_issued') {
        toast.error(e.message);
        router.refresh();
        return null;
      }
      toast.error(errorMessage(e));
      return null;
    } finally {
      setSaving(false);
    }
  }

  /**
   * A save landed. The first one also claims the document's own address — swapped in without a navigation, so
   * a half-written line, an open dialog and the cursor all survive the moment the draft becomes real.
   */
  function settle(id: string, rev: number) {
    setEdit({ rev, draft: { ...draft } });
    setSavedAt(Date.now());
    setConflict(false);
    if (documentId === null) {
      setDocumentId(id);
      window.history.replaceState(
        null,
        '',
        `/app/w/${workspaceId}/money/${kind === 'estimate' ? 'estimates' : 'invoices'}/${id}`,
      );
      return;
    }
    router.refresh();
  }

  async function saveThenSend() {
    const id = dirty || !documentId ? await save() : documentId;
    if (id) setSending(true);
  }

  /** Everything above the total: what the phone's bar shows when it is opened, under its own big Total. */
  const totalsBreakdown = (
    <>
      <TotalRow label="Subtotal" value={money(totals.lineSubtotalCents)} testId="totals-subtotal" />
      {totals.discountCents > 0 ? (
        <TotalRow
          label={
            draft.discountKind === 'percent'
              ? `${percentLabel(draft.discountPercentBp)} off, before tax`
              : 'Off the whole job, before tax'
          }
          value={`−${money(totals.discountCents)}`}
          credit
          testId="totals-discount"
        />
      ) : null}
      {taxed ? (
        <TotalRow
          label={`${settings.tax.name} · ${percentLabel(settings.tax.rateBp)} on ${money(totals.taxableBaseCents)}`}
          value={money(totals.taxCents)}
          testId="totals-tax"
        />
      ) : null}
    </>
  );
  const totalsBlock = (
    <>
      {totalsBreakdown}
      <TotalRow label="Total" value={money(totals.totalCents)} big testId="totals-total" />
    </>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
              {kind === 'estimate' ? 'Estimate' : 'Invoice'}
              {draft.person ? ` for ${draft.person.fullName}` : ''}
            </h1>
            <StatusBadge kind={kind} state="draft" testId="document-status" />
          </div>
          <p className="mt-1 text-[13px] text-text-2" data-testid="document-saved">
            {props.startedBy ? `Started by ${props.startedBy}` : 'New'}
            {props.startedAt ? ` · ${dayLabel(Date.parse(props.startedAt), timeZone)}` : ''}
            {dirty ? ' · not saved yet' : savedAt ? ' · all changes saved' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:hidden">
          <Button
            variant="secondary"
            loading={saving}
            disabled={!dirty && !!documentId}
            onClick={() => void save()}
            data-testid="document-save"
          >
            Save draft
          </Button>
          <Button
            loading={saving && sending}
            disabled={!!problem}
            onClick={() => void saveThenSend()}
            data-testid="document-send"
          >
            Send
          </Button>
          {documentId ? (
            <Button variant="ghost" onClick={() => setVoiding(true)} data-testid="document-void">
              Void
            </Button>
          ) : null}
        </div>
      </div>

      {stale || conflict ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
          <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
          <span className="flex-1">
            Someone saved this {kind} while you were editing. Saving now would be refused.
          </span>
          <Button
            variant="secondary"
            size="sm"
            data-testid="document-reload"
            onClick={() => {
              setWantsTheirs(true);
              router.refresh();
            }}
          >
            Load their version
          </Button>
        </div>
      ) : null}

      <div className={SPLIT}>
        <div className="flex min-w-0 flex-col gap-4">
          {/* Who it is for */}
          <Card className="px-5 py-2">
            <Row label="Customer">
              {draft.person ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar name={draft.person.fullName} seed={draft.person.id} size="sm" />
                  <span className="truncate font-semibold">{draft.person.fullName}</span>
                  <span className="truncate text-xs text-text-3">
                    {[draft.person.email, draft.person.phone].filter(Boolean).join(' · ')}
                  </span>
                  <button
                    type="button"
                    className="ml-auto flex-none text-[13px] font-medium text-accent-text hover:underline"
                    onClick={() => set({ person: null, personId: '' })}
                  >
                    Change
                  </button>
                </span>
              ) : (
                <PersonPicker
                  workspaceId={workspaceId}
                  autoFocus={!props.documentId}
                  onPick={(p) => set({ person: p, personId: p.id })}
                />
              )}
            </Row>
            <Row label="What it is for">
              <Input
                inputSize="sm"
                value={draft.title}
                maxLength={200}
                autoComplete="off"
                placeholder="New AC install"
                aria-label="What it is for"
                onChange={(e) => set({ title: e.target.value })}
                data-testid="document-title"
              />
              {draft.leadId ? (
                <Link
                  href={`/app/w/${workspaceId}/leads/${draft.leadId}`}
                  className="flex-none text-[13px] font-medium text-accent-text hover:underline"
                >
                  Open the lead
                </Link>
              ) : null}
            </Row>
            <Row label="Paid into">
              {kind === 'invoice' && payable.length > 0 ? (
                <Select
                  selectSize="sm"
                  aria-label="Paid into"
                  value={draft.connectionId ?? ''}
                  onChange={(e) => set({ connectionId: e.target.value || null })}
                  data-testid="document-connection"
                >
                  {payable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {connectionLabel(c)}
                      {c.isDefault ? ' · default' : ''}
                      {c.usableByMe ? '' : ' · not yours'}
                    </option>
                  ))}
                </Select>
              ) : theirs ? (
                <span className="flex flex-1 items-center gap-2 text-[13px]">
                  <span className="font-semibold">{connectionLabel(theirs)}</span>
                  {theirs.isDefault ? <Badge variant="owner">Default</Badge> : null}
                  <span className="text-text-3">Chosen when you turn this into an invoice.</span>
                </span>
              ) : connections.length > 0 ? (
                <span className="flex-1 text-[13px] text-text-3" data-testid="document-no-account">
                  None of the connected accounts is yours to bill into.{' '}
                  <Link
                    href={`/app/w/${workspaceId}/settings/payments`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    See who uses them
                  </Link>
                </span>
              ) : (
                <span className="flex-1 text-[13px] text-text-3">
                  No account connected yet.{' '}
                  <Link
                    href={`/app/w/${workspaceId}/settings/payments`}
                    className="font-medium text-accent-text hover:underline"
                  >
                    Connect one
                  </Link>{' '}
                  to take card and bank payments.
                </span>
              )}
            </Row>
          </Card>

          {/* The lines */}
          <Card className="px-5 pb-5 pt-4" data-testid="document-lines">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold tracking-tight">Lines</h2>
              <span className="text-[13px] text-text-3">
                Prices come from Products. Changing one here changes only this {kind}.
              </span>
            </div>

            {/* Desk: a row each */}
            <div className="max-md:hidden">
              <div
                className={cn(
                  'grid gap-2.5 pb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3',
                  GRID,
                )}
              >
                <span>Item</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Price</span>
                <span className="text-center">{taxed ? 'Tax' : ''}</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              {draft.lines.map((line) => (
                <div
                  key={line.key}
                  className={cn('grid items-center gap-2.5 border-t border-border py-2', GRID)}
                  data-testid={`line-row-${line.name || 'new'}`}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <Input
                      inputSize="sm"
                      value={line.name}
                      maxLength={200}
                      autoComplete="off"
                      aria-label="What it is"
                      placeholder="What it is"
                      onChange={(e) => setLine(line.key, { name: e.target.value })}
                    />
                    <Input
                      inputSize="sm"
                      value={line.description}
                      maxLength={2_000}
                      autoComplete="off"
                      aria-label="Description"
                      placeholder="Description (optional)"
                      className="h-6 border-0 bg-transparent px-0.5 text-xs text-text-2 focus:ring-0"
                      onChange={(e) => setLine(line.key, { description: e.target.value })}
                    />
                    {line.discountCents > 0 ? (
                      <span className="flex items-center gap-2 px-0.5 text-xs text-success-text">
                        −{money(line.discountCents)} off this line
                        <button
                          type="button"
                          className="text-text-3 hover:underline"
                          onClick={() => setLine(line.key, { discountCents: 0 })}
                        >
                          undo
                        </button>
                      </span>
                    ) : null}
                  </span>
                  <QuantityInput
                    value={line.quantity}
                    aria-label="How many"
                    inputSize="sm"
                    onChange={(quantity) => setLine(line.key, { quantity })}
                  />
                  <MoneyInput
                    valueCents={line.unitPriceCents}
                    aria-label="Price"
                    inputSize="sm"
                    onChange={(unitPriceCents) => setLine(line.key, { unitPriceCents })}
                  />
                  <span className="flex justify-center">
                    {taxed ? (
                      <Switch
                        checked={line.taxable}
                        label={`Sales tax on ${line.name || 'this line'}`}
                        onChange={(taxable) => setLine(line.key, { taxable })}
                      />
                    ) : null}
                  </span>
                  <span className="text-right text-[13.5px] font-semibold tabular-nums">
                    {money(lineSubtotalCents(line))}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${line.name || 'this line'}`}
                    onClick={() => removeLine(line.key)}
                    className="flex h-8 w-8 items-center justify-center rounded-control text-text-3 hover:bg-card-2 hover:text-danger-text"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>

            {/* Phone: a card each, with the full editor a tap away */}
            <ul className="flex flex-col gap-2.5 md:hidden">
              {draft.lines.map((line) => (
                <li
                  key={line.key}
                  className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 shadow-1"
                  data-testid={`line-card-${line.name || 'new'}`}
                >
                  <span className="flex items-start gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[15px] font-semibold leading-[1.3]">
                        {line.name || 'A new line'}
                      </span>
                      {line.description ? (
                        <span className="truncate text-xs text-text-3">{line.description}</span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${line.name || 'this line'}`}
                      onClick={() => removeLine(line.key)}
                      className="flex h-11 w-11 flex-none items-center justify-center rounded-control text-text-3"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                  </span>
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-text-2">
                      {line.quantity} {unitWord(line.quantity, line.unitLabel)} ×{' '}
                      {money(line.unitPriceCents)}
                    </span>
                    <span className="text-[15px] font-semibold tabular-nums">
                      {money(lineSubtotalCents(line))}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-3 border-t border-border pt-2">
                    {taxed ? (
                      <span
                        className={cn(
                          'inline-flex h-[22px] items-center rounded-control px-2 text-xs font-semibold',
                          line.taxable
                            ? 'bg-success-soft text-success-text'
                            : 'bg-card-2 text-text-2',
                        )}
                      >
                        {line.taxable ? 'Taxable' : 'No tax'}
                      </span>
                    ) : (
                      <span />
                    )}
                    <Button
                      variant="ghost"
                      size="lg"
                      onClick={() => setSheetKey(line.key)}
                      data-testid={`line-edit-${line.name || 'new'}`}
                    >
                      <Pencil className="h-4 w-4" strokeWidth={1.5} />
                      Edit
                    </Button>
                  </span>
                </li>
              ))}
            </ul>

            {draft.lines.length === 0 ? (
              <p className="border-t border-border py-4 text-[13px] text-text-3">
                Nothing on it yet. Add a line, or pick one from the catalogue.
              </p>
            ) : null}

            <div className="relative mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="max-md:h-11 max-md:flex-1"
                onClick={() => addLine(blankLine(''))}
                data-testid="line-add"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                Add a line
              </Button>
              <span className="relative max-md:flex-1">
                <Button
                  variant="secondary"
                  size="sm"
                  className="max-md:h-11 max-md:w-full"
                  onClick={() => setPicker((p) => !p)}
                  data-testid="line-catalogue"
                >
                  <Boxes className="h-4 w-4" strokeWidth={1.5} />
                  Add from the catalogue
                </Button>
                <ProductPicker
                  products={products}
                  open={picker}
                  onClose={() => setPicker(false)}
                  onPick={addLine}
                />
              </span>
              <span className="flex-1 max-md:hidden" />
              <DocumentDiscount
                draft={draft}
                set={set}
                discountCents={totals.discountCents}
                className="max-md:w-full"
              />
            </div>
          </Card>

          {/* Notes */}
          <Card className="px-5 pb-5 pt-4">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold tracking-tight">
                Notes for {draft.person?.fullName.split(/\s+/)[0] ?? 'the customer'}
              </h2>
              <span className="text-[13px] text-text-3">Shown on their page and in the email</span>
            </div>
            <Textarea
              rows={3}
              value={draft.notes}
              maxLength={5_000}
              aria-label="Notes for the customer"
              onChange={(e) => set({ notes: e.target.value })}
              data-testid="document-notes-input"
            />
            <p className="mt-1.5 text-xs text-text-3">
              From Settings → Payments. Edit it here for this {kind} only.
            </p>
          </Card>
        </div>

        {/* The right-hand column: totals, deposit or terms, and what happens on Send */}
        <div className="flex flex-col gap-4">
          <Card className="px-[18px] py-4 max-md:hidden">
            <h2 className="mb-1.5 text-base font-semibold tracking-tight">Totals</h2>
            {totalsBlock}
            {taxed ? (
              <MoneyNote icon={<Info className="h-3.5 w-3.5" strokeWidth={1.75} />}>
                Tax is worked out once, over the discounted taxable lines, so the parts always add
                up to the total.
              </MoneyNote>
            ) : null}
          </Card>

          {kind === 'estimate' ? (
            <DepositCard
              draft={draft}
              set={set}
              depositCents={totals.depositCents}
              totalCents={totals.totalCents}
              problem={depositIssue}
              firstName={draft.person?.fullName.split(/\s+/)[0] ?? 'They'}
            />
          ) : (
            <TermsCard draft={draft} set={set} today={today} timeZone={timeZone} />
          )}

          <Card className="px-[18px] py-4">
            <h2 className="mb-1 text-base font-semibold tracking-tight">When you send</h2>
            <TotalRow label="Goes by" value="Text and email" />
            {kind === 'estimate' ? (
              <TotalRow
                label="Good until"
                value={`${dayLabel(localInstant(expiresOn, '12:00', timeZone), timeZone)} · ${settings.estimateGoodForDays} days`}
              />
            ) : null}
            <TotalRow
              label="Number"
              value={<span className="font-mono text-[12.5px]">{nextNumber}</span>}
            />
            <p className="mt-1.5 text-[12.5px] text-text-3">
              The number is taken the moment you press Send, so numbers stay in order and are never
              reused.
            </p>
          </Card>
        </div>
      </div>

      {/* The phone's sticky totals bar: what you are changing and what it comes to, both on screen. */}
      <div
        className="md:hidden"
        style={{ height: barHeight || 132 }}
        data-testid="phone-totals-spacer"
        aria-hidden
      />
      <div
        ref={setBar}
        className="fixed inset-x-0 bottom-[66px] z-20 flex flex-col gap-2 border-t border-border bg-card px-3.5 pb-3 pt-3 shadow-[0_-6px_18px_rgba(25,29,37,0.08)] md:hidden"
        data-testid="phone-totals-bar"
      >
        <button
          type="button"
          aria-expanded={openTotals}
          onClick={() => setOpenTotals((v) => !v)}
          className="flex items-center justify-between gap-2 px-0.5 text-left text-[13px] text-text-2"
          data-testid="phone-totals-toggle"
        >
          <span>
            Subtotal {money(totals.lineSubtotalCents)}
            {totals.discountCents > 0 ? ` · −${money(totals.discountCents)}` : ''}
            {taxed ? ` · tax ${money(totals.taxCents)}` : ''}
          </span>
          <span aria-hidden>{openTotals ? '▾' : '▴'}</span>
        </button>
        {/* Opened, the bar shows the breakdown only: its own big Total is right underneath. */}
        {openTotals ? <div className="px-0.5">{totalsBreakdown}</div> : null}
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[15px] font-semibold">Total</span>
          <span className="text-[22px] font-semibold tabular-nums" data-testid="phone-total">
            {money(totals.totalCents)}
          </span>
        </div>
        <div className="flex gap-2 pt-0.5">
          <Button
            variant="secondary"
            size="lg"
            className="flex-1"
            loading={saving && !sending}
            disabled={!dirty && !!documentId}
            onClick={() => void save()}
            data-testid="document-save-phone"
          >
            Save draft
          </Button>
          <Button
            size="lg"
            className="flex-[1.3]"
            disabled={!!problem}
            onClick={() => void saveThenSend()}
            data-testid="document-send-phone"
          >
            Send
          </Button>
        </div>
      </div>

      <LineSheet
        line={sheetLine}
        taxed={taxed}
        onClose={() => setSheetKey(null)}
        onRemove={() => {
          if (sheetKey) removeLine(sheetKey);
          setSheetKey(null);
        }}
        onSave={(line) => {
          setLine(line.key, line);
          setSheetKey(null);
        }}
      />

      {documentId && draft.person ? (
        <SendDialog
          open={sending}
          onOpenChange={setSending}
          kind={kind}
          workspaceId={workspaceId}
          documentId={documentId}
          person={draft.person}
          // A sent document is read-only, so the editor hands over to its own page — and a draft created on
          // this page needs a real navigation, because its address was swapped in rather than routed to.
          onSent={() =>
            router.replace(
              `/app/w/${workspaceId}/money/${kind === 'estimate' ? 'estimates' : 'invoices'}/${documentId}`,
            )
          }
        />
      ) : null}
      {documentId ? (
        <VoidDialog
          open={voiding}
          onOpenChange={setVoiding}
          kind={kind}
          workspaceId={workspaceId}
          documentId={documentId}
        />
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border py-2.5 first:border-t-0 md:flex-row md:items-center md:gap-3">
      <span className="flex-none text-[13px] text-text-2 md:w-[110px]">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

/** "Take off 10% = −$900.90, spread over the lines before tax". */
function DocumentDiscount({
  draft,
  set,
  discountCents,
  className,
}: {
  draft: DocumentDraft;
  set: (patch: Partial<DocumentDraft>) => void;
  discountCents: number;
  className?: string;
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-2', className)}>
      <span className="text-[13px] text-text-2">Take off</span>
      <Select
        selectSize="sm"
        className="w-[92px]"
        aria-label="How the discount is worked out"
        value={draft.discountKind}
        onChange={(e) => set({ discountKind: e.target.value as DocumentDraft['discountKind'] })}
        data-testid="discount-kind"
      >
        <option value="none">Nothing</option>
        <option value="percent">A %</option>
        <option value="amount">An amount</option>
      </Select>
      {draft.discountKind === 'percent' ? (
        <PercentInput
          inputSize="sm"
          className="w-[72px]"
          aria-label="Percent off"
          valueBp={draft.discountPercentBp}
          onChange={(discountPercentBp) => set({ discountPercentBp })}
          data-testid="discount-percent"
        />
      ) : null}
      {draft.discountKind === 'amount' ? (
        <MoneyInput
          inputSize="sm"
          className="w-[100px]"
          aria-label="Amount off"
          valueCents={draft.discountAmountCents}
          onChange={(discountAmountCents) => set({ discountAmountCents })}
          data-testid="discount-amount"
        />
      ) : null}
      {discountCents > 0 ? (
        <span className="text-[13px] text-text-3">
          = −{money(discountCents)}, spread over the lines before tax
        </span>
      ) : null}
    </span>
  );
}

function DepositCard({
  draft,
  set,
  depositCents,
  totalCents,
  problem,
  firstName,
}: {
  draft: DocumentDraft;
  set: (patch: Partial<DocumentDraft>) => void;
  depositCents: number;
  totalCents: number;
  problem: string | null;
  firstName: string;
}) {
  const on = draft.depositKind !== 'none';
  return (
    <Card className="px-[18px] py-4" data-testid="deposit-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">Deposit</h2>
        <Switch
          checked={on}
          label="Ask for a deposit"
          onChange={(next) => set({ depositKind: next ? 'percent' : 'none' })}
          testId="deposit-switch"
        />
      </div>
      {on ? (
        <>
          <div className="mt-2.5 flex items-center gap-2">
            {draft.depositKind === 'percent' ? (
              <>
                <PercentInput
                  inputSize="sm"
                  className="w-[72px]"
                  aria-label="Deposit percent"
                  valueBp={draft.depositPercentBp}
                  onChange={(depositPercentBp) => set({ depositPercentBp })}
                  data-testid="deposit-percent"
                />
                <span className="text-[13px] text-text-2">% of the total</span>
              </>
            ) : (
              <MoneyInput
                inputSize="sm"
                className="w-[120px]"
                aria-label="Deposit amount"
                valueCents={draft.depositAmountCents}
                onChange={(depositAmountCents) => set({ depositAmountCents })}
                data-testid="deposit-amount"
              />
            )}
            <span className="flex-1" />
            <span className="font-semibold tabular-nums" data-testid="deposit-amount-shown">
              {money(depositCents)}
            </span>
          </div>
          <button
            type="button"
            className="mt-1 text-[13px] text-accent-text hover:underline"
            onClick={() =>
              set({ depositKind: draft.depositKind === 'percent' ? 'amount' : 'percent' })
            }
          >
            {draft.depositKind === 'percent' ? 'Ask for an amount instead' : 'Ask for a % instead'}
          </button>
          <TotalRow
            label="Balance when the work is done"
            value={money(Math.max(0, totalCents - depositCents))}
            testId="deposit-balance"
          />
          {problem ? (
            <p className="mt-1.5 text-[12.5px] text-danger-text" role="alert">
              {problem}
            </p>
          ) : (
            <p className="mt-1.5 text-[12.5px] text-text-3">
              {firstName} pays the deposit on their own page. The balance invoice goes out when the
              job is done.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-text-3">
          Nothing is asked for up front. The whole amount is invoiced when they approve.
        </p>
      )}
    </Card>
  );
}

function TermsCard({
  draft,
  set,
  today,
  timeZone,
}: {
  draft: DocumentDraft;
  set: (patch: Partial<DocumentDraft>) => void;
  today: string;
  timeZone: string;
}) {
  const chosen = TERMS_OPTIONS.find((t) => TERMS_WORDS[t.value] === draft.terms)?.value ?? null;
  return (
    <Card className="px-[18px] py-4" data-testid="terms-card">
      <h2 className="mb-2 text-base font-semibold tracking-tight">When it is due</h2>
      <Select
        selectSize="sm"
        aria-label="When it is due"
        value={draft.dueOn ? 'date' : (chosen ?? '')}
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'date') {
            set({ dueOn: dueDateFor(chosen ?? 'net_14', today), terms: null });
            return;
          }
          set({
            terms: value ? TERMS_WORDS[value as PaymentTerms] : null,
            dueOn: null,
          });
        }}
        data-testid="terms-select"
      >
        <option value="">The business's own terms</option>
        {TERMS_OPTIONS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
        <option value="date">A date I pick</option>
      </Select>
      {draft.dueOn ? (
        <Input
          type="date"
          inputSize="sm"
          className="mt-2"
          aria-label="Due date"
          value={draft.dueOn}
          onChange={(e) => set({ dueOn: e.target.value || null })}
          data-testid="due-date"
        />
      ) : null}
      <p className="mt-1.5 text-[12.5px] text-text-3">
        {draft.dueOn
          ? `Due ${dayLabel(localInstant(draft.dueOn, '12:00', timeZone), timeZone)}.`
          : chosen
            ? TERMS_DAYS[chosen] === 0
              ? 'Due the day you send it.'
              : `Due ${TERMS_DAYS[chosen]} days after you send it.`
            : 'The due date is worked out from your terms when you send it.'}
      </p>
    </Card>
  );
}
