import { BIN_WORDS, formatDate, holds, RECORD_WORDS } from '@hfos/core';
import { router, type Href } from 'expo-router';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable } from 'react-native';

import { saveCompany, type CompanyEdit } from '@/customers/actions';
import { assignedWords, contactDetails, otherPhoneLines } from '@/customers/contact-lines';
import { useRecord } from '@/customers/use-record';
import { DeleteSheet } from '@/components/bin/delete-sheet';
import {
  ACTION_ICONS,
  headLine,
  RecordActions,
  RecordHead,
  type RecordAction,
  type RecordTab,
} from '@/components/customers/bits';
import { RecordBody } from '@/components/customers/record-screen';
import { EditSheet, RECORD_SHEET_WORDS } from '@/components/customers/sheets';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';

/**
 * A company's own screen: the same 360 as a customer's, with its people instead of a phone call. An owner deletes it
 * for good from Details, with signal (the Deleted bin, 20261027000800).
 */
export default function CompanyScreen() {
  const { companyId } = useLocalSearchParams<{ companyId: string }>();
  const { business } = useBusiness();
  const data = useRecord('company', companyId);
  const company = data.company;
  const canDelete = holds(useGrants(), 'records.delete');
  const { online } = useNetwork();
  const [deleting, setDeleting] = React.useState(false);
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

  if (!company)
    return (
      <Screen title="Company" leading="back" testID="company">
        <Text className="py-10 text-center text-[13px] text-text-3" testID="company-missing">
          This company isn’t on this phone.
        </Text>
      </Screen>
    );

  const ref = { workspaceId: business.id, recordType: 'company' as const, recordId: companyId };
  const actions: RecordAction[] = [
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
  ];
  const contact = [
    company.phone ? { key: 'phone', text: company.phone } : null,
    // Its other numbers (0103), each a tap from a call.
    ...otherPhoneLines(company),
    company.email ? { key: 'email-line', text: company.email } : null,
    data.address ? { key: 'address', text: data.address } : null,
  ].filter((c): c is { key: string; text: string; onPress?: () => void } => c !== null);

  const opened: CompanyEdit = {
    name: company.name,
    phone: company.phone ?? '',
    email: company.email ?? '',
    website: company.website ?? '',
    notes: company.notes ?? '',
  };

  return (
    <Screen title={company.name} leading="back" testID="company">
      <RecordHead
        name={company.name}
        seed={company.id}
        company
        line={headLine(company.createdAt, company.source)}
        owed={0}
        archived={!!company.archivedAt}
        contact={contact}
        tags={company.tags}
        onTags={() => onSheet('tags', true)}
      >
        <RecordActions actions={actions} />
      </RecordHead>

      <Card className="gap-2 px-3.5 py-3" testID="company-people">
        <Text className="text-[15px] font-semibold">{`People · ${data.companyPeople.length}`}</Text>
        {data.companyPeople.length === 0 ? (
          <Text className="text-[13px] text-text-2">{RECORD_WORDS.nobodyLinked}</Text>
        ) : (
          data.companyPeople.map((p) => (
            <Pressable
              key={p.id}
              role="button"
              onPress={() =>
                router.push(businessHref(business.id, `customers/people/${p.id}`) as Href)
              }
              className="min-h-12 flex-row items-center gap-2.5"
              testID={`company-person-${p.id}`}
            >
              <Avatar name={p.fullName} seed={p.id} size="sm" />
              <Text className="min-w-0 flex-1 text-[14px]">
                {p.fullName}
                {p.archived ? ' (archived)' : ''}
              </Text>
              <Text className="text-[12px] text-text-3">{p.detail ?? ''}</Text>
            </Pressable>
          ))
        )}
      </Card>

      <RecordBody
        data={data}
        ref={ref}
        name={company.name}
        kind="company"
        tags={company.tags}
        tab={tab}
        onTab={setTab}
        details={[
          ...contactDetails(company, {
            phone: company.phone,
            email: company.email,
            address: data.address,
          }),
          { label: RECORD_WORDS.labels.website, value: company.website },
          { label: RECORD_WORDS.labels.assignedTo, value: assignedWords(company) },
          { label: RECORD_WORDS.labels.source, value: company.source },
          { label: RECORD_WORDS.labels.created, value: formatDate(company.createdAt) },
          { label: RECORD_WORDS.labels.notes, value: company.notes },
        ]}
        onEdit={() => setSheets((all) => ({ ...all, edit: true }))}
        onDelete={
          canDelete ? () => (online ? setDeleting(true) : toast.error(BIN_WORDS.offline)) : null
        }
        sheets={sheets}
        onSheet={onSheet}
        nextVisit={null}
      />

      <EditSheet
        open={sheets.edit}
        onClose={() => setSheets((all) => ({ ...all, edit: false }))}
        fields={[
          { key: 'name', label: 'Name', value: opened.name },
          { key: 'phone', label: 'Phone', value: opened.phone, keyboard: 'phone-pad' },
          { key: 'email', label: 'Email', value: opened.email, keyboard: 'email-address' },
          { key: 'website', label: 'Website', value: opened.website },
          { key: 'notes', label: 'Notes', value: opened.notes, multiline: true },
        ]}
        onSave={async (values) => {
          const saved = await saveCompany(business.id, companyId, opened, {
            ...opened,
            ...(values as unknown as CompanyEdit),
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
        kind="company"
        ids={[companyId]}
        names={[company.name]}
        onDeleted={() => {
          if (router.canGoBack()) router.back();
          else router.replace(businessHref(business.id, 'customers') as Href);
        }}
      />
    </Screen>
  );
}
