'use client';
import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { addressSearch, type AddressSuggestion, type LatLngLiteral } from '@/lib/maps/google';
import { cn } from '@/lib/utils';

/**
 * The address field in a service area's dialog (M18): Google suggests addresses as you type (Places API (New)),
 * and picking one finds it. Enter with nothing picked is `onFind` (the Geocoder), which is also all there is when
 * Places isn't turned on for the key.
 */
export function AddressInput({
  id,
  value,
  onChange,
  onPick,
  onFind,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  onPick: (found: { point: LatLngLiteral; formatted: string } | null) => void;
  onFind: () => void;
}) {
  const search = useMemo(() => addressSearch(), []);
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Only what someone typed is searched: not an address a pick, Find or the map's pin filled in, nor the one the
  // area was saved with.
  const [typed, setTyped] = useState<string | null>(null);
  const off = useRef(false);

  useEffect(() => {
    const query = value.trim();
    if (value !== typed || off.current || query.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await search(query);
        if (!cancelled) {
          setResults(found.slice(0, 5));
          setActive(-1);
        }
      } catch {
        // No Places on this key (or no connection): stop asking, and leave Find to do the work.
        off.current = true;
        if (!cancelled) setResults([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, typed, search]);

  async function pick(s: AddressSuggestion) {
    setTyped(null);
    setOpen(false);
    setResults([]);
    onChange([s.main, s.more].filter(Boolean).join(', '));
    onPick(await s.place());
  }

  const listId = `${id}-suggestions`;
  const shown = open && results.length > 0 && value === typed;
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        id={id}
        value={value}
        maxLength={300}
        placeholder="1500 Marilla St, Dallas, TX"
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
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && shown) {
            e.preventDefault();
            setActive((a) => (a + 1) % results.length);
          } else if (e.key === 'ArrowUp' && shown) {
            e.preventDefault();
            setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const s = shown ? results[active] : undefined;
            if (s) void pick(s);
            else {
              setOpen(false);
              onFind();
            }
          }
        }}
      />
      {shown ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-[44px] z-50 max-h-64 overflow-auto rounded-menu border border-border bg-card p-1 shadow-2"
          data-testid="address-suggestions"
        >
          {results.map((s, i) => (
            <li
              key={`${s.main}|${s.more}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-[6px] px-2.5 py-2 text-sm hover:bg-card-2',
                i === active && 'bg-card-2',
              )}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void pick(s)}
            >
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-text-3" strokeWidth={1.5} />
              <span className="min-w-0">
                <span className="block truncate">{s.main}</span>
                {s.more ? (
                  <span className="block truncate text-xs text-text-3">{s.more}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
