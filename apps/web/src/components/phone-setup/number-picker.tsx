'use client';
/**
 * The guided phone setup's "Pick your number": the numbers free right now, and a search under them for a different
 * one. Everything today's number screen can look by is here (the owner, 22 Nov 2026: "the phone number search before
 * had the ability to search in a city and state as well please add that back"): city and state, how far out, the
 * area code (or how a toll-free one starts) and digits to have in it. Picking one buys nothing: that is the last
 * screen's job. What was searched for and the number picked are answers like any other, so they are kept.
 */
import {
  PHONE_SETUP_WORDS as WORDS,
  phoneSetupNumberType,
  type PhoneSetupAnswers,
  type PhoneSetupSearch,
} from '@hfos/core';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Pill } from '@/components/inbox/bits';
import { Button } from '@/components/ui/button';
import { FieldError, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/client';
import { searchNumbers, type AvailableNumber } from '@/lib/api/worker';
import { cn } from '@/lib/utils';

const W = WORDS.number;
const TOLL_FREE_STARTS = ['833', '844', '855'];

interface Row {
  readonly e164: string;
  readonly display: string;
  readonly place: string | null;
}

export function NumberPicker({
  workspaceId,
  answers,
  set,
  canSwitchKind,
}: {
  workspaceId: string;
  answers: PhoneSetupAnswers;
  set: (patch: Partial<PhoneSetupAnswers>) => void;
  /** Whether the other kind of number may be shown instead. */
  canSwitchKind: boolean;
}) {
  const kind = phoneSetupNumberType(answers);
  const local = kind === 'local';
  const s = answers.search;
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last search asked for more than an area code, which is what usually empties the results. */
  const [narrowed, setNarrowed] = useState(false);

  const change = (patch: Partial<PhoneSetupSearch>) => set({ search: { ...s, ...patch } });

  /** `broaden` drops the city and the digits and looks again: the empty result's way out. */
  async function search(look: PhoneSetupSearch, { broaden = false }: { broaden?: boolean } = {}) {
    if (!broaden && local && look.city.trim() && !look.state) {
      setError(W.stateNeeded);
      return;
    }
    const city = broaden ? '' : look.city.trim();
    const digits = broaden ? '' : look.digits;
    const code = local
      ? look.areaCode
      : TOLL_FREE_STARTS.includes(look.areaCode)
        ? look.areaCode
        : '';
    if (broaden) set({ search: { ...look, city: '', state: '', miles: '', digits: '' } });
    setSearching(true);
    setError(null);
    setNarrowed(Boolean(digits || (local && city)));
    try {
      const out = await searchNumbers({
        workspaceId,
        numberType: kind,
        ...(code ? { areaCode: code } : {}),
        ...(digits ? { contains: digits } : {}),
        ...(local && city && look.state ? { city, state: look.state } : {}),
        ...(local && city && look.state && look.miles ? { withinMiles: Number(look.miles) } : {}),
      });
      setResults(out.numbers);
      if (out.numbers.length === 0)
        setError(
          local && city && look.miles
            ? W.noneWide(city)
            : digits || (local && city)
              ? W.noneNarrow
              : W.none,
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  // The numbers show on the way in, and again when the kind of number changes: near the business for a local one,
  // any for a toll-free one. A local search with nowhere to look waits for a city or an area code.
  const looked = useRef<string | null>(null);
  useEffect(() => {
    if (looked.current === kind) return;
    looked.current = kind;
    setResults(null);
    setError(null);
    if (!local || (s.city.trim() && s.state) || s.areaCode.length === 3) void search(s);
  }, [kind]);

  const placeOf = (r: AvailableNumber) =>
    local ? [r.locality, r.region].filter(Boolean).join(', ') || null : null;
  const found: Row[] = (results ?? []).map((r) => ({
    e164: r.e164,
    display: r.display,
    place: placeOf(r),
  }));
  const picked = answers.number;
  // The one they picked stays on the list, first, when a newer search no longer shows it.
  const rows: Row[] =
    picked && !found.some((r) => r.e164 === picked.e164)
      ? [{ e164: picked.e164, display: picked.display, place: picked.place }, ...found]
      : found;

  return (
    <div className="flex flex-col gap-4" data-testid="number-picker">
      {rows.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium" id="number-results-label">
            {W.results}
          </div>
          <div
            role="radiogroup"
            aria-labelledby="number-results-label"
            className="overflow-hidden rounded-menu border border-border"
            data-testid="number-results"
          >
            {rows.map((r) => {
              const on = picked?.e164 === r.e164;
              return (
                <button
                  key={r.e164}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() =>
                    set({
                      number: {
                        e164: r.e164,
                        display: r.display,
                        numberType: kind,
                        place: r.place,
                      },
                    })
                  }
                  className={cn(
                    'flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0',
                    on ? 'bg-accent-soft' : 'hover:bg-card-2',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-4 w-4 flex-none rounded-full border-[1.5px]',
                      on
                        ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_var(--card)]'
                        : 'border-border-strong',
                    )}
                  />
                  <span className="flex-1 font-mono text-[15px] font-medium">{r.display}</span>
                  <span className="text-xs text-text-3">
                    {local ? (r.place ?? 'Local') : 'Toll-free'}
                  </span>
                  <Pill className="hidden sm:inline-flex">{W.features}</Pill>
                </button>
              );
            })}
          </div>
        </div>
      ) : searching ? (
        <div
          className="flex items-center gap-2.5 rounded-menu border border-border px-4 py-3 text-[13.5px] text-text-2"
          role="status"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {W.looking}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-3 rounded-menu bg-card-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void search(s);
        }}
        data-testid="number-search"
      >
        <div>
          <div className="text-[13.5px] font-medium">{rows.length > 0 ? W.different : W.find}</div>
          {local ? <div className="text-[13px] text-text-2">{W.differentHint}</div> : null}
        </div>
        <div className="flex flex-wrap items-end gap-2.5">
          {local ? (
            <>
              <div>
                <Label htmlFor="number-city">{W.city}</Label>
                <Input
                  id="number-city"
                  value={s.city}
                  maxLength={40}
                  onChange={(e) => change({ city: e.target.value })}
                  placeholder="Huntsville"
                  className="h-9 w-44"
                />
              </div>
              <div>
                <Label htmlFor="number-state">{W.state}</Label>
                <Input
                  id="number-state"
                  maxLength={2}
                  value={s.state}
                  onChange={(e) =>
                    change({ state: e.target.value.replace(/[^A-Za-z]/g, '').toUpperCase() })
                  }
                  placeholder="AL"
                  className="h-9 w-20"
                />
              </div>
              <div>
                <Label htmlFor="number-miles">{W.miles}</Label>
                <Select
                  id="number-miles"
                  value={s.miles}
                  onChange={(e) => change({ miles: e.target.value })}
                  className="h-9 w-44"
                >
                  <option value="">That city only</option>
                  <option value="15">Within 15 miles</option>
                  <option value="25">Within 25 miles</option>
                  <option value="50">Within 50 miles</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="area-code">{W.areaCode}</Label>
                <Input
                  id="area-code"
                  inputMode="numeric"
                  maxLength={3}
                  value={s.areaCode}
                  onChange={(e) => change({ areaCode: e.target.value.replace(/[^0-9]/g, '') })}
                  placeholder="256"
                  className="h-9 w-40"
                />
              </div>
            </>
          ) : (
            <div>
              <Label htmlFor="toll-free-prefix">{W.startsWith}</Label>
              <Select
                id="toll-free-prefix"
                value={TOLL_FREE_STARTS.includes(s.areaCode) ? s.areaCode : ''}
                onChange={(e) => change({ areaCode: e.target.value })}
                className="h-9 w-40"
              >
                <option value="">Any</option>
                {TOLL_FREE_STARTS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="number-contains">{W.digits}</Label>
            <Input
              id="number-contains"
              inputMode="numeric"
              maxLength={10}
              value={s.digits}
              onChange={(e) => change({ digits: e.target.value.replace(/[^0-9*]/g, '') })}
              placeholder="454"
              className="h-9 w-44"
            />
          </div>
          <Button type="submit" variant="secondary" loading={searching} data-testid="show-numbers">
            {searching ? null : <Search className="h-3.5 w-3.5" strokeWidth={1.5} />}
            {W.show}
          </Button>
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        {results && results.length === 0 && narrowed ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              loading={searching}
              onClick={() => void search(s, { broaden: true })}
              data-testid="broaden-search"
            >
              {W.broaden}
            </Button>
          </div>
        ) : null}
        {canSwitchKind ? (
          <button
            type="button"
            // The search belongs to the kind it was made for: an area code isn't how a toll-free number starts.
            onClick={() =>
              set({
                numberType: local ? 'toll_free' : 'local',
                search: { ...s, areaCode: '' },
              })
            }
            className="self-start text-[13px] text-accent-text hover:underline"
            data-testid="number-other-kind"
          >
            {local ? W.tollFreeInstead : W.localInstead}
          </button>
        ) : null}
      </form>
    </div>
  );
}
