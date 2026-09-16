'use client';
/**
 * Settings → Products (design/m9 Products.dc.html): the catalogue an estimate or an invoice is built from. A
 * price here is only where the editor starts — a line keeps what the product said the moment it was added, so
 * repricing something never reprices a document that has already gone out.
 *
 * Nothing is ever deleted. Archiving keeps an item on every document it is already on and takes it out of the
 * picker, which is why the table can show archived rows and put one back.
 */
import { money, type MoneySettings } from '@hfos/core';
import { ArrowUpRight, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { MoneyInput } from '@/components/money/money-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ProductRow, ServiceItem } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

type Kind = ProductRow['kind'];

const KIND_WORDS: Readonly<Record<Kind, string>> = {
  product: 'Product',
  service: 'Service',
  fee: 'Fee',
};

/** What one of something is called. A business can type its own. */
const UNITS = ['each', 'hour', 'day', 'foot', 'sq ft', 'pound', 'gallon', 'visit', 'month'];

interface Form {
  id: string | null;
  name: string;
  sku: string;
  kind: Kind;
  unitPriceCents: number;
  unitLabel: string;
  taxable: boolean;
  serviceId: string | null;
  archived: boolean;
}

const blank = (taxable: boolean): Form => ({
  id: null,
  name: '',
  sku: '',
  kind: 'product',
  unitPriceCents: 0,
  unitLabel: 'each',
  taxable,
  serviceId: null,
  archived: false,
});

const formOf = (p: ProductRow): Form => ({
  id: p.id,
  name: p.name,
  sku: p.sku ?? '',
  kind: p.kind,
  unitPriceCents: p.unitPriceCents,
  unitLabel: p.unitLabel,
  taxable: p.taxable,
  serviceId: p.serviceId,
  archived: p.archivedAt !== null,
});

export function ProductsPage({
  workspaceId,
  products,
  services,
  settings,
}: {
  workspaceId: string;
  products: readonly ProductRow[];
  /** Bookable services, so one price can serve the catalogue and the booking page. */
  services: readonly ServiceItem[];
  settings: MoneySettings;
}) {
  useLiveRefresh(['product', 'service']);
  const [form, setForm] = useState<Form | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const live = products.filter((p) => p.archivedAt === null);
  const shown = showArchived ? products : live;
  const archivedCount = products.length - live.length;
  const serviceName = (id: string | null) =>
    id ? (services.find((s) => s.id === id)?.name ?? 'A service') : null;

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card className="overflow-hidden" data-testid="products">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3.5 pt-[18px]">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">Products and services</h2>
              <p className="mt-1 text-[13px] text-text-2">
                What you put on an estimate or an invoice. A price here is the one the editor starts
                from.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setForm(blank(settings.tax.newProductsTaxable))}
              data-testid="product-new"
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New product
            </Button>
          </div>
          {shown.length === 0 ? (
            <EmptyState title="Nothing to sell yet" className="border-t border-border">
              Add the parts, work and charges you put on an estimate, each with its price and what
              one of it is called.
            </EmptyState>
          ) : (
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr className="text-left text-xs font-medium tracking-[0.02em] text-text-3">
                    {[
                      'Item',
                      'Code',
                      'Kind',
                      'Price',
                      'Unit',
                      'Sales tax',
                      'Customers can book it as',
                    ].map((h) => (
                      <th
                        key={h}
                        className="border-y border-border bg-card-2 px-4 py-2.5 font-medium"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const on = form?.id === p.id;
                    const archived = p.archivedAt !== null;
                    const td = cn(
                      'border-b border-border px-4 py-3',
                      on && 'bg-accent-soft',
                      archived && 'text-text-3',
                    );
                    return (
                      <tr
                        key={p.id}
                        className="cursor-pointer hover:[&>td]:bg-card-2"
                        onClick={() => setForm(formOf(p))}
                        data-testid={`product-row-${p.name}`}
                        data-archived={archived ? 'yes' : 'no'}
                      >
                        <td className={td}>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className={cn('font-medium', archived && 'line-through')}>
                              {p.name}
                            </span>
                            {archived ? <Badge variant="gray">Archived</Badge> : null}
                          </span>
                        </td>
                        <td className={cn(td, 'font-mono text-[12px]')}>{p.sku || '—'}</td>
                        <td className={td}>{KIND_WORDS[p.kind]}</td>
                        <td className={cn(td, 'tabular-nums')}>{money(p.unitPriceCents)}</td>
                        <td className={td}>{p.unitLabel}</td>
                        <td className={td}>
                          {p.taxable ? (
                            <Badge variant="accent">Taxable</Badge>
                          ) : (
                            <span className="text-text-3">No tax</span>
                          )}
                        </td>
                        <td className={td}>{serviceName(p.serviceId) ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/*
           * The same catalogue on a phone. Seven columns will not fit in 390 px, and a sideways swipe hides
           * the price — the one thing anyone opens this page for — so each item is a card that opens the
           * editor, exactly as its row does.
           */}
          {shown.length === 0 ? null : (
            <ul className="border-t border-border md:hidden" data-testid="products-cards">
              {shown.map((p) => {
                const archived = p.archivedAt !== null;
                const bookableAs = serviceName(p.serviceId);
                return (
                  <li key={p.id} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setForm(formOf(p))}
                      data-testid={`product-card-${p.name}`}
                      data-archived={archived ? 'yes' : 'no'}
                      className={cn(
                        'flex w-full flex-col gap-1.5 px-4 py-3.5 text-left active:bg-card-2',
                        form?.id === p.id && 'bg-accent-soft',
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-[15px] font-medium',
                            archived && 'text-text-3 line-through',
                          )}
                        >
                          {p.name}
                        </span>
                        <span className="whitespace-nowrap text-[15px] font-semibold tabular-nums">
                          {money(p.unitPriceCents)}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-text-2">
                        <span>{KIND_WORDS[p.kind]}</span>
                        <span aria-hidden>·</span>
                        <span>per {p.unitLabel}</span>
                        {p.sku ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono text-[12px]">{p.sku}</span>
                          </>
                        ) : null}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {p.taxable ? (
                          <Badge variant="accent">Taxable</Badge>
                        ) : (
                          <Badge variant="gray">No tax</Badge>
                        )}
                        {archived ? <Badge variant="gray">Archived</Badge> : null}
                        {bookableAs ? (
                          <span className="text-[13px] text-text-3">
                            Customers book it as {bookableAs}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {archivedCount > 0 ? (
            <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-[13px]">
              <span className="text-text-2">
                {archivedCount} archived {archivedCount === 1 ? 'item' : 'items'}, still on the
                documents {archivedCount === 1 ? 'it’s' : 'they’re'} already on.
              </span>
              <Switch
                checked={showArchived}
                label="Show archived items"
                onChange={setShowArchived}
                testId="show-archived"
              />
            </div>
          ) : null}
        </Card>

        <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight">Maintenance plans</h2>
            <p className="mt-1 text-[13px] text-text-2">
              Plans that bill themselves live under Money → Plans, because they have members, cycles
              and a card on file.
            </p>
          </div>
          <Link
            href={`/app/w/${workspaceId}/money/plans`}
            className="inline-flex h-8 flex-none items-center gap-1.5 rounded-control border border-border-strong bg-card px-2.5 text-[13px] font-medium shadow-1 hover:bg-card-2"
            data-testid="open-plans"
          >
            Open Plans
            <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} />
          </Link>
        </Card>
      </div>

      {form ? (
        <ProductEditor
          key={form.id ?? 'new'}
          workspaceId={workspaceId}
          initial={form}
          services={services}
          products={products}
          taxRateBp={settings.tax.rateBp}
          taxName={settings.tax.name}
          onDone={() => setForm(null)}
        />
      ) : (
        <Card className="hidden p-6 text-[13px] text-text-2 xl:block">
          Pick an item to change it, or add a new one.
        </Card>
      )}
    </div>
  );
}

function ProductEditor({
  workspaceId,
  initial,
  services,
  products,
  taxRateBp,
  taxName,
  onDone,
}: {
  workspaceId: string;
  initial: Form;
  services: readonly ServiceItem[];
  products: readonly ProductRow[];
  taxRateBp: number;
  taxName: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [badPrice, setBadPrice] = useState(false);
  const invalid = !f.name.trim() || !f.unitLabel.trim() || badPrice;
  // One product per bookable service, so "AC tune-up" is one price in two places.
  const taken = new Set(
    products
      .filter((p) => p.archivedAt === null && p.serviceId && p.id !== f.id)
      .map((p) => p.serviceId!),
  );
  const bookable = services.filter((s) => !taken.has(s.id) || s.id === f.serviceId);

  async function save() {
    setBusy(true);
    try {
      const body = {
        workspaceId,
        name: f.name.trim(),
        sku: f.sku.trim() || null,
        kind: f.kind,
        unitPriceCents: f.unitPriceCents,
        unitLabel: f.unitLabel.trim(),
        taxable: f.taxable,
        serviceId: f.serviceId,
      };
      if (f.id)
        unwrap(
          await apiBrowser().POST('/v1/commands/product.update', {
            body: { ...body, productId: f.id },
          }),
        );
      else unwrap(await apiBrowser().POST('/v1/commands/product.create', { body }));
      toast.success(f.id ? `${body.name} saved.` : `${body.name} is in the catalogue.`);
      onDone();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive(archived: boolean) {
    if (!f.id) return;
    if (
      archived &&
      !confirm(
        `Archive ${f.name}? It stays on every document it’s already on, and stops showing in the picker.`,
      )
    )
      return;
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/product.archive', {
          body: { workspaceId, productId: f.id, archived },
        }),
      );
      toast.success(
        archived
          ? 'Archived. It stays on the documents it’s already on.'
          : `${f.name} is back in the picker.`,
      );
      onDone();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-[22px] py-[18px]" data-testid="product-editor">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {f.id ? initial.name : 'New product'}
          </h2>
          {f.archived ? (
            <Badge variant="gray" className="mt-1">
              Archived
            </Badge>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onDone}>
          <X className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_140px] gap-3">
        <Field label="Name" htmlFor="product-name">
          <Input
            id="product-name"
            inputSize="sm"
            value={f.name}
            maxLength={160}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            data-testid="product-name"
          />
        </Field>
        <Field
          label="Code"
          htmlFor="product-sku"
          hint="Yours to choose. It shows on the document and in exports."
        >
          <Input
            id="product-sku"
            inputSize="sm"
            value={f.sku}
            maxLength={64}
            onChange={(e) => setF({ ...f, sku: e.target.value })}
            data-testid="product-sku"
          />
        </Field>
      </div>

      <div className="mt-3">
        <span className="mb-1.5 block text-[13px] font-medium">Kind</span>
        <Segmented<Kind>
          ariaLabel="Kind"
          value={f.kind}
          onChange={(kind) => setF({ ...f, kind })}
          options={[
            { value: 'product', label: 'Product', testId: 'kind-product' },
            { value: 'service', label: 'Service', testId: 'kind-service' },
            { value: 'fee', label: 'Fee', testId: 'kind-fee' },
          ]}
        />
        <p className="mt-1.5 text-[12.5px] text-text-3">
          A product is a thing you sell, a service is time or labour, and a fee is a charge like a
          call-out.
        </p>
      </div>

      <div className="mt-3 grid grid-cols-[140px_minmax(0,1fr)] gap-3">
        <Field label="Price" htmlFor="product-price">
          <MoneyInput
            id="product-price"
            inputSize="sm"
            valueCents={f.unitPriceCents}
            onChange={(cents) => setF({ ...f, unitPriceCents: cents })}
            // MoneyInput's own "is this an amount?" call shares a name with the DOM's onInvalid, so the
            // handler takes either and only a plain true means the box can't be read.
            onInvalid={(v: boolean | SyntheticEvent<HTMLInputElement>) => setBadPrice(v === true)}
            aria-label="Price"
            data-testid="product-price"
          />
        </Field>
        <Field label="Per" htmlFor="product-unit">
          <Input
            id="product-unit"
            inputSize="sm"
            list="product-units"
            value={f.unitLabel}
            maxLength={40}
            onChange={(e) => setF({ ...f, unitLabel: e.target.value })}
            data-testid="product-unit"
          />
          <datalist id="product-units">
            {UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-border pt-3.5">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium">Charge sales tax on it</span>
          <span className="text-xs text-text-3">
            At {taxRateBp / 100}%, the {taxName.toLowerCase()} rate in Settings → Payments.
          </span>
        </span>
        <Switch
          checked={f.taxable}
          label="Charge sales tax on it"
          onChange={(taxable) => setF({ ...f, taxable })}
          testId="product-taxable"
        />
      </div>

      <div className="mt-3.5 border-t border-border pt-3.5">
        <Field
          label="Customers can book it"
          htmlFor="product-service"
          hint="Link it to a bookable service so the price is the same in both places."
        >
          <Select
            id="product-service"
            selectSize="sm"
            value={f.serviceId ?? ''}
            onChange={(e) => setF({ ...f, serviceId: e.target.value || null })}
            data-testid="product-service"
          >
            <option value="">Not bookable</option>
            {bookable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {f.id ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void archive(!f.archived)}
            data-testid="product-archive"
          >
            {f.archived ? 'Put it back' : 'Archive'}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          loading={busy}
          disabled={invalid}
          onClick={() => void save()}
          data-testid="product-save"
        >
          Save
        </Button>
      </div>
      <p className="mt-2 text-[12.5px] text-text-3">
        Archiving keeps it on every document it is already on. It just stops showing in the picker.
      </p>
    </Card>
  );
}
