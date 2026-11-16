'use client';
import { hourWords, MORNING_PUSH_HOURS } from '@hfos/core/addons/outreach/alerts';
import {
  CONTACTS_FROM_CHATS,
  CONTACTS_FROM_CHATS_WORDS,
  type ContactsFromChats,
  type OutreachSettings,
} from '@hfos/core/addons/outreach/chat-read';
import {
  COUNTRY_MODE_WORDS,
  COUNTRY_MODES,
  COUNTRY_UNSURE,
  COUNTRY_UNSURE_WORDS,
  COUNTRY_WORDS,
  countryRuleWords,
  type CountryRule,
} from '@hfos/core/addons/outreach/countries';
import { FOUND_CHECKS } from '@hfos/core/addons/outreach/finds';
import { SETTINGS_PAGE_WORDS as SP } from '@hfos/core/addons/outreach/settings-pages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { RadioCard } from '@/components/ui/radio-card';
import { Switch } from '@/components/ui/switch';
import { CountryPicker } from './country-picker';
import { ChangeRow, PickRow } from './network-settings';

/** The weeks a sent friend request can wait before it's suggested for cancelling. */
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);
/** The people found by topic the AI checks a day for each person: 10 to 100, in tens (decision 116). */
const FOUND_CHECK_STEPS = Array.from(
  { length: (FOUND_CHECKS.most - FOUND_CHECKS.least) / 10 + 1 },
  (_, i) => FOUND_CHECKS.least + i * 10,
);

/** The business's Social Outreach settings these fields change: all but the extension's link and the video library, each with its own place. */
export type TeamSettings = Omit<OutreachSettings, 'extensionLink' | 'videos'>;

/** Why the countries can't be saved yet: Only these countries, with none picked. Null when they can. */
export const countriesProblem = (countries: CountryRule): string | null =>
  countries.mode === 'only' && !countries.codes.length ? COUNTRY_WORDS.noneOnly : null;

const select =
  'h-8 max-w-full rounded-control border border-border-strong bg-card px-2 text-[13px] max-md:h-11';

/**
 * Team's For the whole business (Social Outreach → Settings → Team, for owners and admins; the Add-ons page links
 * there, settings-link.tsx), as rows that say how each stands (decision 170): which countries it reaches (decision
 * 61) and what happens when a look can't tell where someone lives (decision 86), behind Change; who from the chats
 * the AI reads goes in Contacts (decision 3), how long a request or follow is warmed up before it's withdrawn
 * (decision 12), the hour of the morning push to each person's phone, in the business's time zone (decision 22), and
 * whether each person gets the weekly report by email (decision 34), each a short pick. Anyone already in Contacts
 * gets the tags whatever it says. Each change goes to `onChange`, which saves it (./use-autosave.ts).
 */
export function BusinessRows({
  value,
  onChange,
}: {
  value: TeamSettings;
  onChange: (change: Partial<TeamSettings>) => void;
}) {
  const { countries } = value;
  const problem = countriesProblem(countries);
  return (
    <>
      <ChangeRow
        title={SP.countries}
        about={countryRuleWords(countries)}
        open={problem !== null}
        testId="outreach-countries-row"
      >
        <div data-testid="outreach-countries">
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
          {countries.mode !== 'anywhere' ? (
            <div className="mt-4" data-testid="outreach-countries-unsure">
              <h4 className="text-[13.5px] font-semibold">{COUNTRY_UNSURE_WORDS.title}</h4>
              <p className="text-[13px] text-text-2">{COUNTRY_UNSURE_WORDS.note}</p>
              <div
                role="radiogroup"
                aria-label={COUNTRY_UNSURE_WORDS.title}
                className="mt-2 flex flex-col gap-2"
              >
                {COUNTRY_UNSURE.map((u) => (
                  <RadioCard
                    key={u}
                    selected={countries.unsure === u}
                    onSelect={() => onChange({ countries: { ...countries, unsure: u } })}
                    title={COUNTRY_UNSURE_WORDS[u]}
                    description={u === 'ask' ? W.usual : undefined}
                    testId={`outreach-countries-unsure-${u}`}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </ChangeRow>
      <PickRow title={SP.contacts} about={SP.contactsAbout} testId="outreach-contacts-row">
        <select
          className={select}
          value={value.contactsFromChats}
          onChange={(e) => onChange({ contactsFromChats: e.target.value as ContactsFromChats })}
          aria-label={SP.contacts}
          title={CONTACTS_FROM_CHATS_WORDS[value.contactsFromChats]}
          data-testid="outreach-contacts"
        >
          {CONTACTS_FROM_CHATS.map((k) => (
            <option key={k} value={k}>
              {SP.contactsShort[k]}
            </option>
          ))}
        </select>
      </PickRow>
      <PickRow title={SP.warmUp} about={SP.warmUpAbout} testId="outreach-cancel-weeks-row">
        <select
          className={select}
          value={value.cancelRequestsAfterWeeks}
          onChange={(e) => onChange({ cancelRequestsAfterWeeks: Number(e.target.value) })}
          aria-label={SP.warmUp}
          data-testid="outreach-cancel-weeks"
        >
          {WEEKS.map((w) => (
            <option key={w} value={w}>
              {W.weeks(w)}
            </option>
          ))}
        </select>
      </PickRow>
      <PickRow title={SP.morning} about={SP.morningAbout} testId="outreach-morning-row">
        <select
          className={select}
          value={value.morningPushHour === null ? 'off' : String(value.morningPushHour)}
          onChange={(e) =>
            onChange({
              morningPushHour: e.target.value === 'off' ? null : Number(e.target.value),
            })
          }
          aria-label={SP.morning}
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
      </PickRow>
      <PickRow title={SP.weekly} about={SP.weeklyAbout} testId="outreach-weekly-row">
        <Switch
          checked={value.weeklyReport}
          onChange={(weeklyReport) => onChange({ weeklyReport })}
          label={SP.weekly}
          testId="outreach-weekly-report"
        />
      </PickRow>
    </>
  );
}

/** How many people found by topic the AI checks a day for each person (decision 116): under Team's More settings. */
export function FoundChecksPick({
  value,
  onChange,
}: {
  value: TeamSettings;
  onChange: (change: Partial<TeamSettings>) => void;
}) {
  return (
    <PickRow
      title={W.sections.foundChecks}
      about={W.abouts.foundChecks}
      testId="outreach-found-checks-row"
    >
      <select
        className={select}
        value={value.foundChecksPerDay}
        onChange={(e) => onChange({ foundChecksPerDay: Number(e.target.value) })}
        aria-label={W.sections.foundChecks}
        data-testid="outreach-found-checks"
      >
        {/* A number set some other way still shows. */}
        {[...new Set([...FOUND_CHECK_STEPS, value.foundChecksPerDay])]
          .sort((a, b) => a - b)
          .map((n) => (
            <option key={n} value={n}>
              {W.aDay(n)}
            </option>
          ))}
      </select>
    </PickRow>
  );
}
