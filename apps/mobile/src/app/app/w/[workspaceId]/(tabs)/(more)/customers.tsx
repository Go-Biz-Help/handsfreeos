import * as React from 'react';
import {
  ADD_CONTACT_WORDS,
  CONTACTS_WORDS,
  HANDS_WORDS,
  holds,
  MORE_WORDS,
  PICKED_CONTACT_WORDS as PC,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';

import {
  Building,
  ChevronRight,
  Search,
  SquareKanban,
  StickyNote,
  User,
  UserPlus,
  X,
} from '@/components/icons';
import { AddContactSheet, type AddContactWay } from '@/components/customers/add-contact-sheet';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { handsCalls } from '@/customers/hands';
import { usePickCustomer } from '@/customers/pick-contact';
import {
  useCustomers,
  useCustomerSearch,
  type CompanyRow,
  type CustomerTab,
  type PersonRow,
  type SearchHit,
} from '@/customers/use-customers';
import { useNetwork } from '@/lib/network';
import { SearchEverythingRow } from '@/search/rows';

/**
 * Contacts, reached from More: people and companies from the phone's copy, and a search across customers, companies
 * and leads that works with no signal — by name, by number, and by a word someone wrote in a note, ending with Search
 * everything for what was typed. The + at the top adds someone: from a business card it scans, typed in (New contact),
 * or picked from the phone's own contacts, one at a time. With signal, In your hands opens the people someone on the
 * team has, so the AI leaves them alone (core's messaging/hands.ts).
 */
export default function Customers() {
  const { business, viewing } = useBusiness();
  const { pick, picking } = usePickCustomer(business.id);
  const mayAdd = !viewing && holds(business, 'records.write');
  const [adding, setAdding] = React.useState(false);
  const [tab, setTab] = React.useState<CustomerTab>('people');
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const { people, companies, loading } = useCustomers();
  // On from the first letter typed until the box is empty again, and not before: see `useCustomerSearch`.
  const { hits, loading: finding } = useCustomerSearch(q, typed.trim() !== '' || q !== '');
  const searching = q.length >= 2;
  const inHands = useInHandsCount(business.id);

  const openHit = React.useCallback(
    (hit: SearchHit) =>
      router.push(
        businessHref(
          business.id,
          hit.kind === 'person'
            ? `customers/people/${hit.id}`
            : hit.kind === 'company'
              ? `customers/companies/${hit.id}`
              : `leads/${hit.id}`,
        ) as Href,
      ),
    [business.id],
  );

  const pickFromContacts = async () => {
    const result = await pick();
    if (result.kind === 'failed') toast.error(result.message);
    if (result.kind !== 'added' && result.kind !== 'already') return;
    toast.show(result.kind === 'added' ? PC.added(result.name) : PC.already(result.name), {
      action: {
        label: PC.open,
        onPress: () =>
          router.push(businessHref(business.id, `customers/people/${result.id}`) as Href),
      },
    });
  };

  const addBy = async (way: AddContactWay) => {
    setAdding(false);
    // An iPhone won't show the contacts picker over a sheet that is closing.
    await new Promise((r) => setTimeout(r, 450));
    if (way === 'pick') return void pickFromContacts();
    router.push(
      businessHref(business.id, way === 'scan' ? 'customers/new?scan=1' : 'customers/new') as Href,
    );
  };

  return (
    <Screen
      title={MORE_WORDS.customers}
      leading="back"
      testID="customers"
      scroll={false}
      trailing={
        mayAdd ? (
          <Pressable
            role="button"
            accessibilityLabel={ADD_CONTACT_WORDS.button}
            accessibilityState={{ busy: picking }}
            onPress={() => setAdding(true)}
            testID="customers-add"
            className="size-11 items-center justify-center rounded-full active:bg-card-2"
          >
            <Icon as={UserPlus} className="size-[22px] text-accent" />
          </Pressable>
        ) : undefined
      }
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <Input
          value={typed}
          onChangeText={setTyped}
          placeholder="Search by name, number or a word in a note"
          accessibilityLabel={CONTACTS_WORDS.search}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          testID="customers-search"
          className="h-11"
          trailing={
            typed ? (
              <Pressable
                role="button"
                accessibilityLabel="Clear"
                onPress={() => setTyped('')}
                hitSlop={8}
                className="size-11 items-center justify-center"
              >
                <Icon as={X} className="size-4 text-text-3" />
              </Pressable>
            ) : (
              <View className="size-11 items-center justify-center">
                <Icon as={Search} className="size-4 text-text-3" />
              </View>
            )
          }
        />
        {searching || !inHands ? null : (
          <Pressable
            role="button"
            onPress={() => router.push(businessHref(business.id, 'customers/in-hands') as Href)}
            className="min-h-11 flex-row items-center justify-between rounded-card bg-card-2 px-3"
            testID="customers-in-hands"
          >
            <Text className="text-[14px] font-medium">{`${HANDS_WORDS.title} · ${inHands}`}</Text>
            <Icon as={ChevronRight} className="size-4 text-text-3" />
          </Pressable>
        )}
        {searching ? null : (
          <Segmented
            value={tab}
            onChange={setTab}
            label="People or companies"
            options={[
              { value: 'people', label: `People · ${people.length}`, testID: 'customers-people' },
              {
                value: 'companies',
                label: `Companies · ${companies.length}`,
                testID: 'customers-companies',
              },
            ]}
          />
        )}
      </View>

      {searching ? (
        <FlatList
          data={hits}
          keyExtractor={(hit) => `${hit.kind}:${hit.id}`}
          renderItem={({ item }) => <HitRow hit={item} onPress={openHit} />}
          contentContainerClassName="px-3.5 pb-8"
          initialNumToRender={12}
          keyboardShouldPersistTaps="handled"
          testID="customers-hits"
          ListFooterComponent={
            <SearchEverythingRow
              workspaceId={business.id}
              q={q}
              testID="customers-search-everything"
            />
          }
          ListEmptyComponent={
            finding ? null : (
              <Text
                className="py-10 text-center text-[13px] text-text-3"
                testID="customers-no-hits"
              >
                {`Nothing on this phone matches “${q}”.`}
              </Text>
            )
          }
        />
      ) : tab === 'people' ? (
        <FlatList
          data={people}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <PersonRowView person={item} businessId={business.id} />}
          contentContainerClassName="px-3.5 pb-8"
          initialNumToRender={14}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          testID="customers-list"
          ListEmptyComponent={
            loading ? null : (
              <Text className="py-10 text-center text-[13px] text-text-3">
                No customers are on this phone yet.
              </Text>
            )
          }
        />
      ) : (
        <FlatList
          data={companies}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <CompanyRowView company={item} businessId={business.id} />}
          contentContainerClassName="px-3.5 pb-8"
          initialNumToRender={14}
          windowSize={7}
          testID="companies-list"
          ListEmptyComponent={
            loading ? null : (
              <Text className="py-10 text-center text-[13px] text-text-3">
                No companies are on this phone yet.
              </Text>
            )
          }
        />
      )}
      <AddContactSheet
        open={adding}
        onClose={() => setAdding(false)}
        onPick={(way) => void addBy(way)}
      />
    </Screen>
  );
}

/** How many people are in someone's hands, asked for with signal; 0 without, or while it's loading. */
function useInHandsCount(workspaceId: string): number {
  const { online } = useNetwork();
  const [n, setN] = React.useState(0);
  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    handsCalls(workspaceId)
      .list({ limit: 1 })
      .then((r) => {
        if (!cancelled) setN(r.total);
      })
      .catch(() => {
        // Only a way in: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [online, workspaceId]);
  return n;
}

function PersonRowView({ person, businessId }: { person: PersonRow; businessId: string }) {
  return (
    <Pressable
      role="button"
      onPress={() => router.push(businessHref(businessId, `customers/people/${person.id}`) as Href)}
      className="min-h-14 flex-row items-center gap-3 border-b border-border py-2.5"
      testID={`customer-row-${person.id}`}
    >
      <Avatar name={person.fullName} seed={person.id} size="md" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-medium" numberOfLines={1} testID="customer-name">
          {person.fullName}
        </Text>
        <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
          {person.detail}
        </Text>
      </View>
      {person.openLeads > 0 ? (
        <View className="flex-row items-center gap-1">
          <Icon as={SquareKanban} className="size-3.5 text-text-3" />
          <Text className="text-[12px] text-text-3">{person.openLeads}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function CompanyRowView({ company, businessId }: { company: CompanyRow; businessId: string }) {
  return (
    <Pressable
      role="button"
      onPress={() =>
        router.push(businessHref(businessId, `customers/companies/${company.id}`) as Href)
      }
      className="min-h-14 flex-row items-center gap-3 border-b border-border py-2.5"
      testID={`company-row-${company.id}`}
    >
      <View className="size-10 items-center justify-center rounded-card bg-card-3">
        <Icon as={Building} className="size-5 text-text-2" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-medium" numberOfLines={1}>
          {company.name}
        </Text>
        <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
          {company.detail}
        </Text>
      </View>
      <Text className="text-[12px] text-text-3">{`${company.peopleCount} people`}</Text>
    </Pressable>
  );
}

function HitRow({ hit, onPress }: { hit: SearchHit; onPress: (hit: SearchHit) => void }) {
  return (
    <Pressable
      role="button"
      onPress={() => onPress(hit)}
      className="min-h-14 flex-row items-center gap-3 border-b border-border py-2.5"
      testID={`hit-${hit.kind}-${hit.id}`}
    >
      <View className="size-10 items-center justify-center rounded-card bg-card-2">
        <Icon
          as={
            hit.inNote
              ? StickyNote
              : hit.kind === 'company'
                ? Building
                : hit.kind === 'lead'
                  ? SquareKanban
                  : User
          }
          className="size-5 text-text-3"
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[15px] font-medium" numberOfLines={1} testID="hit-title">
          {hit.title}
        </Text>
        <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
          {hit.inNote ? `In a note: ${hit.detail}` : hit.detail}
        </Text>
      </View>
    </Pressable>
  );
}
