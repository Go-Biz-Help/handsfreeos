import {
  COMPOSE_CHANNELS,
  COMPOSE_WORDS as W,
  composeTargets,
  contactFromSearch,
  formatPhone,
  holds,
  matchesSearch,
  NEW_CONTACT_WORDS,
  SEARCH_MIN_CHARS,
  type ComposeChannel,
  type ContactStart,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useCustomers, type CustomerChoice } from '@/calendar/use-calendar';
import { AddContactOffer, NewContactForm } from '@/components/customers/new-contact-form';
import { Mail, MessageCircle } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { startConversation } from '@/inbox/start';

/** How many customers the sheet lists at once: a search narrows it, as Link to a contact's does. */
const SHOWN = 8;

/** How to reach whoever was picked, from the phone's copy (someone just added is there already). */
export const REACH_SQL = `SELECT phone_e164, email FROM people WHERE id = ?`;

const ICONS = { sms: MessageCircle, email: Mail } as const;

/**
 * New message, from the Inbox's top bar (the owner, 2026-11-22: a way to text or email someone who hasn't written
 * first): a search over the business's customers on this phone, or a new contact added on the spot, then Text or
 * Email. Their conversation opens with the message box ready; one they don't have yet is started, which needs signal
 * (`startConversation`). What can't reach them says why, and where to fix it.
 */
export function NewMessageSheet({
  open,
  onClose,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  /** Their conversation, to open once the sheet is gone. */
  onOpened: (conversationId: string) => void;
}) {
  const { business, viewing } = useBusiness();
  const customers = useCustomers(open);
  const [typed, setTyped] = React.useState('');
  const [chosen, setChosen] = React.useState<CustomerChoice | null>(null);
  /** The New contact form, open, with what's in its boxes. */
  const [contact, setContact] = React.useState<ContactStart | null>(null);
  const [busy, setBusy] = React.useState<ComposeChannel | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  /** The conversation to open once the sheet has gone: iOS shows nothing new while a sheet is still closing. */
  const opening = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setTyped('');
    setChosen(null);
    setContact(null);
    setBusy(null);
    setProblem(null);
    opening.current = null;
  }, [open]);

  const { data: reach } = useQuery<{ phone_e164: string | null; email: string | null }>(REACH_SQL, [
    chosen?.id ?? '',
  ]);
  const to = composeTargets({
    phoneE164: reach[0]?.phone_e164 ?? null,
    email: reach[0]?.email ?? null,
  });

  const found = React.useMemo(() => {
    const wanted = typed.trim();
    return (
      wanted ? customers.filter((c) => matchesSearch(c.searchText, wanted)) : customers
    ).slice(0, SHOWN);
  }, [customers, typed]);
  const mayAdd = !viewing && holds(business, 'records.write');
  const offer = mayAdd && typed.trim().length >= SEARCH_MIN_CHARS;

  const choose = (customer: CustomerChoice) => {
    setChosen(customer);
    setTyped('');
    setContact(null);
    setProblem(null);
  };

  const start = async (channel: ComposeChannel) => {
    const counterpart = to[channel];
    if (!chosen || !counterpart || busy) return;
    setBusy(channel);
    setProblem(null);
    try {
      const started = await startConversation({
        workspaceId: business.id,
        personId: chosen.id,
        name: chosen.name,
        channel,
        counterpart,
      });
      if (!started.ok) return setProblem(started.message);
      opening.current = started.conversationId;
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : W.notReached);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onClosed={() => {
        const id = opening.current;
        opening.current = null;
        if (id) onOpened(id);
      }}
      title={W.title}
      description={W.description}
      scroll
      testID="new-message-sheet"
    >
      {chosen ? (
        <View className="mt-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Avatar name={chosen.name || '?'} seed={chosen.id} size="md" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-[15px]" testID="new-message-to">
              {chosen.name}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onPress={() => {
                setChosen(null);
                setProblem(null);
              }}
              testID="new-message-change"
            >
              {W.someoneElse}
            </Button>
          </View>
          {COMPOSE_CHANNELS.map((channel, i) => (
            <Button
              key={channel}
              variant={i === 0 ? 'primary' : 'secondary'}
              icon={ICONS[channel]}
              loading={busy === channel}
              disabled={!to[channel] || (!!busy && busy !== channel)}
              onPress={() => void start(channel)}
              testID={`new-message-${channel}`}
            >
              <Text numberOfLines={1} className="shrink">
                {to[channel]
                  ? `${W.channel[channel]} ${channel === 'sms' ? formatPhone(to.sms!) : to.email}`
                  : W.channel[channel]}
              </Text>
            </Button>
          ))}
          {COMPOSE_CHANNELS.filter((channel) => !to[channel]).map((channel) => (
            <Text
              key={channel}
              className="text-[13px] leading-[19px] text-text-2"
              testID={`new-message-no-${channel}`}
            >
              {W.missing(channel, chosen.name)}
            </Text>
          ))}
          {problem ? (
            <Text
              role="alert"
              className="text-[13px] leading-[19px] text-danger-text"
              testID="new-message-problem"
            >
              {problem}
            </Text>
          ) : null}
        </View>
      ) : contact ? (
        <View className="mt-3">
          <NewContactForm
            value={contact}
            onChange={setContact}
            onCancel={() => setContact(null)}
            onAdded={(customer) => choose(customer)}
            onChooseExisting={(id, name) =>
              choose(
                customers.find((c) => c.id === id) ?? { id, name, address: null, searchText: '' },
              )
            }
            // HandsFreeOS starts their conversation, so it has to know them first.
            rightAway
          />
        </View>
      ) : (
        <>
          <Input
            value={typed}
            onChangeText={setTyped}
            placeholder={W.search}
            accessibilityLabel={W.to}
            autoCorrect={false}
            autoCapitalize="none"
            className="mt-3"
            testID="new-message-search"
          />
          <View className="mt-2 gap-0.5">
            {found.map((c) => (
              <Pressable
                key={c.id}
                role="button"
                onPress={() => choose(c)}
                className="min-h-12 flex-row items-center gap-3 rounded-menu px-2 active:bg-card-2"
                testID={`new-message-person-${c.id}`}
              >
                <Avatar name={c.name || '?'} seed={c.id} size="md" />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-[15px]">
                    {c.name}
                  </Text>
                  {c.address ? (
                    <Text numberOfLines={1} className="text-[13px] text-text-3">
                      {c.address}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
          {offer ? (
            <AddContactOffer
              typed={typed.trim()}
              nobody={!found.length}
              onAdd={() => setContact(contactFromSearch(typed))}
              testID="new-message"
            />
          ) : typed.trim() && !found.length ? (
            <Text className="mt-2 px-2 text-[13px] text-text-2" testID="new-message-nobody">
              {NEW_CONTACT_WORDS.nobody(typed.trim())}
            </Text>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
