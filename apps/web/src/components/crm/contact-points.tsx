'use client';
import {
  CONTACT_LABELS,
  type OtherAddressOut,
  type OtherEmailOut,
  type OtherPhoneOut,
} from '@hfos/core';
import { ArrowUp, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';

/**
 * A customer's other emails, numbers and addresses in the add and edit dialogs (0103): a row each, with an optional
 * label ("Work", "Rental"), a way to make one the main one, and blanks left out when saved.
 */

export interface PointRow {
  readonly id: string;
  readonly value: string;
  readonly label: string;
}
export interface AddressRow {
  readonly id: string;
  readonly label: string;
  readonly line1: string;
  /** Kept as it came (an import's "Apt 5", another country): the rows don't edit them, and never drop them. */
  readonly line2: string;
  readonly country: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

let seq = 0;
const rowId = () => `point-${++seq}`;
export const newPoint = (value = '', label = ''): PointRow => ({ id: rowId(), value, label });
export const newAddress = (a: Partial<Omit<AddressRow, 'id'>> = {}): AddressRow => ({
  id: rowId(),
  label: '',
  line1: '',
  line2: '',
  country: '',
  city: '',
  state: '',
  postalCode: '',
  ...a,
});

export const emailRows = (list: readonly OtherEmailOut[]) =>
  list.map((e) => newPoint(e.email, e.label ?? ''));
export const phoneRows = (list: readonly OtherPhoneOut[]) =>
  list.map((p) => newPoint(p.phone, p.label ?? ''));
export const addressRows = (list: readonly OtherAddressOut[]) =>
  list.map((a) =>
    newAddress({
      label: a.label ?? '',
      line1: a.line1 ?? '',
      line2: a.line2 ?? '',
      country: a.country ?? '',
      city: a.city ?? '',
      state: a.state ?? '',
      postalCode: a.postalCode ?? '',
    }),
  );

const filled = (r: PointRow) => !!r.value.trim();
const placed = (r: AddressRow) => [r.line1, r.city, r.postalCode].some((v) => v.trim());
export const sentPoints = (rows: readonly PointRow[]) => rows.filter(filled);
export const sentAddresses = (rows: readonly AddressRow[]) => rows.filter(placed);

/** The lists as the API takes them; a row left blank is not sent. */
export const emailsOut = (rows: readonly PointRow[]) =>
  sentPoints(rows).map((r) => ({ email: r.value.trim(), label: r.label.trim() || null }));
export const phonesOut = (rows: readonly PointRow[]) =>
  sentPoints(rows).map((r) => ({ phone: r.value.trim(), label: r.label.trim() || null }));
export const addressesOut = (rows: readonly AddressRow[]) =>
  sentAddresses(rows).map((r) => ({
    label: r.label.trim() || null,
    line1: r.line1.trim() || null,
    line2: r.line2.trim() || null,
    city: r.city.trim() || null,
    state: r.state.trim() || null,
    postalCode: r.postalCode.trim() || null,
    ...(r.country.trim() ? { country: r.country.trim() } : {}),
  }));

/** One of the others becomes the main one, and the main one takes its place in the list (or leaves it, when empty). */
export function swapMainPoint(main: string, list: readonly PointRow[], row: PointRow) {
  const was = main.trim();
  return {
    main: row.value,
    list: was
      ? list.map((r) => (r.id === row.id ? newPoint(was) : r))
      : list.filter((r) => r.id !== row.id),
  };
}

/** The main address as a dialog holds it: the parts it shows, and the second line and country it carries along. */
export interface MainAddressForm {
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}
/** Every part moves with its address, the ones the dialog doesn't show too, so nothing is mixed or lost. */
export function swapMainAddress(
  main: MainAddressForm,
  list: readonly AddressRow[],
  row: AddressRow,
) {
  const hadOne = [main.line1, main.city, main.postalCode].some((v) => v.trim());
  const was = {
    line1: main.line1,
    line2: main.line2,
    city: main.city,
    state: main.state,
    postalCode: main.postalCode,
    country: main.country,
  };
  return {
    main: {
      line1: row.line1,
      line2: row.line2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country || main.country,
    },
    list: hadOne
      ? list.map((r) => (r.id === row.id ? newAddress(was) : r))
      : list.filter((r) => r.id !== row.id),
  };
}

/** The other lists as they were stored when a dialog opened: what an edit says it saw (see editedOnly). */
export const storedLists = (r: {
  readonly otherEmails: readonly OtherEmailOut[];
  readonly otherPhones: readonly OtherPhoneOut[];
  readonly otherAddresses: readonly OtherAddressOut[];
}) => ({
  otherEmails: r.otherEmails.map((e) => ({ email: e.email, label: e.label })),
  otherPhones: r.otherPhones.map((x) => ({ phone: x.phoneE164, label: x.label })),
  otherAddresses: r.otherAddresses.map((a) => ({
    label: a.label,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    country: a.country,
  })),
});

/** Every list's row errors from one failed save, or nothing. */
export const listErrorsOf = (
  e: unknown,
  f: {
    readonly otherEmails: readonly PointRow[];
    readonly otherPhones: readonly PointRow[];
    readonly otherAddresses: readonly AddressRow[];
  },
): Record<string, string> => ({
  ...rowErrors(e, 'otherEmails', sentPoints(f.otherEmails)),
  ...rowErrors(e, 'otherPhones', sentPoints(f.otherPhones)),
  ...rowErrors(e, 'otherAddresses', sentAddresses(f.otherAddresses)),
});

/**
 * A validation error's messages for one list, by row: the server names `otherPhones.1.phone`, and the second row it
 * was sent is the second row that had something in it.
 */
export function rowErrors(
  e: unknown,
  list: 'otherEmails' | 'otherPhones' | 'otherAddresses',
  sent: readonly { readonly id: string }[],
): Record<string, string> {
  if (!(e instanceof ApiError) || e.code !== 'validation' || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const parts = (Array.isArray(d.path) ? d.path.map(String) : String(d.path ?? '').split(/[./]/))
      .map((p) => p.trim())
      .filter(Boolean);
    const at = parts.indexOf(list);
    const index = at >= 0 ? Number(parts[at + 1]) : NaN;
    const row = Number.isInteger(index) ? sent[index] : undefined;
    if (row && typeof d.message === 'string' && !(row.id in out)) out[row.id] = d.message;
  }
  return out;
}

function LabelInput({
  kind,
  value,
  onChange,
  name,
}: {
  kind: keyof typeof CONTACT_LABELS;
  value: string;
  onChange: (v: string) => void;
  name: string;
}) {
  return (
    <>
      <Input
        aria-label={`${name} label`}
        placeholder="Label"
        value={value}
        maxLength={40}
        list={`contact-labels-${kind}`}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <datalist id={`contact-labels-${kind}`}>
        {CONTACT_LABELS[kind].map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-menu text-text-3 hover:bg-card-2 hover:text-text"
    >
      {children}
    </button>
  );
}

/** The other numbers or emails: label, value, make it the main one, take it off. */
export function OtherPoints({
  kind,
  rows,
  onChange,
  onMakeMain,
  errors,
}: {
  kind: 'email' | 'phone';
  rows: readonly PointRow[];
  onChange: (rows: PointRow[]) => void;
  /** Swaps this one with the main one. */
  onMakeMain: (row: PointRow) => void;
  errors: Record<string, string>;
}) {
  const noun = kind === 'email' ? 'email' : 'number';
  const set = (id: string, patch: Partial<PointRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2" data-testid={`other-${kind}s`}>
      {rows.map((r, i) => (
        <div key={r.id}>
          <div className="grid grid-cols-[104px_1fr_auto_auto] items-center gap-2">
            <LabelInput
              kind={kind}
              value={r.label}
              onChange={(label) => set(r.id, { label })}
              name={`Other ${noun} ${i + 1}`}
            />
            <Input
              aria-label={`Other ${noun} ${i + 1}`}
              type={kind === 'email' ? 'email' : 'tel'}
              inputMode={kind === 'email' ? 'email' : 'tel'}
              placeholder={kind === 'email' ? 'another@example.com' : '(713) 555-0101'}
              value={r.value}
              invalid={!!errors[r.id]}
              onChange={(e) => set(r.id, { value: e.target.value })}
              autoComplete="off"
              data-testid={`other-${kind}-${i}`}
            />
            <RowButton label={`Make this the main ${noun}`} onClick={() => onMakeMain(r)}>
              <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
            </RowButton>
            <RowButton
              label={`Remove this ${noun}`}
              onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </RowButton>
          </div>
          {errors[r.id] ? (
            <p role="alert" className="mt-1 text-[12.5px] text-danger-text">
              {errors[r.id]}
            </p>
          ) : null}
        </div>
      ))}
      {rows.length < 20 ? (
        <button
          type="button"
          onClick={() => onChange([...rows, newPoint()])}
          className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-accent-text hover:underline"
          data-testid={`add-other-${kind}`}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add another {noun}
        </button>
      ) : null}
    </div>
  );
}

/** The other addresses: label, street, town, state, ZIP; make it the main one, take it off. */
export function OtherAddresses({
  rows,
  onChange,
  onMakeMain,
  errors,
}: {
  rows: readonly AddressRow[];
  onChange: (rows: AddressRow[]) => void;
  onMakeMain: (row: AddressRow) => void;
  errors: Record<string, string>;
}) {
  const set = (id: string, patch: Partial<AddressRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-3" data-testid="other-addresses">
      {rows.map((r, i) => (
        <div key={r.id} className="rounded-menu border border-border p-2.5">
          <div className="grid grid-cols-[104px_1fr_auto_auto] items-center gap-2">
            <LabelInput
              kind="address"
              value={r.label}
              onChange={(label) => set(r.id, { label })}
              name={`Other address ${i + 1}`}
            />
            <Input
              aria-label={`Other address ${i + 1}`}
              placeholder="12 Oak St"
              value={r.line1}
              invalid={!!errors[r.id]}
              onChange={(e) => set(r.id, { line1: e.target.value })}
              autoComplete="off"
              data-testid={`other-address-${i}`}
            />
            <RowButton label="Make this the main address" onClick={() => onMakeMain(r)}>
              <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
            </RowButton>
            <RowButton
              label="Remove this address"
              onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </RowButton>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_72px_96px] gap-2">
            <Input
              aria-label={`Other address ${i + 1} city`}
              placeholder="City"
              value={r.city}
              onChange={(e) => set(r.id, { city: e.target.value })}
              autoComplete="off"
            />
            <Input
              aria-label={`Other address ${i + 1} state`}
              placeholder="State"
              value={r.state}
              onChange={(e) => set(r.id, { state: e.target.value })}
              autoComplete="off"
            />
            <Input
              aria-label={`Other address ${i + 1} ZIP`}
              placeholder="ZIP"
              value={r.postalCode}
              onChange={(e) => set(r.id, { postalCode: e.target.value })}
              autoComplete="off"
            />
          </div>
          {errors[r.id] ? (
            <p role="alert" className="mt-1 text-[12.5px] text-danger-text">
              {errors[r.id]}
            </p>
          ) : null}
        </div>
      ))}
      {rows.length < 20 ? (
        <button
          type="button"
          onClick={() => onChange([...rows, newAddress()])}
          className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-accent-text hover:underline"
          data-testid="add-other-address"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add another address
        </button>
      ) : null}
    </div>
  );
}
