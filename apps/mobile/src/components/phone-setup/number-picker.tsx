import {
  PHONE_SETUP_WORDS as WORDS,
  phoneSetupNumberType,
  US_STATES,
  type PhoneSetupAnswers,
  type PhoneSetupSearch,
} from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { ChoiceField } from '@/components/ai-setup/fields';
import { Info, Search } from '@/components/icons';
import { EmailMeALink, Note } from '@/components/onboarding-setup/screens';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { NotInThisBuild, type AvailableNumber, type PhoneSetupCalls } from '@/phone-setup/calls';
import { PHONE_SETUP_PHONE_WORDS as PW } from '@/phone-setup/words';
import { useColors } from '@/theme';

const W = WORDS.number;
const TOLL_FREE_STARTS = ['833', '844', '855'] as const;
const STATE_CHOICES = US_STATES.map((s) => ({ value: s.code, label: s.name }));
const MILES = ['', '15', '25', '50'] as const;

interface Row {
  readonly e164: string;
  readonly display: string;
  readonly place: string | null;
}

/**
 * The guided setup's "Pick your number" on the phone, as the web's phone-setup/number-picker.tsx: the numbers free
 * right now, and a search under them for a different one, by everything the web looks by (city and state, how far
 * out, the area code or how a toll-free one starts, and digits to have in it). Picking one buys nothing: that is the
 * last screen's job. What was searched for and the number picked are answers like any other, so they are kept.
 */
export function NumberPicker({
  workspaceId,
  answers,
  set,
  canSwitchKind,
  calls,
}: {
  workspaceId: string;
  answers: PhoneSetupAnswers;
  set: (patch: Partial<PhoneSetupAnswers>) => void;
  /** Whether the other kind of number may be shown instead. */
  canSwitchKind: boolean;
  calls: PhoneSetupCalls;
}) {
  const colors = useColors();
  const kind = phoneSetupNumberType(answers);
  const local = kind === 'local';
  const s = answers.search;
  const [results, setResults] = React.useState<readonly AvailableNumber[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** The last search asked for more than an area code, which is what usually empties the results. */
  const [narrowed, setNarrowed] = React.useState(false);
  const [noBuild, setNoBuild] = React.useState(false);

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
      : (TOLL_FREE_STARTS as readonly string[]).includes(look.areaCode)
        ? look.areaCode
        : '';
    if (broaden) set({ search: { ...look, city: '', state: '', miles: '', digits: '' } });
    setSearching(true);
    setError(null);
    setNarrowed(Boolean(digits || (local && city)));
    try {
      const out = await calls.searchNumbers({
        numberType: kind,
        ...(code ? { areaCode: code } : {}),
        ...(digits ? { contains: digits } : {}),
        ...(local && city && look.state ? { city, state: look.state } : {}),
        ...(local && city && look.state && look.miles ? { withinMiles: Number(look.miles) } : {}),
      });
      setResults(out);
      if (out.length === 0)
        setError(
          local && city && look.miles
            ? W.noneWide(city)
            : digits || (local && city)
              ? W.noneNarrow
              : W.none,
        );
    } catch (e) {
      if (e instanceof NotInThisBuild) setNoBuild(true);
      else setError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  // The numbers show on the way in, and again when the kind of number changes: near the business for a local one,
  // any for a toll-free one. A local search with nowhere to look waits for a city or an area code.
  const looked = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (looked.current === kind) return;
    looked.current = kind;
    setResults(null);
    setError(null);
    if (!local || (s.city.trim() && s.state) || s.areaCode.length === 3) void search(s);
  }, [kind]);

  if (noBuild)
    return (
      <Note
        icon={Info}
        action={<EmailMeALink workspaceId={workspaceId} step="number" testID="number-link" />}
        testID="number-not-in-build"
      >
        {P.numberOnComputer}
      </Note>
    );

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
    <View className="gap-4" testID="number-picker">
      {rows.length > 0 ? (
        <View className="gap-1.5">
          <Label>{W.results}</Label>
          <View
            role="radiogroup"
            accessibilityLabel={W.results}
            className="overflow-hidden rounded-menu border border-border bg-card"
            testID="number-results"
          >
            {rows.map((r, i) => {
              const on = picked?.e164 === r.e164;
              return (
                <Pressable
                  key={r.e164}
                  role="radio"
                  aria-checked={on}
                  accessibilityLabel={`${r.display}, ${local ? (r.place ?? 'Local') : 'Toll-free'}`}
                  onPress={() =>
                    set({
                      number: {
                        e164: r.e164,
                        display: r.display,
                        numberType: kind,
                        place: r.place,
                      },
                    })
                  }
                  testID={`number-${r.e164.replace(/\D/g, '')}`}
                  className={cn(
                    'min-h-12 flex-row items-center gap-3 px-4 py-3',
                    i > 0 && 'border-t border-border',
                    on ? 'bg-accent-soft' : 'active:bg-card-2',
                  )}
                >
                  <View
                    className={cn(
                      'size-[18px] items-center justify-center rounded-full border-[1.5px]',
                      on ? 'border-accent' : 'border-border-strong',
                    )}
                  >
                    {on ? <View className="size-2.5 rounded-full bg-accent" /> : null}
                  </View>
                  <Text className="min-w-0 flex-1 font-mono text-[15px] font-medium">
                    {r.display}
                  </Text>
                  <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
                    {local ? (r.place ?? 'Local') : 'Toll-free'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text className="text-[12.5px] text-text-3">{W.features}</Text>
        </View>
      ) : searching ? (
        <View
          className="flex-row items-center gap-2.5 rounded-menu border border-border px-4 py-3"
          role="status"
          testID="number-looking"
        >
          <ActivityIndicator size="small" color={colors.accent} />
          <Text className="text-[13.5px] text-text-2">{W.looking}</Text>
        </View>
      ) : null}

      <View className="gap-3 rounded-menu bg-card-2 p-4" testID="number-search">
        <View className="gap-0.5">
          <Text className="text-[14px] font-semibold">
            {rows.length > 0 ? W.different : W.find}
          </Text>
          {local ? (
            <Text className="text-[13px] leading-[18px] text-text-2">{W.differentHint}</Text>
          ) : null}
        </View>
        {local ? (
          <>
            <View className="flex-row gap-2.5">
              <View className="min-w-0 flex-[3] gap-1.5">
                <Label>{W.city}</Label>
                <Input
                  value={s.city}
                  maxLength={40}
                  onChangeText={(v) => change({ city: v })}
                  placeholder="Huntsville"
                  autoCorrect={false}
                  accessibilityLabel={W.city}
                  testID="number-city"
                />
              </View>
              <View className="min-w-0 flex-[2] gap-1.5">
                <Label>{W.state}</Label>
                <ChoiceField
                  value={s.state || null}
                  options={STATE_CHOICES}
                  onChange={(v) => change({ state: v ?? '' })}
                  placeholder="Alabama"
                  sheetTitle={PW.pickState}
                  search={PW.searchStates}
                  testID="number-state"
                />
              </View>
            </View>
            <View className="gap-1.5">
              <Label>{W.miles}</Label>
              <ChoiceField
                value={s.miles}
                options={MILES.map((m) => ({
                  value: m,
                  label: m ? PW.within(m) : PW.cityOnly,
                }))}
                onChange={(v) => change({ miles: v ?? '' })}
                placeholder={PW.cityOnly}
                sheetTitle={PW.pickMiles}
                testID="number-miles"
              />
            </View>
            <View className="gap-1.5">
              <Label>{W.areaCode}</Label>
              <Input
                value={s.areaCode}
                maxLength={3}
                keyboardType="number-pad"
                onChangeText={(v) => change({ areaCode: v.replace(/[^0-9]/g, '') })}
                placeholder="256"
                accessibilityLabel={W.areaCode}
                testID="number-area-code"
              />
            </View>
          </>
        ) : (
          <View className="gap-1.5">
            <Label>{W.startsWith}</Label>
            <ChoiceField
              value={(TOLL_FREE_STARTS as readonly string[]).includes(s.areaCode) ? s.areaCode : ''}
              options={[
                { value: '', label: PW.anyStart },
                ...TOLL_FREE_STARTS.map((p) => ({ value: p as string, label: p })),
              ]}
              onChange={(v) => change({ areaCode: v ?? '' })}
              placeholder={PW.anyStart}
              sheetTitle={PW.pickStart}
              testID="number-starts"
            />
          </View>
        )}
        <View className="gap-1.5">
          <Label>{W.digits}</Label>
          <Input
            value={s.digits}
            maxLength={10}
            keyboardType="number-pad"
            onChangeText={(v) => change({ digits: v.replace(/[^0-9*]/g, '') })}
            placeholder="454"
            returnKeyType="search"
            onSubmitEditing={() => void search(s)}
            accessibilityLabel={W.digits}
            testID="number-digits"
          />
        </View>
        <Button
          variant="secondary"
          icon={Search}
          loading={searching}
          onPress={() => void search(s)}
          testID="show-numbers"
        >
          {W.show}
        </Button>
        {error ? <FieldError testID="number-search-error">{error}</FieldError> : null}
        {results && results.length === 0 && narrowed ? (
          <Button
            variant="secondary"
            loading={searching}
            onPress={() => void search(s, { broaden: true })}
            testID="broaden-search"
          >
            {W.broaden}
          </Button>
        ) : null}
        {canSwitchKind ? (
          <Pressable
            role="button"
            // The search belongs to the kind it was made for: an area code isn't how a toll-free number starts.
            onPress={() =>
              set({
                numberType: local ? 'toll_free' : 'local',
                search: { ...s, areaCode: '' },
              })
            }
            hitSlop={8}
            className="self-start py-1"
            testID="number-other-kind"
          >
            <Text className="text-[13.5px] font-medium text-accent-text">
              {local ? W.tollFreeInstead : W.localInstead}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
