'use client';
/**
 * "Your business", the onboarding setup's first screen (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4):
 * the name, what they do (a search, or 8 big buttons that open the kinds in them), the address, which sets the time
 * zone shown to confirm, and the website. The same screen makes the business after signing up, and changes it later.
 */
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
import { useState } from 'react';
import { WebsiteField } from '@/components/ai-setup/fields';
import { StartFrom, type ScreenProps } from '@/components/ai-setup/screens';
import { IndustryPicker } from '@/components/settings/industry-picker';
import { Field, FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const pill = (on: boolean) =>
  cn(
    'inline-flex min-h-10 items-center rounded-full border px-4 py-1.5 text-left text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring max-md:min-h-11',
    on
      ? 'border-accent bg-accent-soft text-accent-text'
      : 'border-border-strong bg-card text-text-2 hover:bg-card-2 hover:text-text',
  );

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
      <Field label={W.businessName} htmlFor="setup-business-name" error={problems['business.name']}>
        <Input
          id="setup-business-name"
          inputSize="lg"
          placeholder="Lone Star HVAC & Roofing"
          value={business.name}
          maxLength={120}
          autoComplete="organization"
          invalid={!!problems['business.name']}
          onChange={(e) => onChange({ ...business, name: e.target.value })}
          data-testid="setup-business-name"
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

/** "What do you do?": a search over every kind, or a big button that opens the kinds in it. */
function KindPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (industry: string) => void;
  error?: string;
}) {
  const [open, setOpen] = useState<OnboardingPickerKey | null>(() => pickerKeyOf(value));
  const kinds = open ? industriesForPicker(open) : [];
  const groups = [...new Set(kinds.map((k) => k.group))];
  return (
    <div data-testid="setup-kind">
      <Label htmlFor="setup-kind-search">{W.whatYouDo}</Label>
      <IndustryPicker
        id="setup-kind-search"
        inputSize="lg"
        value={value}
        onChange={(industry) => {
          onChange(industry);
          setOpen(pickerKeyOf(industry));
        }}
      />
      {error ? <FieldError>{error}</FieldError> : <Hint>{W.whatYouDoHint}</Hint>}
      <div
        className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4"
        role="group"
        aria-label={W.whatYouDo}
      >
        {ONBOARDING_PICKER.map((b) => (
          <button
            key={b.key}
            type="button"
            aria-pressed={open === b.key}
            aria-expanded={open === b.key}
            onClick={() => setOpen(open === b.key ? null : b.key)}
            className={cn(
              'min-h-[52px] rounded-menu border px-3 py-2 text-left text-[13.5px] font-semibold leading-snug transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              open === b.key
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card hover:bg-card-2',
            )}
            data-testid={`setup-kind-button-${b.key}`}
          >
            {b.label}
          </button>
        ))}
      </div>
      {open ? (
        <div
          className="mt-3 flex flex-col gap-3 rounded-menu border border-border bg-card-2 p-3"
          data-testid="setup-kinds"
        >
          {groups.map((group) => (
            <div key={group}>
              {groups.length > 1 ? (
                <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                  {group}
                </div>
              ) : null}
              <div role="radiogroup" aria-label={group} className="flex flex-wrap gap-2">
                {kinds
                  .filter((k) => k.group === group)
                  .map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      role="radio"
                      aria-checked={value === k.id}
                      onClick={() => onChange(k.id)}
                      className={pill(value === k.id)}
                      data-testid={`setup-kind-${k.id}`}
                    >
                      {k.label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
    <fieldset className="flex flex-col gap-3" data-testid="setup-address">
      <legend className="text-[13px] font-medium">{W.address}</legend>
      <Hint className="-mt-2.5">{W.addressHint}</Hint>
      <Field label={W.line1} htmlFor="setup-line1" error={problem('line1')}>
        <Input
          id="setup-line1"
          value={address.line1}
          maxLength={200}
          autoComplete="address-line1"
          invalid={!!problem('line1')}
          onChange={(e) => set({ line1: e.target.value })}
          data-testid="setup-line1"
        />
      </Field>
      <Field label={W.line2} htmlFor="setup-line2" error={problem('line2')}>
        <Input
          id="setup-line2"
          value={address.line2 ?? ''}
          maxLength={100}
          autoComplete="address-line2"
          onChange={(e) => set({ line2: e.target.value })}
          data-testid="setup-line2"
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
        <Field label={W.city} htmlFor="setup-city" error={problem('city')}>
          <Input
            id="setup-city"
            value={address.city}
            maxLength={100}
            autoComplete="address-level2"
            invalid={!!problem('city')}
            onChange={(e) => set({ city: e.target.value })}
            data-testid="setup-city"
          />
        </Field>
        <Field label={W.state} htmlFor="setup-state" error={problem('state')}>
          <Select
            id="setup-state"
            value={address.state}
            autoComplete="address-level1"
            aria-invalid={!!problem('state') || undefined}
            onChange={(e) => set({ state: e.target.value })}
            data-testid="setup-state"
          >
            <option value="">{W.state}</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={W.postalCode} htmlFor="setup-postal-code" error={problem('postalCode')}>
          <Input
            id="setup-postal-code"
            value={address.postalCode}
            maxLength={10}
            inputMode="numeric"
            autoComplete="postal-code"
            invalid={!!problem('postalCode')}
            onChange={(e) => set({ postalCode: e.target.value })}
            data-testid="setup-postal-code"
          />
        </Field>
      </div>
    </fieldset>
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
  const [changing, setChanging] = useState(false);
  if (!picked && !changing)
    return (
      <p
        className="-mt-1 flex flex-wrap items-center gap-x-2 text-[13.5px] text-text-2"
        data-testid="setup-time-zone"
      >
        {W.timeZoneFromAddress(usTimeZoneLabel(timeZone))}
        <button
          type="button"
          onClick={() => setChanging(true)}
          className="font-medium text-accent-text hover:underline"
          data-testid="setup-time-zone-change"
        >
          {W.changeTimeZone}
        </button>
      </p>
    );
  return (
    <Field label={W.timeZone} htmlFor="setup-time-zone">
      <Select
        id="setup-time-zone"
        value={timeZone}
        onChange={(e) => onPick(e.target.value)}
        data-testid="setup-time-zone-pick"
      >
        {US_TIME_ZONES.some((z) => z.id === timeZone) ? null : (
          <option value={timeZone}>{timeZone}</option>
        )}
        {US_TIME_ZONES.map((z) => (
          <option key={z.id} value={z.id}>
            {z.label} ({z.example})
          </option>
        ))}
      </Select>
    </Field>
  );
}
