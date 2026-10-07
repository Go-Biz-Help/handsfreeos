import {
  AI_SETUP_FIELD_WORDS,
  industriesForPicker,
  ONBOARDING_PICKER,
  ONBOARDING_SETUP_WORDS as W,
  pickerKeyOf,
  US_STATES,
  US_TIME_ZONES,
  usTimeZoneLabel,
  withAiName,
  withBusinessAddress,
  type AiSetupProblems,
  type BusinessAddressInput,
  type OnboardingPickerKey,
  type OnboardingSetupBusinessDraft,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChoiceField, Field, KindField, WebsiteField } from '@/components/ai-setup/fields';
import { StartFrom, type ScreenProps } from '@/components/ai-setup/screens';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

/**
 * "Your business", the onboarding setup's first screen on the phone
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8), as the web's components/onboarding-setup/business.tsx:
 * the name, what they do (a search on a sheet, or 8 big buttons that open the kinds in them), the address, which sets
 * the time zone shown to confirm, and the website. The same screen makes the business after signing up, and changes
 * it later. The state and the time zone are sheets, in place of the web's menus.
 */
export function BusinessScreen({
  business,
  onChange,
  problems,
  name,
  startFrom = null,
}: {
  business: OnboardingSetupBusinessDraft;
  onChange: (next: OnboardingSetupBusinessDraft) => void;
  problems: AiSetupProblems;
  /** The AI teammate's name, for the website's hint. */
  name: string;
  /** "Start from", while the agency has saved answers and the business has no teammate (§9). */
  startFrom?: ScreenProps['startFrom'];
}) {
  return (
    <>
      <Field label={W.businessName} error={problems['business.name']}>
        <Input
          value={business.name}
          onChangeText={(text) => onChange({ ...business, name: text })}
          placeholder="Lone Star HVAC & Roofing"
          maxLength={120}
          autoCapitalize="words"
          autoComplete="organization"
          textContentType="organizationName"
          invalid={!!problems['business.name']}
          accessibilityLabel={W.businessName}
          testID="setup-business-name"
        />
      </Field>
      <KindPicker
        value={business.industry}
        onChange={(industry) => onChange({ ...business, industry })}
        error={problems['business.industry']}
      />
      <AddressFields
        address={business.address}
        onChange={(address) => onChange(withBusinessAddress(business, address))}
        problems={problems}
      />
      <TimeZoneLine
        timeZone={business.timeZone}
        picked={business.timeZonePicked}
        onPick={(timeZone) => onChange({ ...business, timeZone, timeZonePicked: true })}
      />
      <WebsiteField
        value={business.site}
        noSite={business.noSite}
        onChange={(site) => onChange({ ...business, site })}
        onNoSite={(noSite) => onChange({ ...business, noSite })}
        hint={withAiName(
          business.noSite ? AI_SETUP_FIELD_WORDS.noWebsiteHint : AI_SETUP_FIELD_WORDS.websiteHint,
          name,
        )}
        error={problems['business.website']}
      />
      {startFrom ? <StartFrom {...startFrom} basics /> : null}
    </>
  );
}

/** "What do you do?": a search over every kind on a sheet, or a big button that opens the kinds in it. */
function KindPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (industry: string) => void;
  error?: string;
}) {
  const [open, setOpen] = React.useState<OnboardingPickerKey | null>(() => pickerKeyOf(value));
  const kinds = open ? industriesForPicker(open) : [];
  const groups = [...new Set(kinds.map((k) => k.group))];
  return (
    <View className="gap-3" testID="setup-kind">
      <KindField
        value={value}
        onChange={(industry) => {
          onChange(industry);
          setOpen(pickerKeyOf(industry));
        }}
        error={error}
        question={W.whatYouDo}
        hint={W.whatYouDoHint}
      />
      <View className="flex-row flex-wrap gap-2" role="group" accessibilityLabel={W.whatYouDo}>
        {ONBOARDING_PICKER.map((b) => (
          <Pressable
            key={b.key}
            role="button"
            aria-pressed={open === b.key}
            aria-expanded={open === b.key}
            accessibilityLabel={b.label}
            onPress={() => setOpen(open === b.key ? null : b.key)}
            testID={`setup-kind-button-${b.key}`}
            className={cn(
              'min-h-[52px] basis-[47%] grow justify-center rounded-menu border px-3 py-2',
              open === b.key
                ? 'border-accent bg-accent-soft'
                : 'border-border-strong bg-card active:bg-card-2',
            )}
          >
            <Text
              className={cn(
                'text-[13.5px] font-semibold leading-[18px]',
                open === b.key && 'text-accent-text',
              )}
            >
              {b.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {open ? (
        <View
          className="gap-3 rounded-menu border border-border bg-card-2 p-3"
          testID="setup-kinds"
        >
          {groups.map((group) => (
            <View key={group} className="gap-1.5">
              {groups.length > 1 ? <Text variant="group">{group}</Text> : null}
              <View
                role="radiogroup"
                accessibilityLabel={group}
                className="flex-row flex-wrap gap-2"
              >
                {kinds
                  .filter((k) => k.group === group)
                  .map((k) => (
                    <Pressable
                      key={k.id}
                      role="radio"
                      aria-checked={value === k.id}
                      accessibilityLabel={k.label}
                      onPress={() => onChange(k.id)}
                      testID={`setup-kind-${k.id}`}
                      className={cn(
                        'min-h-11 justify-center rounded-full border px-4 py-1.5',
                        value === k.id
                          ? 'border-accent bg-accent-soft'
                          : 'border-border-strong bg-card active:bg-card-2',
                      )}
                    >
                      <Text
                        className={cn(
                          'text-[14px] font-medium',
                          value === k.id ? 'text-accent-text' : 'text-text-2',
                        )}
                      >
                        {k.label}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const STATE_CHOICES = US_STATES.map((s) => ({ value: s.code, label: s.name }));
const ZONE_CHOICES = US_TIME_ZONES.map((z) => ({
  value: z.id as string,
  label: z.label,
  hint: z.example,
}));

function AddressFields({
  address,
  onChange,
  problems,
}: {
  address: BusinessAddressInput;
  onChange: (next: BusinessAddressInput) => void;
  problems: AiSetupProblems;
}) {
  const set = (patch: Partial<BusinessAddressInput>) => onChange({ ...address, ...patch });
  const problem = (key: keyof BusinessAddressInput) => problems[`business.address.${key}`];
  return (
    <View className="gap-3" testID="setup-address">
      <View className="gap-1">
        <Label>{W.address}</Label>
        <Text className="text-[13px] leading-[18px] text-text-3">{W.addressHint}</Text>
      </View>
      <Field label={W.line1} error={problem('line1')}>
        <Input
          value={address.line1}
          onChangeText={(line1) => set({ line1 })}
          maxLength={200}
          autoComplete="address-line1"
          textContentType="streetAddressLine1"
          invalid={!!problem('line1')}
          accessibilityLabel={W.line1}
          testID="setup-line1"
        />
      </Field>
      <Field label={W.line2} error={problem('line2')}>
        <Input
          value={address.line2 ?? ''}
          onChangeText={(line2) => set({ line2 })}
          maxLength={100}
          autoComplete="address-line2"
          textContentType="streetAddressLine2"
          accessibilityLabel={W.line2}
          testID="setup-line2"
        />
      </Field>
      <Field label={W.city} error={problem('city')}>
        <Input
          value={address.city}
          onChangeText={(city) => set({ city })}
          maxLength={100}
          autoComplete="postal-address-locality"
          textContentType="addressCity"
          invalid={!!problem('city')}
          accessibilityLabel={W.city}
          testID="setup-city"
        />
      </Field>
      <View className="flex-row gap-3">
        <View className="min-w-0 flex-[1.4]">
          <ChoiceField
            label={W.state}
            value={address.state.trim().toUpperCase() || null}
            options={STATE_CHOICES}
            onChange={(state) => set({ state: state ?? '' })}
            placeholder={W.state}
            sheetTitle={P.pickState}
            search={P.searchStates}
            error={problem('state')}
            testID="setup-state"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Field label={W.postalCode} error={problem('postalCode')}>
            <Input
              value={address.postalCode}
              onChangeText={(postalCode) => set({ postalCode })}
              maxLength={10}
              keyboardType="number-pad"
              autoComplete="postal-code"
              textContentType="postalCode"
              invalid={!!problem('postalCode')}
              accessibilityLabel={W.postalCode}
              testID="setup-postal-code"
            />
          </Field>
        </View>
      </View>
    </View>
  );
}

/** "Central time, from your address." with Change, or the pick once someone made their own. */
function TimeZoneLine({
  timeZone,
  picked,
  onPick,
}: {
  timeZone: string;
  picked: boolean;
  onPick: (timeZone: string) => void;
}) {
  const [changing, setChanging] = React.useState(false);
  if (!picked && !changing)
    return (
      <View className="-mt-1 flex-row flex-wrap items-center gap-x-2" testID="setup-time-zone">
        <Text className="text-[13.5px] text-text-2">
          {W.timeZoneFromAddress(usTimeZoneLabel(timeZone))}
        </Text>
        <Pressable
          role="button"
          onPress={() => setChanging(true)}
          hitSlop={10}
          testID="setup-time-zone-change"
        >
          <Text className="text-[13.5px] font-medium text-accent-text">{W.changeTimeZone}</Text>
        </Pressable>
      </View>
    );
  // A zone the list doesn't have (set elsewhere) shows as it is, and stays until another is picked.
  const options = ZONE_CHOICES.some((z) => z.value === timeZone)
    ? ZONE_CHOICES
    : [{ value: timeZone, label: timeZone, hint: '' }, ...ZONE_CHOICES];
  return (
    <ChoiceField
      label={W.timeZone}
      value={timeZone}
      options={options}
      onChange={(zone) => {
        if (zone) onPick(zone);
      }}
      placeholder={W.timeZone}
      sheetTitle={P.pickTimeZone}
      testID="setup-time-zone-pick"
    />
  );
}
