'use client';
/**
 * Picking countries for Social Outreach's country setting (docs/outreach.md, decision 61): the ones picked as chips,
 * each with a ×, and a box that finds the rest by name or code as it's typed.
 */
import { COUNTRIES_BY_NAME, countryName } from '@hfos/core/addons/outreach/countries';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';

/** How many matches the list shows at once. */
const SHOWN = 8;

export function CountryPicker({
  codes,
  onChange,
}: {
  codes: readonly string[];
  onChange: (codes: string[]) => void;
}) {
  const [typed, setTyped] = useState('');
  const picked = new Set(codes);
  const words = typed.trim().toLowerCase();
  const found = words
    ? COUNTRIES_BY_NAME.filter(
        (c) =>
          !picked.has(c.code) &&
          (c.name.toLowerCase().includes(words) || c.code.toLowerCase() === words),
      ).slice(0, SHOWN)
    : [];
  const add = (code: string) => {
    onChange([...codes, code].sort());
    setTyped('');
  };
  return (
    <div className="mt-2" data-testid="outreach-country-picker">
      {codes.length ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Countries picked">
          {codes.map((code) => (
            <li
              key={code}
              className="flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-[12.5px] text-accent-text"
            >
              {countryName(code)}
              <button
                type="button"
                aria-label={`Take ${countryName(code)} off`}
                className="rounded-full p-0.5 hover:bg-card-2"
                onClick={() => onChange(codes.filter((c) => c !== code))}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        inputSize="sm"
        aria-label="Find a country"
        placeholder="Find a country"
        value={typed}
        maxLength={60}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && found[0]) {
            e.preventDefault();
            add(found[0].code);
          }
        }}
        data-testid="outreach-country-find"
      />
      {found.length ? (
        <ul className="mt-1 rounded-control border border-border bg-card text-[13px]">
          {found.map((c) => (
            <li key={c.code}>
              <button
                type="button"
                className="w-full px-2.5 py-1.5 text-left hover:bg-card-2"
                onClick={() => add(c.code)}
                data-testid={`outreach-country-${c.code}`}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      ) : typed.trim() ? (
        <p className="mt-1 text-[12.5px] text-text-3">
          No country called “{typed.trim()}”. Check the spelling.
        </p>
      ) : null}
    </div>
  );
}
