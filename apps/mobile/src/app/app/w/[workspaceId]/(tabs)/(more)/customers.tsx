import * as React from 'react';
import { CONTACTS_WORDS, lowerLabel, MORE_WORDS } from '@hfos/core';
import { router, type Href } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';

import { Building, Search, SquareKanban, StickyNote, User, X } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import {
  useCustomers,
  useCustomerSearch,
  type CompanyRow,
  type CustomerTab,
  type PersonRow,
  type SearchHit,
  type Standing,
  withStanding,
} from '@/customers/use-customers';

/**
 * Contacts, reached from More: people and companies from the phone's copy, everyone or only the leads or the clients,
 * and a search across customers, companies and leads that works with no signal — by name, by number, and by a word
 * someone wrote in a note.
 */
export default function Customers() {
  const { business } = useBusiness();
  const [tab, setTab] = React.useState<CustomerTab>('people');
  const [standing, setStanding] = React.useState<Standing>('all');
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const { people, companies, loading } = useCustomers();
  const shownPeople = withStanding(people, standing);
  const shownCompanies = withStanding(companies, standing);
  const nobody = (noun: string) =>
    standing === 'all'
      ? `No ${noun} are on this phone yet.`
      : `No ${lowerLabel(standing === 'lead' ? CONTACTS_WORDS.leads : CONTACTS_WORDS.clients)} here yet. ${CONTACTS_WORDS.clientRule}`;
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

  return (
    <Screen title={MORE_WORDS.customers} leading="back" testID="customers" scroll={false}>
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <Input
          value={typed}
          onChangeText={setTyped}
          placeholder="Search by name, number or a word in a note"
          accessibilityLabel="Search contacts"
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
          <>
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
            <Segmented
              value={standing}
              onChange={setStanding}
              label={CONTACTS_WORDS.standing}
              options={[
                { value: 'all', label: CONTACTS_WORDS.all, testID: 'customers-standing-all' },
                { value: 'lead', label: CONTACTS_WORDS.leads, testID: 'customers-standing-lead' },
                {
                  value: 'client',
                  label: CONTACTS_WORDS.clients,
                  testID: 'customers-standing-client',
                },
              ]}
            />
          </>
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
          ListEmptyComponent={
            <Text className="py-10 text-center text-[13px] text-text-3" testID="customers-no-hits">
              {`Nothing on this phone matches “${q}”.`}
            </Text>
          }
        />
      ) : tab === 'people' ? (
        <FlatList
          data={shownPeople}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <PersonRowView person={item} businessId={business.id} />}
          contentContainerClassName="px-3.5 pb-8"
          initialNumToRender={14}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          testID="customers-list"
          ListEmptyComponent={
            loading ? null : (
              <Text className="px-4 py-10 text-center text-[13px] text-text-3">
                {nobody('customers')}
              </Text>
            )
          }
        />
      ) : (
        <FlatList
          data={shownCompanies}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <CompanyRowView company={item} businessId={business.id} />}
          contentContainerClassName="px-3.5 pb-8"
          initialNumToRender={14}
          windowSize={7}
          testID="companies-list"
          ListEmptyComponent={
            loading ? null : (
              <Text className="px-4 py-10 text-center text-[13px] text-text-3">
                {nobody('companies')}
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
      {person.client ? <Badge variant="ok">{CONTACTS_WORDS.client}</Badge> : null}
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
      {company.client ? <Badge variant="ok">{CONTACTS_WORDS.client}</Badge> : null}
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
