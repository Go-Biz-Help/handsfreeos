'use client';
import {
  conditionValueProblem,
  DURATION_UNITS,
  fieldDef,
  isConditionGroup,
  OPERATOR_LABELS,
  OPERATORS_BY_TYPE,
  type AnyConditionGroup,
  type Condition,
  type ConditionGroup,
  type DurationUnit,
  type FieldDef,
  type Operator,
} from '@hfos/core';
import { Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { FieldError, Hint } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import {
  defaultConditionValue,
  defaultOperator,
  fieldsFor,
  GROUP_LABELS,
  isDurationOp,
  isListOp,
  refOptions,
  takesValue,
  type ConditionPlace,
} from '@/lib/workflows/fields';
import type { ApplyOutcome } from '@/lib/workflows/use-draft';
import { cn } from '@/lib/utils';
import { useEditor } from '../editor-context';

type Item = Condition | AnyConditionGroup;
const MAX_DEPTH = 3;

/**
 * All/any groups of checks, at most 3 deep, over the fields known at this point in the workflow. Every
 * change hands back the whole group; a check that doesn't fit yet (a number field left blank) is shown but
 * not saved.
 */
export function ConditionsEditor({
  group,
  onChange,
  place,
  label,
  hint,
  emptyNote,
  addLabel = 'Add a rule',
  testId,
}: {
  group: ConditionGroup;
  onChange: (next: ConditionGroup) => ApplyOutcome;
  place: ConditionPlace;
  label?: ReactNode;
  hint?: ReactNode;
  emptyNote?: string;
  addLabel?: string;
  testId?: string;
}) {
  const { def } = useEditor();
  const fields = useMemo(() => fieldsFor(def, place), [def, place]);
  const [error, setError] = useState<string | null>(null);
  const commit = (next: AnyConditionGroup) => {
    const out = onChange(next as ConditionGroup);
    setError(out.ok ? null : out.message);
    return out;
  };
  return (
    <div className="mb-3.5 last:mb-0" data-testid={testId}>
      {label ? <div className="mb-[5px] text-[13px] font-medium">{label}</div> : null}
      <GroupBox
        group={group}
        depth={1}
        fields={fields}
        onChange={commit}
        emptyNote={emptyNote}
        addLabel={addLabel}
      />
      {error ? (
        <FieldError>{error}</FieldError>
      ) : hint ? (
        <Hint className="mt-[5px]">{hint}</Hint>
      ) : null}
    </div>
  );
}

function GroupBox({
  group,
  depth,
  fields,
  onChange,
  onRemove,
  emptyNote,
  addLabel,
}: {
  group: AnyConditionGroup;
  depth: number;
  fields: readonly FieldDef[];
  onChange: (next: AnyConditionGroup) => ApplyOutcome;
  onRemove?: () => void;
  emptyNote?: string;
  addLabel: string;
}) {
  const { catalogs, readOnly } = useEditor();
  const set = (conditions: readonly Item[]) => onChange({ match: group.match, conditions });
  const replace = (i: number, next: Item) =>
    set(group.conditions.map((c, j) => (j === i ? next : c)));
  const remove = (i: number) => set(group.conditions.filter((_, j) => j !== i));
  const newRule = (): Condition | null => {
    for (const f of fields) {
      const op = defaultOperator(f, catalogs);
      if (op) return { field: f.key, op, value: defaultConditionValue(f, op, catalogs) ?? null };
    }
    return null;
  };
  const addRule = () => {
    const rule = newRule();
    if (rule) set([...group.conditions, rule]);
  };
  const addGroup = () => {
    const rule = newRule();
    if (rule) set([...group.conditions, { match: 'any', conditions: [rule] }]);
  };
  return (
    <div
      className={cn(
        'flex flex-col gap-[7px] rounded-[10px] border border-border p-2.5',
        depth % 2 ? 'bg-card-2' : 'bg-card',
      )}
    >
      {group.conditions.length > 1 || depth > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-flex h-5 items-center rounded-[5px] bg-card-3 px-[7px] text-[11px] font-semibold uppercase tracking-[0.03em] text-text-2">
              {group.match}
            </span>
            <span className="text-xs text-text-3">of these</span>
          </span>
          <span className="flex items-center gap-1">
            {readOnly ? null : (
              <span
                className="inline-flex rounded-control bg-card-3/60 p-0.5"
                role="radiogroup"
                aria-label="Match"
              >
                {(['all', 'any'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={group.match === m}
                    onClick={() => onChange({ match: m, conditions: group.conditions })}
                    className={cn(
                      'h-[22px] rounded-[6px] px-2 text-xs font-medium',
                      group.match === m
                        ? 'bg-card text-text shadow-1'
                        : 'text-text-2 hover:text-text',
                    )}
                  >
                    {m === 'all' ? 'All' : 'Any'}
                  </button>
                ))}
              </span>
            )}
            {onRemove && !readOnly ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-[26px] w-[26px]"
                title="Remove the group"
                aria-label="Remove the group"
                onClick={onRemove}
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {group.conditions.map((c, i) =>
        isConditionGroup(c) ? (
          <GroupBox
            key={i}
            group={c}
            depth={depth + 1}
            fields={fields}
            onChange={(next) => replace(i, next)}
            onRemove={() => remove(i)}
            addLabel={addLabel}
          />
        ) : (
          <ConditionRow
            key={i}
            c={c}
            fields={fields}
            onChange={(next) => replace(i, next)}
            onRemove={() => remove(i)}
          />
        ),
      )}
      {!group.conditions.length && emptyNote ? (
        <p className="text-[12.5px] text-text-3">{emptyNote}</p>
      ) : null}
      {readOnly ? null : (
        <span className="flex flex-wrap gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5"
            onClick={addRule}
            data-testid="add-rule"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            {addLabel}
          </Button>
          {depth < MAX_DEPTH ? (
            <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={addGroup}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Add a group
            </Button>
          ) : null}
        </span>
      )}
    </div>
  );
}

function ConditionRow({
  c,
  fields,
  onChange,
  onRemove,
}: {
  c: Condition;
  fields: readonly FieldDef[];
  onChange: (next: Condition) => ApplyOutcome;
  onRemove: () => void;
}) {
  const { catalogs, readOnly } = useEditor();
  const f = fieldDef(c.field);
  const list = fields.some((x) => x.key === c.field) || !f ? fields : [...fields, f];
  const groups = [...new Set(list.map((x) => x.group))];
  const ops = f ? OPERATORS_BY_TYPE[f.type] : [];
  const setField = (key: string) => {
    const nf = fieldDef(key);
    if (!nf) return;
    const op = defaultOperator(nf, catalogs);
    if (!op) return;
    onChange({ field: key, op, value: defaultConditionValue(nf, op, catalogs) ?? null });
  };
  const setOp = (op: Operator) => {
    if (!f) return;
    const keep = conditionValueProblem(f, op, c.value) === null;
    onChange({
      field: c.field,
      op,
      value: keep ? c.value : (defaultConditionValue(f, op, catalogs) ?? null),
    });
  };
  return (
    <div
      className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_26px] items-center gap-1.5"
      data-testid="condition-row"
    >
      <Select
        selectSize="sm"
        aria-label="Field"
        className="px-2 pr-7 text-[13px]"
        value={c.field}
        disabled={readOnly}
        onChange={(e) => setField(e.target.value)}
      >
        {groups.map((g) => (
          <optgroup key={g} label={GROUP_LABELS[g]}>
            {list
              .filter((x) => x.group === g)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      <Select
        selectSize="sm"
        aria-label="Check"
        className="px-2 pr-7 text-[13px]"
        value={c.op}
        disabled={readOnly}
        onChange={(e) => setOp(e.target.value as Operator)}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </Select>
      {f && takesValue(c.op) ? <ValueInput f={f} c={c} onChange={onChange} /> : <span />}
      {readOnly ? (
        <span />
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-[26px] w-[26px]"
          title="Remove"
          aria-label="Remove the rule"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}

function ValueInput({
  f,
  c,
  onChange,
}: {
  f: FieldDef;
  c: Condition;
  onChange: (next: Condition) => ApplyOutcome;
}) {
  const { catalogs, readOnly } = useEditor();
  const set = (value: unknown) => onChange({ ...c, value });
  const cls = 'px-2 text-[13px]';

  if (isDurationOp(c.op)) {
    const d = (c.value ?? { amount: 1, unit: 'days' }) as { amount: number; unit: DurationUnit };
    return (
      <span className="flex min-w-0 gap-1">
        <TextValue
          value={String(d.amount)}
          numeric
          label="How many"
          onCommit={(t) => {
            const n = Number(t);
            if (!/^\d+$/.test(t) || n < 1 || n > 1000) return false;
            return set({ amount: n, unit: d.unit }).ok;
          }}
        />
        <Select
          selectSize="sm"
          aria-label="Unit"
          className={cn(cls, 'pr-6')}
          value={d.unit}
          disabled={readOnly}
          onChange={(e) => set({ amount: d.amount, unit: e.target.value })}
        >
          {DURATION_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </span>
    );
  }
  if (c.op === 'before' || c.op === 'after')
    return (
      <Input
        type="date"
        inputSize="sm"
        aria-label="Date"
        className={cls}
        value={typeof c.value === 'string' ? c.value.slice(0, 10) : ''}
        readOnly={readOnly}
        onChange={(e) => {
          if (e.target.value) set(e.target.value);
        }}
      />
    );
  const options =
    f.type === 'enum'
      ? (f.options ?? []).map((o) => ({ value: o.value, label: o.label }))
      : (f.type === 'ref' || f.type === 'tags') && f.refKind
        ? refOptions(f.refKind, catalogs)
        : null;
  if (options) {
    if (isListOp(c.op)) {
      const picked = Array.isArray(c.value) ? (c.value as unknown[]).map(String) : [];
      return (
        <Select
          selectSize="sm"
          aria-label="Values"
          className={cls}
          value=""
          disabled={readOnly}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            set(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
          }}
        >
          <option value="">
            {picked.length
              ? picked.map((p) => options.find((o) => o.value === p)?.label ?? 'Gone').join(', ')
              : 'Pick…'}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {picked.includes(o.value) ? `✓ ${o.label}` : o.label}
            </option>
          ))}
        </Select>
      );
    }
    const current = typeof c.value === 'string' ? c.value : '';
    const known = options.some((o) => o.value === current);
    return (
      <Select
        selectSize="sm"
        aria-label="Value"
        className={cn(cls, !known && 'border-danger')}
        value={known ? current : ''}
        disabled={readOnly}
        onChange={(e) => set(e.target.value)}
      >
        {!known ? (
          <option value="" disabled>
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
  if (f.type === 'number')
    return (
      <TextValue
        value={typeof c.value === 'number' ? String(c.value) : ''}
        numeric
        label="Value"
        onCommit={(t) => {
          const n = Number(t);
          if (t.trim() === '' || !Number.isFinite(n)) return false;
          return set(n).ok;
        }}
      />
    );
  return (
    <TextValue
      value={typeof c.value === 'string' ? c.value : ''}
      label="Value"
      onCommit={(t) => set(t).ok}
    />
  );
}

/** A typed value kept as typed; saved when it fits. */
function TextValue({
  value,
  onCommit,
  numeric,
  label,
}: {
  value: string;
  onCommit: (text: string) => boolean;
  numeric?: boolean;
  label: string;
}) {
  const { readOnly } = useEditor();
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [bad, setBad] = useState(false);
  if (value !== seen) {
    setSeen(value);
    if (value !== text.trim()) setText(value);
  }
  return (
    <Input
      inputSize="sm"
      aria-label={label}
      inputMode={numeric ? 'decimal' : undefined}
      className="min-w-0 px-2 text-[13px]"
      value={text}
      invalid={bad}
      readOnly={readOnly}
      onChange={(e) => {
        setText(e.target.value);
        setBad(!onCommit(e.target.value));
      }}
    />
  );
}
