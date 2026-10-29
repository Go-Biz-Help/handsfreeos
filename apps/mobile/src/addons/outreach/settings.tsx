import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import type {
  AutomationOutput,
  AutomationPeopleOutput,
  AutomationSettings,
} from '@hfos/core/addons/outreach/automation';
import {
  outreachSettings,
  settingsToSave,
  type OutreachSettings,
} from '@hfos/core/addons/outreach/chat-read';
import type { CountriesSkippedOutput, CountryList } from '@hfos/core/addons/outreach/countries';
import { networksOn } from '@hfos/core/addons/outreach/network-words';
import { PLATFORM_KEYS, PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  isNetworkPart,
  NEXT_NETWORKS,
  SETTINGS_WORDS,
  settingsPartOf,
} from '@hfos/core/addons/outreach/settings-parts';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { useFocusEffect } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Check, CircleDashed, Globe, Laptop, SlidersHorizontal } from '@/components/icons';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api, errorMessage, unwrap } from '@/lib/api';

import { useAutosave, type SaveState } from './autosave';
import { CountryListRows, CountryListsPart } from './countries';
import {
  NeedsSignal,
  Note,
  openOutreach,
  openSettingsPart,
  Part,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';
import { SaveLine } from './settings-bits';
import { GeneralMine, GeneralTeam } from './settings-general';
import { NetworkMine, NetworkTeam } from './settings-network';
import type { LikeYoursProps } from './like-yours';
import { useAskActions, useAsks, type AskActions } from './asks';
import { useProfileProps, type ProfileProps } from './ready';

/**
 * Social Outreach's Settings on the phone (decision 44), a page for each part as on the web (Chris, 2026-10-16: "a
 * settings menu with general settings and then all the platforms"). The Settings screen is the menu: General, each
 * network with whether it's on for the person shown, the networks still to come, then Your computer (Playbooks are a
 * page of their own since decision 126).
 * Owners and admins pick whose under Settings for, and each part opens for them. A part is its own screen over the
 * menu (`?part=`, ./kit.tsx's `openSettingsPart`); an address with no part, as every link before the parts, opens the
 * menu. Every change saves as it's made (./autosave.ts), with no Save button: the person's through
 * `outreach.automation.save`, the business's through `addon.save_settings`. The extension follows within seconds. It
 * all needs signal. General also leads to the lists the country setting makes, for everyone (./countries.tsx).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = (e: unknown) => (e instanceof ChangeError ? e.message : errorMessage(e));

/** The parts the phone draws as a page: General and each network. Your computer is the Live screen. */
export type PhonePart = 'general' | Platform;

/** The part an address names, or null for the menu: no part, or one the phone opens elsewhere. */
export function phonePartOf(raw: string | null | undefined): PhonePart | null {
  if (!raw) return null;
  const part = settingsPartOf(raw);
  return part === 'general' || isNetworkPart(part) ? part : null;
}

export function SettingsScreen({ whose, part: raw }: { whose?: string; part?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const part = phonePartOf(raw);
  const [picked, setUserId] = React.useState<string | null>(
    whose && UUID.test(whose) ? whose.toLowerCase() : null,
  );
  // Someone else's only for owners and admins, read as their grants come.
  const userId = ctx.manages ? picked : null;
  const mine = !userId || userId === ctx.userId;
  const automation = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.automation', {
          body: { workspaceId: ws, ...(mine ? {} : { userId: userId! }) },
        }),
      ),
    `automation:${ws}:${userId ?? 'me'}`,
    W.rows.settings,
  );
  // Whose to pick from, on the menu; the business's, on a part.
  const people = useOutreachAnswer(
    ctx.manages && !part
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.automation.people', { body: { workspaceId: ws } }),
          )
      : null,
    `automation-people:${ws}`,
    W.rows.settings,
  );
  const business = useOutreachAnswer(
    ctx.manages && part
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/addon.settings', {
              body: { workspaceId: ws, addonId: 'outreach' },
            }),
          ).settings
      : null,
    `outreach-business:${ws}`,
    W.rows.settings,
  );
  // On General: how many the country setting holds back, for its lists (decisions 61 and 86).
  const countries = useOutreachAnswer(
    part === 'general'
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.countries.skipped', {
              body: { workspaceId: ws, list: 'skipped', page: 1 },
            }),
          )
      : null,
    `countries-count:${ws}`,
    W.rows.settings,
  );
  // On Instagram's page: the business's accounts like yours (decision 110).
  const likeYours = useOutreachAnswer(
    part === 'instagram'
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.like_yours.list', { body: { workspaceId: ws } }),
          )
      : null,
    `like-yours:${ws}`,
    W.rows.settings,
  );
  // A network's page, the person's own: Check LinkedIn's ask, and their computer (decision 74).
  const networkPart = part !== null && part !== 'general' && mine;
  const asks = useAsks('settings', W.rows.settings, networkPart);
  const askActions = useAskActions(asks.data, asks.reload);
  // Their profile there, read and checked (decision 80).
  const profile = useProfileProps(networkPart ? part : null, asks.data, W.rows.settings);
  // Back on the menu from a part: asked again, so each network's On or Off is as just saved.
  const shown = React.useRef(false);
  const { reload: reloadAutomation } = automation;
  const { reload: reloadPeople } = people;
  const { reload: reloadCountries } = countries;
  useFocusEffect(
    React.useCallback(() => {
      if (shown.current && !part) {
        reloadAutomation();
        reloadPeople();
      }
      // Back on General from a country list: its counts as they are now.
      if (shown.current && part === 'general') reloadCountries();
      shown.current = true;
    }, [part, reloadAutomation, reloadPeople, reloadCountries]),
  );
  // The business's saves go one at a time, each on what's kept as it goes, so two parts saving together never undo
  // each other.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());

  if (!part)
    return (
      <SettingsMenuBody
        automation={automation.data}
        error={automation.error}
        mine={mine}
        people={ctx.manages ? people.data : null}
        online={ctx.online}
        onRetry={automation.reload}
        onWhose={(id) => setUserId(id === ctx.userId ? null : id)}
        onPart={(p) => openSettingsPart(ws, p, mine ? null : userId)}
        onOpen={(view) => openOutreach(ws, view)}
      />
    );
  return (
    <SettingsPartBody
      part={part}
      automation={automation.data}
      error={automation.error}
      asks={asks.data}
      askActions={askActions}
      profile={profile}
      mine={mine}
      business={ctx.manages ? business.data : null}
      manages={ctx.manages}
      online={ctx.online}
      countries={countries.data}
      onCountries={(list) => openOutreach(ws, 'countries', `show=${list}`)}
      likeYours={
        part === 'instagram'
          ? {
              list: likeYours.data,
              timeZone: ctx.timeZone,
              onAdd: async (account) => {
                try {
                  await change('outreach.like_yours.add', { workspaceId: ws, account });
                  likeYours.reload();
                  return null;
                } catch (e) {
                  return failed(e);
                }
              },
              onRemove: async (id) => {
                try {
                  await change('outreach.like_yours.remove', { workspaceId: ws, id });
                  likeYours.reload();
                  return null;
                } catch (e) {
                  return failed(e);
                }
              },
            }
          : null
      }
      onRetry={automation.reload}
      onSaveMine={async (settings) => {
        try {
          await change('outreach.automation.save', {
            workspaceId: ws,
            ...(mine ? {} : { userId: userId! }),
            settings,
          });
          automation.reload();
          return null;
        } catch (e) {
          return failed(e);
        }
      }}
      onSaveBusiness={(edit) => {
        const save = async () => {
          try {
            // What's kept now, so a setting this page doesn't show stays as it is; read as it's checked, so a stored
            // link that stopped passing doesn't refuse the save.
            const kept =
              unwrap(
                await api.POST('/v1/queries/addon.settings', {
                  body: { workspaceId: ws, addonId: 'outreach' },
                }),
              ).settings ?? {};
            await change('addon.save_settings', {
              workspaceId: ws,
              addonId: 'outreach',
              settings: settingsToSave(kept, edit(outreachSettings(kept))),
            });
            business.reload();
            automation.reload();
            countries.reload();
            return null;
          } catch (e) {
            return failed(e);
          }
        };
        const next = queue.current.then(save);
        queue.current = next;
        return next;
      }}
    />
  );
}

/** The menu: General, the networks, and the rest. */
export function SettingsMenuBody({
  automation,
  error,
  mine,
  people,
  online,
  onRetry,
  onWhose,
  onPart,
  onOpen,
}: {
  automation: AutomationOutput | null;
  error: string | null;
  mine: boolean;
  people: AutomationPeopleOutput | null;
  online: boolean;
  onRetry: () => void;
  onWhose: (userId: string) => void;
  onPart: (part: PhonePart) => void;
  /** The person's computer, beside the settings; Playbooks are a page of their own (decision 126). */
  onOpen: (view: 'live') => void;
}) {
  if (!automation)
    return (
      <Screen title={W.rows.settings} leading="back" testID="outreach-settings">
        {error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="settings-needs-signal" />
        ) : null}
      </Screen>
    );
  const on = networksOn(automation.settings, automation.rules.networksAllowed);
  return (
    <Screen
      title={W.rows.settings}
      subtitle={mine ? undefined : W.settingsOf(automation.name)}
      leading="back"
      testID="outreach-settings"
    >
      {!online ? <NeedsSignal words={W.needsSignal(W.rows.settings)} /> : null}
      {people && people.people.length > 1 ? (
        <Part title={W.settingsFor} testID="settings-for">
          <List>
            {people.people.map((p) => (
              <ListRow
                key={p.userId}
                label={`${p.name}${p.saved ? '' : W.notSetYet}`}
                end={
                  p.userId === automation.userId ? (
                    <Icon as={Check} className="size-5 text-accent" />
                  ) : undefined
                }
                chevron={false}
                onPress={() => onWhose(p.userId)}
                testID="settings-for-person"
              />
            ))}
          </List>
        </Part>
      ) : null}
      <View className="gap-1.5">
        <ListLabel>{SETTINGS_WORDS.menu.settings}</ListLabel>
        <List>
          <ListRow
            icon={SlidersHorizontal}
            label={SETTINGS_WORDS.general}
            onPress={() => onPart('general')}
            testID="settings-open-general"
          />
        </List>
      </View>
      <View className="gap-1.5">
        <ListLabel>{SETTINGS_WORDS.menu.networks}</ListLabel>
        <List testID="settings-networks">
          {PLATFORM_KEYS.map((p) => {
            const isOn = on.includes(p);
            const words = isOn ? SETTINGS_WORDS.on : SETTINGS_WORDS.off;
            return (
              <ListRow
                key={p}
                // A network by its name, never a logo (Chris).
                icon={Globe}
                label={PLATFORMS[p]}
                end={
                  <Badge variant={isOn ? 'ok' : 'gray'} testID={`settings-open-${p}-badge`}>
                    {words}
                  </Badge>
                }
                endWords={words}
                onPress={() => onPart(p)}
                testID={`settings-open-${p}`}
              />
            );
          })}
          <View
            className="min-h-14 flex-row items-center gap-3.5 px-4"
            testID="settings-networks-coming"
          >
            <Icon as={CircleDashed} className="size-[22px] text-text-3" />
            <Text className="flex-1 py-2 text-[13.5px] leading-[18px] text-text-3">
              {SETTINGS_WORDS.comingLine(NEXT_NETWORKS)}
            </Text>
          </View>
        </List>
      </View>
      <View className="gap-1.5">
        <ListLabel>{SETTINGS_WORDS.menu.more}</ListLabel>
        <List>
          <ListRow
            icon={Laptop}
            label={W.settingsParts.computer}
            detail={W.rowDetails.live}
            onPress={() => onOpen('live')}
            testID="settings-open-computer"
          />
        </List>
      </View>
      <Note>{SETTINGS_WORDS.autosaves}</Note>
    </Screen>
  );
}

interface PartProps {
  part: PhonePart;
  automation: AutomationOutput | null;
  error: string | null;
  mine: boolean;
  /** The business's saved settings, for owners and admins. */
  business: Readonly<Record<string, unknown>> | null;
  manages: boolean;
  online: boolean;
  onRetry: () => void;
  /** Saves the person's settings: the problem's words, or null once saved. */
  onSaveMine: (settings: AutomationSettings) => Promise<string | null>;
  /** Saves some of the business's settings, made on what's kept as the save goes; the others stay as they are. */
  onSaveBusiness: (
    edit: (now: OutreachSettings) => Partial<OutreachSettings>,
  ) => Promise<string | null>;
  /** On a network's page, the person's own asks of their computer and what to do with them (decision 74). */
  asks?: AsksOutput | null;
  askActions?: AskActions | null;
  /** On a network's page, the person's own profile there, read and checked (decision 80). */
  profile?: ProfileProps | null;
  /** On General: how many the country setting holds back, and opening its lists. */
  countries?: CountriesSkippedOutput | null;
  onCountries?: (list: CountryList) => void;
  /** On Instagram's page: the business's accounts like yours, added and removed with signal (decision 110). */
  likeYours?: LikeYoursProps | null;
}

/** A part's page: General, or a network's. */
export function SettingsPartBody({ automation, error, ...rest }: PartProps) {
  const title = rest.part === 'general' ? SETTINGS_WORDS.general : PLATFORMS[rest.part];
  if (!automation)
    return (
      <Screen title={title} leading="back" testID={`settings-part-${rest.part}`}>
        {error ? (
          <NeedsSignal words={error} onRetry={rest.onRetry} testID="settings-needs-signal" />
        ) : null}
      </Screen>
    );
  return (
    // A form for each person: an owner's pick starts it again.
    <PartPage key={automation.userId} title={title} automation={automation} {...rest} />
  );
}

function PartPage({
  part,
  title,
  automation,
  mine,
  business,
  manages,
  online,
  onSaveMine,
  onSaveBusiness,
  asks = null,
  askActions = null,
  profile = null,
  countries = null,
  onCountries,
  likeYours = null,
}: Omit<PartProps, 'automation' | 'error'> & { title: string; automation: AutomationOutput }) {
  const mineID = part === 'general' ? 'settings-general' : `settings-networks-${part}`;
  // One line for the page, fixed under its title so it shows wherever the change was made: how the latest save went,
  // the person's or the team's.
  const [line, setLine] = React.useState<{ testID: string; state: SaveState }>({
    testID: mineID,
    state: { kind: 'idle' },
  });
  const report = (testID: string) => (state: SaveState) => {
    if (state.kind !== 'idle') setLine({ testID, state });
  };
  const form = useAutosave(automation.settings, onSaveMine, report(mineID));
  return (
    <Screen
      title={title}
      subtitle={mine ? undefined : W.settingsOf(automation.name)}
      leading="back"
      scroll={false}
      header={
        <View className="border-b border-border px-3 py-2">
          <SaveLine state={line.state} idle={SETTINGS_WORDS.autosaves} testID={line.testID} />
        </View>
      }
      testID={`settings-part-${part}`}
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
      >
        <Note>
          {part === 'general'
            ? SETTINGS_WORDS.generalAbout
            : SETTINGS_WORDS.networkAbout(PLATFORMS[part])}
        </Note>
        {!online ? <NeedsSignal words={W.needsSignal(W.rows.settings)} /> : null}
        {part === 'general' ? (
          <>
            <GeneralMine automation={automation} form={form} online={online} />
            {manages && business ? (
              <GeneralTeam
                business={business}
                timezone={automation.timezone}
                online={online}
                onSave={onSaveBusiness}
                onState={report('settings-team')}
                countryLists={
                  onCountries ? <CountryListRows got={countries} onOpen={onCountries} /> : null
                }
              />
            ) : !manages ? (
              <>
                {onCountries ? <CountryListsPart got={countries} onOpen={onCountries} /> : null}
                <Note>{W.abouts.notOwner}</Note>
              </>
            ) : null}
          </>
        ) : (
          <>
            <NetworkMine
              platform={part}
              automation={automation}
              form={form}
              manages={manages}
              online={online}
              asks={mine ? asks : null}
              askActions={mine ? askActions : null}
              profile={mine ? profile : null}
              likeYours={likeYours}
            />
            {manages && business ? (
              <NetworkTeam
                platform={part}
                business={business}
                online={online}
                onSave={onSaveBusiness}
                onState={report(`settings-team-${part}`)}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
