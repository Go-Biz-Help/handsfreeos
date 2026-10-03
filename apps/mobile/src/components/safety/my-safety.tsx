import { normalizePhone, SAFETY_PHONE_WORDS } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change } from '@/changes';
import { Check, Plus, Users } from '@/components/icons';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { safetyTimesOf } from '@/safety/check-in';
import type { MyContact } from '@/safety/use-check-in-context';

/**
 * My safety (board 91, last panel): each person's own contacts, who's told if they don't check out, and the
 * business's times. Only they see their contacts; owners see neither the contacts nor the places. Reading works with
 * no signal; adding or removing someone needs it (an outside contact is asked by text at once).
 */

export const SAFETY_TIMES_SQL = 'SELECT settings FROM workspaces WHERE id = ?';

export function useSafetyTimes(workspaceId: string) {
  const { data } = useQuery<{ settings: string | null }>(SAFETY_TIMES_SQL, [workspaceId]);
  return React.useMemo(() => safetyTimesOf(data[0]?.settings ?? null), [data]);
}

export function MySafety({
  workspaceId,
  contacts,
  teammates,
}: {
  workspaceId: string;
  contacts: readonly MyContact[];
  /** Teammates who could be contacts: everyone on the team but the person. */
  teammates: readonly { id: string; name: string }[];
}) {
  const times = useSafetyTimes(workspaceId);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<MyContact | null>(null);
  return (
    <>
      <ListLabel>{SAFETY_PHONE_WORDS.whoIsTold}</ListLabel>
      {contacts.length === 0 ? (
        <Card className="px-4 py-4">
          <Text className="text-[14px] text-text-2">{SAFETY_PHONE_WORDS.noContacts}</Text>
        </Card>
      ) : (
        <List testID="my-safety-contacts">
          {contacts.map((c) => (
            <ListRow
              key={c.id}
              icon={Users}
              label={c.name}
              detail={c.line}
              onPress={() => setRemoving(c)}
              testID={`my-safety-contact-${c.id}`}
            />
          ))}
        </List>
      )}
      <Button
        variant="secondary"
        icon={Plus}
        onPress={() => setAdding(true)}
        testID="my-safety-add"
      >
        {SAFETY_PHONE_WORDS.addSomeone}
      </Button>
      <ListLabel>{SAFETY_PHONE_WORDS.when}</ListLabel>
      <List>
        <ListRow
          label={SAFETY_PHONE_WORDS.askMeAfter}
          end={SAFETY_PHONE_WORDS.minutes(times.askAfterMinutes)}
          testID="my-safety-ask-after"
        />
        <ListRow
          label={SAFETY_PHONE_WORDS.thenTell}
          end={SAFETY_PHONE_WORDS.moreMinutes(times.alertAfterMinutes)}
          testID="my-safety-tell-after"
        />
      </List>
      <Text className="px-1 text-[12.5px] leading-[17px] text-text-3">
        {SAFETY_PHONE_WORDS.whenNote} {SAFETY_PHONE_WORDS.onlyYou}
      </Text>
      <AddContactSheet
        open={adding}
        onClose={() => setAdding(false)}
        workspaceId={workspaceId}
        teammates={teammates.filter((t) => !contacts.some((c) => c.teammateUserId === t.id))}
      />
      <RemoveContactSheet
        contact={removing}
        onClose={() => setRemoving(null)}
        workspaceId={workspaceId}
      />
    </>
  );
}

function AddContactSheet({
  open,
  onClose,
  workspaceId,
  teammates,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  teammates: readonly { id: string; name: string }[];
}) {
  const { online } = useNetwork();
  const [kind, setKind] = React.useState<'teammate' | 'outside'>('teammate');
  const [mate, setMate] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setMate(null);
    setName('');
    setPhone('');
    setEmail('');
  }, [open]);

  const ready =
    kind === 'teammate'
      ? mate !== null
      : name.trim() !== '' && (phone.trim() !== '' || email.trim() !== '');
  const save = async () => {
    setBusy(true);
    try {
      const number = phone.trim() ? (normalizePhone(phone.trim()) ?? phone.trim()) : null;
      await change(
        'safety_contact.save',
        kind === 'teammate'
          ? { workspaceId, contactUserId: mate! }
          : {
              workspaceId,
              name: name.trim(),
              ...(number ? { phone: number } : {}),
              ...(email.trim() ? { email: email.trim() } : {}),
            },
      );
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={SAFETY_PHONE_WORDS.addTitle}
      testID="my-safety-add-sheet"
    >
      <View className="gap-3.5">
        <Segmented
          label={SAFETY_PHONE_WORDS.addTitle}
          value={kind}
          onChange={setKind}
          options={[
            {
              value: 'teammate',
              label: SAFETY_PHONE_WORDS.aTeammate,
              testID: 'my-safety-kind-teammate',
            },
            {
              value: 'outside',
              label: SAFETY_PHONE_WORDS.someoneOutside,
              testID: 'my-safety-kind-outside',
            },
          ]}
        />
        {kind === 'teammate' ? (
          <View className="overflow-hidden rounded-card border border-border">
            {teammates.map((t, i) => (
              <Pressable
                key={t.id}
                onPress={() => setMate(t.id)}
                className={`min-h-12 flex-row items-center gap-3 px-3.5 ${i > 0 ? 'border-t border-border' : ''}`}
                testID={`my-safety-mate-${t.id}`}
              >
                <Text className="flex-1 text-[15px]">{t.name}</Text>
                {mate === t.id ? <Icon as={Check} className="size-4 text-accent" /> : null}
              </Pressable>
            ))}
          </View>
        ) : (
          <View className="gap-2.5">
            <Input
              value={name}
              onChangeText={setName}
              placeholder={SAFETY_PHONE_WORDS.nameLabel}
              testID="my-safety-name"
            />
            <Input
              value={phone}
              onChangeText={setPhone}
              placeholder={SAFETY_PHONE_WORDS.phoneLabel}
              keyboardType="phone-pad"
              testID="my-safety-phone"
            />
            <Input
              value={email}
              onChangeText={setEmail}
              placeholder={SAFETY_PHONE_WORDS.emailLabel}
              keyboardType="email-address"
              autoCapitalize="none"
              testID="my-safety-email"
            />
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {SAFETY_PHONE_WORDS.outsideNote}
            </Text>
          </View>
        )}
        <Button
          onPress={() => void save()}
          disabled={!ready || !online}
          loading={busy}
          testID="my-safety-save"
        >
          {online ? SAFETY_PHONE_WORDS.save : SAFETY_PHONE_WORDS.needsSignal}
        </Button>
      </View>
    </Sheet>
  );
}

function RemoveContactSheet({
  contact,
  onClose,
  workspaceId,
}: {
  contact: MyContact | null;
  onClose: () => void;
  workspaceId: string;
}) {
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const remove = async () => {
    if (!contact) return;
    setBusy(true);
    try {
      await change('safety_contact.remove', { workspaceId, id: contact.id });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={contact !== null}
      onClose={onClose}
      title={contact?.name}
      description={contact ? SAFETY_PHONE_WORDS.removeAsk(contact.name) : undefined}
      testID="my-safety-remove-sheet"
    >
      <Button
        variant="danger"
        onPress={() => void remove()}
        disabled={!online}
        loading={busy}
        testID="my-safety-remove"
      >
        {online ? SAFETY_PHONE_WORDS.remove : SAFETY_PHONE_WORDS.needsSignal}
      </Button>
    </Sheet>
  );
}
