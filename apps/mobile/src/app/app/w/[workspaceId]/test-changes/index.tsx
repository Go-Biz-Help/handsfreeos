import { formatClock } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { useBusiness, businessHref } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ChangeError } from '@/changes';
import { useChanges } from '@/changes/hooks';
import { quietHoursWindow } from '@/changes/rules';
import {
  addNote,
  addPhotoTo,
  ageNewestChange,
  changePhoneAndEmail,
  clearEveryChange,
  moveLeadToWon,
  newCustomerAndLead,
  setOldVersion,
  quietWindowCoveringNow,
  setQuietHours,
  testCustomer,
  textCustomer,
  type Customer,
} from '@/changes/test-actions';
import {
  PRETEND_EVENING,
  setPretendBusinessTime,
  setSlowUploads,
  useTestOverrides,
} from '@/changes/test-overrides';
import { changes } from '@/changes';
import { appVersion, BELOW_MINIMUM_VERSION } from '@/lib/app-version';
import { testToolsEnabled } from '@/lib/config';
import { isTestOffline, setTestOffline } from '@/lib/network';

const TEXT =
  'Thanks again, Maria. We’ll be back Monday at 8:00 AM to put in the new system. Call me if anything changes.';

type Part = 'make' | 'photos' | 'pretend';

const PARTS = [
  { value: 'make', label: 'Make a change', testID: 'tc-part-make' },
  { value: 'photos', label: 'Photos', testID: 'tc-part-photos' },
  { value: 'pretend', label: 'Pretend', testID: 'tc-part-pretend' },
] as const;

/**
 * Test builds only: the changes the screens will make (steps 13–17), made here on one customer through `change()`, and
 * the pretending the on-device checks need: an old change, 9:40 PM where the business is, an app below the API's
 * minimum, slow uploads, and the business's quiet hours on HandsFreeOS.
 *
 * In three parts, each short enough to need no scrolling on a phone, because flows tap these buttons: on the iOS
 * simulator a button scrolled under the fixed top still counts as on screen, and the tap lands on the top instead.
 */
export default function TestChanges() {
  const { business } = useBusiness();
  const snapshot = useChanges();
  const overrides = useTestOverrides();
  const [part, setPart] = React.useState<Part>('make');
  const [customer, setCustomer] = React.useState<Customer | null>(null);
  const [email, setEmail] = React.useState('rosa.delgado@gmail.com');
  const [text, setText] = React.useState(TEXT);
  const [withNote, setWithNote] = React.useState(true);
  const [oldVersion, setOld] = React.useState(appVersion() === BELOW_MINIMUM_VERSION);
  const [noSignal, setNoSignal] = React.useState(isTestOffline());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);
  const { data: workspace } = useQuery<{ settings: string | null }>(
    'SELECT settings FROM workspaces WHERE id = ?',
    [business.id],
  );
  const quiet = quietHoursWindow(workspace[0]?.settings ?? null);
  const { data: people } = useQuery<{ n: number }>(
    'SELECT count(*) AS n FROM people WHERE workspace_id = ?',
    [business.id],
  );

  React.useEffect(() => {
    void testCustomer(business.id).then(setCustomer);
  }, [business.id, people]);

  if (!testToolsEnabled) return null;

  const act = (id: string, work: () => Promise<string>) => {
    setBusy(id);
    setResult(null);
    void work()
      .then(setResult)
      .catch((error: unknown) =>
        setResult(
          error instanceof ChangeError || error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => setBusy(null));
  };
  const need = () => {
    if (!customer) throw new Error('No customer on this phone yet.');
    return customer;
  };
  const name = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    : 'No customer yet';

  return (
    <Screen
      title="Test changes"
      subtitle={name}
      leading="back"
      testID="test-changes-screen"
      scroll={false}
    >
      {/* Always on screen: what's waiting, the last result, no signal, and the way to the list. */}
      <View className="gap-2 border-b border-border px-3 pb-3 pt-2.5">
        <View className="flex-row items-center justify-between gap-2 px-1">
          <Text className="text-[13px] leading-[19px] text-text-3" testID="tc-counts">
            {`${snapshot.waiting} waiting · ${snapshot.needsYou} need you${snapshot.tooOld ? ' · too old' : ''}`}
          </Text>
          <Text
            className="min-w-0 flex-1 text-right text-[13px] leading-[19px] text-text-2"
            testID="tc-result"
          >
            {result ?? ''}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1 flex-row items-center justify-between rounded-card border border-border bg-card px-4 py-2">
            <Text className="text-base">No signal</Text>
            <Switch
              label="No signal"
              checked={noSignal}
              onCheckedChange={(next) => {
                setTestOffline(next);
                setNoSignal(next);
              }}
              testID="tc-no-signal"
            />
          </View>
          <Button
            variant="secondary"
            className="flex-1"
            onPress={() => router.push(businessHref(business.id, 'changes'))}
            testID="tc-open-changes"
          >
            Changes
          </Button>
        </View>
        <Segmented value={part} onChange={setPart} options={PARTS} label="Test changes" />
      </View>
      <ScrollView
        key={part}
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
      >
        {part === 'make' ? (
          <>
            <View className="gap-2">
              <Button
                variant="secondary"
                loading={busy === 'note'}
                onPress={() =>
                  act('note', async () => {
                    await addNote(
                      business.id,
                      need().id,
                      `A note from the phone at ${new Date().toLocaleTimeString('en-US')}`,
                    );
                    return 'Added a note.';
                  })
                }
                testID="tc-note"
              >
                Add a note
              </Button>
              <Button
                variant="secondary"
                loading={busy === 'phone'}
                onPress={() =>
                  act('phone', async () => {
                    await changePhoneAndEmail(business.id, need());
                    return 'Changed the phone number and email.';
                  })
                }
                testID="tc-phone-email"
              >
                Change phone and email
              </Button>
              <Button
                variant="secondary"
                loading={busy === 'won'}
                onPress={() =>
                  act('won', async () => {
                    await moveLeadToWon(business.id, need().id);
                    return 'Moved the lead to Won.';
                  })
                }
                testID="tc-won"
              >
                Move the lead to Won
              </Button>
            </View>

            <View className="gap-1.5">
              <Label nativeID="tc-text-label">Text</Label>
              <Input
                value={text}
                onChangeText={setText}
                multiline
                submitBehavior="blurAndSubmit"
                returnKeyType="done"
                className="h-auto min-h-[88px] py-2.5"
                aria-labelledby="tc-text-label"
                testID="tc-text-body"
              />
              <Button
                variant="secondary"
                loading={busy === 'text'}
                onPress={() =>
                  act('text', async () => {
                    await textCustomer(business.id, need().id, text);
                    return 'Wrote a text.';
                  })
                }
                testID="tc-text"
              >
                Text them
              </Button>
            </View>

            <View className="gap-1.5">
              <Label nativeID="tc-email-label">New customer’s email</Label>
              <Input
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                returnKeyType="done"
                aria-labelledby="tc-email-label"
                testID="tc-email"
              />
              <Button
                variant="secondary"
                loading={busy === 'customer'}
                onPress={() =>
                  act('customer', async () => {
                    await newCustomerAndLead(business.id, email);
                    return 'Added Rosa Delgado and a lead for her.';
                  })
                }
                testID="tc-new-customer"
              >
                Add a customer and a lead
              </Button>
            </View>
          </>
        ) : null}

        {part === 'photos' ? (
          <>
            <List>
              <ListRow
                label="A note waits for the photo"
                end={
                  <Switch
                    label="A note waits for the photo"
                    checked={withNote}
                    onCheckedChange={setWithNote}
                    testID="tc-photo-note"
                  />
                }
              />
            </List>
            <View className="gap-2">
              {(['library', 'camera', 'large'] as const).map((source) => (
                <Button
                  key={source}
                  variant="secondary"
                  loading={busy === source}
                  onPress={() =>
                    act(source, async () => {
                      const id = await addPhotoTo(business.id, need().id, source, withNote);
                      return id ? 'Added a photo.' : 'No photo chosen.';
                    })
                  }
                  testID={`tc-photo-${source}`}
                >
                  {source === 'library'
                    ? 'Add a photo from the library'
                    : source === 'camera'
                      ? 'Take a photo'
                      : 'Add a large file (13 MB, in pieces)'}
                </Button>
              ))}
            </View>

            <List>
              <ListRow
                label="Slow uploads"
                detail="A pause between the pieces of a large file"
                end={
                  <Switch
                    label="Slow uploads"
                    checked={overrides.slowUploads}
                    onCheckedChange={setSlowUploads}
                    testID="tc-slow-uploads"
                  />
                }
              />
            </List>
          </>
        ) : null}

        {part === 'pretend' ? (
          <>
            <View className="gap-2">
              <Button
                variant="secondary"
                loading={busy === 'age'}
                onPress={() =>
                  act('age', async () =>
                    (await ageNewestChange(45))
                      ? 'The newest change waiting is now 45 minutes old.'
                      : 'Nothing is waiting.',
                  )
                }
                testID="tc-age"
              >
                Make the newest change 45 minutes old
              </Button>
            </View>
            <List>
              <ListRow
                label="It’s 9:40 PM where the business is"
                detail="For the quiet-hours question on this phone"
                end={
                  <Switch
                    label="It’s 9:40 PM where the business is"
                    checked={overrides.pretendTime === PRETEND_EVENING}
                    onCheckedChange={(on) => setPretendBusinessTime(on ? PRETEND_EVENING : null)}
                    testID="tc-evening"
                  />
                }
              />
              <ListRow
                label="App version below the minimum"
                detail={`Says it’s ${oldVersion ? BELOW_MINIMUM_VERSION : appVersion()}`}
                end={
                  <Switch
                    label="App version below the minimum"
                    checked={oldVersion}
                    onCheckedChange={(on) => {
                      setOld(on);
                      void setOldVersion(on);
                    }}
                    testID="tc-old-version"
                  />
                }
              />
            </List>
            <View className="gap-2">
              <Text className="px-1 text-[13px] leading-[19px] text-text-3">
                The business’s quiet hours on HandsFreeOS itself, so a text can go at any hour or
                wait for the morning.
              </Text>
              <Text className="px-1 text-[13px] leading-[19px] text-text-2" testID="tc-quiet-state">
                {quiet.enabled
                  ? `On this phone: ${formatClock(quiet.start)} to ${formatClock(quiet.end)}`
                  : 'On this phone: off'}
              </Text>
              <View className="flex-row gap-2">
                {(['off', 'on'] as const).map((v) => (
                  <Button
                    key={v}
                    variant="secondary"
                    className="flex-1"
                    loading={busy === `quiet-${v}`}
                    onPress={() =>
                      act(`quiet-${v}`, async () => {
                        await setQuietHours(business.id, v === 'on');
                        return v === 'on'
                          ? 'Quiet hours are 8 PM to 8 AM.'
                          : 'Quiet hours are off.';
                      })
                    }
                    testID={`tc-quiet-${v}`}
                  >
                    {v === 'on' ? 'Quiet 8 PM–8 AM' : 'Quiet hours off'}
                  </Button>
                ))}
              </View>
              <Button
                variant="secondary"
                loading={busy === 'quiet-now'}
                onPress={() =>
                  act('quiet-now', async () => {
                    const window = quietWindowCoveringNow(business.timezone);
                    await setQuietHours(business.id, true, window);
                    return `Quiet hours are ${formatClock(window.start)} to ${formatClock(window.end)}.`;
                  })
                }
                testID="tc-quiet-now"
              >
                Quiet hours from now until the morning
              </Button>
            </View>
            <Button
              variant="secondary"
              loading={busy === 'discard-all'}
              onPress={() =>
                act('discard-all', async () => {
                  const n = await clearEveryChange();
                  setPretendBusinessTime(null);
                  setSlowUploads(false);
                  if (oldVersion) {
                    setOld(false);
                    await setOldVersion(false);
                  }
                  return n === 0 ? 'The list was empty.' : `Cleared ${n}.`;
                })
              }
              testID="tc-discard-all"
            >
              Clear the list and stop pretending
            </Button>
            <Button
              variant="secondary"
              loading={busy === 'retry'}
              onPress={() =>
                act('retry', async () => {
                  await changes.retryNow();
                  return 'Sending set-aside changes again.';
                })
              }
              testID="tc-retry-now"
            >
              Send set-aside changes now
            </Button>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
