import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import type {
  AutomationOutput,
  AutomationPeopleOutput,
  AutomationSettings,
  WheelsListOutput,
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
import { CircleDashed, Globe, Laptop, UserRound, UsersRound } from '@/components/icons';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useAskActions, useAsks, type AskActions } from './asks';
import { useProfileProps, type ProfileProps } from './ready';

/**
 * Social Outreach's Settings on the phone (decision 44), a page for each part as on the web (Chris, 2026-10-16: "a
 * settings menu with general settings and then all the platforms"; regrouped by decision 129). The Settings screen is
 * the menu: You, each network with whether it's on for the person shown, the networks still to come, This computer,
 * and for owners and admins Team (Playbooks are a page of their own since decision 127).
 * Team has everything about the business's people: each one's training wheels to end and their settings to open (each
 * part then opens for them, `&for=`), what people may pick and the business's other settings with the country
 * setting's lists, and each network's say for everyone. A part is its own screen over the menu (`?part=`, ./kit.tsx's
 * `openSettingsPart`); an address with no part, as every link before the parts, opens the menu. Every change saves as
 * it's made (./autosave.ts), with no Save button: the person's through `outreach.automation.save`, the business's
 * through `addon.save_settings`. The extension follows within seconds. It all needs signal. You also leads to the lists
 * the country setting makes, for everyone else (./countries.tsx).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = (e: unknown) => (e instanceof ChangeError ? e.message : errorMessage(e));

/** The parts the phone draws as a page: You (`general`), each network and Team. Your computer is the Live screen. */
export type PhonePart = 'general' | Platform | 'team';

/** The part an address names, or null for the menu: no part, or one the phone opens elsewhere. */
export function phonePartOf(raw: string | null | undefined): PhonePart | null {
  if (!raw) return null;
  const part = settingsPartOf(raw);
  return part === 'general' || part === 'team' || isNetworkPart(part) ? part : null;
}

export function SettingsScreen({ whose, part: raw }: { whose?: string; part?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const part = phonePartOf(raw);
  const [picked, setUserId] = React.useState<string | null>(
    whose && UUID.test(whose) ? whose.toLowerCase() : null,
  );
  // Someone else's only for owners and admins, read as their grants come; Team is the business's.
  const userId = ctx.manages && part !== 'team' ? picked : null;
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
  // Everyone's, and who's on training wheels, on Team; the business's, on a part.
  const team = ctx.manages && part === 'team';
  const people = useOutreachAnswer(
    team
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.automation.people', { body: { workspaceId: ws } }),
          )
      : null,
    `automation-people:${ws}`,
    W.rows.settings,
  );
  const wheels = useOutreachAnswer(
    team
      ? async () =>
          unwrap(await api.POST('/v1/queries/outreach.wheels', { body: { workspaceId: ws } }))
      : null,
    `wheels:${ws}`,
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
  // On You, and Team for owners and admins: how many the country setting holds back, for its lists (decisions 61, 86).
  const countries = useOutreachAnswer(
    part === 'general' || team
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
  // A network's page, the person's own: Check LinkedIn's ask, and their computer (decision 74).
  const networkPart = part !== null && isNetworkPart(part) && mine;
  const asks = useAsks('settings', W.rows.settings, networkPart);
  const askActions = useAskActions(asks.data, asks.reload);
  // Their profile there, read and checked (decision 80).
  const profile = useProfileProps(
    networkPart && isNetworkPart(part) ? part : null,
    asks.data,
    W.rows.settings,
  );
  // Back on the menu from a part: asked again, so each network's On or Off is as just saved.
  const shown = React.useRef(false);
  const { reload: reloadAutomation } = automation;
  const { reload: reloadPeople } = people;
  const { reload: reloadCountries } = countries;
  useFocusEffect(
    React.useCallback(() => {
      if (shown.current && !part) reloadAutomation();
      // Back on Team from someone's settings: whether they've saved theirs, as it is now.
      if (shown.current && part === 'team') reloadPeople();
      // Back on You or Team from a country list: its counts as they are now.
      if (shown.current && (part === 'general' || part === 'team')) reloadCountries();
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
        manages={ctx.manages}
        online={ctx.online}
        onRetry={automation.reload}
        onBackToYours={() => setUserId(null)}
        onPart={(p) => openSettingsPart(ws, p, mine || p === 'team' ? null : userId)}
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
      onLikeYours={part === 'instagram' ? () => openOutreach(ws, 'find', 'net=instagram') : null}
      people={team ? people.data : null}
      wheels={team ? wheels.data : null}
      myId={ctx.userId}
      onTheirs={(id) => openSettingsPart(ws, 'general', id === ctx.userId ? null : id)}
      onTeam={() => openSettingsPart(ws, 'team')}
      onEndWheels={async (userId, platform) => {
        try {
          await change('outreach.wheels.end', { workspaceId: ws, userId, platform });
          wheels.reload();
          return null;
        } catch (e) {
          return failed(e);
        }
      }}
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

/** The menu (decision 129): You, the networks, This computer, and Team for owners and admins. */
export function SettingsMenuBody({
  automation,
  error,
  mine,
  manages = false,
  online,
  onRetry,
  onBackToYours,
  onPart,
  onOpen,
}: {
  automation: AutomationOutput | null;
  error: string | null;
  mine: boolean;
  /** An owner or admin, whose Team is. */
  manages?: boolean;
  online: boolean;
  onRetry: () => void;
  /** Someone else's shown: back to the person's own. */
  onBackToYours?: () => void;
  onPart: (part: PhonePart) => void;
  /** The person's computer, beside the settings; Playbooks are a page of their own (decision 127). */
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
      {mine ? null : (
        // Someone else's, opened from Team: whose they are, and back to the person's own.
        <View className="gap-2 rounded-card bg-accent-soft px-4 py-3" testID="settings-whose">
          <Text className="text-[14px] text-accent-text">
            {SETTINGS_WORDS.whose(automation.name)}
          </Text>
          {onBackToYours ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onPress={onBackToYours}
              testID="settings-whose-back"
            >
              {SETTINGS_WORDS.backToYours}
            </Button>
          ) : null}
        </View>
      )}
      <View className="gap-1.5">
        <ListLabel>{SETTINGS_WORDS.menu.you}</ListLabel>
        <List>
          <ListRow
            icon={UserRound}
            label={SETTINGS_WORDS.general}
            detail={SETTINGS_WORDS.generalRow}
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
        <ListLabel>{SETTINGS_WORDS.menu.computer}</ListLabel>
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
      {manages ? (
        <View className="gap-1.5">
          <ListLabel>{SETTINGS_WORDS.menu.owners}</ListLabel>
          <List>
            <ListRow
              icon={UsersRound}
              label={W.settingsParts.team}
              detail={SETTINGS_WORDS.people}
              onPress={() => onPart('team')}
              testID="settings-open-team"
            />
          </List>
        </View>
      ) : null}
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
  /** On Instagram's page: opens Find people, where the accounts like yours are now (decision 128). */
  onLikeYours?: (() => void) | null;
  /** On Team: everyone who uses it here, and who's on training wheels. */
  people?: AutomationPeopleOutput | null;
  wheels?: WheelsListOutput | null;
  /** The owner or admin looking: their own open as theirs. */
  myId?: string;
  /** On Team: opens someone's settings. */
  onTheirs?: (userId: string) => void;
  /** Opens Team, from a page whose team's say moved there. */
  onTeam?: () => void;
  /** On Team: ends someone's training wheels on a network: the problem's words, or null once ended. */
  onEndWheels?: (userId: string, platform: Platform) => Promise<string | null>;
}

/** A part's page: You, a network's, or Team. */
export function SettingsPartBody({ automation, error, ...rest }: PartProps) {
  const title =
    rest.part === 'general'
      ? SETTINGS_WORDS.general
      : rest.part === 'team'
        ? SETTINGS_WORDS.teamTitle
        : PLATFORMS[rest.part];
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
  onLikeYours = null,
  people = null,
  wheels = null,
  myId,
  onTheirs,
  onTeam,
  onEndWheels,
}: Omit<PartProps, 'automation' | 'error'> & { title: string; automation: AutomationOutput }) {
  const mineID =
    part === 'general'
      ? 'settings-general'
      : part === 'team'
        ? 'settings-team'
        : `settings-networks-${part}`;
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
            : part === 'team'
              ? SETTINGS_WORDS.teamPageAbout
              : SETTINGS_WORDS.networkAbout(PLATFORMS[part])}
        </Note>
        {!online ? <NeedsSignal words={W.needsSignal(W.rows.settings)} /> : null}
        {part === 'team' ? (
          manages && business ? (
            <>
              {people ? (
                <YourPeople
                  people={people}
                  wheels={wheels}
                  myId={myId}
                  online={online}
                  onTheirs={onTheirs}
                  onEnd={onEndWheels}
                />
              ) : null}
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
              <Part
                title={SETTINGS_WORDS.networksTitle}
                about={SETTINGS_WORDS.networksAbout}
                testID="settings-team-networks"
              >
                <View className="gap-3">
                  {PLATFORM_KEYS.map((p) => (
                    <NetworkTeam
                      key={p}
                      platform={p}
                      business={business}
                      online={online}
                      onSave={onSaveBusiness}
                      onState={report(`settings-team-${p}`)}
                    />
                  ))}
                </View>
              </Part>
            </>
          ) : null
        ) : part === 'general' ? (
          <>
            <GeneralMine automation={automation} form={form} online={online} />
            {manages ? (
              <TeamMoved
                words={SETTINGS_WORDS.teamMovedAll}
                onTeam={onTeam}
                testID="settings-team-moved"
              />
            ) : (
              <>
                {onCountries ? <CountryListsPart got={countries} onOpen={onCountries} /> : null}
                <Note>{W.abouts.notOwner}</Note>
              </>
            )}
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
              onLikeYours={onLikeYours}
            />
            {manages ? (
              <TeamMoved
                words={SETTINGS_WORDS.teamMoved(PLATFORMS[part])}
                onTeam={onTeam}
                testID={`settings-team-moved-${part}`}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/** Where the team's say went, for an owner or admin (decision 129): a line, and Team. */
function TeamMoved({
  words,
  onTeam,
  testID,
}: {
  words: string;
  onTeam?: () => void;
  testID: string;
}) {
  return (
    <View className="gap-2" testID={testID}>
      <Note>{words}</Note>
      {onTeam ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onPress={onTeam}
          testID={`${testID}-open`}
        >
          {SETTINGS_WORDS.openTeam}
        </Button>
      ) : null}
    </View>
  );
}

/** Team's people (decision 129): each with their training wheels on each network to end, and their settings. */
export function YourPeople({
  people,
  wheels,
  myId,
  online,
  onTheirs,
  onEnd,
}: {
  people: AutomationPeopleOutput;
  wheels: WheelsListOutput | null;
  myId?: string;
  online: boolean;
  onTheirs?: (userId: string) => void;
  onEnd?: (userId: string, platform: Platform) => Promise<string | null>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <Part title={SETTINGS_WORDS.people} about={SETTINGS_WORDS.peopleAbout} testID="settings-people">
      {wheels?.people.length ? <Note>{SETTINGS_WORDS.wheelsAbout}</Note> : null}
      {problem ? (
        <Text role="alert" className="text-[13.5px] text-danger-text">
          {problem}
        </Text>
      ) : null}
      <List>
        {people.people.map((p) => {
          const theirs = wheels?.people.filter((w) => w.userId === p.userId) ?? [];
          return (
            <View key={p.userId} testID="settings-person">
              <ListRow
                label={p.userId === myId ? `${p.name} ${SETTINGS_WORDS.you}` : p.name}
                detail={p.saved ? SETTINGS_WORDS.theirSettings : SETTINGS_WORDS.notSaved}
                onPress={onTheirs ? () => onTheirs(p.userId) : undefined}
                testID="settings-person-open"
              />
              {theirs.map((w) => (
                <View
                  key={w.platform}
                  className="flex-row flex-wrap items-center gap-2 px-4 pb-3"
                  testID="settings-person-wheels"
                >
                  <Text className="min-w-0 flex-1 text-[13px] text-text-2">
                    {`${SETTINGS_WORDS.wheelsOn(PLATFORMS[w.platform])} · ${SETTINGS_WORDS.wheelsLine(w.wheels.ok, w.wheels.daysLeft)}`}
                  </Text>
                  {onEnd ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!online || busy !== null}
                      loading={busy === `${w.userId}:${w.platform}`}
                      onPress={async () => {
                        setBusy(`${w.userId}:${w.platform}`);
                        setProblem(await onEnd(w.userId, w.platform));
                        setBusy(null);
                      }}
                      testID="settings-person-wheels-end"
                    >
                      {W.endNow}
                    </Button>
                  ) : null}
                </View>
              ))}
            </View>
          );
        })}
      </List>
    </Part>
  );
}
