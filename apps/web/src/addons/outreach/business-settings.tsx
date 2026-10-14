'use client';
import { hourWords, MORNING_PUSH_HOURS } from '@hfos/core/addons/outreach/alerts';
import {
  CONTACTS_FROM_CHATS,
  CONTACTS_FROM_CHATS_WORDS,
  outreachSettings,
  settingsToSave,
  type ContactsFromChats,
} from '@hfos/core/addons/outreach/chat-read';
import {
  COUNTRY_MODE_WORDS,
  COUNTRY_MODES,
  COUNTRY_WORDS,
  countryRuleWords,
  type CountryRule,
} from '@hfos/core/addons/outreach/countries';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioCard } from '@/components/ui/radio-card';
import type { AddonSettingsProps } from '../registry';
import { CountryPicker } from './country-picker';
import { useAct } from './use-act';

/** The weeks a sent friend request can wait before it's suggested for cancelling. */
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * In Social Outreach → Settings → Business settings, for owners and admins (the Add-ons page links there,
 * settings-link.tsx): who from the chats brought in from Facebook goes in Contacts once the AI has read them
 * (docs/outreach.md, decision 3), and how long a sent friend request waits before it's suggested for cancelling
 * (decision 12), the hour of the morning push to each person's phone, in the business's time zone (decision 22), and
 * whether each person gets the weekly report by email (decision 34), and which countries it reaches (decision 61).
 * Anyone already in Contacts gets the tags whatever it says.
 */
export default function OutreachBusinessSettings({ settings, saveSettings }: AddonSettingsProps) {
  const now = outreachSettings(settings);
  const saved = now.contactsFromChats;
  const [pick, setPick] = useState<ContactsFromChats>(saved);
  const [weeks, setWeeks] = useState(now.cancelRequestsAfterWeeks);
  const [hour, setHour] = useState(now.morningPushHour);
  const [weekly, setWeekly] = useState(now.weeklyReport);
  const [countries, setCountries] = useState<CountryRule>(now.countries);
  const countriesChanged =
    countries.mode !== now.countries.mode ||
    countries.codes.join(',') !== now.countries.codes.join(',');
  const countriesProblem =
    countries.mode === 'only' && !countries.codes.length ? COUNTRY_WORDS.noneOnly : null;
  const { busy, act } = useAct();
  if (settings === null)
    return (
      <p className="text-[13px] text-text-2">
        Who from your Facebook chats goes in Contacts: {CONTACTS_FROM_CHATS_WORDS[saved]}. Friend
        requests are suggested for cancelling after {W.weeks(now.cancelRequestsAfterWeeks)}. The
        morning push{' '}
        {now.morningPushHour === null ? 'is off' : `comes at ${hourWords(now.morningPushHour)}`},
        and the weekly report {now.weeklyReport ? 'comes by email on Mondays' : 'is off'}. Countries
        reached: {countryRuleWords(now.countries)}. An owner or admin can change these.
      </p>
    );
  return (
    <div className="space-y-3" data-testid="outreach-settings">
      <div>
        <h3 className="text-[14px] font-semibold">{W.sections.contacts}</h3>
        <p className="text-[13px] text-text-2">{W.abouts.contacts}</p>
      </div>
      <div role="radiogroup" aria-label="Who goes in Contacts" className="flex flex-col gap-2">
        {CONTACTS_FROM_CHATS.map((k) => (
          <RadioCard
            key={k}
            selected={pick === k}
            onSelect={() => setPick(k)}
            title={CONTACTS_FROM_CHATS_WORDS[k]}
            description={k === 'tagged' ? W.usual : undefined}
            testId={`outreach-contacts-${k}`}
          />
        ))}
      </div>
      <label className="block">
        <span className="text-[14px] font-semibold">{W.sections.cancelAfter}</span>
        <span className="block text-[13px] text-text-2">{W.abouts.cancelAfter}</span>
        <select
          className="mt-1.5 h-8 rounded-control border border-border-strong bg-card px-2 text-[13px]"
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value))}
          data-testid="outreach-cancel-weeks"
        >
          {WEEKS.map((w) => (
            <option key={w} value={w}>
              {W.weeks(w)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[14px] font-semibold">{W.sections.morning}</span>
        <span className="block text-[13px] text-text-2">{W.abouts.morning}</span>
        <select
          className="mt-1.5 h-8 rounded-control border border-border-strong bg-card px-2 text-[13px]"
          value={hour === null ? 'off' : String(hour)}
          onChange={(e) => setHour(e.target.value === 'off' ? null : Number(e.target.value))}
          data-testid="outreach-morning-hour"
        >
          {/* An hour set some other way still shows. */}
          {[...new Set([...MORNING_PUSH_HOURS, ...(hour === null ? [] : [hour])])]
            .sort((a, b) => a - b)
            .map((h) => (
              <option key={h} value={String(h)}>
                {hourWords(h)}
              </option>
            ))}
          <option value="off">{W.off}</option>
        </select>
      </label>
      <div>
        <Checkbox
          label={<span className="text-[14px] font-semibold">{W.sections.weekly}</span>}
          checked={weekly}
          onChange={(e) => setWeekly(e.target.checked)}
          data-testid="outreach-weekly-report"
        />
        <span className="mt-0.5 block pl-7 text-[13px] text-text-2">{W.abouts.weekly}</span>
      </div>
      <div data-testid="outreach-countries">
        <h3 className="text-[14px] font-semibold">{W.sections.countries}</h3>
        <p className="text-[13px] text-text-2">{W.abouts.countries}</p>
        <div role="radiogroup" aria-label="Which countries" className="mt-2 flex flex-col gap-2">
          {COUNTRY_MODES.map((m) => (
            <RadioCard
              key={m}
              selected={countries.mode === m}
              onSelect={() => setCountries({ ...countries, mode: m })}
              title={COUNTRY_MODE_WORDS[m]}
              description={m === 'anywhere' ? W.usual : undefined}
              testId={`outreach-countries-${m}`}
            />
          ))}
        </div>
        {countries.mode !== 'anywhere' ? (
          <CountryPicker
            codes={countries.codes}
            onChange={(codes) => setCountries({ ...countries, codes })}
          />
        ) : null}
        {countriesProblem ? (
          <p className="mt-1.5 text-[12.5px] text-danger-text" role="alert">
            {countriesProblem}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        disabled={
          (pick === saved &&
            weeks === now.cancelRequestsAfterWeeks &&
            hour === now.morningPushHour &&
            weekly === now.weeklyReport &&
            !countriesChanged) ||
          countriesProblem !== null ||
          busy !== null
        }
        onClick={() =>
          void act(
            'save',
            () =>
              saveSettings(
                // What's kept, read as it's checked, so a stored link that stopped passing doesn't refuse the save.
                settingsToSave(settings, {
                  contactsFromChats: pick,
                  cancelRequestsAfterWeeks: weeks,
                  morningPushHour: hour,
                  weeklyReport: weekly,
                  countries,
                }),
              ),
            W.saved,
          )
        }
        data-testid="outreach-settings-save"
      >
        {W.save}
      </Button>
    </div>
  );
}
