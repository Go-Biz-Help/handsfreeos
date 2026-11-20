import { checkNewContact, NEW_CONTACT_WORDS as NC, type ContactStart } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import type { CustomerChoice } from '@/calendar/use-calendar';
import { changes } from '@/changes';
import { UserPlus } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { addCustomer } from '@/customers/add-customer';

/**
 * Under a customer search: "No one matches “Dana”." when it found nobody, and "Add “Dana” as a new contact", which
 * opens `NewContactForm` in place of the search (core `new-contact.ts`). Shown only to someone who may add contacts.
 */
export function AddContactOffer({
  typed,
  nobody,
  onAdd,
  testID,
}: {
  typed: string;
  /** The search found nobody, so it says so first. */
  nobody: boolean;
  onAdd: () => void;
  testID?: string;
}) {
  return (
    <View className="mt-2 gap-2" testID={testID && nobody ? `${testID}-nobody` : undefined}>
      {nobody ? <Text className="text-[13px] text-text-2">{NC.nobody(typed)}</Text> : null}
      <Button
        variant="secondary"
        size="md"
        icon={UserPlus}
        className="max-w-full self-start"
        onPress={onAdd}
        testID={testID && `${testID}-add-contact`}
      >
        <Text numberOfLines={1} className="shrink">
          {NC.add(typed)}
        </Text>
      </Button>
    </View>
  );
}

/**
 * New contact, in place of the search it was started from (New appointment's sheet, a document's signers): a name
 * (all it needs), and the number and email that let them be reached. Checked as the server will check it before
 * anything is kept, so what goes with no signal isn't refused later. When the number or email is already a
 * customer's, it offers them instead, or adds this one anyway.
 *
 * `rightAway` is for a screen that asks HandsFreeOS about them at once (a document's signers are filled in from the
 * server): the new contact is sent straight away, and handed on only once it's there. Without signal they stay on the
 * phone and go with the next signal, and the form says so.
 */
export function NewContactForm({
  value,
  onChange,
  onCancel,
  onAdded,
  onChooseExisting,
  hint = NC.hint,
  rightAway = false,
}: {
  value: ContactStart;
  onChange: (next: ContactStart) => void;
  onCancel: () => void;
  onAdded: (customer: CustomerChoice, changeId: string) => void;
  onChooseExisting: (id: string, name: string) => void;
  /** The line under the boxes: New appointment's says the number or email tells them about the visit. */
  hint?: string;
  rightAway?: boolean;
}) {
  const { business } = useBusiness();
  const [problem, setProblem] = React.useState<{ field: string; message: string } | null>(null);
  const [already, setAlready] = React.useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const edit = (key: keyof ContactStart) => (text: string) => {
    onChange({ ...value, [key]: text });
    setProblem(null);
    setAlready(null);
  };

  const add = async (anyway = false) => {
    const check = checkNewContact(value);
    if (!check.ok) return setProblem({ field: check.field, message: check.message });
    setBusy(true);
    try {
      const result = await addCustomer(
        business.id,
        { ...check.person, otherPhones: [], otherEmails: [], otherAddresses: [] },
        check.name,
        { anyway },
      );
      if (result.kind === 'already') return setAlready({ id: result.id, name: result.name });
      if (rightAway) {
        const row = await changes.sendQueuedNow(result.changeId);
        if (row && row.state !== 'sent')
          return setProblem({
            field: '',
            message:
              row.state === 'refused' && row.reason ? row.reason : NC.notThereYet(result.name),
          });
      }
      toast.show(NC.added(result.name));
      onAdded({ id: result.id, name: result.name, address: null, searchText: '' }, result.changeId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-2 rounded-menu bg-card-2 p-3" testID="new-contact">
      <Text className="text-[15px] font-semibold">{NC.title}</Text>
      <Input
        value={value.name}
        onChangeText={edit('name')}
        placeholder={NC.namePlaceholder}
        accessibilityLabel={NC.name}
        autoCapitalize="words"
        autoCorrect={false}
        textContentType="name"
        invalid={problem?.field === 'name'}
        testID="new-contact-name"
      />
      <Input
        value={value.phone}
        onChangeText={edit('phone')}
        placeholder={NC.phonePlaceholder}
        accessibilityLabel={NC.phone}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        invalid={problem?.field === 'phone'}
        testID="new-contact-phone"
      />
      <Input
        value={value.email}
        onChangeText={edit('email')}
        placeholder={NC.emailPlaceholder}
        accessibilityLabel={NC.email}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="emailAddress"
        invalid={problem?.field === 'email'}
        testID="new-contact-email"
      />
      {problem ? (
        <Text className="text-[13px] text-danger-text" testID="new-contact-problem">
          {problem.message}
        </Text>
      ) : (
        <Text className="text-xs text-text-3">{hint}</Text>
      )}
      {already ? (
        <View className="gap-2" testID="new-contact-already">
          <Text className="text-[13px] text-text-2">
            {NC.already(already.name, {
              phone: !!value.phone.trim(),
              email: !!value.email.trim(),
            })}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              variant="secondary"
              size="md"
              onPress={() => onChooseExisting(already.id, already.name)}
              testID="new-contact-choose"
            >
              {NC.choose(already.name)}
            </Button>
            <Button
              variant="ghost"
              size="md"
              loading={busy}
              onPress={() => void add(true)}
              testID="new-contact-anyway"
            >
              {NC.addAnyway}
            </Button>
          </View>
        </View>
      ) : (
        <View className="flex-row gap-2">
          <Button
            size="md"
            icon={UserPlus}
            loading={busy}
            onPress={() => void add()}
            testID="new-contact-save"
          >
            {NC.save}
          </Button>
          <Button variant="ghost" size="md" onPress={onCancel} testID="new-contact-cancel">
            {NC.cancel}
          </Button>
        </View>
      )}
    </View>
  );
}
