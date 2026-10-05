'use client';
/**
 * The duty editor's pieces (board 8): when a duty is due, what finishes it, and its reminders, each written the way
 * the catalog writes them and checked by the same schemas when saved (packages/core/src/addons/realestate/editor.ts).
 */
import {
  DEAL_FIELDS,
  DOCUMENT_KINDS,
  type DealField,
  type DocumentKind,
  type ProofItem,
  type ProofRule,
} from '@hfos/core/addons/realestate/catalog/types';
import type { DueRule } from '@hfos/core/addons/realestate/dates/due';
import {
  KEY_DATES,
  KEY_DATE_KEYS,
  type KeyDateKey,
} from '@hfos/core/addons/realestate/dates/key-dates';
import { proofItemWords } from '@hfos/core/addons/realestate/proof';
import { dueRuleWords } from '@hfos/core/addons/realestate/rule-words';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';

type Leaf = Exclude<DueRule, { kind: 'earliest' | 'latest' }>;
type Unit = 'days' | 'businessDays' | 'hours';

const num = (s: string, fallback: number) => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** When it's due: no deadline, ongoing, some time after it starts, before or after a key date, or every few days. */
export function DueRuleEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: DueRule;
  onChange: (rule: DueRule) => void;
  idPrefix: string;
}) {
  if (value.kind === 'earliest' || value.kind === 'latest')
    return (
      <div className="space-y-2 text-[13.5px]">
        <p>{dueRuleWords(value)}</p>
        <Button size="sm" variant="ghost" onClick={() => onChange(value.of[0] as Leaf)}>
          Use one rule instead
        </Button>
      </div>
    );
  const leaf = value;
  const set = (kind: Leaf['kind']) => {
    if (kind === 'none' || kind === 'ongoing') onChange({ kind });
    else if (kind === 'every') onChange({ kind, days: 7 });
    else if (kind === 'after_start') onChange({ kind, days: 2 });
    else onChange({ kind: 'relative', to: 'closing', days: -3 });
  };
  const unitOf = (r: { days?: number; businessDays?: number; hours?: number }): Unit =>
    r.businessDays !== undefined ? 'businessDays' : r.hours !== undefined ? 'hours' : 'days';
  return (
    <div className="space-y-2">
      <Select
        id={`${idPrefix}-kind`}
        value={leaf.kind}
        onChange={(e) => set(e.target.value as Leaf['kind'])}
        aria-label="How it’s due"
      >
        <option value="relative">Before or after a key date</option>
        <option value="after_start">Some time after it starts</option>
        <option value="every">Again every few days</option>
        <option value="ongoing">Kept up while the deal is open</option>
        <option value="none">No deadline</option>
      </Select>
      {leaf.kind === 'after_start' ? (
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          <span>Within</span>
          <Input
            className="w-20"
            inputMode="numeric"
            aria-label="How many"
            value={String(leaf.hours ?? leaf.businessDays ?? leaf.days ?? 1)}
            onChange={(e) => {
              const n = Math.max(1, num(e.target.value, 1));
              const u = unitOf(leaf);
              onChange({ kind: 'after_start', [u]: n });
            }}
          />
          <Select
            className="w-40"
            aria-label="Unit"
            value={unitOf(leaf)}
            onChange={(e) =>
              onChange({
                kind: 'after_start',
                [e.target.value]: leaf.hours ?? leaf.businessDays ?? leaf.days ?? 1,
              })
            }
          >
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="businessDays">business days</option>
          </Select>
          <span>of it starting</span>
        </div>
      ) : null}
      {leaf.kind === 'every' ? (
        <div className="flex items-center gap-2 text-[13.5px]">
          <span>Every</span>
          <Input
            className="w-20"
            inputMode="numeric"
            aria-label="Days"
            value={String(leaf.days)}
            onChange={(e) =>
              onChange({ kind: 'every', days: Math.min(365, Math.max(1, num(e.target.value, 1))) })
            }
          />
          <span>days while it’s open</span>
        </div>
      ) : null}
      {leaf.kind === 'relative' ? <RelativeEditor rule={leaf} onChange={onChange} /> : null}
      <p className="text-[12.5px] text-text-3">{dueRuleWords(value)}</p>
    </div>
  );
}

function RelativeEditor({
  rule,
  onChange,
}: {
  rule: Extract<DueRule, { kind: 'relative' }>;
  onChange: (rule: DueRule) => void;
}) {
  const unit: Unit =
    rule.businessDays !== undefined ? 'businessDays' : rule.hours !== undefined ? 'hours' : 'days';
  const by = rule.businessDays ?? rule.hours ?? rule.days ?? 0;
  const dir = by < 0 ? 'before' : by > 0 ? 'after' : 'on';
  const make = (n: number, u: Unit, d: string, to: KeyDateKey, at?: string) => {
    const signed = d === 'on' ? 0 : d === 'before' ? -Math.abs(n) : Math.abs(n);
    onChange({
      kind: 'relative',
      to,
      ...(signed ? { [u]: signed } : {}),
      ...(at ? { at } : {}),
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
      {dir !== 'on' ? (
        <>
          <Input
            className="w-20"
            inputMode="numeric"
            aria-label="How many"
            value={String(Math.abs(by))}
            onChange={(e) => make(Math.max(0, num(e.target.value, 0)), unit, dir, rule.to, rule.at)}
          />
          <Select
            className="w-36"
            aria-label="Unit"
            value={unit}
            onChange={(e) => make(Math.abs(by), e.target.value as Unit, dir, rule.to, rule.at)}
          >
            <option value="days">days</option>
            <option value="businessDays">business days</option>
            <option value="hours">hours</option>
          </Select>
        </>
      ) : null}
      <Select
        className="w-28"
        aria-label="Before, on or after"
        value={dir}
        onChange={(e) => make(Math.abs(by) || 1, unit, e.target.value, rule.to, rule.at)}
      >
        <option value="before">before</option>
        <option value="on">on</option>
        <option value="after">after</option>
      </Select>
      <Select
        className="w-56"
        aria-label="Which date"
        value={rule.to}
        onChange={(e) => make(Math.abs(by), unit, dir, e.target.value as KeyDateKey, rule.at)}
      >
        {KEY_DATE_KEYS.map((k) => (
          <option key={k} value={k}>
            {KEY_DATES[k].label.toLowerCase()}
          </option>
        ))}
      </Select>
      <Input
        type="time"
        className="w-32"
        aria-label="At a time (optional)"
        value={rule.at ?? ''}
        onChange={(e) => make(Math.abs(by), unit, dir, rule.to, e.target.value || undefined)}
      />
    </div>
  );
}

type Adding =
  'document' | 'file' | 'note' | 'attestation' | 'appointment' | 'message' | 'dates' | 'deal_field';

/** What finishes a duty: nothing but saying so, or all (or any one) of a few kinds of proof. */
export function ProofEditor({
  value,
  onChange,
}: {
  value: ProofRule | null;
  onChange: (rule: ProofRule | null) => void;
}) {
  const [adding, setAdding] = useState<Adding | ''>('');
  const [doc, setDoc] = useState<DocumentKind>('contract');
  const [signed, setSigned] = useState(false);
  const [words, setWords] = useState('');
  const [date, setDate] = useState<KeyDateKey>('closing');
  const [field, setField] = useState<DealField>('property');
  const items = value?.items ?? [];
  const put = (list: readonly ProofItem[]) =>
    onChange(list.length ? { mode: value?.mode ?? 'all', items: list } : null);
  const add = () => {
    if (!adding) return;
    const item: ProofItem =
      adding === 'document'
        ? { kind: 'document', documents: [doc], ...(signed ? { signed: true } : {}) }
        : adding === 'attestation'
          ? { kind: 'attestation', words: words.trim() }
          : adding === 'dates'
            ? { kind: 'dates', keys: [date] }
            : adding === 'deal_field'
              ? { kind: 'deal_field', field }
              : { kind: adding };
    if (item.kind === 'attestation' && item.words.length < 3) return;
    put([...items, item].slice(0, 6));
    setAdding('');
    setWords('');
  };
  return (
    <div className="space-y-2 text-[13.5px]">
      {items.length === 0 ? (
        <p className="text-text-2">Saying it’s done is enough.</p>
      ) : (
        <>
          {items.length > 1 ? (
            <Select
              aria-label="All or any"
              value={value!.mode}
              onChange={(e) => onChange({ mode: e.target.value as 'all' | 'any', items })}
            >
              <option value="all">All of these</option>
              <option value="any">Any one of these</option>
            </Select>
          ) : null}
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded-menu bg-card-2 px-3 py-1.5"
              >
                <span>{proofItemWords(item)}</span>
                <button
                  type="button"
                  aria-label="Take it off"
                  className="text-text-3 hover:text-danger-text"
                  onClick={() => put(items.filter((_, j) => j !== i))}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {items.length < 6 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-52"
            aria-label="Add proof"
            value={adding}
            onChange={(e) => setAdding(e.target.value as Adding | '')}
          >
            <option value="">Add proof…</option>
            <option value="document">A document</option>
            <option value="file">Any file</option>
            <option value="note">A note of what was done</option>
            <option value="attestation">Someone’s word</option>
            <option value="appointment">An appointment</option>
            <option value="message">A message</option>
            <option value="dates">A date confirmed</option>
            <option value="deal_field">Something filled in on the deal</option>
          </Select>
          {adding === 'document' ? (
            <>
              <Select
                className="w-52"
                aria-label="Kind of document"
                value={doc}
                onChange={(e) => setDoc(e.target.value as DocumentKind)}
              >
                {(Object.keys(DOCUMENT_KINDS) as DocumentKind[]).map((k) => (
                  <option key={k} value={k}>
                    {DOCUMENT_KINDS[k]}
                  </option>
                ))}
              </Select>
              <Checkbox
                label="Signed"
                checked={signed}
                onChange={(e) => setSigned(e.target.checked)}
              />
            </>
          ) : null}
          {adding === 'attestation' ? (
            <Input
              className="w-64"
              placeholder="I was at the inspection"
              value={words}
              onChange={(e) => setWords(e.target.value)}
            />
          ) : null}
          {adding === 'dates' ? (
            <Select
              className="w-52"
              aria-label="Which date"
              value={date}
              onChange={(e) => setDate(e.target.value as KeyDateKey)}
            >
              {KEY_DATE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {KEY_DATES[k].label}
                </option>
              ))}
            </Select>
          ) : null}
          {adding === 'deal_field' ? (
            <Select
              className="w-52"
              aria-label="What’s filled in"
              value={field}
              onChange={(e) => setField(e.target.value as DealField)}
            >
              {(Object.keys(DEAL_FIELDS) as DealField[]).map((k) => (
                <option key={k} value={k}>
                  {DEAL_FIELDS[k]}
                </option>
              ))}
            </Select>
          ) : null}
          {adding ? (
            <Button size="sm" variant="secondary" onClick={add}>
              Add
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Days before it's due to remind: up to four, 1 to 30. */
export function RemindersInput({
  value,
  onChange,
  id,
}: {
  value: readonly number[];
  onChange: (days: number[]) => void;
  id: string;
}) {
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      id={id}
      value={text}
      placeholder="7, 3, 1"
      onChange={(e) => {
        setText(e.target.value);
        const days = [
          ...new Set(
            e.target.value
              .split(/[\s,]+/)
              .map((s) => Number.parseInt(s, 10))
              .filter((n) => Number.isFinite(n) && n >= 1 && n <= 30),
          ),
        ]
          .sort((a, b) => b - a)
          .slice(0, 4);
        onChange(days);
      }}
    />
  );
}
