'use client';
import { findIndustry, industryLabel, searchIndustries, type IndustryOption } from '@hfos/core';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const OTHER = findIndustry('other')!;

/**
 * The kind of business, picked from core's list (industries.ts) by typing: "plumber", "dog", "AC repair". With
 * nothing typed it's the whole list under its groups. Other is always there, last, for what the list doesn't have.
 * Used at sign-up and in Settings → Workspace.
 */
export function IndustryPicker({
  id,
  value,
  onChange,
  inputSize = 'md',
}: {
  id: string;
  value: string;
  onChange: (industry: string) => void;
  inputSize?: 'md' | 'lg';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const typed = query.trim().length > 0;
  const options = useMemo<IndustryOption[]>(() => {
    const found = searchIndustries(query);
    return typed ? [...found, OTHER] : found;
  }, [query, typed]);
  const nothingFound = typed && options.length === 1;

  const listId = `${id}-options`;
  const optionId = (i: number) => `${listId}-${options[i]?.id ?? i}`;
  const activeId = open ? optionId(active) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function show() {
    setQuery('');
    setActive(
      Math.max(
        0,
        searchIndustries('').findIndex((o) => o.id === value),
      ),
    );
    setOpen(true);
  }

  function pick(option: IndustryOption | undefined) {
    if (!option) return;
    onChange(option.id);
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="relative">
      {open ? (
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
          strokeWidth={1.5}
        />
      ) : null}
      <Input
        id={id}
        inputSize={inputSize}
        className={cn('pr-9', open && 'pl-9')}
        value={open ? query : industryLabel(value)}
        placeholder={open ? 'Search: plumbing, dog grooming, dental…' : 'Pick one'}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeId}
        data-testid="industry-picker"
        onFocus={show}
        onClick={() => (open ? null : show())}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) return show();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
            setQuery('');
          }
        }}
      />
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
        strokeWidth={1.8}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Kinds of business"
          // Keeps the field focused while the list is clicked or scrolled.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-50 mt-1.5 max-h-72 overflow-y-auto rounded-menu border border-border bg-card p-1 shadow-2"
          data-testid="industry-options"
        >
          {nothingFound ? (
            <li role="presentation" className="px-2.5 py-2 text-[13px] text-text-3">
              Nothing on the list matches “{query.trim()}”. Pick Other for now; you can change it
              any time in Settings → Workspace.
            </li>
          ) : null}
          {options.map((option, i) => {
            const heading = !typed && option.group !== options[i - 1]?.group ? option.group : null;
            return (
              <Fragment key={option.id}>
                {heading ? (
                  <li
                    role="presentation"
                    className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
                  >
                    {heading}
                  </li>
                ) : null}
                <li
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  data-testid={`industry-option-${option.id}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(option)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-[6px] px-2.5 py-2 text-sm max-md:min-h-11',
                    i === active && 'bg-card-2',
                    typed && option.id === 'other' && 'mt-1 border-t border-border pt-2.5',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {typed && option.id !== 'other' ? (
                      <span className="block truncate text-xs text-text-3">{option.group}</span>
                    ) : null}
                  </span>
                  {option.id === value ? (
                    <Check className="h-4 w-4 flex-none text-accent-text" strokeWidth={2} />
                  ) : null}
                </li>
              </Fragment>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
