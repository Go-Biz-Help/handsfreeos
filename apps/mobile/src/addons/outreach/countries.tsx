import {
  COUNTRY_HOW_WORDS,
  COUNTRY_LIST_WORDS as LW,
  COUNTRY_LISTS,
  countryRuleOn,
  countryRuleWords,
  type CountriesSkippedOutput,
  type CountryChoice,
  type CountryList,
} from '@hfos/core/addons/outreach/countries';
import { seenWords } from '@hfos/core/addons/outreach/live';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { NeedsSignal, Note, openOutside, useOutreachAnswer, useOutreachContext } from './kit';
import { PHONE_WORDS } from './phone-words';

/**
 * The lists the business's country setting makes (docs/outreach.md, decisions 61 and 86), as the web's Friends tab has
 * them (country-skipped.tsx), each on its own screen (`?view=countries&show=unsure|skipped`), opened from General in
 * Settings while the setting picks countries:
 *
 * - **Not sure where they live**: everyone a look couldn't place, while When we can't tell is Ask me. Each waits for a
 *   person's call: **Let through** or **Skip**, both for good (`outreach.country.decide`).
 * - **Skipped for country**: everyone the setting skips, with what their profile and friends say, and how many still
 *   wait for a look. **Unskip** lets one through from then on, whatever the setting says (`outreach.country.unskip`);
 *   one a person skipped can be put back under the setting (**Undo**).
 *
 * Each list is `outreach.countries.skipped`, a page at a time, with Show more. It needs signal, and so do the calls.
 */

const C = PHONE_WORDS.countries;

export type CountryRow = CountriesSkippedOutput['people'][number];
/** A call on someone: one of the Not sure list's, Undo, or Unskip. */
export type CountryCall = CountryChoice | 'unskip';

/** The list an address names: the Skipped for country list unless it says Not sure. */
export const countryListOf = (show: string | null | undefined): CountryList =>
  COUNTRY_LISTS.find((l) => l === show) ?? 'skipped';

/** A list's title, as its screen and General's row say it. */
export const countryListTitle = (list: CountryList): string =>
  list === 'unsure' ? LW.unsureTitle : C.skippedTitle;

/** What a call says once it's kept: "Dana Reyes is let through from now on." */
export function countryCallDone(call: CountryCall, name: string): string {
  switch (call) {
    case 'through':
      return C.throughDone(name);
    case 'skip':
      return C.skipDone(name);
    case 'setting':
      return C.undoDone(name);
    default:
      return C.unskipDone(name);
  }
}

/** Whether the lists are worth showing: only while the setting picks countries, or anyone is still skipped. */
export const countryListsShown = (got: CountriesSkippedOutput | null): boolean =>
  got !== null && (countryRuleOn(got.rule) || got.total > 0 || got.unsure > 0);

/**
 * General's rows to the lists, each with how many are on it: Not sure where they live while anyone waits, and Skipped
 * for country. Nothing while the setting reaches anywhere and nobody is skipped.
 */
export function CountryListRows({
  got,
  onOpen,
}: {
  got: CountriesSkippedOutput | null;
  onOpen: (list: CountryList) => void;
}) {
  if (!got || !countryListsShown(got)) return null;
  return (
    <List testID="settings-country-lists">
      {got.unsure > 0 ? (
        <ListRow
          label={LW.unsureTitle}
          end={got.unsure.toLocaleString('en-US')}
          onPress={() => onOpen('unsure')}
          testID="settings-country-list-unsure"
        />
      ) : null}
      <ListRow
        label={C.skippedTitle}
        end={got.total.toLocaleString('en-US')}
        onPress={() => onOpen('skipped')}
        testID="settings-country-list-skipped"
      />
    </List>
  );
}

/** General's part for someone who doesn't set the countries: what the business reaches, and the lists. */
export function CountryListsPart({
  got,
  onOpen,
}: {
  got: CountriesSkippedOutput | null;
  onOpen: (list: CountryList) => void;
}) {
  if (!got || !countryListsShown(got)) return null;
  return (
    <View className="gap-2" testID="settings-country-lists-part">
      <View className="gap-0.5 px-1">
        <Text className="text-[15px] font-semibold">{W.sections.countries}</Text>
        <Note>{C.reaches(countryRuleWords(got.rule))}</Note>
      </View>
      <CountryListRows got={got} onOpen={onOpen} />
    </View>
  );
}

export function CountriesScreen({ show }: { show?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const list = countryListOf(show);
  const [pages, setPages] = React.useState(1);
  const answer = useOutreachAnswer(
    async () => {
      const all: CountriesSkippedOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.countries.skipped', {
              body: { workspaceId: ws, list, page },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, people: all.flatMap((a) => a.people) };
    },
    `countries:${ws}:${list}:${pages}`,
    countryListTitle(list),
  );
  return (
    <CountriesBody
      list={list}
      got={answer.data}
      error={answer.error}
      online={ctx.online}
      timeZone={ctx.timeZone}
      now={Date.now()}
      onRetry={answer.reload}
      onMore={() => setPages((p) => p + 1)}
      onOpen={openOutside}
      onCall={async (p, call) => {
        try {
          if (call === 'unskip')
            await change('outreach.country.unskip', {
              workspaceId: ws,
              profileId: p.profileId,
              through: true,
            });
          else
            await change('outreach.country.decide', {
              workspaceId: ws,
              profileId: p.profileId,
              choice: call,
            });
          toast.show(countryCallDone(call, p.name));
          answer.reload();
        } catch (e) {
          toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
        }
      }}
    />
  );
}

export function CountriesBody({
  list,
  got,
  error,
  online,
  timeZone,
  now,
  onRetry,
  onMore,
  onOpen,
  onCall,
}: {
  list: CountryList;
  got: CountriesSkippedOutput | null;
  error: string | null;
  online: boolean;
  timeZone: string;
  now: number;
  onRetry: () => void;
  onMore: () => void;
  /** Opens someone's profile on their network. */
  onOpen: (url: string) => void;
  /** A call on someone: kept, said, and the list asked again. */
  onCall: (person: CountryRow, call: CountryCall) => Promise<void>;
}) {
  const title = countryListTitle(list);
  // One call at a time, as the web's: the list moves once it's kept.
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!got)
    return (
      <Screen title={title} leading="back" testID="outreach-countries">
        {error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="countries-needs-signal" />
        ) : (
          <ActivityIndicator className="py-8" />
        )}
      </Screen>
    );
  const call = async (p: CountryRow, c: CountryCall) => {
    setBusy(`${c}:${p.profileId}`);
    try {
      await onCall(p, c);
    } finally {
      setBusy(null);
    }
  };
  const note =
    list === 'unsure'
      ? LW.unsureNote
      : [
          `${C.reaches(countryRuleWords(got.rule))} ${C.skippedAbout}`,
          got.unskipped ? C.unskipped(got.unskipped) : null,
          got.waiting ? LW.waiting(got.waiting) : null,
        ]
          .filter(Boolean)
          .join(' ');
  const off = !online || busy !== null;
  const button = (p: CountryRow, c: CountryCall, words: string, testID: string) => (
    <Button
      size="sm"
      variant="secondary"
      loading={busy === `${c}:${p.profileId}`}
      disabled={off}
      onPress={() => void call(p, c)}
      testID={testID}
    >
      {words}
    </Button>
  );
  return (
    <Screen
      title={title}
      subtitle={got.total ? got.total.toLocaleString('en-US') : undefined}
      leading="back"
      testID="outreach-countries"
    >
      {!online ? <NeedsSignal words={W.needsSignal(title)} testID="countries-offline" /> : null}
      <Note testID="countries-note">{note}</Note>
      {got.people.length ? (
        <List testID={`countries-${list}`}>
          {got.people.map((p) => (
            <View key={p.profileId} className="gap-1.5 px-4 py-3" testID="country-row">
              <Pressable
                role="link"
                accessibilityLabel={p.name}
                onPress={() => onOpen(p.url)}
                className="min-h-11 justify-center self-start"
              >
                <Text className="text-[15px] font-medium text-accent-text">{p.name}</Text>
              </Pressable>
              <View className="flex-row flex-wrap items-center gap-1.5">
                {p.countryName ? (
                  <Text className="text-[13px] text-text-2">{p.countryName}</Text>
                ) : null}
                {p.skippedByYou ? (
                  <Badge variant="gray">
                    <Text>{LW.skippedByYou}</Text>
                  </Badge>
                ) : p.how ? (
                  <Badge variant={p.how === 'seen' || p.how === 'friends' ? 'ok' : 'gray'}>
                    <Text>{COUNTRY_HOW_WORDS[p.how]}</Text>
                  </Badge>
                ) : null}
                {p.at ? (
                  <Text className="text-[12.5px] text-text-3">
                    {seenWords(p.at, timeZone, now)}
                  </Text>
                ) : null}
              </View>
              {p.reason.length ? <Note>{p.reason.join(' · ')}</Note> : null}
              {p.why ? (
                <Text className="text-[13px] leading-[18px] text-text-3">{p.why}</Text>
              ) : null}
              <View className="flex-row flex-wrap gap-2">
                {list === 'unsure' ? (
                  <>
                    {button(p, 'through', LW.through, 'country-let-through')}
                    {button(p, 'skip', LW.skip, 'country-skip')}
                  </>
                ) : p.skippedByYou ? (
                  button(p, 'setting', LW.undo, 'country-undo-skip')
                ) : (
                  button(p, 'unskip', C.unskip, 'country-unskip')
                )}
              </View>
            </View>
          ))}
        </List>
      ) : list === 'skipped' ? (
        <Note testID="countries-empty">{C.skippedEmpty}</Note>
      ) : null}
      {got.page < got.pages ? (
        <Button variant="secondary" onPress={onMore} testID="countries-more">
          {W.more}
        </Button>
      ) : null}
    </Screen>
  );
}
