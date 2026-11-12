'use client';
/**
 * A job's materials (docs/contractor.md, "Materials"; the owner's decision 9): what the job needs and how much of
 * each is ordered, delivered, used, wasted and returned. On the job's page it's the whole list; on a visit's work
 * order it's what that visit needs. One press moves a material along (ordered, delivered, used); the rest is in
 * its dialog. Where a material stands and what's short come worked out from the server.
 *
 * What one costs shows only for people who may see job costs (the owner's decision 11): the server sends nobody
 * else a cost. A done or cancelled job's materials are read-only, as the job is.
 */
import {
  amountWords,
  MATERIAL_COUNTS,
  nextStep,
  type MaterialCount,
  type MaterialState,
  type MaterialStep,
} from '@hfos/core/addons/contractor/materials';
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import {
  CONTRACTOR_WORDS,
  MATERIAL_COUNT_HINTS,
  MATERIAL_COUNT_WORDS,
  MATERIAL_STATE_WORDS,
} from '@hfos/core/addons/contractor/words';
import { formatDateOnly, money, parseMoney } from '@hfos/core';
import { MoreHorizontal, Package } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { jobHref } from './bits';
import { ConfirmDialog } from './job-dialogs';
import type { Material, MaterialCosting, VisitMaterial } from './types';
import { useAct } from './use-act';

const M = CONTRACTOR_WORDS.materials;

/** A visit a material can be for, as the dialog's picker lists it. */
export interface MaterialVisit {
  readonly appointmentId: string;
  readonly label: string;
}

/** A price list item to pick a material from. */
export interface MaterialProduct {
  readonly id: string;
  readonly name: string;
  readonly unitLabel: string;
}

/** A material as either page has it: the work order's come without a cost. */
type Row = VisitMaterial & { readonly unitCostCents?: Material['unitCostCents'] };

const STATE_BADGE: Readonly<Record<MaterialState, BadgeVariant>> = {
  to_order: 'danger',
  ordered: 'pending',
  here: 'ok',
  used: 'gray',
};

const STEP_WORDS: Readonly<
  Record<MaterialStep, { press: string; done: (name: string) => string }>
> = {
  order: { press: M.markOrdered, done: M.markedOrdered },
  deliver: { press: M.markDelivered, done: M.markedDelivered },
  use: { press: M.markUsed, done: M.markedUsed },
};

export function MaterialsCard({
  workspaceId,
  jobId,
  materials,
  visits,
  products,
  costing,
  mayCost,
  readOnly,
  forVisit,
}: {
  workspaceId: string;
  jobId: string;
  materials: readonly Row[];
  /** The job's visits, to say which one a material is for. */
  visits: readonly MaterialVisit[];
  /** The price list, for people who can see it; empty for everyone else. */
  products: readonly MaterialProduct[];
  /** What the materials cost in all; null for anyone who may not see job costs. */
  costing?: MaterialCosting | null;
  mayCost: boolean;
  /** The job is done or cancelled (or the visit was cancelled): shown, not changed. */
  readOnly: boolean;
  /** On a visit's work order: the visit, which a material added here is for. */
  forVisit?: string;
}) {
  const { busy, act } = useAct();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const missing = materials.filter((m) => m.short > 0).length;
  const visitLabel = (appointmentId: string | null) =>
    appointmentId ? (visits.find((v) => v.appointmentId === appointmentId)?.label ?? null) : null;
  const step = (m: Row) => {
    const next = nextStep(m);
    if (!next) return;
    void act(
      `step:${m.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/contractor.material.update', {
            body: { workspaceId, materialId: m.id, ...next.change },
          }),
        ),
      STEP_WORDS[next.step].done(m.name),
    );
  };
  return (
    <Card className="p-0" data-testid="materials-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{forVisit ? M.visitTitle : M.title}</h2>
          {materials.length ? (
            <p
              className={cn('text-[12.5px]', missing ? 'text-danger-text' : 'text-text-3')}
              data-testid="materials-missing"
            >
              {missing ? M.missing(missing) : M.allHere}
            </p>
          ) : null}
        </div>
        {!readOnly ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAdding(true)}
            data-testid="material-add"
          >
            {M.add}
          </Button>
        ) : null}
      </div>
      {materials.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-text-2">{forVisit ? M.noneForVisit : M.none}</p>
      ) : (
        <ul>
          {materials.map((m) => {
            const next = readOnly ? null : nextStep(m);
            const visit = forVisit
              ? m.appointmentId === forVisit
                ? M.thisVisit
                : null
              : visitLabel(m.appointmentId);
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
                data-testid={`material-${m.name}`}
              >
                <Package className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                <div className="min-w-[160px] flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                    <span>{m.name}</span>
                    <Badge variant={STATE_BADGE[m.state]} data-testid="material-state">
                      {MATERIAL_STATE_WORDS[m.state]}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-text-3">
                    <span className="text-text-2">
                      {M.of(
                        amountWords(m.delivered, m.unitLabel),
                        amountWords(m.needed, m.unitLabel),
                      )}
                    </span>
                    {m.short > 0 ? (
                      <span className="font-medium text-danger-text">
                        {M.short(amountWords(m.short, m.unitLabel))}
                      </span>
                    ) : m.left > 0 && m.left < m.delivered ? (
                      <span>{M.left(amountWords(m.left, m.unitLabel))}</span>
                    ) : null}
                    {m.short > 0 && m.expectedOn ? (
                      <span>{M.expected(formatDateOnly(m.expectedOn))}</span>
                    ) : null}
                    {m.supplier ? <span>{M.from(m.supplier)}</span> : null}
                    {visit ? <span>{visit}</span> : null}
                    {m.fromEstimate ? <span>{M.fromEstimate}</span> : null}
                    {mayCost && m.unitCostCents !== undefined ? (
                      <span data-testid="material-cost">
                        {m.unitCostCents === null
                          ? M.noCost
                          : `${money(m.unitCostCents)} ${M.unitCost.toLowerCase()}`}
                      </span>
                    ) : null}
                  </div>
                  {m.note ? (
                    <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-text-2">{m.note}</p>
                  ) : null}
                </div>
                {next ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `step:${m.id}`}
                    onClick={() => step(m)}
                    data-testid="material-step"
                  >
                    {STEP_WORDS[next.step].press}
                  </Button>
                ) : null}
                {!readOnly ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="rounded p-1.5 text-text-3 hover:bg-card-2 hover:text-text"
                        aria-label={M.menu(m.name)}
                        data-testid="material-menu"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setEditing(m)}>{M.edit}</DropdownMenuItem>
                      <DropdownMenuItem danger onSelect={() => setRemoving(m)}>
                        {M.remove}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {costing && materials.length ? (
        <div
          className="border-t border-border px-5 py-3 text-[12.5px] text-text-2"
          data-testid="materials-costing"
        >
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>
              {M.planned}:{' '}
              <span className="font-medium tabular-nums text-text">
                {money(costing.plannedCents)}
              </span>
            </span>
            <span>
              {M.taken}:{' '}
              <span className="font-medium tabular-nums text-text">
                {money(costing.takenCents)}
              </span>
            </span>
          </div>
          {costing.uncosted ? (
            <p className="mt-1 text-text-3">{M.uncosted(costing.uncosted)}</p>
          ) : null}
        </div>
      ) : null}
      {forVisit ? (
        <div className="border-t border-border px-5 py-2.5">
          <Link
            href={jobHref(workspaceId, jobId)}
            className="text-[12.5px] text-text-2 hover:text-text hover:underline"
          >
            {M.seeAll}
          </Link>
        </div>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title={M.addTitle} description={forVisit ? M.visitHint : M.hint}>
          {adding ? (
            <MaterialForm
              workspaceId={workspaceId}
              jobId={jobId}
              material={null}
              visits={visits}
              products={products}
              mayCost={mayCost}
              forVisit={forVisit}
              onClose={() => setAdding(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing ? M.editTitle(editing.name) : M.edit}>
          {editing ? (
            <MaterialForm
              workspaceId={workspaceId}
              jobId={jobId}
              material={editing}
              visits={visits}
              products={products}
              mayCost={mayCost}
              forVisit={forVisit}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `${M.remove} “${removing.name}”?` : M.remove}
        description={removing ? M.removeAsk(removing.name) : ''}
        submit={M.remove}
        done={removing ? M.removed(removing.name) : ''}
        run={async () =>
          removing &&
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.material.remove', {
              body: { workspaceId, materialId: removing.id },
            }),
          )
        }
      />
    </Card>
  );
}

const qty = (n: number) => String(n);

/** A typed amount: a number from 0 up, or 'bad'. Empty is nothing (0). */
function amount(text: string): number | 'bad' {
  const t = text.trim().replace(/,/g, '');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= LIMITS.quantity ? Math.round(n * 1000) / 1000 : 'bad';
}

/** Adding a material (material null) or changing one: what it is, its counts, where it's from, and its cost. */
function MaterialForm({
  workspaceId,
  jobId,
  material,
  visits,
  products,
  mayCost,
  forVisit,
  onClose,
}: {
  workspaceId: string;
  jobId: string;
  material: Row | null;
  visits: readonly MaterialVisit[];
  products: readonly MaterialProduct[];
  mayCost: boolean;
  forVisit?: string;
  onClose: () => void;
}) {
  const [productId, setProductId] = useState('');
  const [name, setName] = useState(material?.name ?? '');
  const [unitLabel, setUnitLabel] = useState(material?.unitLabel ?? 'each');
  const [appointmentId, setAppointmentId] = useState(
    material ? (material.appointmentId ?? '') : (forVisit ?? ''),
  );
  const [counts, setCounts] = useState<Record<MaterialCount, string>>(() => ({
    needed: qty(material?.needed ?? 1),
    ordered: qty(material?.ordered ?? 0),
    delivered: qty(material?.delivered ?? 0),
    used: qty(material?.used ?? 0),
    wasted: qty(material?.wasted ?? 0),
    returned: qty(material?.returned ?? 0),
  }));
  const [supplier, setSupplier] = useState(material?.supplier ?? '');
  const [expectedOn, setExpectedOn] = useState(material?.expectedOn ?? '');
  const [note, setNote] = useState(material?.note ?? '');
  const costNow = material?.unitCostCents ?? null;
  const [cost, setCost] = useState(costNow === null ? '' : money(costNow).replace('$', ''));
  const { busy, errors, setErrors, act } = useAct(onClose);
  // A new material is asked only what's known when it goes on the list; the rest comes as it happens.
  const shown: readonly MaterialCount[] = material
    ? MATERIAL_COUNTS
    : ['needed', 'ordered', 'delivered'];
  const pickProduct = (id: string) => {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (!p) return;
    setName(p.name);
    setUnitLabel(p.unitLabel || 'each');
  };
  const submit = () => {
    const bad: Record<string, string> = {};
    const numbers = {} as Record<MaterialCount, number>;
    for (const k of shown) {
      const n = amount(counts[k]);
      if (n === 'bad') bad[k] = 'Type an amount, like 12 or 2.5.';
      else numbers[k] = n;
    }
    if (!name.trim()) bad.name = 'Say what the material is.';
    if (!unitLabel.trim()) bad.unitLabel = 'Say what it’s counted in, such as each, ft or box.';
    // The cost is its own change, and only when it was touched.
    const typed = cost.trim();
    const costCents = typed ? parseMoney(typed) : null;
    if (mayCost && typed && costCents === null) bad.unitCostCents = 'Type an amount, like 4.25.';
    if (Object.keys(bad).length) return setErrors(bad);
    const costChanged = mayCost && costCents !== costNow;
    void act(
      'save',
      async () => {
        if (!material) {
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.material.add', {
              body: {
                workspaceId,
                jobId,
                name: name.trim(),
                unitLabel: unitLabel.trim(),
                ...(productId ? { productId } : {}),
                ...(appointmentId ? { appointmentId } : {}),
                needed: numbers.needed,
                ordered: numbers.ordered,
                delivered: numbers.delivered,
                ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
                ...(expectedOn ? { expectedOn } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
                // Left out, a price list item's own cost is filled in.
                ...(mayCost && costCents !== null ? { unitCostCents: costCents } : {}),
              },
            }),
          );
          return;
        }
        unwrap(
          await apiBrowser().POST('/v1/commands/contractor.material.update', {
            body: {
              workspaceId,
              materialId: material.id,
              name: name.trim(),
              unitLabel: unitLabel.trim(),
              appointmentId: appointmentId || null,
              ...numbers,
              supplier: supplier.trim() || null,
              expectedOn: expectedOn || null,
              note: note.trim() || null,
            },
          }),
        );
        if (costChanged)
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.material.set_cost', {
              body: { workspaceId, materialId: material.id, unitCostCents: costCents },
            }),
          );
      },
      material ? M.saved : M.added(name.trim()),
    );
  };
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="material-form"
    >
      {!material && products.length ? (
        <Field label={M.product} htmlFor="material-product" error={errors.productId}>
          <Select
            id="material-product"
            value={productId}
            onChange={(e) => pickProduct(e.target.value)}
            data-testid="material-product"
          >
            <option value="">{M.productNone}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
        <Field label={M.name} htmlFor="material-name" error={errors.name}>
          <Input
            id="material-name"
            value={name}
            maxLength={LIMITS.materialName}
            placeholder={M.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
            data-testid="material-name"
          />
        </Field>
        <Field label={M.unit} htmlFor="material-unit" error={errors.unitLabel}>
          <Input
            id="material-unit"
            value={unitLabel}
            maxLength={LIMITS.unitLabel}
            placeholder={M.unitPlaceholder}
            onChange={(e) => setUnitLabel(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {shown.map((k) => (
          <Field
            key={k}
            label={MATERIAL_COUNT_WORDS[k]}
            htmlFor={`material-${k}`}
            hint={MATERIAL_COUNT_HINTS[k]}
            error={errors[k]}
          >
            <Input
              id={`material-${k}`}
              inputMode="decimal"
              className="tabular-nums"
              value={counts[k]}
              onChange={(e) => setCounts((c) => ({ ...c, [k]: e.target.value }))}
              data-testid={`material-${k}`}
            />
          </Field>
        ))}
      </div>
      <Field label={M.forVisit} htmlFor="material-visit" error={errors.appointmentId}>
        <Select
          id="material-visit"
          value={appointmentId}
          onChange={(e) => setAppointmentId(e.target.value)}
          data-testid="material-visit"
        >
          <option value="">{M.anyVisit}</option>
          {visits.map((v) => (
            <option key={v.appointmentId} value={v.appointmentId}>
              {v.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={M.supplier} htmlFor="material-supplier" error={errors.supplier}>
          <Input
            id="material-supplier"
            value={supplier}
            maxLength={LIMITS.supplier}
            placeholder={M.supplierPlaceholder}
            onChange={(e) => setSupplier(e.target.value)}
          />
        </Field>
        <Field label={M.expectedOn} htmlFor="material-expected" error={errors.expectedOn}>
          <Input
            id="material-expected"
            type="date"
            value={expectedOn}
            onChange={(e) => setExpectedOn(e.target.value)}
          />
        </Field>
      </div>
      {mayCost ? (
        <Field
          label={M.unitCost}
          htmlFor="material-cost"
          hint={M.unitCostHint}
          error={errors.unitCostCents}
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-3">
              $
            </span>
            <Input
              id="material-cost"
              inputMode="decimal"
              className="pl-7 tabular-nums"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              data-testid="material-cost-input"
            />
          </div>
        </Field>
      ) : null}
      <Field label={M.note} htmlFor="material-note" error={errors.note}>
        <Textarea
          id="material-note"
          rows={2}
          value={note}
          maxLength={LIMITS.materialNote}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {M.cancel}
        </Button>
        <Button
          type="submit"
          loading={busy === 'save'}
          disabled={!name.trim()}
          data-testid="material-save"
        >
          {M.save}
        </Button>
      </div>
    </form>
  );
}
