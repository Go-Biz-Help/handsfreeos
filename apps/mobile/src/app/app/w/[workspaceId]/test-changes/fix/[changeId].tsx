import { useQuery } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { DiscardSheet, type Decided } from '@/components/changes/decide-sheets';
import { Ban, CirclePause, RefreshCw } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { changes } from '@/changes';
import { describe, fieldProblems, loadNames, type ChangeWords } from '@/changes/describe';
import type { OutboxRow } from '@/changes/outbox';
import { clockTime } from '@/lib/sync-status';

/**
 * Fix and try again, for a new customer the API refused (test builds, standing in for the customer screen that step 15
 * builds): what was entered, the API's words on the field that needs attention, what waits for the customer, Try again,
 * and "Don't add Rosa".
 */

interface PersonInput {
  workspaceId: string;
  id?: string;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  email?: string | null;
  address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string };
  [key: string]: unknown;
}

const addressText = (a: PersonInput['address']) =>
  a
    ? [a.line1, a.line2, a.city, [a.state, a.postalCode].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : '';

export default function FixNewCustomer() {
  const { changeId } = useLocalSearchParams<{ changeId: string }>();
  const { data } = useQuery<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [changeId]);
  const row = data[0] ?? null;
  const input = React.useMemo(
    () => (row ? (JSON.parse(row.input) as PersonInput) : null),
    [row?.input],
  );
  const [fields, setFields] = React.useState<Record<string, string> | null>(null);
  const [touched, setTouched] = React.useState<Set<string>>(new Set());
  const [waiting, setWaiting] = React.useState<ChangeWords[]>([]);
  const [discarding, setDiscarding] = React.useState<{
    decided: Decided;
    dependants: ChangeWords[];
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!input || fields) return;
    setFields({
      firstName: input.firstName ?? '',
      lastName: input.lastName ?? '',
      phone: input.phone ?? '',
      email: input.email ?? '',
      address: addressText(input.address),
    });
  }, [input, fields]);

  React.useEffect(() => {
    const db = changes.open?.db;
    if (!row || !db) return;
    void changes.dependantsOf(row.id).then(async (rows) => {
      const names = await loadNames(db, rows);
      setWaiting(rows.map((r) => describe(r, names)));
    });
  }, [row?.id, row?.state]);

  if (!row || !input || !fields)
    return <Screen title="Fix and try again" leading="close" testID="fix-change" />;

  const first = input.firstName || input.lastName || 'them';
  const problems = row.state === 'refused' ? fieldProblems(row.answer) : [];
  const problem = (path: string) =>
    touched.has(path) ? null : (problems.find((p) => p.path === path) ?? null);
  const set = (key: string) => (value: string) => {
    setFields({ ...fields, [key]: value });
    setTouched(new Set([...touched, key]));
  };

  const tryAgain = async () => {
    setBusy(true);
    try {
      const fixed: PersonInput = {
        ...input,
        firstName: fields.firstName.trim(),
        lastName: fields.lastName.trim(),
        phone: fields.phone.trim() || null,
        email: fields.email.trim() || null,
      };
      if (fields.address.trim() !== addressText(input.address))
        fixed.address = fields.address.trim() ? { line1: fields.address.trim() } : undefined;
      await changes.fix(row.id, fixed);
      toast.show(`Trying ${first} again.`);
      router.back();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dontAdd = async () => {
    const dependants = await changes.dependantsOf(row.id);
    const db = changes.open?.db;
    if (dependants.length === 0) {
      await changes.discard([row.id]);
      toast.show(`${first} wasn’t added.`);
      router.back();
      return;
    }
    const names = db ? await loadNames(db, dependants) : null;
    setDiscarding({
      decided: { row, words: describe(row, names ?? (await loadNames(changes.open!.db, [row]))) },
      dependants: names ? dependants.map((d) => describe(d, names)) : [],
    });
  };

  const field = (
    key: string,
    label: string,
    props: Partial<React.ComponentProps<typeof Input>> = {},
  ) => {
    const wrong = problem(key);
    return (
      <View className="min-w-0 flex-1 gap-1.5">
        <Label nativeID={`fix-${key}-label`}>{label}</Label>
        <Input
          value={fields[key]}
          onChangeText={set(key)}
          invalid={wrong !== null}
          aria-labelledby={`fix-${key}-label`}
          testID={`fix-${key}`}
          {...props}
        />
        <FieldError testID={`fix-${key}-error`}>{wrong?.message}</FieldError>
      </View>
    );
  };

  const heldLine =
    waiting.length === 1
      ? `The ${waiting[0]!.title.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} is held until ${first} is saved, then it goes right after.`
      : waiting.length > 1
        ? `${waiting.length} changes are held until ${first} is saved, then they go right after.`
        : null;

  return (
    <Screen
      title="Fix and try again"
      subtitle={`New customer · made ${clockTime(Date.parse(row.made_at))}`}
      leading="close"
      testID="fix-change"
      contentClassName="gap-3.5 px-4 pt-3.5"
    >
      {row.state === 'refused' ? (
        <View
          className="flex-row items-start gap-[9px] rounded-[9px] bg-danger-soft px-[11px] py-[9px]"
          testID="fix-reason"
        >
          <Icon as={Ban} className="mt-0.5 size-[17px] text-danger-text" />
          <Text className="flex-1 text-sm leading-5 text-danger-text">
            <Text className="text-sm font-semibold leading-5 text-danger-text">
              This wasn’t saved.{' '}
            </Text>
            {`${row.reason ?? 'HandsFreeOS couldn’t add them.'} Nothing else was lost.`}
          </Text>
        </View>
      ) : null}
      <View className="flex-row gap-2.5">
        {field('firstName', 'First name')}
        {field('lastName', 'Last name')}
      </View>
      {field('phone', 'Mobile', { keyboardType: 'phone-pad' })}
      {field('email', 'Email', {
        keyboardType: 'email-address',
        autoCapitalize: 'none',
        autoCorrect: false,
      })}
      {field('address', 'Address')}
      {heldLine ? (
        <View
          className="flex-row items-start gap-[9px] rounded-[10px] bg-card-2 px-3 py-[11px]"
          testID="fix-held"
        >
          <Icon as={CirclePause} className="mt-px size-[17px] text-text-2" />
          <Text className="flex-1 text-[13.5px] leading-5 text-text-2">{heldLine}</Text>
        </View>
      ) : null}
      <View className="mt-0.5 gap-2">
        <Button
          icon={RefreshCw}
          loading={busy}
          onPress={() => void tryAgain()}
          testID="fix-try-again"
        >
          Try again
        </Button>
        <Button variant="ghostDanger" onPress={() => void dontAdd()} testID="fix-dont-add">
          {`Don’t add ${first}`}
        </Button>
      </View>
      <DiscardSheet
        decided={discarding?.decided ?? null}
        dependants={discarding?.dependants ?? []}
        onClose={() => setDiscarding(null)}
        onDiscarded={() => {
          toast.show(`${first} wasn’t added.`);
          router.back();
        }}
      />
    </Screen>
  );
}
