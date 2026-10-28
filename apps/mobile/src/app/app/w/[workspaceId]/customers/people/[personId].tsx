import { BIN_WORDS, formatDate, holds, RECORD_WORDS, telHref, VIDEO_CALL_WORDS } from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Linking, View } from 'react-native';

import { savePerson, type PersonEdit } from '@/customers/actions';
import { assignedWords, contactDetails, otherPhoneLines } from '@/customers/contact-lines';
import { PERSON_CONVERSATIONS_SQL } from '@/customers/queries';
import { useRecord } from '@/customers/use-record';
import {
  ACTION_ICONS,
  DuplicateBanner,
  headLine,
  RecordActions,
  RecordHead,
  type RecordAction,
  type RecordTab,
} from '@/components/customers/bits';
import { DeleteSheet } from '@/components/bin/delete-sheet';
import { AttributionCard } from '@/components/customers/attribution';
import { FunnelCard } from '@/components/customers/funnel-card';
import { PartnerCard } from '@/components/customers/partner-card';
import { RecordBody, nextVisitLine } from '@/components/customers/record-screen';
import { EditSheet, RECORD_SHEET_WORDS } from '@/components/customers/sheets';
import { useBusiness, businessHref } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Video } from '@/components/icons';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { startCall } from '@/inbox/calls';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { sees } from '@/view-as/state';
import { useLens } from '@/view-as/use-lens';
import { useCanStartVideoCall, useStartVideoCall } from '@/video-call/start-call';

/**
 * A customer's own screen — the canvas's 360 view. Everything on it is read from the phone's copy, so it opens with no
 * signal: the head with what they owe and their next visit, the timeline, their leads, tasks, files and details, and
 * the buttons a truck needs (Call through the person's own cell, Text, Email, Book, Note, Photo, Task, Lead, and a
 * Video call where the business has them, which sends them their own link and opens the call). The ads
 * that brought them, and their Partner card, show while there's signal.
 *
 * Editing follows the field-merge rules: only what changed is sent, with what the screen showed, so a teammate's
 * change to another detail stays. An owner deletes them for good from Details, with signal (the Deleted bin,
 * 20261027000400).
 */
export default function PersonScreen() {
  const { personId, compose } = useLocalSearchParams<{ personId: string; compose?: string }>();
  const { business } = useBusiness();
  const data = useRecord('person', personId);
  const person = data.person;
  const canDelete = holds(useGrants(), 'records.delete');
  const { online } = useNetwork();
  const [deleting, setDeleting] = React.useState(false);
  const canVideo = useCanStartVideoCall(business.id);
  const video = useStartVideoCall(business.id);
  const [tab, setTab] = React.useState<RecordTab>('timeline');
  const [sheets, setSheets] = React.useState({
    note: false,
    tags: false,
    task: false,
    photo: false,
    edit: false,
  });
  const onSheet = (which: 'note' | 'tags' | 'task' | 'photo', open: boolean) =>
    setSheets((all) => ({ ...all, [which]: open }));

  const { data: allConversations, isLoading: threadsLoading } = useQuery<{
    id: string;
    channel: string;
  }>(PERSON_CONVERSATIONS_SQL, [business.id, personId]);
  // Viewing as a teammate (20261018000100): Text and Email open only threads they see.
  const lens = useLens();
  const conversations = allConversations.filter((c) => sees(lens?.conversations, c.id));
  const threadFor = (channel: 'sms' | 'email') =>
    conversations.find((c) => c.channel === channel)?.id ??
    (channel === 'sms' ? undefined : conversations.find((c) => c.channel === 'chat')?.id);

  const openThread = (channel: 'sms' | 'email') => {
    const id = threadFor(channel);
    if (!id) {
      toast.error(
        channel === 'sms'
          ? 'No text thread with them yet. Start one from the Inbox.'
          : 'No email thread with them yet. Start one from the Inbox.',
      );
      return;
    }
    router.push(businessHref(business.id, `inbox/${id}`) as Href);
  };

  // Text, from a search result (`?compose=sms`): their text thread, as the Text button opens it, once.
  const composeOnce = React.useRef(false);
  React.useEffect(() => {
    if (composeOnce.current || compose !== 'sms' || !person || threadsLoading) return;
    composeOnce.current = true;
    openThread('sms');
    // Only when the address asks for it and the threads have been read.
  }, [compose, person, threadsLoading]);

  if (!person)
    return (
      <Screen title="Customer" leading="back" testID="person">
        <Text className="py-10 text-center text-[13px] text-text-3" testID="person-missing">
          This customer isn’t on this phone.
        </Text>
      </Screen>
    );

  const ref = { workspaceId: business.id, recordType: 'person' as const, recordId: personId };
  const actions: RecordAction[] = [
    {
      key: 'call',
      label: RECORD_WORDS.actions.call,
      icon: ACTION_ICONS.call,
      primary: true,
      disabled: !person.phoneE164,
      onPress: () => startCall({ personId }, { workspaceId: business.id }),
    },
    {
      key: 'text',
      label: RECORD_WORDS.actions.text,
      icon: ACTION_ICONS.text,
      primary: true,
      disabled: !person.phoneE164,
      onPress: () => openThread('sms'),
    },
    {
      key: 'email',
      label: RECORD_WORDS.actions.email,
      icon: ACTION_ICONS.email,
      primary: true,
      disabled: !person.email,
      onPress: () => openThread('email'),
    },
    ...(canVideo && (person.phoneE164 || person.email)
      ? [
          {
            key: 'video',
            label: VIDEO_CALL_WORDS.start,
            icon: Video,
            disabled: video.busy,
            onPress: () =>
              person.phoneE164 && person.email
                ? video.choose(personId, person.phone ?? person.phoneE164, person.email)
                : void video.start({ personId, channel: person.phoneE164 ? 'sms' : 'email' }),
          },
        ]
      : []),
    {
      key: 'book',
      label: RECORD_WORDS.actions.book,
      icon: ACTION_ICONS.book,
      onPress: () => router.push(businessHref(business.id, 'calendar') as Href),
    },
    {
      key: 'note',
      label: RECORD_WORDS.actions.note,
      icon: ACTION_ICONS.note,
      onPress: () => onSheet('note', true),
    },
    {
      key: 'photo',
      label: RECORD_WORDS.actions.photo,
      icon: ACTION_ICONS.photo,
      onPress: () => onSheet('photo', true),
    },
    {
      key: 'task',
      label: RECORD_WORDS.actions.task,
      icon: ACTION_ICONS.task,
      onPress: () => onSheet('task', true),
    },
    {
      key: 'lead',
      label: RECORD_WORDS.actions.lead,
      icon: ACTION_ICONS.lead,
      onPress: () => router.push(businessHref(business.id, 'pipeline') as Href),
    },
  ];

  const contact = [
    person.phone
      ? {
          key: 'phone',
          text: person.phone,
          onPress: () => {
            const href = telHref(person.phoneE164);
            if (href) void Linking.openURL(href);
          },
        }
      : null,
    // Their other numbers (0103), each a tap from a call like the main one.
    ...otherPhoneLines(person),
    person.email ? { key: 'email-line', text: person.email } : null,
    data.address ? { key: 'address', text: data.address } : null,
  ].filter((c): c is { key: string; text: string; onPress?: () => void } => c !== null);

  const opened: PersonEdit = {
    firstName: person.firstName,
    lastName: person.lastName,
    phone: person.phone ?? '',
    email: person.email ?? '',
    notes: person.notes ?? '',
    line1: person.address.line1 ?? '',
    city: person.address.city ?? '',
    state: person.address.state ?? '',
    postalCode: person.address.postalCode ?? '',
  };

  return (
    <Screen title={person.fullName} leading="back" testID="person">
      <RecordHead
        name={person.fullName}
        seed={person.id}
        line={headLine(person.createdAt, person.source)}
        owed={data.balanceCents}
        archived={!!person.archivedAt}
        contact={contact}
        tags={person.tags}
        onTags={() => onSheet('tags', true)}
      >
        {data.nextVisit ? (
          <View className="rounded-menu bg-card-2 px-3 py-2" testID="record-next-visit">
            <Text className="text-[12.5px] text-text-2">
              {`Next: ${nextVisitLine(data.nextVisit, data.timeZone)}`}
            </Text>
          </View>
        ) : null}
        <RecordActions actions={actions} />
      </RecordHead>

      {person.possibleDuplicateOf ? (
        <DuplicateBanner
          other={{
            id: person.possibleDuplicateOf,
            name: data.names.person(person.possibleDuplicateOf)?.fullName ?? 'a customer',
            value: person.phone,
          }}
          onOpen={(id) =>
            router.replace(businessHref(business.id, `customers/people/${id}`) as Href)
          }
        />
      ) : null}

      <AttributionCard workspaceId={business.id} personId={personId} />
      <PartnerCard
        workspaceId={business.id}
        personId={personId}
        name={person.fullName}
        archived={!!person.archivedAt}
      />
      {person.archivedAt ? null : <FunnelCard workspaceId={business.id} personId={personId} />}

      <RecordBody
        data={data}
        ref={ref}
        name={person.fullName}
        kind="person"
        tags={person.tags}
        tab={tab}
        onTab={setTab}
        details={[
          ...contactDetails(person, {
            phone: person.phone,
            email: person.email,
            address: data.address,
          }),
          { label: RECORD_WORDS.labels.company, value: person.company?.name ?? null },
          { label: RECORD_WORDS.labels.assignedTo, value: assignedWords(person) },
          { label: RECORD_WORDS.labels.source, value: person.source },
          { label: RECORD_WORDS.labels.created, value: formatDate(person.createdAt) },
          { label: RECORD_WORDS.labels.notes, value: person.notes },
        ]}
        onEdit={() => setSheets((all) => ({ ...all, edit: true }))}
        onDelete={
          canDelete ? () => (online ? setDeleting(true) : toast.error(BIN_WORDS.offline)) : null
        }
        sheets={sheets}
        onSheet={onSheet}
        nextVisit={data.nextVisit}
      />

      <EditSheet
        open={sheets.edit}
        onClose={() => setSheets((all) => ({ ...all, edit: false }))}
        fields={[
          { key: 'firstName', label: 'First name', value: opened.firstName },
          { key: 'lastName', label: 'Last name', value: opened.lastName },
          { key: 'phone', label: 'Mobile', value: opened.phone, keyboard: 'phone-pad' },
          { key: 'email', label: 'Email', value: opened.email, keyboard: 'email-address' },
          { key: 'line1', label: 'Street', value: opened.line1 },
          { key: 'city', label: 'City', value: opened.city },
          { key: 'state', label: 'State', value: opened.state },
          { key: 'postalCode', label: 'ZIP', value: opened.postalCode },
          { key: 'notes', label: 'Notes', value: opened.notes, multiline: true },
        ]}
        onSave={async (values) => {
          const saved = await savePerson(business.id, personId, opened, {
            ...opened,
            ...(values as unknown as PersonEdit),
          });
          toast.show(
            saved.changed ? RECORD_SHEET_WORDS.edit.saved : RECORD_SHEET_WORDS.edit.nothing,
          );
        }}
      />
      <DeleteSheet
        open={deleting}
        onClose={() => setDeleting(false)}
        workspaceId={business.id}
        kind="person"
        ids={[personId]}
        names={[person.fullName]}
        onDeleted={() => {
          if (router.canGoBack()) router.back();
          else router.replace(businessHref(business.id, 'customers') as Href);
        }}
      />
      {video.sheet}
    </Screen>
  );
}
