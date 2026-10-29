import {
  COUNTRIES_BY_NAME,
  COUNTRY_MODE_WORDS,
  COUNTRY_MODES,
  COUNTRY_UNSURE,
  COUNTRY_UNSURE_WORDS,
  COUNTRY_WORDS,
  countryName,
  type CountryRule,
} from '@hfos/core/addons/outreach/countries';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { X } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Note, Part } from './kit';
import { PHONE_WORDS } from './phone-words';
import { Choice } from './settings-bits';

/**
 * Which countries the business reaches (docs/outreach.md, decisions 61 and 86), under For your team on General, as
 * the web's (business-settings.tsx): Anywhere, Only these countries or Not these countries, the countries picked as
 * chips with a box that finds the rest by name or code as it's typed, and When we can't tell. It saves as it's
 * changed with the rest of For your team, but Only these countries with none picked waits for one (`countriesProblem`,
 * the form's `hold`), saying why under the picker.
 */

const C = PHONE_WORDS.countries;

/** How many matches the list shows at once. */
const SHOWN = 8;

/** Why the countries can't be saved yet: Only these countries, with none picked. Null when they can. */
export const countriesProblem = (countries: CountryRule): string | null =>
  countries.mode === 'only' && !countries.codes.length ? COUNTRY_WORDS.noneOnly : null;

/** The countries a search finds: by name, or by its two-letter code, leaving out those already picked. */
export function countriesFound(typed: string, picked: readonly string[]) {
  const words = typed.trim().toLowerCase();
  if (!words) return [];
  const have = new Set(picked);
  return COUNTRIES_BY_NAME.filter(
    (c) =>
      !have.has(c.code) && (c.name.toLowerCase().includes(words) || c.code.toLowerCase() === words),
  ).slice(0, SHOWN);
}

export function CountrySetting({
  value,
  onChange,
  disabled,
  children,
}: {
  value: CountryRule;
  onChange: (countries: CountryRule) => void;
  disabled: boolean;
  /** Under it: the lists it makes, Not sure where they live and Skipped for country (./countries.tsx). */
  children?: React.ReactNode;
}) {
  const problem = countriesProblem(value);
  return (
    <Card className="gap-4 px-4 py-4" testID="settings-countries">
      <Part title={W.sections.countries} about={W.abouts.countries}>
        <View className="gap-2">
          {COUNTRY_MODES.map((m) => (
            <Choice
              key={m}
              label={COUNTRY_MODE_WORDS[m]}
              about={m === 'anywhere' ? W.usual : undefined}
              selected={value.mode === m}
              onPress={() => onChange({ ...value, mode: m })}
              disabled={disabled}
              testID={`settings-countries-${m}`}
            />
          ))}
        </View>
        {value.mode !== 'anywhere' ? (
          <CountryPicker
            codes={value.codes}
            onChange={(codes) => onChange({ ...value, codes })}
            disabled={disabled}
          />
        ) : null}
        {problem ? (
          <Text
            className="text-[13px] leading-[18px] text-danger"
            accessibilityRole="alert"
            testID="settings-countries-problem"
          >
            {problem}
          </Text>
        ) : null}
      </Part>
      {value.mode !== 'anywhere' ? (
        <Part
          title={COUNTRY_UNSURE_WORDS.title}
          about={COUNTRY_UNSURE_WORDS.note}
          testID="settings-countries-unsure"
        >
          <View className="gap-2">
            {COUNTRY_UNSURE.map((u) => (
              <Choice
                key={u}
                label={COUNTRY_UNSURE_WORDS[u]}
                about={u === 'ask' ? W.usual : undefined}
                selected={value.unsure === u}
                onPress={() => onChange({ ...value, unsure: u })}
                disabled={disabled}
                testID={`settings-countries-unsure-${u}`}
              />
            ))}
          </View>
        </Part>
      ) : null}
      {children}
    </Card>
  );
}

/** The countries picked, each with an × to take it off, and the box that finds the rest. */
export function CountryPicker({
  codes,
  onChange,
  disabled = false,
}: {
  codes: readonly string[];
  onChange: (codes: string[]) => void;
  disabled?: boolean;
}) {
  const [typed, setTyped] = React.useState('');
  const found = countriesFound(typed, codes);
  const add = (code: string) => {
    onChange([...codes, code].sort());
    setTyped('');
  };
  return (
    <View className="gap-2" testID="settings-country-picker">
      {codes.length ? (
        <View
          className="flex-row flex-wrap gap-1.5"
          accessibilityLabel={C.picked}
          testID="settings-countries-picked"
        >
          {codes.map((code) => (
            <Pressable
              key={code}
              role="button"
              accessibilityLabel={C.takeOff(countryName(code))}
              disabled={disabled}
              onPress={() => onChange(codes.filter((c) => c !== code))}
              hitSlop={{ top: 6, bottom: 6 }}
              className={cn(
                'h-8 flex-row items-center gap-1 rounded-full bg-accent-soft pl-3 pr-2',
                disabled && 'opacity-50',
              )}
              testID={`settings-country-chip-${code}`}
            >
              <Text className="text-[13.5px] text-accent-text">{countryName(code)}</Text>
              <Icon as={X} className="size-3.5 text-accent-text" />
            </Pressable>
          ))}
        </View>
      ) : null}
      <Input
        value={typed}
        placeholder={C.find}
        accessibilityLabel={C.find}
        autoCorrect={false}
        maxLength={60}
        editable={!disabled}
        returnKeyType="done"
        onChangeText={setTyped}
        onSubmitEditing={() => {
          if (found[0]) add(found[0].code);
        }}
        testID="settings-country-find"
      />
      {found.length ? (
        <List testID="settings-country-found">
          {found.map((c) => (
            <ListRow
              key={c.code}
              label={c.name}
              chevron={false}
              disabled={disabled}
              onPress={() => add(c.code)}
              testID={`settings-country-${c.code}`}
            />
          ))}
        </List>
      ) : typed.trim() ? (
        <Note testID="settings-country-none">{C.noMatch(typed.trim())}</Note>
      ) : null}
    </View>
  );
}
