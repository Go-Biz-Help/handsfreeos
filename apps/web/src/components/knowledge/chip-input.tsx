'use client';
import { X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

/**
 * A list of short words (tags, words to use or avoid): type and press Enter or a comma to add one, × to
 * remove it. Case-insensitive duplicates are ignored.
 */
export function ChipInput({
  id,
  value,
  onChange,
  placeholder = 'Type and press Enter',
  max = 20,
  maxLength = 40,
  danger,
  disabled,
  testId,
}: {
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
  maxLength?: number;
  /** Words to avoid read in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const [draft, setDraft] = useState('');
  const full = value.length >= max;

  function add(raw: string) {
    const words = raw
      .split(',')
      .map((w) => w.replace(/\s+/g, ' ').trim().slice(0, maxLength))
      .filter(Boolean);
    if (!words.length) return;
    const next = [...value];
    for (const w of words)
      if (next.length < max && !next.some((v) => v.toLowerCase() === w.toLowerCase())) next.push(w);
    onChange(next);
    setDraft('');
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-control border border-border-strong bg-card px-2 py-1.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring',
        disabled && 'bg-card-2',
      )}
      data-testid={testId}
    >
      {value.map((w) => (
        <span
          key={w}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full bg-card-2 pl-2.5 text-[12.5px] font-medium',
            danger ? 'text-danger-text' : 'text-text-2',
            disabled ? 'pr-2.5' : 'pr-1',
          )}
        >
          {w}
          {disabled ? null : (
            <button
              type="button"
              aria-label={`Remove ${w}`}
              onClick={() => onChange(value.filter((v) => v !== w))}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-text-3 hover:bg-card-3 hover:text-text"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          )}
        </span>
      ))}
      {disabled ? null : (
        <input
          id={id}
          value={draft}
          disabled={full}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          placeholder={full ? `At most ${max}` : placeholder}
          className="h-7 min-w-[120px] flex-1 bg-transparent px-1 text-[15px] text-text placeholder:text-placeholder focus:outline-none disabled:cursor-not-allowed"
        />
      )}
    </div>
  );
}
