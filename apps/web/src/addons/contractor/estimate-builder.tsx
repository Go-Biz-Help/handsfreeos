'use client';
/**
 * The estimate builder (docs/contractor.md, "Costs and estimates"): an estimate with what it costs to do. Labor by
 * the hour, materials at cost, a markup on each line, and each option's profit and margin as it's typed. It writes an
 * ordinary HandsFreeOS estimate (its number, its link and the customer's page are core's), so it shares core's
 * editor's pieces: the customer and product pickers, the options bar, the discount and the deposit.
 *
 * An estimate under the business's lowest margin, or with labor or material lines nobody put a cost on, waits for an
 * owner's or admin's OK before it's sent (the owner's decision 6). The server decides; this page shows the same
 * figures from the same arithmetic (`@hfos/core/addons/contractor/estimating`) while someone types.
 */
import {
  checkMargin,
  COST_KINDS,
  costOption,
  defaultCostKind,
  lineCostCents,
  marginBpOf,
  markupBpOf,
  priceFromMarkup,
  type CostKind,
} from '@hfos/core/addons/contractor/estimating';
import {
  CONTRACTOR_WORDS,
  COST_KIND_HINTS,
  COST_KIND_WORDS,
  okNeededWords,
} from '@hfos/core/addons/contractor/words';
import {
  addDays,
  dayLabel,
  depositProblem,
  formatDate,
  lineSubtotalCents,
  localDateOf,
  localInstant,
  money,
  parseMoney,
  type MoneySettings,
} from '@hfos/core';
import { AlertTriangle, ArrowLeft, Boxes, Clock, Plus, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SendDialog } from '@/components/money/document-actions';
import { DepositCard, DocumentDiscount } from '@/components/money/document-editor';
import {
  addOption,
  blankDraft,
  depositTerms,
  discountTerms,
  draftOfEstimate,
  draftProblem,
  draftTotals,
  lineKey,
  newLine,
  optionLines,
  OPTIONS_MAX,
  removeOption,
  smallestTotalCents,
  withOptionLines,
  type DocumentDraft,
  type DraftLine,
} from '@/components/money/draft';
import { OptionsBar } from '@/components/money/estimate-options';
import { PercentInput, QuantityInput, MoneyInput } from '@/components/money/money-input';
import { PersonPicker } from '@/components/money/person-picker';
import { ProductPicker, type PickedProduct } from '@/components/money/product-picker';
import { StatusBadge } from '@/components/money/status-badge';
import { percentLabel, TotalRow } from '@/components/money/totals';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select, type InputProps } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ProductRow } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { contractorHref, jobHref } from './bits';
import { CheckNote, CostingRows, Margin, OptionMargins } from './costing';
import type {
  BuilderDraft,
  DraftedLine,
  EstimateBuilderData,
  Estimating,
  ItemCost,
  MarginCheck,
} from './types';

const B = CONTRACTOR_WORDS.builder;
const A = CONTRACTOR_WORDS.aiDraft;
const SPLIT = 'grid grid-cols-1 items-start gap-5 min-[1360px]:grid-cols-[minmax(0,1fr)_340px]';

/** What the builder keeps beside a line: how it's costed, what one costs, and whether its price still follows that. */
interface LineCost {
  readonly kind: CostKind;
  readonly unitCostCents: number | null;
  /** The price hasn't been typed yet, so it follows the cost at the business's starting markup. */
  readonly auto?: boolean;
  /** The AI guessed this cost (part 7): it's marked until someone changes it. */
  readonly guessed?: boolean;
}

const costOf = (line: DraftLine): LineCost => {
  const x = (line.extra ?? {}) as Partial<LineCost>;
  return {
    kind: x.kind ?? 'material',
    unitCostCents: x.unitCostCents ?? null,
    auto: x.auto,
    ...(x.guessed ? { guessed: true } : {}),
  };
};
const withCost = (cost: LineCost): Pick<DraftLine, 'extra'> => ({ extra: { ...cost } });

const costed = (line: DraftLine) => ({
  quantity: line.quantity,
  unitPriceCents: line.unitPriceCents,
  discountCents: line.discountCents,
  ...costOf(line),
});

const estimateHref = (workspaceId: string, id: string) =>
  contractorHref(workspaceId, `estimates/${id}`);
const documentHref = (workspaceId: string, id: string) =>
  `/app/w/${workspaceId}/money/estimates/${id}`;

/** A line the AI drafted, as the builder holds one: its cost beside it, marked when the cost is a guess. */
const lineFromAi = (l: DraftedLine): DraftLine =>
  newLine({
    productId: l.productId,
    name: l.name,
    description: l.description ?? '',
    quantity: l.quantity,
    unitLabel: l.unitLabel,
    unitPriceCents: l.unitPriceCents,
    taxable: l.taxable,
    ...withCost({
      kind: l.kind,
      unitCostCents: l.unitCostCents,
      ...(l.guessed ? { guessed: true } : {}),
    }),
  });

/**
 * The draft the builder opens with: the estimate as it's kept, each line with its cost; or, for a new one, the AI's
 * draft when it starts from one (nothing of it is saved until the person saves), else a blank one for the job.
 */
function initialDraft(data: EstimateBuilderData, settings: MoneySettings): DocumentDraft {
  if (!data.estimate) {
    const blank = blankDraft('estimate', settings, [], {
      person: data.person,
      title: data.draft?.draft.title ?? data.job?.name ?? '',
    });
    const sets = data.draft?.draft.options ?? [];
    if (sets.length > 1)
      return {
        ...blank,
        lines: [],
        options: sets.map((o) => ({
          key: lineKey(),
          name: o.name,
          lines: o.lines.map(lineFromAi),
        })),
      };
    return sets[0] ? { ...blank, lines: sets[0].lines.map(lineFromAi) } : blank;
  }
  const draft = draftOfEstimate(data.estimate, settings);
  const put = (lines: DraftLine[], option: number) =>
    lines.map((l, n) => {
      const c = data.costs.find((x) => x.option === option && x.line === n);
      return {
        ...l,
        ...withCost({ kind: c?.kind ?? 'material', unitCostCents: c?.unitCostCents ?? null }),
      };
    });
  return {
    ...draft,
    lines: put(draft.lines, 1),
    options: draft.options.map((o, i) => ({ ...o, lines: put(o.lines, i + 1) })),
  };
}

/** Every option costed as it stands on screen, and whether it would need an OK. */
function costingOf(draft: DocumentDraft, settings: MoneySettings, minMarginBp: number) {
  const sets = draft.options.length
    ? draft.options.map((o) => ({ name: o.name.trim() || null, lines: o.lines }))
    : [{ name: null, lines: draft.lines }];
  const options = sets.map((s, i) => ({
    name: s.name,
    costing: costOption(s.lines.map(costed), draftTotals(draft, settings, i).subtotalCents),
  }));
  return { options, check: checkMargin(options, minMarginBp) };
}

const lineBody = (l: DraftLine) => {
  const c = costOf(l);
  return {
    productId: l.productId,
    name: l.name.trim(),
    description: l.description.trim() || null,
    quantity: l.quantity,
    unitLabel: l.unitLabel.trim() || 'each',
    unitPriceCents: l.unitPriceCents,
    taxable: l.taxable,
    discountCents: l.discountCents,
    kind: c.kind,
    unitCostCents: c.unitCostCents,
  };
};

export function EstimateBuilder({
  workspaceId,
  data,
  settings,
  products,
  itemCosts,
  timeZone,
  nextNumber,
}: {
  workspaceId: string;
  data: EstimateBuilderData;
  settings: MoneySettings;
  products: readonly ProductRow[];
  /** What each price list item costs, so a line picked from it arrives with its cost. */
  itemCosts: readonly ItemCost[];
  timeZone: string;
  nextNumber: string;
}) {
  const router = useRouter();
  const estimating = data.estimating;
  const start = useMemo(() => initialDraft(data, settings), [data, settings]);
  const [estimateId, setEstimateId] = useState(data.estimate?.id ?? null);
  const [edit, setEdit] = useState(() => ({ rev: data.estimate?.revision ?? 0, draft: start }));
  const [draft, setDraft] = useState<DocumentDraft>(start);
  const [check, setCheck] = useState<MarginCheck | null>(data.check);
  const [busy, setBusy] = useState<'save' | 'ask' | 'ok' | null>(null);
  const [conflict, setConflict] = useState(false);
  const [sending, setSending] = useState(false);
  const [okOpen, setOkOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const [openOption, setOpenOption] = useState(0);
  const active = Math.min(openOption, Math.max(0, draft.options.length - 1));

  // After an ask or an OK the page is read again: what the server says about this very revision is the truth.
  useEffect(() => {
    if (data.check && data.estimate && data.estimate.revision === edit.rev) setCheck(data.check);
  }, [data, edit.rev]);

  const set = (patch: Partial<DocumentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setLine = (key: string, patch: Partial<DraftLine>) =>
    setDraft((d) =>
      withOptionLines(d, active, (lines) =>
        lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
      ),
    );
  const removeLine = (key: string) =>
    setDraft((d) => withOptionLines(d, active, (lines) => lines.filter((l) => l.key !== key)));
  const addLine = (line: DraftLine) =>
    setDraft((d) => withOptionLines(d, active, (lines) => [...lines, line]));
  const addPicked = (picked: PickedProduct) => {
    const known = itemCosts.find((c) => c.productId === picked.productId);
    const product = products.find((p) => p.id === picked.productId);
    addLine(
      newLine({
        productId: picked.productId,
        name: picked.name,
        description: picked.description ?? '',
        unitPriceCents: picked.unitPriceCents,
        unitLabel: picked.unitLabel,
        taxable: picked.taxable,
        ...withCost({
          kind: known?.kind ?? defaultCostKind(product?.kind),
          unitCostCents: known?.costCents ?? null,
          // A line typed by hand has no price yet: it follows its cost until someone types one.
          auto: picked.productId === null,
        }),
      }),
    );
  };
  const addLabor = () =>
    addLine(
      newLine({
        name: B.laborName,
        unitLabel: B.laborUnit,
        unitPriceCents: estimating.laborRateCents,
        ...withCost({
          kind: 'labor',
          unitCostCents: estimating.laborCostCents || null,
          auto: estimating.laborRateCents === 0,
        }),
      }),
    );

  const lines = optionLines(draft, active);
  const option = draft.options[active] ?? null;
  const totals = useMemo(() => draftTotals(draft, settings, active), [draft, settings, active]);
  const live = useMemo(
    () => costingOf(draft, settings, estimating.minMarginBp),
    [draft, settings, estimating.minMarginBp],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(edit.draft);
  // Lines still carrying a cost the AI guessed, in every option.
  const guessedNow = (
    draft.options.length ? draft.options.flatMap((o) => o.lines) : draft.lines
  ).filter((l) => costOf(l).guessed).length;
  const problem = draftProblem(draft);
  const depositIssue = depositProblem(depositTerms(draft), smallestTotalCents(draft, settings));
  const taxed = settings.tax.rateBp > 0;
  const today = localDateOf(Date.now(), timeZone);
  const expiresOn = draft.expiresOn ?? addDays(today, settings.estimateGoodForDays);
  // An OK is for the estimate exactly as it was saved: a change on screen needs a fresh one.
  const okStands = !dirty && !!check?.ok;
  const needsOk = live.check.needsOk !== null && !okStands;
  const asked = check?.asked ?? null;
  const firstName = draft.person?.fullName.split(/\s+/)[0] ?? 'They';

  /** Saves it whole against the revision it loaded, and answers the server's check of what was saved. */
  async function save(): Promise<{ id: string; check: MarginCheck } | null> {
    if (problem || depositIssue) {
      toast.error(problem ?? depositIssue!);
      return null;
    }
    setBusy((b) => b ?? 'save');
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/contractor.estimate.save', {
          body: {
            workspaceId,
            ...(estimateId
              ? { estimateId, baseRevision: edit.rev }
              : {
                  ...(data.job ? { jobId: data.job.id } : {}),
                  // Started from the AI's draft: saving is what makes it an estimate, and uses the draft up.
                  ...(data.draft ? { draftId: data.draft.id } : {}),
                }),
            personId: draft.personId,
            title: draft.title.trim() || null,
            notes: draft.notes.trim() || null,
            discount: discountTerms(draft),
            deposit: depositTerms(draft),
            expiresOn: draft.expiresOn,
            options: draft.options.length
              ? draft.options.map((o) => ({ name: o.name.trim(), lines: o.lines.map(lineBody) }))
              : [{ name: '', lines: draft.lines.map(lineBody) }],
          },
        }),
      );
      setEdit({ rev: out.revision, draft: { ...draft } });
      setCheck(out.check);
      setConflict(false);
      if (estimateId === null) {
        // The draft's own address, swapped in without a navigation so nothing on screen is lost.
        setEstimateId(out.estimateId);
        window.history.replaceState(null, '', estimateHref(workspaceId, out.estimateId));
      }
      return { id: out.estimateId, check: out.check };
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'document_conflict') setConflict(true);
      toast.error(errorMessage(e));
      return null;
    } finally {
      setBusy((b) => (b === 'save' ? null : b));
    }
  }

  /** What's saved, saving first when something on screen isn't. */
  const saved = async () => (dirty || !estimateId || !check ? save() : { id: estimateId, check });

  async function askOk() {
    setBusy('ask');
    try {
      const s = await saved();
      if (!s) return;
      if (s.check.canSend) return void toast.success(B.costing.fineOne);
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.estimate.ask_ok', {
          body: { workspaceId, estimateId: s.id },
        }),
      );
      setCheck({ ...s.check, asked: s.check.asked ?? { by: null, at: new Date().toISOString() } });
      toast.success(B.ok.askedNow);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function giveOk(note: string) {
    setBusy('ok');
    try {
      const s = await saved();
      if (!s) return;
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.estimate.ok', {
          body: { workspaceId, estimateId: s.id, ...(note ? { note } : {}) },
        }),
      );
      setCheck({
        ...s.check,
        asked: null,
        canSend: true,
        ok: { by: null, at: new Date().toISOString(), note: note || null },
      });
      setOkOpen(false);
      toast.success(B.ok.givenNow);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveThenSend() {
    const s = await saved();
    if (!s) return;
    if (!s.check.canSend) {
      const why = okNeededWords(s.check) ?? B.ok.needed;
      toast.error(
        `${why} ${data.may.approve ? `Press ${B.ok.give} first, or raise its price.` : `Press ${B.ok.ask}, or raise its price.`}`,
      );
      return;
    }
    setSending(true);
  }

  const okState = (
    <OkState
      needsOk={needsOk}
      okStands={okStands}
      stale={dirty && !!check?.ok}
      asked={asked}
      okBy={check?.ok?.by ?? null}
      okNote={check?.ok?.note ?? null}
      mayApprove={data.may.approve}
      busy={busy}
      disabled={!!problem}
      onAsk={() => void askOk()}
      onOk={() => setOkOpen(true)}
    />
  );

  return (
    <div data-testid="estimate-builder">
      <BackLink workspaceId={workspaceId} job={data.job} />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
              {estimateId ? B.title : B.newTitle}
              {draft.person ? ` for ${draft.person.fullName}` : ''}
            </h1>
            <StatusBadge kind="estimate" state="draft" testId="builder-status" />
          </div>
          <p className="mt-1 text-[13px] text-text-2" data-testid="builder-saved">
            {estimateId ? `Number ${nextNumber} when it’s sent` : 'New'}
            {dirty ? ' · not saved yet' : estimateId ? ' · all changes saved' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            loading={busy === 'save'}
            disabled={(!dirty && !!estimateId) || busy !== null}
            onClick={() => void save()}
            data-testid="builder-save"
          >
            {B.save}
          </Button>
          <Button
            disabled={!!problem || busy !== null}
            onClick={() => void saveThenSend()}
            data-testid="builder-send"
          >
            {B.send}
          </Button>
        </div>
      </div>

      {data.draft ? (
        <AiDraftNote
          draft={data.draft}
          saved={estimateId !== null}
          guessed={guessedNow}
          timeZone={timeZone}
        />
      ) : null}

      {data.may.bill ? null : (
        <p
          className="mb-4 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text"
          data-testid="builder-no-billing"
        >
          {B.noBilling}
        </p>
      )}

      {conflict ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
          <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
          <span className="flex-1">
            Someone saved this estimate while you were editing, so saving now would be refused.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
            data-testid="builder-reload"
          >
            Load their version
          </Button>
        </div>
      ) : null}

      <div className={SPLIT}>
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="px-5 py-2">
            <Row label={B.customer}>
              {draft.person ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar name={draft.person.fullName} seed={draft.person.id} size="sm" />
                  <span className="truncate font-semibold">{draft.person.fullName}</span>
                  <span className="truncate text-xs text-text-3">
                    {[draft.person.email, draft.person.phone].filter(Boolean).join(' · ')}
                  </span>
                  {/* Once it's written, an estimate stays with its customer. */}
                  {estimateId ? null : (
                    <button
                      type="button"
                      className="ml-auto flex-none text-[13px] font-medium text-accent-text hover:underline"
                      onClick={() => set({ person: null, personId: '' })}
                    >
                      Change
                    </button>
                  )}
                </span>
              ) : (
                <PersonPicker
                  workspaceId={workspaceId}
                  autoFocus
                  onPick={(p) => set({ person: p, personId: p.id })}
                />
              )}
            </Row>
            <Row label={B.forJob}>
              {data.job ? (
                <Link
                  href={jobHref(workspaceId, data.job.id)}
                  className="font-medium hover:underline"
                >
                  {data.job.name}
                </Link>
              ) : (
                <span className="text-text-3">{B.noJob}</span>
              )}
            </Row>
            <Row label={B.titleField}>
              <Input
                inputSize="sm"
                value={draft.title}
                maxLength={200}
                autoComplete="off"
                placeholder={B.titlePlaceholder}
                aria-label={B.titleField}
                onChange={(e) => set({ title: e.target.value })}
                data-testid="builder-title"
              />
            </Row>
          </Card>

          <Card className="px-5 pb-5 pt-4" data-testid="builder-lines">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold tracking-tight">{B.lines}</h2>
              <span className="text-[13px] text-text-3">{B.costHint}</span>
            </div>
            <OptionsBar
              options={draft.options.map((o, i) => ({
                key: o.key,
                name: o.name,
                totalCents: draftTotals(draft, settings, i).totalCents,
              }))}
              active={active}
              max={OPTIONS_MAX}
              onPick={setOpenOption}
              onAdd={() => {
                setOpenOption(Math.max(1, draft.options.length));
                setDraft(addOption);
              }}
              onRename={(index, name) =>
                setDraft((d) => ({
                  ...d,
                  options: d.options.map((o, i) => (i === index ? { ...o, name } : o)),
                }))
              }
              onRemove={(index) => {
                setOpenOption(0);
                setDraft((d) => removeOption(d, index));
              }}
            />

            <ul>
              {lines.map((line) => (
                <BuilderLine
                  key={line.key}
                  line={line}
                  taxed={taxed}
                  estimating={estimating}
                  onChange={(patch) => setLine(line.key, patch)}
                  onRemove={() => removeLine(line.key)}
                />
              ))}
            </ul>
            {lines.length === 0 ? (
              <p className="border-t border-border py-4 text-[13px] text-text-3">
                {option
                  ? `Nothing in “${option.name.trim() || 'this option'}” yet. Add labor, a line, or something from your price list.`
                  : 'Nothing on it yet. Add labor, a line, or something from your price list.'}
              </p>
            ) : null}

            <div className="relative mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={addLabor}
                data-testid="builder-add-labor"
              >
                <Clock className="h-4 w-4" strokeWidth={1.75} />
                {B.addLabor}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  addLine(newLine(withCost({ kind: 'material', unitCostCents: null, auto: true })))
                }
                data-testid="builder-add-line"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                {B.addLine}
              </Button>
              <span className="relative">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPicker((p) => !p)}
                  data-testid="builder-price-list"
                >
                  <Boxes className="h-4 w-4" strokeWidth={1.5} />
                  Add from your price list
                </Button>
                <ProductPicker
                  products={products}
                  open={picker}
                  onClose={() => setPicker(false)}
                  onPick={addPicked}
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

          <Card className="px-5 pb-5 pt-4">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold tracking-tight">{B.notes}</h2>
              <span className="text-[13px] text-text-3">Shown on their page and in the email</span>
            </div>
            <Textarea
              rows={3}
              value={draft.notes}
              maxLength={5_000}
              aria-label={B.notes}
              onChange={(e) => set({ notes: e.target.value })}
              data-testid="builder-notes"
            />
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="px-[18px] py-4" data-testid="builder-costing">
            <h2 className="text-base font-semibold tracking-tight">
              {option
                ? `${B.costing.title}: “${option.name.trim() || 'this option'}”`
                : B.costing.title}
            </h2>
            <p className="mb-1.5 mt-0.5 text-[12.5px] text-text-3">{B.costing.hint}</p>
            <CostingRows
              costing={live.options[active]?.costing ?? live.options[0]!.costing}
              minBp={estimating.minMarginBp}
            />
            <OptionMargins options={live.options} minBp={estimating.minMarginBp} />
            {okStands ? null : <CheckNote check={live.check} options={live.options.length} />}
            {okState}
          </Card>

          <Card className="px-[18px] py-4" data-testid="builder-totals">
            <h2 className="mb-1.5 text-base font-semibold tracking-tight">
              {option ? `Totals for “${option.name.trim() || 'this option'}”` : 'Totals'}
            </h2>
            <TotalRow label="Subtotal" value={money(totals.lineSubtotalCents)} />
            {totals.discountCents > 0 ? (
              <TotalRow
                label={
                  draft.discountKind === 'percent'
                    ? `${percentLabel(draft.discountPercentBp)} off, before tax`
                    : 'Off the whole job, before tax'
                }
                value={`−${money(totals.discountCents)}`}
                credit
              />
            ) : null}
            {taxed ? (
              <TotalRow
                label={`${settings.tax.name} · ${percentLabel(settings.tax.rateBp)} on ${money(totals.taxableBaseCents)}`}
                value={money(totals.taxCents)}
              />
            ) : null}
            <TotalRow label="Total" value={money(totals.totalCents)} big testId="builder-total" />
          </Card>

          <DepositCard
            draft={draft}
            set={set}
            depositCents={totals.depositCents}
            totalCents={totals.totalCents}
            problem={depositIssue}
            firstName={firstName}
          />

          <Card className="px-[18px] py-4">
            <h2 className="mb-2 text-base font-semibold tracking-tight">{B.expires}</h2>
            <Input
              type="date"
              inputSize="sm"
              aria-label={B.expires}
              value={draft.expiresOn ?? ''}
              min={today}
              onChange={(e) => set({ expiresOn: e.target.value || null })}
              data-testid="builder-expires"
            />
            <p className="mt-1.5 text-[12.5px] text-text-3">
              {draft.expiresOn
                ? `Good until ${dayLabel(localInstant(expiresOn, '12:00', timeZone), timeZone)}.`
                : `Left empty, it’s good for ${settings.estimateGoodForDays} days from the day it’s sent.`}
            </p>
          </Card>
        </div>
      </div>

      {estimateId && draft.person ? (
        <SendDialog
          open={sending}
          onOpenChange={setSending}
          kind="estimate"
          workspaceId={workspaceId}
          documentId={estimateId}
          person={draft.person}
          send={async (how) =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.estimate.send', {
                body: { workspaceId, estimateId, ...how },
              }),
            )
          }
          // Once it has gone it's core's document: its own page shows what the customer sees and does.
          onSent={() => router.replace(documentHref(workspaceId, estimateId))}
        />
      ) : null}
      <OkDialog
        open={okOpen}
        onOpenChange={setOkOpen}
        why={okNeededWords(live.check)}
        busy={busy === 'ok'}
        onOk={(note) => void giveOk(note)}
      />
    </div>
  );
}

/**
 * Says the AI drafted this (part 7; the owner's decision 6: an estimate the AI drafts always waits for a person):
 * what it read, which costs it guessed, what it assumed and what it couldn't tell. On a new estimate it's the
 * reminder to check every line before saving; on a saved one, where the estimate came from.
 */
function AiDraftNote({
  draft,
  saved,
  guessed,
  timeZone,
}: {
  draft: BuilderDraft;
  /** The person saved it: it's an estimate now, started from the draft. */
  saved: boolean;
  /** Lines on screen still carrying a cost the AI guessed. */
  guessed: number;
  timeZone: string;
}) {
  const when = formatDate(draft.createdAt, { timeZone });
  const points = (title: string, list: readonly string[], testId: string) =>
    list.length ? (
      <div className="mt-2.5" data-testid={testId}>
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-text-3">{title}</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text">
          {list.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div
      className="mb-4 rounded-menu bg-accent-soft px-3.5 py-3 text-[13px] leading-[1.5]"
      role="note"
      data-testid="builder-ai-draft"
    >
      <p className="flex items-start gap-2 font-semibold text-accent-text">
        <Sparkles className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
        <span>{saved ? A.startedFrom(draft.askedBy, when) : A.bannerTitle}</span>
      </p>
      {saved ? null : (
        <p className="mt-1 text-text-2">{A.bannerBody(draft.notesRead, draft.photosRead)}</p>
      )}
      {guessed > 0 ? (
        <p className="mt-1 text-text-2" data-testid="builder-ai-guessed">
          {A.bannerGuessed(guessed)}
        </p>
      ) : null}
      {points(A.assumed, draft.draft.assumptions, 'builder-ai-assumed')}
      {points(A.questions, draft.draft.questions, 'builder-ai-questions')}
    </div>
  );
}

function BackLink({ workspaceId, job }: { workspaceId: string; job: EstimateBuilderData['job'] }) {
  return (
    <Link
      href={job ? jobHref(workspaceId, job.id) : contractorHref(workspaceId, 'estimates')}
      className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-text"
    >
      <ArrowLeft className="h-4 w-4" />
      {job ? job.name : CONTRACTOR_WORDS.estimates.title}
    </Link>
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

function Small({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {label}
      </span>
      {children}
    </label>
  );
}

/** A cost that may be empty: nobody has said what it costs yet. */
function CostInput({
  valueCents,
  onChange,
  className,
  ...rest
}: Omit<InputProps, 'value' | 'onChange' | 'defaultValue'> & {
  valueCents: number | null;
  onChange: (cents: number | null) => void;
}) {
  const shown = (c: number | null) => (c === null ? '' : money(c));
  const [text, setText] = useState(() => shown(valueCents));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(shown(valueCents));
  }, [valueCents, touched]);
  const read = (t: string) => (t.trim() === '' ? null : parseMoney(t));
  const invalid = text.trim() !== '' && parseMoney(text) === null;
  return (
    <Input
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      invalid={invalid}
      placeholder="Not set"
      className={cn('text-right tabular-nums', className)}
      onChange={(e) => {
        setTouched(true);
        setText(e.target.value);
        const blank = e.target.value.trim() === '';
        const next = read(e.target.value);
        if (blank || next !== null) onChange(next);
      }}
      onBlur={() => {
        setTouched(false);
        setText(shown(invalid ? valueCents : read(text)));
      }}
    />
  );
}

/** One line: what it is, how it's costed, and the markup between its cost and its price. */
function BuilderLine({
  line,
  taxed,
  estimating,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  taxed: boolean;
  estimating: Estimating;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const cost = costOf(line);
  const markupBp = markupBpOf(line.unitPriceCents, cost.unitCostCents);
  const subtotal = lineSubtotalCents(line);
  const lineCost = lineCostCents({ quantity: line.quantity, unitCostCents: cost.unitCostCents });
  const hasCost = cost.unitCostCents !== null && cost.unitCostCents > 0;
  const named = line.name || 'this line';
  return (
    <li
      className="border-t border-border py-3 first:border-t-0"
      data-testid={`builder-line-${line.name || 'new'}`}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            inputSize="sm"
            value={line.name}
            maxLength={200}
            autoComplete="off"
            aria-label="What it is"
            placeholder="What it is"
            onChange={(e) => onChange({ name: e.target.value })}
            data-testid="line-name"
          />
          <Input
            inputSize="sm"
            value={line.description}
            maxLength={2_000}
            autoComplete="off"
            aria-label="Description"
            placeholder="Description (optional)"
            className="h-6 border-0 bg-transparent px-0.5 text-xs text-text-2 focus:ring-0"
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </span>
        <span className="flex flex-none flex-col items-end pt-1.5">
          <span className="text-[13.5px] font-semibold tabular-nums" data-testid="line-amount">
            {money(subtotal)}
          </span>
          {hasCost ? (
            <span className="text-[11.5px] tabular-nums text-text-3">
              {B.lineProfit} {money(subtotal - lineCost)} ·{' '}
              <Margin bp={marginBpOf(subtotal, lineCost)} minBp={estimating.minMarginBp} />
            </span>
          ) : null}
        </span>
        <button
          type="button"
          aria-label={`${B.remove} ${named}`}
          onClick={onRemove}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-control text-text-3 hover:bg-card-2 hover:text-danger-text"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-end gap-2.5">
        <Small label={B.kind}>
          <Select
            selectSize="sm"
            className="w-[108px]"
            value={cost.kind}
            title={COST_KIND_HINTS[cost.kind]}
            onChange={(e) => onChange(withCost({ ...cost, kind: e.target.value as CostKind }))}
            data-testid="line-kind"
          >
            {COST_KINDS.map((k) => (
              <option key={k} value={k} title={COST_KIND_HINTS[k]}>
                {COST_KIND_WORDS[k]}
              </option>
            ))}
          </Select>
        </Small>
        <Small label={cost.kind === 'labor' ? 'Hours' : B.quantity}>
          <QuantityInput
            value={line.quantity}
            inputSize="sm"
            className="w-[72px]"
            onChange={(quantity) => onChange({ quantity })}
            data-testid="line-qty"
          />
        </Small>
        <Small label={cost.kind === 'labor' ? 'Cost per hour' : B.cost}>
          <CostInput
            valueCents={cost.unitCostCents}
            inputSize="sm"
            className="w-[104px]"
            onChange={(unitCostCents) =>
              onChange({
                // A cost someone typed is theirs, not the AI's guess anymore.
                ...withCost({ ...cost, unitCostCents, guessed: false }),
                // Until a price is typed, it follows the cost at the business's starting markup.
                ...(cost.auto && unitCostCents !== null
                  ? { unitPriceCents: priceFromMarkup(unitCostCents, estimating.markupBp) }
                  : {}),
              })
            }
            data-testid="line-cost"
          />
        </Small>
        {cost.guessed ? (
          <Badge
            variant="pending"
            className="mb-[5px]"
            title={A.guessHint}
            data-testid="line-guess"
          >
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            {A.guess}
          </Badge>
        ) : null}
        <Small label={B.markup}>
          <PercentInput
            valueBp={Math.max(0, markupBp ?? 0)}
            max={100_000}
            inputSize="sm"
            className="w-[72px]"
            disabled={!hasCost}
            title={hasCost ? undefined : 'Put in what it costs first.'}
            onChange={(bp) =>
              onChange({
                unitPriceCents: priceFromMarkup(cost.unitCostCents ?? 0, bp),
                ...withCost({ ...cost, auto: false }),
              })
            }
            data-testid="line-markup"
          />
        </Small>
        <Small label={cost.kind === 'labor' ? 'Price per hour' : B.price}>
          <MoneyInput
            valueCents={line.unitPriceCents}
            inputSize="sm"
            className="w-[104px]"
            onChange={(unitPriceCents) =>
              onChange({ unitPriceCents, ...withCost({ ...cost, auto: false }) })
            }
            data-testid="line-price"
          />
        </Small>
        {taxed ? (
          <span className="flex h-8 items-center gap-1.5 text-[12.5px] text-text-2">
            <Switch
              checked={line.taxable}
              label={`Sales tax on ${named}`}
              onChange={(taxable) => onChange({ taxable })}
            />
            Tax
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Where its OK stands, and the button that moves it on: ask for one, or give it. */
function OkState({
  needsOk,
  okStands,
  stale,
  asked,
  okBy,
  okNote,
  mayApprove,
  busy,
  disabled,
  onAsk,
  onOk,
}: {
  needsOk: boolean;
  okStands: boolean;
  stale: boolean;
  asked: MarginCheck['asked'];
  okBy: string | null;
  okNote: string | null;
  mayApprove: boolean;
  busy: string | null;
  disabled: boolean;
  onAsk: () => void;
  onOk: () => void;
}) {
  if (okStands)
    return (
      <p className="mt-3 rounded-menu bg-success-soft px-3 py-2.5 text-[12.5px] text-success-text">
        <span data-testid="builder-ok-given">{B.ok.given(okBy)}</span>
        {okNote ? <span className="mt-0.5 block text-text-2">“{okNote}”</span> : null}
      </p>
    );
  if (!needsOk) return null;
  return (
    <div className="mt-2.5 space-y-2">
      {stale ? <p className="text-[12.5px] text-text-2">{B.ok.stale}</p> : null}
      {asked ? (
        <p className="text-[12.5px] text-text-2" data-testid="builder-asked">
          {B.ok.asked(asked.by)}
        </p>
      ) : null}
      {mayApprove ? (
        <Button
          size="sm"
          loading={busy === 'ok'}
          disabled={disabled || busy !== null}
          onClick={onOk}
          data-testid="builder-ok"
        >
          {B.ok.give}
        </Button>
      ) : asked ? null : (
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'ask'}
          disabled={disabled || busy !== null}
          onClick={onAsk}
          data-testid="builder-ask-ok"
        >
          {B.ok.ask}
        </Button>
      )}
    </div>
  );
}

function OkDialog({
  open,
  onOpenChange,
  why,
  busy,
  onOk,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  why: string | null;
  busy: boolean;
  onOk: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="OK this estimate to go out?"
        description={`${why ?? ''} Your OK is for the estimate exactly as it is now. If it changes, it needs a fresh one.`.trim()}
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onOk(note.trim());
          }}
        >
          <Field label={B.ok.note} htmlFor="estimate-ok-note">
            <Textarea
              id="estimate-ok-note"
              value={note}
              maxLength={500}
              placeholder={B.ok.notePlaceholder}
              onChange={(e) => setNote(e.target.value)}
              className="min-h-[72px]"
              data-testid="builder-ok-note"
            />
          </Field>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Not yet
            </Button>
            <Button type="submit" loading={busy} data-testid="builder-ok-confirm">
              {B.ok.give}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An estimate that has gone out: it can't change here, so this is its costs and profit (each option's, and the one
 * they picked), with the way to its own page.
 */
export function SentEstimate({
  workspaceId,
  data,
}: {
  workspaceId: string;
  data: EstimateBuilderData;
}) {
  const est = data.estimate!;
  const check = data.check;
  const minBp = data.estimating.minMarginBp;
  return (
    <div className="max-w-[760px]" data-testid="estimate-sent">
      <BackLink workspaceId={workspaceId} job={data.job} />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
              {est.number ?? B.title} for {est.person.fullName}
            </h1>
            <StatusBadge kind="estimate" state={est.state} />
          </div>
          <p className="mt-1 text-[13px] text-text-2">{B.gone}</p>
        </div>
        <ButtonLink href={documentHref(workspaceId, est.id)} variant="secondary">
          {B.openDocument}
        </ButtonLink>
      </div>
      {check ? (
        <div className="grid gap-4 md:grid-cols-2">
          {check.options.map((o) => (
            <Card key={o.position} className="px-[18px] py-4" data-testid="sent-costing">
              <h2 className="mb-1.5 text-base font-semibold tracking-tight">
                {o.name ?? B.costing.title}
                {est.optionCount && est.status === 'accepted' && est.optionName === o.name
                  ? ' · they picked this'
                  : ''}
              </h2>
              <CostingRows costing={o} minBp={minBp} />
            </Card>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-[12.5px] text-text-3">{B.costing.hint}</p>
    </div>
  );
}
