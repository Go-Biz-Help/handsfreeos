import {
  OUTREACH_WORDS as W,
  sameNamePeople,
  type SameNamePerson,
} from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Ban, CalendarCheck, Ellipsis, UserPlus, UserRound } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { api, errorMessage, unwrap } from '@/lib/api';

import { NeedsSignal, Note } from './kit';

/**
 * Someone kept in Social Outreach as a profile, on the phone's Today (decision 44), as the web's person menu
 * (apps/web/src/addons/outreach/person-menu.tsx): **Add to Contacts** (customers with the same name offered first,
 * **It’s them** or **Add as new**; `outreach.profile.contact`), or **In Contacts** once they are; **Demo booked**
 * (`outreach.demo.mark`); and **Don’t pitch** (`outreach.friend.set`). Each needs signal: with none, the sheet says so.
 * The words are core's (`OUTREACH_WORDS.person`), the web's too.
 */

const P = W.person;

/** Who the menu is for: the list's profile, the customer they're saved to and whether they booked a demo. */
export interface MenuPerson {
  readonly profileId: string | null;
  readonly name: string;
  readonly personId: string | null;
  readonly demoBooked: boolean;
}

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

/** The menu's button and its sheet, wired to HandsFreeOS. Refreshes the list after a change (`onChanged`). */
export function PersonMenu({
  workspaceId,
  who,
  online,
  onChanged,
}: {
  workspaceId: string;
  who: MenuPerson;
  online: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [same, setSame] = React.useState<readonly SameNamePerson[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const profileId = who.profileId;
  if (!profileId) return null;
  const close = () => {
    setOpen(false);
    setSame(null);
  };
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
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
      setBusy(false);
    }
  };
  /** Adds them, or ties them to the customer picked. */
  const contact = async (personId: string | null) => {
    const saved = await change('outreach.profile.contact', { workspaceId, profileId, personId });
    if (personId) return P.tied(who.name);
    return saved.output.addedPerson ? P.added(who.name) : P.already(who.name);
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={Ellipsis}
        accessibilityLabel={P.menu(who.name)}
        onPress={() => setOpen(true)}
        testID="person-menu"
      />
      <PersonMenuSheet
        open={open}
        who={who}
        same={same}
        busy={busy}
        online={online}
        onClose={close}
        onInContacts={(personId) => {
          close();
          openWebPath(`/app/w/${workspaceId}/customers/people/${personId}`);
        }}
        onAddToContacts={() =>
          void run(async () => {
            // Customers with the same name, not saved with a Facebook profile yet: the person says whether it's them.
            const found = unwrap(
              await api.POST('/v1/queries/outreach.lookup', {
                body: { workspaceId, names: [who.name] },
              }),
            );
            const people = sameNamePeople(found, { withoutProfile: true });
            if (!people.length) return contact(null);
            setSame(people);
            return null;
          })
        }
        onPick={(personId) => void run(() => contact(personId))}
        onNew={() => void run(() => contact(null))}
        onDemo={(booked) =>
          void run(async () => {
            await change('outreach.demo.mark', { workspaceId, profileId, booked });
            return booked ? P.demoMarked(who.name) : P.demoUnmarked;
          })
        }
        onDontPitch={() =>
          void run(async () => {
            await change('outreach.friend.set', { workspaceId, profileId, dontPitch: true });
            return P.dontPitchDone(who.name);
          })
        }
      />
    </>
  );
}

/** The sheet itself: the three choices, or the customers with the same name to pick from. */
export function PersonMenuSheet({
  open,
  who,
  same,
  busy,
  online,
  onClose,
  onInContacts,
  onAddToContacts,
  onPick,
  onNew,
  onDemo,
  onDontPitch,
}: {
  open: boolean;
  who: MenuPerson;
  /** Customers with the same name, once Add to Contacts found some; null before. */
  same: readonly SameNamePerson[] | null;
  busy: boolean;
  online: boolean;
  onClose: () => void;
  onInContacts: (personId: string) => void;
  onAddToContacts: () => void;
  onPick: (personId: string) => void;
  onNew: () => void;
  onDemo: (booked: boolean) => void;
  onDontPitch: () => void;
}) {
  if (same)
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={P.sameTitle(who.name)}
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
                disabled={busy || !online}
                onPress={() => onPick(p.personId)}
                testID="person-same-them"
              >
                {P.itsThem}
              </Button>
            </View>
          ))}
          <Button
            variant="secondary"
            disabled={busy || !online}
            onPress={onNew}
            testID="person-same-new"
          >
            {P.addAsNew}
          </Button>
        </View>
      </Sheet>
    );
  return (
    <Sheet open={open} onClose={onClose} title={who.name} testID="person-menu-sheet">
      <View className="gap-2">
        {!online ? <NeedsSignal words={P.needsSignal} /> : null}
        {who.personId ? (
          <Button
            variant="secondary"
            icon={UserRound}
            onPress={() => onInContacts(who.personId!)}
            testID="person-in-contacts"
          >
            {P.inContacts}
          </Button>
        ) : (
          <Button
            variant="secondary"
            icon={UserPlus}
            loading={busy}
            disabled={!online}
            onPress={onAddToContacts}
            testID="person-add-contact"
          >
            {P.addToContacts}
          </Button>
        )}
        <Button
          variant="secondary"
          icon={CalendarCheck}
          disabled={busy || !online}
          onPress={() => onDemo(!who.demoBooked)}
          testID="person-demo-mark"
        >
          {who.demoBooked ? P.notDemo : P.demoBooked}
        </Button>
        <Button
          variant="dangerOutline"
          icon={Ban}
          disabled={busy || !online}
          onPress={onDontPitch}
          testID="person-dont-pitch"
        >
          {P.dontPitch}
        </Button>
      </View>
    </Sheet>
  );
}
