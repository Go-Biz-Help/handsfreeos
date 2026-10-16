'use client';
import { hourWords, MORNING_PUSH_HOURS } from '@hfos/core/addons/outreach/alerts';
import {
  CONTACTS_FROM_CHATS,
  CONTACTS_FROM_CHATS_WORDS,
  type OutreachSettings,
} from '@hfos/core/addons/outreach/chat-read';
import {
  COUNTRY_MODE_WORDS,
  COUNTRY_MODES,
  COUNTRY_WORDS,
  type CountryRule,
} from '@hfos/core/addons/outreach/countries';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { RadioCard } from '@/components/ui/radio-card';
import { Switch } from '@/components/ui/switch';
import { CountryPicker } from './country-picker';

/** The weeks a sent friend request can wait before it's suggested for cancelling. */
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);

/** The business's Social Outreach settings these fields change: all but the extension's link, which has its own box. */
export type TeamSettings = Omit<OutreachSettings, 'extensionLink'>;

/** Why the countries can't be saved yet: Only these countries, with none picked. Null when they can. */
export const countriesProblem = (countries: CountryRule): string | null =>
  countries.mode === 'only' && !countries.codes.length ? COUNTRY_WORDS.noneOnly : null;

const select =
  'mt-1.5 h-8 rounded-control border border-border-strong bg-card px-2 text-[13px] max-md:h-11';

/**
 * In Social Outreach → Settings → General, under For your team, for owners and admins (the Add-ons page links there,
 * settings-link.tsx): who from the chats brought in from Facebook goes in Contacts once the AI has read them
 * (docs/outreach.md, decision 3), how long a sent friend request waits before it's suggested for cancelling (decision
 * 12), the hour of the morning push to each person's phone, in the business's time zone (decision 22), whether each
 * person gets the weekly report by email (decision 34), and which countries it reaches (decision 61). Anyone already
 * in Contacts gets the tags whatever it says. Each change goes to `onChange`, which saves it (./use-autosave.ts).
 */
export function TeamSettingsFields({
  value,
  onChange,
}: {
  value: TeamSettings;
  onChange: (change: Partial<TeamSettings>) => void;
}) {
  const { countries } = value;
  const problem = countriesProblem(countries);
  return (
    <div className="space-y-4" data-testid="outreach-settings">
      <div className="space-y-2">
        <div>
          <h3 className="text-[14px] font-semibold">{W.sections.contacts}</h3>
          <p className="text-[13px] text-text-2">{W.abouts.contacts}</p>
        </div>
        <div role="radiogroup" aria-label="Who goes in Contacts" className="flex flex-col gap-2">
          {CONTACTS_FROM_CHATS.map((k) => (
            <RadioCard
              key={k}
              selected={value.contactsFromChats === k}
              onSelect={() => onChange({ contactsFromChats: k })}
              title={CONTACTS_FROM_CHATS_WORDS[k]}
              description={k === 'tagged' ? W.usual : undefined}
              testId={`outreach-contacts-${k}`}
            />
          ))}
        </div>
      </div>
      <label className="block border-t border-border pt-4">
        <span className="text-[14px] font-semibold">{W.sections.cancelAfter}</span>
        <span className="block text-[13px] text-text-2">{W.abouts.cancelAfter}</span>
        <select
          className={select}
          value={value.cancelRequestsAfterWeeks}
          onChange={(e) => onChange({ cancelRequestsAfterWeeks: Number(e.target.value) })}
          data-testid="outreach-cancel-weeks"
        >
          {WEEKS.map((w) => (
            <option key={w} value={w}>
              {W.weeks(w)}
            </option>
          ))}
        </select>
      </label>
      <label className="block border-t border-border pt-4">
        <span className="text-[14px] font-semibold">{W.sections.morning}</span>
        <span className="block text-[13px] text-text-2">{W.abouts.morning}</span>
        <select
          className={select}
          value={value.morningPushHour === null ? 'off' : String(value.morningPushHour)}
          onChange={(e) =>
            onChange({
              morningPushHour: e.target.value === 'off' ? null : Number(e.target.value),
            })
          }
          data-testid="outreach-morning-hour"
        >
          {/* An hour set some other way still shows. */}
          {[
            ...new Set([
              ...MORNING_PUSH_HOURS,
              ...(value.morningPushHour === null ? [] : [value.morningPushHour]),
            ]),
          ]
            .sort((a, b) => a - b)
            .map((h) => (
              <option key={h} value={String(h)}>
                {hourWords(h)}
              </option>
            ))}
          <option value="off">{W.off}</option>
        </select>
      </label>
      <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">{W.sections.weekly}</h3>
          <p className="text-[13px] text-text-2">{W.abouts.weekly}</p>
        </div>
        <Switch
          checked={value.weeklyReport}
          onChange={(weeklyReport) => onChange({ weeklyReport })}
          label={W.sections.weekly}
          testId="outreach-weekly-report"
        />
      </div>
      <div className="border-t border-border pt-4" data-testid="outreach-countries">
        <h3 className="text-[14px] font-semibold">{W.sections.countries}</h3>
        <p className="text-[13px] text-text-2">{W.abouts.countries}</p>
        <div role="radiogroup" aria-label="Which countries" className="mt-2 flex flex-col gap-2">
          {COUNTRY_MODES.map((m) => (
            <RadioCard
              key={m}
              selected={countries.mode === m}
              onSelect={() => onChange({ countries: { ...countries, mode: m } })}
              title={COUNTRY_MODE_WORDS[m]}
              description={m === 'anywhere' ? W.usual : undefined}
              testId={`outreach-countries-${m}`}
            />
          ))}
        </div>
        {countries.mode !== 'anywhere' ? (
          <CountryPicker
            codes={countries.codes}
            onChange={(codes) => onChange({ countries: { ...countries, codes } })}
          />
        ) : null}
        {problem ? (
          <p className="mt-1.5 text-[12.5px] text-danger-text" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </div>
  );
}
