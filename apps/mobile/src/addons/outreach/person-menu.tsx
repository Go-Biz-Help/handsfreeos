import {
  personMenuItems,
  type PersonMenuItem,
  type PersonMenuKey,
  type PersonMenuMove,
  type PersonMenuRow,
  type ProfileMarksOutput,
} from '@hfos/core/addons/outreach/person-menu';
import {
  OUTREACH_WORDS as W,
  sameNamePeople,
  type SameNamePerson,
} from '@hfos/core/addons/outreach/words';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import {
  ArrowRight,
  Ban,
  CalendarCheck,
  ChevronDown,
  ExternalLink,
  MessageCircle,
  Undo2,
  UserCheck,
  UserMinus,
  UserPlus,
  UserRound,
  UserX,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { api, errorMessage, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { NeedsSignal, Note, openOutside } from './kit';

/**
 * The person menu on someone's name (docs/outreach.md, decision 91), as the web's
 * (apps/web/src/addons/outreach/person-menu.tsx): wherever the phone shows someone kept in Social Outreach (Waiting for
 * you, Today, the Pipeline, Chats), their name is a button that opens it. Core's `personMenuItems` decides the order,
 * what shows, what can be pressed and the words, for the web and the phone alike: **Open on {Network}** first and
 * **Open in {messages}** when the chat is known, which work with no signal; then **Add to Contacts** (customers with the
 * same name offered first, **It’s them** or **Add as new**) or **In Contacts**; **Mark as client** or **Not a client
 * after all** (`outreach.client.set`, the same same-name step first when they aren't in Contacts), or why they're one;
 * **Demo booked**; **Don’t pitch** and **Never contact**, or taking them off, or who put them on.
 *
 * Where they stand is asked as the menu opens (`outreach.profile.marks`), with signal: until it comes, its switches
 * wait. With no signal only the Open items can be pressed, under a note saying the rest need signal; nothing is queued,
 * since every change here is an online command.
 *
 * A screen gives its names what they need through `PersonMenuScope`: the business, the signal, whether the person may
 * add and edit customers (`records.write`, which Add to Contacts and Mark as client need) and what to reload after a
 * change. With no scope, or no profile, the name is plain words.
 */

const P = W.person;

/** Who the menu is for: their profile, their name, and what the list knows of them (core's `PersonMenuRow`). */
export interface MenuPerson extends PersonMenuRow {
  /** Their profile in Social Outreach: with none (the phone's copy gives ''), the name is plain words. */
  readonly profileId: string | null;
  readonly name: string;
}

/** What a screen gives the names on it. */
export interface PersonMenuScopeValue {
  readonly workspaceId: string;
  readonly online: boolean;
  /** Add and edit customers (`records.write`): Add to Contacts and Mark as client need it. */
  readonly writesContacts: boolean;
  /** Reloads the screen's list after a change, so a card that should leave does. */
  readonly onChanged: () => void;
}

const ScopeContext = React.createContext<PersonMenuScopeValue | null>(null);

/** Makes every name inside a button that opens the person menu. */
export function PersonMenuScope({
  workspaceId,
  online,
  writesContacts,
  onChanged,
  children,
}: PersonMenuScopeValue & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ workspaceId, online, writesContacts, onChanged }),
    [workspaceId, online, writesContacts, onChanged],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

const NAME_STYLE = 'text-[15px] font-semibold';

/**
 * Someone's name: inside a `PersonMenuScope`, a button (labelled with the name, 44 points tall) that opens their menu;
 * otherwise, or with no profile, the name alone.
 */
export function PersonName({
  who,
  ownSwitches = false,
  moves,
  onMove,
  className,
}: {
  who: MenuPerson;
  /** The row has its own Don't pitch and Never contact switches (Chats): the menu leaves them out. */
  ownSwitches?: boolean;
  /** Stages to move them to, on a list that has them. */
  moves?: readonly PersonMenuMove[];
  onMove?: (key: string) => void;
  /** The name's own style, where a list has another. */
  className?: string;
}) {
  const scope = React.useContext(ScopeContext);
  if (!scope || !who.profileId)
    return <Text className={cn(NAME_STYLE, className)}>{who.name}</Text>;
  return (
    <NameMenu
      scope={scope}
      who={who}
      profileId={who.profileId}
      ownSwitches={ownSwitches}
      moves={moves}
      onMove={onMove}
      className={className}
    />
  );
}

/** Customers with the same name, offered before Add to Contacts or Mark as client: then which it was for. */
interface SameStep {
  readonly people: readonly SameNamePerson[];
  readonly then: 'contact' | 'client';
}

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

function NameMenu({
  scope,
  who,
  profileId,
  ownSwitches,
  moves,
  onMove,
  className,
}: {
  scope: PersonMenuScopeValue;
  who: MenuPerson;
  profileId: string;
  ownSwitches: boolean;
  moves?: readonly PersonMenuMove[];
  onMove?: (key: string) => void;
  className?: string;
}) {
  const { workspaceId, online, writesContacts, onChanged } = scope;
  const [open, setOpen] = React.useState(false);
  const [marks, setMarks] = React.useState<ProfileMarksOutput | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [same, setSame] = React.useState<SameStep | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  // Where they stand, asked each time the menu opens with signal (and once signal comes back while it's open).
  React.useEffect(() => {
    if (!open || !online) return;
    let alive = true;
    api
      .POST('/v1/queries/outreach.profile.marks', { body: { workspaceId, profileId } })
      .then((answer) => {
        if (alive) setMarks(unwrap(answer));
      })
      .catch((e: unknown) => {
        if (alive) setProblem(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [open, online, workspaceId, profileId]);

  const items = personMenuItems({
    row: who,
    marks,
    moves,
    contactsWrite: writesContacts,
    online,
    ownSwitches,
  });
  const personId = marks ? marks.personId : (who.personId ?? null);

  const close = () => {
    setOpen(false);
    setSame(null);
  };
  /** Runs a change: its words as a toast, the menu closed and the list reloaded; null when a step comes first. */
  const run = async (key: string, work: () => Promise<string | null>) => {
    setBusy(key);
    try {
      const said = await work();
      if (said) {
        toast.show(said);
        close();
        onChanged();
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };
  /** Customers with the same name, not saved with a profile on a network yet: the person says whether it's them. */
  const sameNamed = async () =>
    sameNamePeople(
      unwrap(
        await api.POST('/v1/queries/outreach.lookup', {
          body: { workspaceId, names: [who.name] },
        }),
      ),
      { withoutProfile: true },
    );
  /** Adds them to Contacts, or ties them to the customer picked. */
  const contact = async (picked: string | null) => {
    const saved = await change('outreach.profile.contact', {
      workspaceId,
      profileId,
      personId: picked,
    });
    if (picked) return P.tied(who.name);
    return saved.output.addedPerson ? P.added(who.name) : P.already(who.name);
  };
  /** Mark as client (tied to the customer picked, if any), or Not a client after all. */
  const client = async (on: boolean, picked: string | null = null) => {
    const { output } = await change('outreach.client.set', {
      workspaceId,
      profileId,
      client: on,
      ...(picked ? { personId: picked } : {}),
    });
    if (on) return P.clientDone(who.name);
    if (!output.client) return P.clientOff(who.name);
    return output.because ? P.clientStill(who.name, output.because) : P.clientLine(null);
  };
  const friendSet = async (list: { dontPitch: boolean } | { neverContact: boolean }) => {
    await change('outreach.friend.set', { workspaceId, profileId, ...list });
  };
  /** Asks for customers with the same name first, unless they're in Contacts already. */
  const sameFirst = (then: SameStep['then'], go: () => Promise<string>) => async () => {
    const people = await sameNamed();
    if (!people.length) return go();
    setSame({ people, then });
    return null;
  };

  const onItem = (item: PersonMenuItem) => {
    if (item.kind === 'open') {
      close();
      openOutside(item.url ?? null);
      return;
    }
    if (item.kind !== 'action' || !item.enabled) return;
    const key: PersonMenuKey = item.key;
    switch (key) {
      case 'in-contacts':
        close();
        if (personId) openWebPath(`/app/w/${workspaceId}/customers/people/${personId}`);
        return;
      case 'add-contact':
        return void run(key, sameFirst('contact', () => contact(null)));
      case 'mark-client':
        return void run(key, personId ? () => client(true) : sameFirst('client', () => client(true)));
      case 'not-client':
        return void run(key, () => client(false));
      case 'demo':
      case 'not-demo':
        return void run(key, async () => {
          const booked = key === 'demo';
          await change('outreach.demo.mark', { workspaceId, profileId, booked });
          return booked ? P.demoMarked(who.name) : P.demoUnmarked;
        });
      case 'dont-pitch':
      case 'not-dont-pitch':
        return void run(key, async () => {
          const on = key === 'dont-pitch';
          await friendSet({ dontPitch: on });
          return on ? P.dontPitchDone(who.name) : P.dontPitchOff(who.name);
        });
      case 'never-contact':
      case 'not-never-contact':
        return void run(key, async () => {
          const on = key === 'never-contact';
          await friendSet({ neverContact: on });
          return on ? P.neverContactDone(who.name) : P.neverContactOff(who.name);
        });
      default:
        if (item.move !== undefined && onMove) {
          close();
          onMove(item.move);
        }
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={who.name}
        accessibilityHint={P.nameHint}
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => {
          setMarks(null);
          setProblem(null);
          setOpen(true);
        }}
        className="min-h-11 shrink flex-row items-center gap-1 active:opacity-60"
        testID="person-menu"
      >
        <Text className={cn(NAME_STYLE, 'shrink', className)}>{who.name}</Text>
        <Icon as={ChevronDown} className="size-3.5 text-text-3" />
      </Pressable>
      <PersonMenuSheet
        open={open}
        name={who.name}
        items={items}
        same={same?.people ?? null}
        busy={busy}
        online={online}
        loading={online && marks === null && problem === null}
        problem={problem}
        onClose={close}
        onItem={onItem}
        onPick={(picked) =>
          void run('same', () =>
            same?.then === 'client' ? client(true, picked) : contact(picked),
          )
        }
        onNew={() =>
          void run('same', () => (same?.then === 'client' ? client(true) : contact(null)))
        }
      />
    </>
  );
}

const ICONS: Partial<Record<PersonMenuKey, LucideIcon>> = {
  'open-page': ExternalLink,
  'open-chat': MessageCircle,
  'in-contacts': UserRound,
  'add-contact': UserPlus,
  'mark-client': UserCheck,
  'not-client': UserMinus,
  demo: CalendarCheck,
  'not-demo': CalendarCheck,
  'dont-pitch': Ban,
  'not-dont-pitch': Undo2,
  'never-contact': UserX,
  'not-never-contact': Undo2,
};

/**
 * The sheet: the menu's items in core's order, the needs-signal note (or "Checking where they stand…") under the Open
 * items, or the customers with the same name to pick from.
 */
export function PersonMenuSheet({
  open,
  name,
  items,
  same,
  busy,
  online,
  loading,
  problem,
  onClose,
  onItem,
  onPick,
  onNew,
}: {
  open: boolean;
  name: string;
  items: readonly PersonMenuItem[];
  /** Customers with the same name, once Add to Contacts or Mark as client found some; null before. */
  same: readonly SameNamePerson[] | null;
  /** The item being run. */
  busy: string | null;
  online: boolean;
  /** Where they stand is being asked. */
  loading: boolean;
  /** Why where they stand couldn't be asked. */
  problem: string | null;
  onClose: () => void;
  onItem: (item: PersonMenuItem) => void;
  onPick: (personId: string) => void;
  onNew: () => void;
}) {
  if (same)
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={P.sameTitle(name)}
        description={P.sameAbout}
        testID="person-same-name"
      >
        <View className="gap-2">
          {same.map((p) => (
            <View
              key={p.personId}
              className="flex-row items-center justify-between gap-3 rounded-menu bg-card-2 p-2.5"
            >
              <View className="min-w-0 flex-1">
                <Text className="text-[14px] font-medium">{p.name}</Text>
                <Note>{p.detail}</Note>
              </View>
              <Button
                size="md"
                disabled={busy !== null || !online}
                onPress={() => onPick(p.personId)}
                testID="person-same-them"
              >
                {P.itsThem}
              </Button>
            </View>
          ))}
          <Button
            variant="secondary"
            disabled={busy !== null || !online}
            onPress={onNew}
            testID="person-same-new"
          >
            {P.addAsNew}
          </Button>
        </View>
      </Sheet>
    );
  const item = (i: PersonMenuItem) => {
    if (i.kind === 'line')
      return i.key === 'move-to' ? (
        <Text key={i.key} className="px-1 pt-1 text-[13px] font-semibold" testID={i.testId}>
          {i.label}
        </Text>
      ) : (
        <View key={i.key} className="px-1 py-1">
          <Note testID={i.testId}>{i.label}</Note>
        </View>
      );
    return (
      <Button
        key={i.key}
        variant={i.danger ? 'dangerOutline' : 'secondary'}
        icon={ICONS[i.key] ?? (i.move !== undefined ? ArrowRight : undefined)}
        loading={busy === i.key}
        disabled={i.kind === 'action' && (!i.enabled || busy !== null)}
        onPress={() => onItem(i)}
        testID={i.testId}
      >
        {i.label}
      </Button>
    );
  };
  const opens = items.filter((i) => i.kind === 'open');
  const rest = items.filter((i) => i.kind !== 'open');
  return (
    <Sheet open={open} onClose={onClose} title={name} testID="person-menu-sheet">
      <View className="gap-2">
        {opens.map(item)}
        {!online ? (
          <NeedsSignal words={P.needsSignal} testID="person-needs-signal" />
        ) : problem ? (
          <Note testID="person-marks-problem">{problem}</Note>
        ) : loading ? (
          <Note testID="person-loading">{P.loading}</Note>
        ) : null}
        {rest.map(item)}
      </View>
    </Sheet>
  );
}
