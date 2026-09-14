'use client';
import {
  DURATION_UNITS,
  type AssignTo,
  type Duration,
  type DurationUnit,
  type Ref,
  type RefKind,
  type WorkflowCatalogs,
} from '@hfos/core';
import { Info, Plus, X, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { refOptions } from '@/lib/workflows/fields';
import type { ApplyOptions, ApplyOutcome } from '@/lib/workflows/use-draft';
import { cn } from '@/lib/utils';
import { useEditor } from '../editor-context';

/** A panel field: label, control, then an error or a hint (the design's `.pf`). */
export function PanelField({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3.5 last:mb-0', className)}>
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="mb-[5px]">
          {label}
        </Label>
      ) : (
        <div className="mb-[5px] text-[13px] font-medium text-text">{label}</div>
      )}
      {children}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : hint ? (
        <Hint className="mt-[5px]">{hint}</Hint>
      ) : null}
    </div>
  );
}

/** A quiet note (the design's `.qh`). */
export function Note({
  icon: Icon = Info,
  children,
  className,
  testId,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2',
        className,
      )}
    >
      <Icon className="mt-px h-3.5 w-3.5 flex-none text-text-3" strokeWidth={1.75} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * A text the user types into a step: shown as typed, committed as an op when valid, with the refusal shown
 * beside the field while it isn't (an empty message, say). The step's saved value wins again after Undo.
 */
export function useDraftText(
  value: string,
  commit: (next: string) => ApplyOutcome,
): { value: string; change: (next: string) => void; error: string | null } {
  const [local, setLocal] = useState(value);
  const [seen, setSeen] = useState(value);
  const [error, setError] = useState<string | null>(null);
  if (value !== seen) {
    setSeen(value);
    // Core trims what's saved; keep what's being typed when it saved as the same thing.
    if (value !== local.trim() && value !== local) {
      setLocal(value);
      setError(null);
    }
  }
  const change = (next: string) => {
    setLocal(next);
    const out = commit(next);
    setError(out.ok ? null : out.message);
  };
  return { value: local, change, error };
}

/** Changes to one step, as `update_step` ops. Typing uses a `group` so it's one Undo step. */
export function useStepUpdate(stepId: string) {
  const { apply } = useEditor();
  return (patch: Record<string, unknown>, label: string, options: ApplyOptions = {}) =>
    apply([{ op: 'update_step', stepId, patch }], label, {
      ...options,
      group: options.group ? `${stepId}:${options.group}` : undefined,
    });
}

const UNIT_LABELS: Record<DurationUnit, [string, string]> = {
  minutes: ['minute', 'minutes'],
  hours: ['hour', 'hours'],
  days: ['day', 'days'],
  weeks: ['week', 'weeks'],
};

/** A number and a unit ("2 days"). An amount out of range is shown but not saved. */
export function DurationInput({
  value,
  onChange,
  label,
  min = 1,
  max = 1000,
  testId,
}: {
  value: { amount: number; unit: DurationUnit };
  onChange: (next: { amount: number; unit: DurationUnit }) => ApplyOutcome | void;
  label: string;
  min?: number;
  max?: number;
  testId?: string;
}) {
  const { readOnly } = useEditor();
  const [text, setText] = useState(String(value.amount));
  const [seen, setSeen] = useState(value.amount);
  if (value.amount !== seen) {
    setSeen(value.amount);
    setText(String(value.amount));
  }
  const bad = !/^\d+$/.test(text) || Number(text) < min || Number(text) > max;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        inputSize="sm"
        inputMode="numeric"
        aria-label={`${label}: how many`}
        className="h-8 w-[72px] px-2.5 text-[13.5px] tabular-nums"
        value={text}
        invalid={bad}
        readOnly={readOnly}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (/^\d+$/.test(e.target.value) && n >= min && n <= max)
            onChange({ amount: n, unit: value.unit });
        }}
      />
      <Select
        selectSize="sm"
        aria-label={`${label}: unit`}
        className="h-8 w-auto text-[13.5px]"
        value={value.unit}
        disabled={readOnly}
        onChange={(e) => onChange({ amount: value.amount, unit: e.target.value as DurationUnit })}
      >
        {DURATION_UNITS.map((u) => (
          <option key={u} value={u}>
            {UNIT_LABELS[u][value.amount === 1 ? 0 : 1]}
          </option>
        ))}
      </Select>
    </span>
  );
}

/** A duration or nothing ("No due time"). */
export function OptionalDuration({
  value,
  onChange,
  label,
  noneLabel,
  fallback = { amount: 1, unit: 'days' },
}: {
  value: Duration | null;
  onChange: (next: Duration | null) => ApplyOutcome | void;
  label: string;
  noneLabel: string;
  fallback?: Duration;
}) {
  const { readOnly } = useEditor();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select
        selectSize="sm"
        aria-label={label}
        className="w-auto"
        value={value ? 'in' : 'none'}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value === 'in' ? fallback : null)}
      >
        <option value="none">{noneLabel}</option>
        <option value="in">In…</option>
      </Select>
      {value ? <DurationInput label={label} value={value} onChange={onChange} /> : null}
    </span>
  );
}

const refLabel = (ref: Ref | null | undefined, kind: RefKind, c: WorkflowCatalogs) => {
  if (!ref) return null;
  if (typeof ref !== 'string') return `Pick ${ref.$ph.replace(/_/g, ' ')}`;
  return refOptions(kind, c).find((o) => o.value === ref)?.label ?? null;
};

/** Pick a stage, tag, calendar, person or workflow. A placeholder or a removed one reads "Pick …". */
export function RefSelect({
  kind,
  value,
  onChange,
  id,
  label,
  none,
  exclude,
  testId,
}: {
  kind: RefKind;
  value: Ref | null;
  onChange: (next: string | null) => ApplyOutcome | void;
  id?: string;
  label: string;
  /** Offer "nothing" with this label (a null value). */
  none?: string;
  exclude?: readonly string[];
  testId?: string;
}) {
  const { catalogs, readOnly } = useEditor();
  const options = refOptions(kind, catalogs).filter((o) => !exclude?.includes(o.value));
  const current = typeof value === 'string' ? value : '';
  const known = options.some((o) => o.value === current);
  const missing = value !== null && !known;
  return (
    <Select
      id={id}
      selectSize="sm"
      aria-label={label}
      className={cn(missing && 'border-danger')}
      value={known ? current : value === null ? '__none' : '__missing'}
      disabled={readOnly}
      data-testid={testId}
      onChange={(e) =>
        onChange(
          e.target.value === '__none' || e.target.value === '__missing' ? null : e.target.value,
        )
      }
    >
      {none ? <option value="__none">{none}</option> : null}
      {missing ? (
        <option value="__missing" disabled>
          {refLabel(value, kind, catalogs) ?? 'Pick one (the one chosen is gone)'}
        </option>
      ) : null}
      {!none && value === null ? (
        <option value="__none" disabled>
          Pick one
        </option>
      ) : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

/** Who gets the work: a named person, the lead's assignee, the customer's owner or no one. */
export function AssignToSelect({
  value,
  onChange,
  label,
  id,
  withLead,
  allowNobody = true,
}: {
  value: AssignTo;
  onChange: (next: AssignTo) => ApplyOutcome | void;
  label: string;
  id?: string;
  withLead: boolean;
  allowNobody?: boolean;
}) {
  const { catalogs, readOnly } = useEditor();
  const people = refOptions('user', catalogs);
  const current =
    value.kind === 'user'
      ? typeof value.userId === 'string'
        ? `user:${value.userId}`
        : '__missing'
      : value.kind;
  const known =
    current === '__missing' ||
    !current.startsWith('user:') ||
    people.some((p) => `user:${p.value}` === current);
  return (
    <Select
      id={id}
      selectSize="sm"
      aria-label={label}
      className={cn((!known || current === '__missing') && 'border-danger')}
      value={known ? current : '__missing'}
      disabled={readOnly}
      onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith('user:')) onChange({ kind: 'user', userId: v.slice(5) });
        else if (v === 'lead_assignee' || v === 'person_owner' || v === 'nobody')
          onChange({ kind: v });
      }}
    >
      {withLead || value.kind === 'lead_assignee' ? (
        <option value="lead_assignee">The lead’s assignee</option>
      ) : null}
      <option value="person_owner">The customer’s owner</option>
      {allowNobody ? <option value="nobody">No one</option> : null}
      {!known || current === '__missing' ? (
        <option value="__missing" disabled>
          Pick someone (the one chosen left)
        </option>
      ) : null}
      <optgroup label="The team">
        {people.map((p) => (
          <option key={p.value} value={`user:${p.value}`}>
            {p.label}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}

/** Named people as tags with ×, and "+ Add". */
export function PeoplePicker({
  userIds,
  onChange,
  label,
}: {
  userIds: readonly Ref[];
  onChange: (next: string[]) => ApplyOutcome | void;
  label: string;
}) {
  const { catalogs, readOnly } = useEditor();
  const people = refOptions('user', catalogs);
  const ids = userIds.filter((u): u is string => typeof u === 'string');
  const left = people.filter((p) => !ids.includes(p.value));
  const name = (id: string) =>
    catalogs.team.find((p) => p.userId === id)?.name ?? 'Someone who left';
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={label} role="group">
      {ids.map((id) => (
        <span
          key={id}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card pl-[3px] pr-1 text-[13px]"
        >
          <Avatar name={name(id)} seed={id} size="sm" className="h-5 w-5 text-[9px]" />
          {name(id)}
          {readOnly ? null : (
            <button
              type="button"
              aria-label={`Remove ${name(id)}`}
              onClick={() => onChange(ids.filter((x) => x !== id))}
              className="rounded-full p-0.5 text-text-3 hover:bg-card-2 hover:text-text"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && left.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-[26px] px-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {left.map((p) => (
              <DropdownMenuItem key={p.value} onSelect={() => onChange([...ids, p.value])}>
                <Avatar name={p.label} seed={p.value} size="sm" />
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** A pick-one row with a dot (the design's `.rc`), with room for inputs when picked. */
export function RadioRow({
  on,
  onSelect,
  title,
  detail,
  children,
  testId,
}: {
  on: boolean;
  onSelect: () => void;
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  const { readOnly } = useEditor();
  const id = useId();
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-[9px] border px-2.5 py-2 text-[13px] leading-[1.4] transition-colors',
        on
          ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
          : 'border-border-strong bg-card',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-labelledby={id}
        disabled={readOnly}
        onClick={onSelect}
        data-testid={testId}
        className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] border-border-strong focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring aria-checked:border-accent"
      >
        {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
      </button>
      <span className="min-w-0 flex-1">
        <span
          id={id}
          className="block cursor-pointer font-semibold"
          onClick={() => {
            if (!readOnly) onSelect();
          }}
        >
          {title}
        </span>
        {detail ? <span className="mt-px block text-xs text-text-2">{detail}</span> : null}
        {on && children ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">{children}</span>
        ) : null}
      </span>
    </div>
  );
}

/** The design's pill chips (Starts when: Event, Schedule…). */
export function ChipChoice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  const { readOnly } = useEditor();
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={readOnly && o.value !== value}
          onClick={() => onChange(o.value)}
          data-testid={`chip-${o.value}`}
          className={cn(
            'inline-flex h-7 items-center rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
            o.value === value
              ? 'border-transparent bg-accent-soft text-accent-text'
              : 'border-border-strong bg-card text-text-2 hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday toggles, Sunday first (0). */
export function DayPicker({
  days,
  onChange,
  label,
}: {
  days: readonly number[];
  onChange: (next: number[]) => void;
  label: string;
}) {
  const { readOnly } = useEditor();
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {DAYS.map((d, i) => {
        const on = days.includes(i);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            disabled={readOnly}
            onClick={() =>
              onChange(on ? days.filter((x) => x !== i) : [...days, i].sort((a, b) => a - b))
            }
            className={cn(
              'inline-flex h-7 min-w-[40px] items-center justify-center rounded-full border px-2 text-xs font-medium',
              on
                ? 'border-transparent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:text-text',
            )}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}
