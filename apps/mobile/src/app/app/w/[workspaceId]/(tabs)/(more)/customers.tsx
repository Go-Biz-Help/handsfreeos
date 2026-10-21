import * as React from 'react';
import { CONTACTS_WORDS, holds, MORE_WORDS, PICKED_CONTACT_WORDS as PC } from '@hfos/core';
import { router, type Href } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';

import { Building, Search, SquareKanban, StickyNote, User, UserPlus, X } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { usePickCustomer } from '@/customers/pick-contact';
import {
  useCustomers,
  useCustomerSearch,
  type CompanyRow,
  type CustomerTab,
  type PersonRow,
  type SearchHit,
} from '@/customers/use-customers';
import { SearchEverythingRow } from '@/search/rows';

/**
 * Contacts, reached from More: people and companies from the phone's copy, and a search across customers, companies
 * and leads that works with no signal — by name, by number, and by a word someone wrote in a note, ending with Search
 * everything for what was typed. The button at the top adds a customer picked from the phone's own contacts, one at a
 * time.
 */
export default function Customers() {
  const { business, viewing } = useBusiness();
  const { pick, picking } = usePickCustomer(business.id);
  const mayAdd = !viewing && holds(business, 'records.write');
  const [tab, setTab] = React.useState<CustomerTab>('people');
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const { people, companies, loading } = useCustomers();
  const hits = useCustomerSearch(q);
  const searching = q.length >= 2;

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
            accessibilityLabel={PC.addFromContacts}
            accessibilityState={{ busy: picking }}
            onPress={() => void pickFromContacts()}
            testID="customers-pick"
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
            <Text className="py-10 text-center text-[13px] text-text-3" testID="customers-no-hits">
              {`Nothing on this phone matches “${q}”.`}
            </Text>
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
    </Screen>
  );
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
