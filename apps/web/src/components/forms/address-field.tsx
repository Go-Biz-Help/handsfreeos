'use client';
import { addressFromPlace, searchesAddresses, type AnswerValue, type Question } from '@hfos/core';
import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { addressSearch, type AddressSuggestion } from '@/lib/maps/google';
import { cn } from '@/lib/utils';

type Address = Record<string, string>;

/**
 * An address question as the person answering sees it: the street, town, state and ZIP boxes. With Google's address
 * search on (`config.search`), the street box suggests real addresses as they type, and picking one fills every box
 * (`addressFromPlace`). Google's script loads only once they start typing in it. Without a Maps key, or when Google
 * won't answer (a business's own domain the key doesn't list), the boxes work as plain boxes.
 */
export function AddressField({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
}) {
  const address = (value ?? {}) as Address;
  const config = question.config as { detail?: string };
  const id = `q-${question.id}-input`;
  const part = (key: string, label: string, autoComplete: string, className?: string) => (
    <Input
      key={key}
      aria-label={label}
      placeholder={label}
      autoComplete={autoComplete}
      className={className}
      value={address[key] ?? ''}
      onChange={(e) => onChange({ ...address, [key]: e.target.value } as never)}
    />
  );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(config.detail ?? 'full') === 'full' ? (
        searchesAddresses(question) ? (
          <StreetSearch id={id} address={address} onChange={onChange} />
        ) : (
          part('line1', 'Street', 'address-line1', 'sm:col-span-2')
        )
      ) : null}
      {part('city', 'Town', 'address-level2')}
      {part('state', 'State', 'address-level1')}
      {part('postalCode', 'Postcode', 'postal-code')}
    </div>
  );
}

/**
 * The street box with Google's suggestions under it. The list sits in the form's own flow rather than floating over
 * it, so a form embedded on a website grows to show it instead of cutting it off at the frame's edge.
 */
function StreetSearch({
  id,
  address,
  onChange,
}: {
  id: string;
  address: Address;
  onChange: (value: AnswerValue) => void;
}) {
  const search = useMemo(() => addressSearch(), []);
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Only what they typed is searched, never the street a pick filled in.
  const [typed, setTyped] = useState<string | null>(null);
  const off = useRef(false);
  const street = address.line1 ?? '';

  useEffect(() => {
    const query = street.trim();
    if (street !== typed || off.current || query.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await search(query);
        if (!cancelled) {
          setResults(found.slice(0, 5));
          setActive(-1);
        }
      } catch {
        // No key, Places not on for it, or no connection: stop asking, and let them type it.
        off.current = true;
        if (!cancelled) setResults([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [street, typed, search]);

  async function pick(s: AddressSuggestion) {
    setTyped(null);
    setOpen(false);
    setResults([]);
    // The street straight away, then every box once Google says what the address is made of.
    const picked: Address = { ...address, line1: s.main };
    onChange(picked as never);
    const parts = await s.parts();
    if (!parts) return;
    const found = addressFromPlace(parts);
    onChange({
      ...picked,
      line1: found.line1 || picked.line1,
      city: found.city || picked.city || '',
      state: found.state || picked.state || '',
      postalCode: found.postalCode || picked.postalCode || '',
    } as never);
  }

  const listId = `${id}-suggestions`;
  const shown = open && results.length > 0 && street === typed;
  return (
    <div className="sm:col-span-2">
      <Input
        id={id}
        aria-label="Street"
        placeholder="Street"
        value={street}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setTyped(e.target.value);
          setOpen(true);
          if (e.target.value.trim().length < 3) setResults([]);
          onChange({ ...address, line1: e.target.value } as never);
        }}
        onKeyDown={(e) => {
          if (!shown) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % results.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
          } else if (e.key === 'Enter' && results[active]) {
            // Enter picks the highlighted address rather than sending the form.
            e.preventDefault();
            void pick(results[active]!);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {shown ? (
        <div
          className="mt-1 rounded-control border border-border bg-card p-1"
          data-testid="form-address-suggestions"
        >
          <ul id={listId} role="listbox" aria-label="Suggested addresses">
            {results.map((s, i) => (
              <li
                key={`${s.main}|${s.more}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-[6px] px-2.5 py-2 text-[14px] hover:bg-card-2',
                  i === active && 'bg-card-2',
                )}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => void pick(s)}
              >
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-text-3" strokeWidth={1.5} />
                <span className="min-w-0">
                  <span className="block truncate text-text">{s.main}</span>
                  {s.more ? (
                    <span className="block truncate text-[12.5px] text-text-3">{s.more}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {/* Google asks for its name beside suggestions shown without one of its maps. */}
          <p className="px-2.5 pb-1 pt-1.5 text-right text-[11px] text-text-3">Google Maps</p>
        </div>
      ) : null}
    </div>
  );
}
