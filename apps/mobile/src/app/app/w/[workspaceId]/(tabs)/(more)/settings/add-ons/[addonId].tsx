import {
  ADDON_CATALOG,
  ADDON_MOVE_WORDS,
  ADDON_STATE_WORDS,
  findAddon,
  type LifecycleAction,
} from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { LifeBuoy, Puzzle } from '@/components/icons';
import {
  AddonsLoading,
  AddonsNeedSignal,
  AddonTile,
  Note,
  StateBadge,
} from '@/components/add-ons/addon-bits';
import { AddonMoveSheet } from '@/components/add-ons/move-sheet';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { addonNameOf, findAddonView, type AddonView } from '@/add-ons/rules';
import {
  addonCommands,
  useAddonGrants,
  useAddonList,
  useAddonSettings,
  type Live,
} from '@/add-ons/use-add-ons';
import type { AddonSettings } from '@/add-ons/types';
import { useAddonMove } from '@/add-ons/use-move';
import { ADDON_PHONE_WORDS, categoryLine } from '@/add-ons/words';
import { errorMessage } from '@/lib/api';

/**
 * One add-on, as an owner or an admin sees it on the phone: where it stands in core's words and what that means,
 * why its last move hasn't finished, what it lets the business do, what it needs, its switches while it's on, and
 * its moves. A move that takes something away asks first, with what it would take with it (`move-sheet.tsx`); a
 * paid add-on says support can turn it on, and a planned one says it's coming. Live, and read again after every
 * move and every few seconds while the worker is still moving it.
 */
export default function AddonScreen() {
  const { business } = useBusiness();
  const { addonId: param } = useLocalSearchParams<{ addonId: string }>();
  const addonId = String(param ?? '');
  const grants = useAddonGrants();
  const list = useAddonList(business.id, grants.manage);
  const view = React.useMemo(
    () => (list.data ? findAddonView(list.data, ADDON_CATALOG, grants, addonId) : null),
    [list.data, grants, addonId],
  );
  // Its switches are asked for only while it's on: turned back on, they're asked for again.
  const settings = useAddonSettings(
    business.id,
    addonId,
    view?.state === 'enabled' && view.flags.length > 0,
  );
  const nameOf = React.useCallback(
    (id: string) => addonNameOf(list.data, ADDON_CATALOG, id),
    [list.data],
  );
  const flow = useAddonMove({ workspaceId: business.id, nameOf, onMoved: list.reload });

  const title = view?.name ?? findAddon(ADDON_CATALOG, addonId)?.name ?? ADDON_PHONE_WORDS.title;
  const openAddon = (id: string) =>
    router.push(businessHref(business.id, `settings/add-ons/${id}`));

  return (
    <Screen
      title={title}
      subtitle={view ? (categoryLine(view.category) ?? undefined) : undefined}
      leading="back"
      back={businessHref(business.id, 'settings/add-ons')}
      testID="add-on"
      contentClassName="gap-2"
    >
      {!grants.manage ? (
        <Note tone="info" lines={[ADDON_PHONE_WORDS.notYours]} testID="add-ons-not-yours" />
      ) : view ? (
        <>
          <Header view={view} />
          {view.trouble.length ? (
            <Note tone="warning" lines={view.trouble} testID="add-on-trouble" />
          ) : null}
          <Does view={view} />
          <Links title={ADDON_PHONE_WORDS.needs} links={view.needs} onOpen={openAddon} />
          <Links title={ADDON_PHONE_WORDS.worksWith} links={view.worksWith} onOpen={openAddon} />
          {view.state === 'enabled' ? (
            <Switches
              view={view}
              settings={settings}
              workspaceId={business.id}
              onSaved={settings.reload}
              onRefused={list.reload}
            />
          ) : null}
          <Moves
            view={view}
            canPurge={grants.purge}
            busy={flow.sending}
            onMove={(action) => flow.start(view, action)}
            onSupport={() => router.push(businessHref(business.id, 'get-help'))}
          />
        </>
      ) : list.loading ? (
        <AddonsLoading />
      ) : list.data ? (
        <Card className="items-center gap-2 px-5 py-8" testID="add-on-not-found">
          <Icon as={Puzzle} className="size-6 text-text-3" />
          <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
            {ADDON_PHONE_WORDS.notFound}
          </Text>
        </Card>
      ) : (
        <AddonsNeedSignal error={list.error} onRetry={list.reload} />
      )}
      <AddonMoveSheet flow={flow} />
    </Screen>
  );
}

/** Its square, its name and where it stands, what it's for, and what that state means for the business. */
function Header({ view }: { view: AddonView }) {
  return (
    <Card className="gap-3 px-3.5 py-3.5" testID="add-on-header">
      <View className="flex-row items-center gap-3">
        <AddonTile state={view.state} size="lg" />
        <View className="min-w-0 flex-1 items-start gap-1">
          <Text className="text-[17px] font-semibold leading-[22px]" testID="add-on-name">
            {view.name}
          </Text>
          <StateBadge view={view} testID="add-on-state" />
        </View>
      </View>
      {view.summary ? (
        <Text className="text-[14.5px] leading-[21px] text-text-2">{view.summary}</Text>
      ) : null}
      {view.description && view.description !== view.summary ? (
        <Text className="text-[13.5px] leading-5 text-text-3">{view.description}</Text>
      ) : null}
      {view.state ? (
        <Text className="text-[13px] leading-[18px] text-text-3" testID="add-on-state-detail">
          {ADDON_STATE_WORDS[view.state].detail}
        </Text>
      ) : null}
    </Card>
  );
}

function Does({ view }: { view: AddonView }) {
  if (!view.does.length) return null;
  return (
    <>
      <ListLabel>{ADDON_PHONE_WORDS.does}</ListLabel>
      <List testID="add-on-does">
        {view.does.map((c) => (
          <ListRow key={c.label} label={c.label} detail={c.description || undefined} />
        ))}
      </List>
    </>
  );
}

/** What it needs, or works with: each opens that add-on's own screen. */
function Links({
  title,
  links,
  onOpen,
}: {
  title: string;
  links: AddonView['needs'];
  onOpen: (addonId: string) => void;
}) {
  if (!links.length) return null;
  return (
    <>
      <ListLabel>{title}</ListLabel>
      <List>
        {links.map((l) => (
          <ListRow
            key={l.addonId}
            icon={Puzzle}
            label={l.name}
            detail={l.why}
            onPress={() => onOpen(l.addonId)}
            testID={`add-on-link-${l.addonId}`}
          />
        ))}
      </List>
    </>
  );
}

/**
 * Its switches, for whoever may change its settings (`addon.settings` answers none to anyone else). Each saves the
 * moment it's flipped, and goes back if HandsFreeOS says no; turned off meanwhile (`addon_inactive`), the screen is
 * read again so it says so.
 */
function Switches({
  view,
  settings,
  workspaceId,
  onSaved,
  onRefused,
}: {
  view: AddonView;
  settings: Live<AddonSettings>;
  workspaceId: string;
  onSaved: () => void;
  onRefused: () => void;
}) {
  const [flipped, setFlipped] = React.useState<Readonly<Record<string, boolean>>>({});
  const [saving, setSaving] = React.useState(false);
  const values = settings.data?.flags;
  // What was flipped shows until HandsFreeOS's answer, read again, agrees.
  React.useEffect(() => {
    if (values) setFlipped({});
  }, [values]);
  if (!view.flags.length || !values) return null;

  const flip = async (key: string, on: boolean) => {
    setFlipped((was) => ({ ...was, [key]: on }));
    setSaving(true);
    try {
      await addonCommands.saveFlags(workspaceId, view.addonId, { [key]: on });
      toast.show(ADDON_PHONE_WORDS.saved);
      onSaved();
    } catch (e) {
      setFlipped((was) => {
        const next = { ...was };
        delete next[key];
        return next;
      });
      toast.error(errorMessage(e));
      if ((e as { rule?: unknown } | null)?.rule === 'addon_inactive') onRefused();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ListLabel>{ADDON_PHONE_WORDS.switches}</ListLabel>
      <List testID="add-on-switches">
        {view.flags.map((f) => (
          <ListRow
            key={f.key}
            label={f.label}
            end={
              <Switch
                label={f.label}
                checked={flipped[f.key] ?? values[f.key] ?? f.default}
                disabled={saving}
                onCheckedChange={(on) => void flip(f.key, on)}
                testID={`add-on-switch-${f.key}`}
              />
            }
          />
        ))}
      </List>
    </>
  );
}

const MOVE_VARIANT: Readonly<Record<LifecycleAction, NonNullable<ButtonProps['variant']>>> = {
  install: 'primary',
  enable: 'primary',
  disable: 'secondary',
  uninstall: 'dangerOutline',
  purge: 'dangerOutline',
};

/**
 * The moves this person can make now, in core's words, and in place of a move that isn't theirs or isn't possible,
 * the sentence that says why: support turns on a paid one, a planned one isn't here yet, only an owner deletes data.
 */
function Moves({
  view,
  canPurge,
  busy,
  onMove,
  onSupport,
}: {
  view: AddonView;
  canPurge: boolean;
  busy: boolean;
  onMove: (action: LifecycleAction) => void;
  onSupport: () => void;
}) {
  const notes: string[] = [];
  const away = view.state === null || view.state === 'uninstalled' || view.state === 'purged';
  if (view.retired) notes.push(ADDON_PHONE_WORDS.retired);
  else if (view.offer === 'coming_soon') notes.push(ADDON_PHONE_WORDS.notYet);
  // No longer offered, or something it needs can't come with it: no Install, and a sentence that says so.
  else if (away && view.offer === null) notes.push(ADDON_PHONE_WORDS.cantInstall);
  if (view.state === 'uninstalled' && !canPurge && !view.retired)
    notes.push(ADDON_PHONE_WORDS.ownersDelete);
  return (
    <View className="gap-2 pt-2">
      {view.offer === 'support' ? (
        <Note tone="info" lines={[ADDON_PHONE_WORDS.support]} testID="add-on-support">
          <Button
            variant="secondary"
            size="sm"
            icon={LifeBuoy}
            className="mt-1.5 self-start"
            onPress={onSupport}
            testID="add-on-ask-support"
          >
            {ADDON_PHONE_WORDS.askSupport}
          </Button>
        </Note>
      ) : null}
      {view.moves.map((action) => (
        <Button
          key={action}
          variant={MOVE_VARIANT[action]}
          disabled={busy}
          onPress={() => onMove(action)}
          testID={`add-on-${action}`}
        >
          {ADDON_MOVE_WORDS[action].button}
        </Button>
      ))}
      {notes.length ? <Note tone="info" lines={notes} testID="add-on-notes" /> : null}
    </View>
  );
}
