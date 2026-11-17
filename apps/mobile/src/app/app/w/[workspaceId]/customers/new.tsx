import {
  BUSINESS_CARD_WORDS as W,
  checkCardForm,
  EMPTY_CARD_FORM,
  fillCardForm,
  type CardCorners,
  type CardForm,
  type CardSide,
  type ReadCardOut,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Camera, Crop, Plus, RotateCcw, UserPlus, X } from '@/components/icons';
import { CardEdges } from '@/components/customers/card-edges';
import { PhotoSheet } from '@/components/customers/sheets';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { addContact, type CardPicture } from '@/customers/add-contact';
import { readCardSide, takeCardPhoto, type CardPhoto } from '@/customers/card-scan';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/** A side of the card, from the picture taken to the card read and straightened. */
type SideState =
  | { readonly status: 'reading'; readonly photo: CardPhoto }
  | { readonly status: 'ready'; readonly photo: CardPhoto; readonly read: ReadCardOut }
  | { readonly status: 'failed'; readonly photo: CardPhoto; readonly message: string };

type Notice = { readonly tone: 'info' | 'warn'; readonly text: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A business card's shape, 3½ by 2 inches, for the tiles. */
const CARD_SHAPE = 1.75;

/**
 * New contact (Contacts → + → Type it in, or Scan a business card): someone who isn't in the phone's own contacts.
 * Scanning reads each side of the card and fills the boxes still empty, and keeps the card itself, straightened, for
 * the contact's Files; the person checks the form, fixes what the AI misread, and adds the contact. Adding works with
 * no signal; reading a card needs it.
 */
export default function NewContact() {
  const { business, userId } = useBusiness();
  const { scan } = useLocalSearchParams<{ scan?: string }>();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [form, setForm] = React.useState<CardForm>(EMPTY_CARD_FORM);
  const formRef = React.useRef(form);
  formRef.current = form;
  const [sides, setSides] = React.useState<Partial<Record<CardSide, SideState>>>({});
  const [scanned, setScanned] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [sheetFor, setSheetFor] = React.useState<CardSide | null>(null);
  const [edgesFor, setEdgesFor] = React.useState<CardSide | null>(null);
  const [edgesBusy, setEdgesBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<{ field: string; message: string } | null>(null);
  const [already, setAlready] = React.useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const setSide = (side: CardSide, state: SideState | undefined) =>
    setSides((all) => ({ ...all, [side]: state }));

  const edit = <K extends keyof CardForm>(key: K, value: CardForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setProblem(null);
    setAlready(null);
  };

  const read = async (side: CardSide, photo: CardPhoto) => {
    setSide(side, { status: 'reading', photo });
    setNotice(null);
    try {
      const result = await readCardSide(business.id, side, photo);
      setSide(side, { status: 'ready', photo, read: result });
      let filled = 0;
      if (result.contact) {
        const next = fillCardForm(formRef.current, result.contact);
        filled = next.filled;
        setForm(next.form);
        setProblem(null);
      }
      if (result.isCard) setScanned(true);
      setNotice(
        !result.isCard
          ? { tone: 'warn', text: W.noCard }
          : !result.cropped
            ? { tone: 'warn', text: W.noEdges }
            : { tone: 'info', text: W.filled(filled) },
      );
    } catch (error) {
      const message = error instanceof TypeError ? W.needsSignal : errorMessage(error);
      setSide(side, { status: 'failed', photo, message });
    }
  };

  const take = async (side: CardSide, source: 'camera' | 'library', fromSheet: boolean) => {
    setSheetFor(null);
    // An iPhone won't show the camera over a sheet that is closing.
    if (fromSheet) await wait(450);
    const taken = await takeCardPhoto(source);
    if (taken.kind === 'no-camera-permission') return void toast.error(W.noCamera);
    if (taken.kind !== 'taken') return;
    await read(side, taken.photo);
  };

  // Scan a business card opens the camera straight away, once the screen has slid in.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (scan !== '1' || started.current) return;
    started.current = true;
    const timer = setTimeout(() => void take('front', 'camera', false), 500);
    return () => clearTimeout(timer);
    // Once, on arrival: `take` is made anew each time the screen draws.
  }, [scan]);

  const crop = async (corners: CardCorners) => {
    const side = edgesFor;
    const state = side ? sides[side] : undefined;
    if (!side || !state) return;
    setEdgesBusy(true);
    try {
      const result = await readCardSide(business.id, side, state.photo, corners);
      const before = state.status === 'ready' ? state.read : null;
      setSide(side, {
        status: 'ready',
        photo: state.photo,
        // What the card says stays as it was read; only the picture changes.
        read: { ...result, contact: before?.contact ?? null, isCard: before?.isCard ?? true },
      });
      setNotice(null);
      setEdgesFor(null);
    } catch (error) {
      toast.error(error instanceof TypeError ? W.needsSignal : errorMessage(error));
    } finally {
      setEdgesBusy(false);
    }
  };

  const reading = Object.values(sides).some((s) => s?.status === 'reading');

  const save = async (anyway = false) => {
    const check = checkCardForm(form, { scanned });
    if (!check.ok) return setProblem({ field: check.field, message: check.message });
    // Each side's straightened card; a side that couldn't be read keeps the picture as taken.
    const pictures: CardPicture[] = [];
    for (const side of ['front', 'back'] as const) {
      const state = sides[side];
      if (state?.status === 'ready') pictures.push({ side, base64: state.read.picture });
      if (state?.status === 'failed') pictures.push({ side, base64: state.photo.base64 });
    }
    setBusy(true);
    try {
      const result = await addContact({
        workspaceId: business.id,
        userId,
        check,
        pictures,
        anyway,
      });
      if (result.kind === 'already') return setAlready({ id: result.id, name: result.name });
      toast.show(pictures.length ? W.addedWithCard(result.name) : W.added(result.name));
      router.replace(businessHref(business.id, `customers/people/${result.id}`) as Href);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const invalid = (field: string) => problem?.field === field;
  const bottom = keyboard ? keyboard + (Platform.OS === 'android' ? insets.bottom : 0) : 0;
  const edgesState = edgesFor ? sides[edgesFor] : undefined;

  return (
    <Screen
      title={scan === '1' ? W.scanTitle : W.title}
      leading="back"
      scroll={false}
      testID="new-contact-screen"
    >
      <View className="flex-1" style={{ paddingBottom: bottom }}>
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-4 px-4 pb-8 pt-4"
          keyboardShouldPersistTaps="handled"
          testID="new-contact-scroll"
        >
          <View className="gap-2">
            <View className="flex-row gap-3">
              {(['front', 'back'] as const).map((side) => (
                <SideTile
                  key={side}
                  side={side}
                  state={sides[side]}
                  // The back waits for the front, so a card is read front first.
                  canStart={side === 'front' || !!sides.front}
                  onStart={() => setSheetFor(side)}
                  onRetake={() => setSheetFor(side)}
                  onFix={() => setEdgesFor(side)}
                  onRetry={() => {
                    const state = sides[side];
                    if (state) void read(side, state.photo);
                  }}
                  onRemove={() => setSide(side, undefined)}
                />
              ))}
            </View>
            {notice ? (
              <Text
                className={cn(
                  'text-[13px]',
                  notice.tone === 'warn' ? 'text-warning-text' : 'text-text-2',
                )}
                testID="new-contact-notice"
              >
                {notice.text}
              </Text>
            ) : !sides.front ? (
              <Text className="text-[12.5px] text-text-3">{W.tip}</Text>
            ) : null}
          </View>

          <Box label={W.name}>
            <Input
              value={form.name}
              onChangeText={(v) => edit('name', v)}
              placeholder={W.namePlaceholder}
              autoCapitalize="words"
              autoCorrect={false}
              textContentType="name"
              invalid={invalid('name')}
              testID="new-contact-name"
            />
          </Box>
          <Box label={W.jobTitle}>
            <Input
              value={form.jobTitle}
              onChangeText={(v) => edit('jobTitle', v)}
              placeholder={W.jobTitlePlaceholder}
              autoCapitalize="words"
              textContentType="jobTitle"
              testID="new-contact-job-title"
            />
          </Box>
          <Box label={W.company} hint={form.company.trim() ? W.companyHint : undefined}>
            <Input
              value={form.company}
              onChangeText={(v) => edit('company', v)}
              placeholder={W.companyPlaceholder}
              autoCapitalize="words"
              textContentType="organizationName"
              testID="new-contact-company"
            />
          </Box>

          <Box label={W.phone}>
            <Input
              value={form.phone}
              onChangeText={(v) => edit('phone', v)}
              placeholder={W.phonePlaceholder}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              invalid={invalid('phone')}
              testID="new-contact-phone"
            />
          </Box>
          {form.otherPhones.map((p, i) => (
            <ExtraLine
              key={`phone-${i}`}
              label={W.otherPhone(p.label)}
              value={p.number}
              keyboard="phone-pad"
              invalid={invalid(`otherPhones:${i}`)}
              onChange={(v) =>
                edit(
                  'otherPhones',
                  form.otherPhones.map((o, j) => (j === i ? { ...o, number: v } : o)),
                )
              }
              onRemove={() =>
                edit(
                  'otherPhones',
                  form.otherPhones.filter((_, j) => j !== i),
                )
              }
              testID={`new-contact-other-phone-${i}`}
            />
          ))}
          <AddLine
            label={W.anotherPhone}
            onPress={() => edit('otherPhones', [...form.otherPhones, { number: '', label: '' }])}
            testID="new-contact-add-phone"
          />

          <Box label={W.email}>
            <Input
              value={form.email}
              onChangeText={(v) => edit('email', v)}
              placeholder={W.emailPlaceholder}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              invalid={invalid('email')}
              testID="new-contact-email"
            />
          </Box>
          {form.otherEmails.map((e, i) => (
            <ExtraLine
              key={`email-${i}`}
              label={W.otherEmail(e.label)}
              value={e.email}
              keyboard="email-address"
              invalid={invalid(`otherEmails:${i}`)}
              onChange={(v) =>
                edit(
                  'otherEmails',
                  form.otherEmails.map((o, j) => (j === i ? { ...o, email: v } : o)),
                )
              }
              onRemove={() =>
                edit(
                  'otherEmails',
                  form.otherEmails.filter((_, j) => j !== i),
                )
              }
              testID={`new-contact-other-email-${i}`}
            />
          ))}
          <AddLine
            label={W.anotherEmail}
            onPress={() => edit('otherEmails', [...form.otherEmails, { email: '', label: '' }])}
            testID="new-contact-add-email"
          />

          <Box label={W.website}>
            <Input
              value={form.website}
              onChangeText={(v) => edit('website', v)}
              placeholder={W.websitePlaceholder}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="URL"
              testID="new-contact-website"
            />
          </Box>

          <Box label={W.address}>
            <View className="gap-2">
              <Input
                value={form.street}
                onChangeText={(v) => edit('street', v)}
                placeholder={W.street}
                accessibilityLabel={W.street}
                textContentType="fullStreetAddress"
                testID="new-contact-street"
              />
              <Input
                value={form.city}
                onChangeText={(v) => edit('city', v)}
                placeholder={W.city}
                accessibilityLabel={W.city}
                textContentType="addressCity"
                testID="new-contact-city"
              />
              <View className="flex-row gap-2">
                <Input
                  className="flex-1"
                  value={form.state}
                  onChangeText={(v) => edit('state', v)}
                  placeholder={W.state}
                  accessibilityLabel={W.state}
                  autoCapitalize="characters"
                  textContentType="addressState"
                  testID="new-contact-state"
                />
                <Input
                  className="flex-1"
                  value={form.postalCode}
                  onChangeText={(v) => edit('postalCode', v)}
                  placeholder={W.postalCode}
                  accessibilityLabel={W.postalCode}
                  keyboardType="number-pad"
                  textContentType="postalCode"
                  testID="new-contact-postal-code"
                />
              </View>
            </View>
          </Box>

          <Box label={W.note}>
            <Input
              value={form.note}
              onChangeText={(v) => edit('note', v)}
              placeholder={W.notePlaceholder}
              multiline
              className="h-24 py-3"
              testID="new-contact-note"
            />
          </Box>
        </ScrollView>

        <View
          className="gap-2 border-t border-border bg-card px-4 pt-3"
          style={{ paddingBottom: keyboard ? 12 : Math.max(insets.bottom, 12) }}
        >
          {problem ? (
            <Text className="text-[13px] text-danger-text" testID="new-contact-problem">
              {problem.message}
            </Text>
          ) : null}
          {already ? (
            <View className="gap-2" testID="new-contact-already">
              <Text className="text-[13px] text-text-2">
                {W.already(already.name, {
                  phone: !!form.phone.trim(),
                  email: !!form.email.trim(),
                })}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  onPress={() =>
                    router.replace(
                      businessHref(business.id, `customers/people/${already.id}`) as Href,
                    )
                  }
                  testID="new-contact-open-existing"
                >
                  {W.open(already.name)}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  loading={busy}
                  onPress={() => void save(true)}
                  testID="new-contact-anyway"
                >
                  {W.addAnyway}
                </Button>
              </View>
            </View>
          ) : (
            <Button
              icon={UserPlus}
              loading={busy}
              disabled={reading}
              onPress={() => void save()}
              testID="new-contact-save"
            >
              {reading ? W.reading : W.save}
            </Button>
          )}
        </View>
      </View>

      <PhotoSheet
        open={sheetFor !== null}
        onClose={() => setSheetFor(null)}
        onPick={(source) => sheetFor && void take(sheetFor, source, true)}
      />
      <CardEdges
        open={edgesFor !== null}
        photo={edgesState?.photo ?? null}
        corners={edgesState?.status === 'ready' ? edgesState.read.corners : null}
        busy={edgesBusy}
        onCancel={() => setEdgesFor(null)}
        onCrop={(corners) => void crop(corners)}
      />
    </Screen>
  );
}

/** A box's label above it, and a line of help under it. */
function Box({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-[13px] font-medium">{label}</Text>
      {children}
      {hint ? <Text className="text-[12px] text-text-3">{hint}</Text> : null}
    </View>
  );
}

/** A number or email past the first, with its label and a ✕ to take it off. */
function ExtraLine({
  label,
  value,
  keyboard,
  invalid,
  onChange,
  onRemove,
  testID,
}: {
  label: string;
  value: string;
  keyboard: 'phone-pad' | 'email-address';
  invalid: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
  testID: string;
}) {
  return (
    <Box label={label}>
      <View className="flex-row items-center gap-2">
        <Input
          className="flex-1"
          value={value}
          onChangeText={onChange}
          keyboardType={keyboard}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={label}
          invalid={invalid}
          testID={testID}
        />
        <Pressable
          role="button"
          onPress={onRemove}
          accessibilityLabel={W.removeLine(label.toLowerCase())}
          className="size-11 items-center justify-center rounded-full active:bg-card-2"
          testID={`${testID}-remove`}
        >
          <Icon as={X} className="size-5 text-text-3" />
        </Pressable>
      </View>
    </Box>
  );
}

function AddLine({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      className="-mt-2 flex-row items-center gap-1.5 self-start py-1.5"
      testID={testID}
    >
      <Icon as={Plus} className="size-4 text-accent-text" />
      <Text className="text-[13.5px] font-medium text-accent-text">{label}</Text>
    </Pressable>
  );
}

/** One side of the card: a button to scan it, the card read and straightened, or what went wrong. */
function SideTile({
  side,
  state,
  canStart,
  onStart,
  onRetake,
  onFix,
  onRetry,
  onRemove,
}: {
  side: CardSide;
  state: SideState | undefined;
  canStart: boolean;
  onStart: () => void;
  onRetake: () => void;
  onFix: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const colors = useColors();
  if (!state)
    return (
      <Pressable
        role="button"
        onPress={onStart}
        disabled={!canStart}
        className={cn(
          'flex-1 items-center justify-center gap-1.5 rounded-control border border-dashed border-border-strong bg-card',
          !canStart && 'opacity-50',
        )}
        style={{ aspectRatio: CARD_SHAPE }}
        testID={`card-${side}-scan`}
      >
        <Icon as={Camera} className="size-6 text-accent-text" />
        <Text className="text-[13px] font-medium text-accent-text">
          {side === 'front' ? W.scanFront : W.addBack}
        </Text>
      </Pressable>
    );
  const picture = state.status === 'ready' ? state.read.picture : state.photo.base64;
  return (
    <View className="flex-1 gap-1.5" testID={`card-${side}`}>
      <View
        className="overflow-hidden rounded-control border border-border bg-card-2"
        style={{ aspectRatio: CARD_SHAPE }}
      >
        <Image
          source={{ uri: `data:image/jpeg;base64,${picture}` }}
          className="size-full"
          resizeMode={state.status === 'ready' && state.read.cropped ? 'cover' : 'contain'}
          accessibilityLabel={W.side[side]}
          accessibilityIgnoresInvertColors
        />
        {state.status === 'reading' ? (
          <View
            className="absolute inset-0 items-center justify-center gap-1.5"
            style={{ backgroundColor: `${colors.card}cc` }}
          >
            <ActivityIndicator color={colors.accent} />
            <Text className="text-[12px] font-medium">{W.reading}</Text>
          </View>
        ) : null}
      </View>
      <Text className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {W.side[side]}
      </Text>
      {state.status === 'failed' ? (
        <View className="gap-1">
          <Text className="text-[12.5px] text-danger-text" testID={`card-${side}-failed`}>
            {state.message}
          </Text>
          <TileAction
            icon={RotateCcw}
            label={W.tryAgain}
            onPress={onRetry}
            testID={`card-${side}-retry`}
          />
        </View>
      ) : null}
      {state.status !== 'reading' ? (
        <View className="flex-row flex-wrap gap-x-3">
          <TileAction
            icon={Camera}
            label={W.retake}
            onPress={onRetake}
            testID={`card-${side}-retake`}
          />
          <TileAction icon={Crop} label={W.fixEdges} onPress={onFix} testID={`card-${side}-fix`} />
          <TileAction icon={X} label={W.remove} onPress={onRemove} testID={`card-${side}-remove`} />
        </View>
      ) : null}
    </View>
  );
}

function TileAction({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: typeof Camera;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      className="min-h-9 flex-row items-center gap-1"
      testID={testID}
    >
      <Icon as={icon} className="size-3.5 text-accent-text" />
      <Text className="text-[12.5px] font-medium text-accent-text">{label}</Text>
    </Pressable>
  );
}
