import {
  DESK_BUSINESS_WORDS,
  DESK_OWN_BUSINESS_WORDS,
  DESK_PHONE_MODEL_WORDS,
  DESK_QUICK_LOOK_WORDS,
  DESK_WALLET_STAGE_TONES,
  DESK_WALLET_STAGES,
  DESK_WALLET_WORDS,
  deskBusinessFlags,
  deskCreditCents,
  deskCreditReference,
  deskLastActive,
  deskMoreLines,
  deskPlanLines,
  deskQuickLookCounts,
  deskReasonGiven,
  deskSetupRows,
  deskTheirMoneyLines,
  deskWalletLines,
  deskWalletMoves,
  PHONE_MODEL_LABELS,
  PHONE_MODELS,
  TICKET_STATUS_WORDS,
  type DeskWalletStage,
  type PhoneModel,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { dayWords, whenWords } from '@/admin/words';
import { desk, useLive, type Ok } from '@/admin/live';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DeskWaiting, Line, Section, Stats } from '@/components/admin/bits';
import {
  GlanceActivity,
  GlanceFlags,
  GlanceLines,
  GlanceProblemReports,
  GlanceSetup,
} from '@/components/admin/business-glance';
import { deskHref, useDesk, useDeskCan } from '@/components/admin/staff-context';
import { Eye, KeyRound, UserRoundSearch } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { openWeb } from '@/lib/open-web';
import { useColors } from '@/theme';

type Wallet = Ok<'/v1/queries/platform.wallet.get'>;

/**
 * One business, as a support person needs it (the web's /admin/businesses/<id>): what needs a look, how much is in it
 * and 30 days of what it did, what is set up and whether it works, who is in it, its plan, what its customers paid it,
 * their balance, the model their calls think with, whether it is HandsFreeOS's own, the rest worth knowing on a call,
 * and its tickets and problem reports. Each change
 * asks the business again once it has gone, as the web refreshes. Looking at the business itself happens on the web,
 * where it is read-only, with a reason and a time limit (the founder opens it as its owner there).
 */
export default function Business() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const id = String(workspaceId);
  const colors = useColors();
  const { staff } = useDesk();
  const canLook = useDeskCan('platform.view_as');
  const canMoveWallet = useDeskCan('platform.wallets.adjust');
  const canPickModel = useDeskCan('platform.ai.manage');
  const canMarkOwn = useDeskCan('platform.own_business.manage');

  // All at once, as the web's page asks them: a business with no balance to read is not a page to act on.
  const live = useLive(
    () =>
      Promise.all([
        desk('/v1/queries/platform.business.get', { workspaceId: id }),
        desk('/v1/queries/platform.wallet.get', { workspaceId: id }),
        desk('/v1/queries/platform.business.glance', { workspaceId: id }),
      ]).then(([detail, wallet, glance]) => ({ detail, wallet, glance })),
    id,
  );

  if (!live.data)
    return (
      <Screen
        title=""
        leading="back"
        back={deskHref('businesses')}
        scroll={false}
        testID="desk-business"
      >
        <DeskWaiting live={live} testID="business" />
      </Screen>
    );

  const { detail, wallet, glance } = live.data;
  const b = detail.business;

  return (
    <Screen
      title={b.name}
      leading="back"
      back={deskHref('businesses')}
      scroll={false}
      testID="desk-business"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={live.refreshing}
            onRefresh={live.reload}
            tintColor={colors.accent}
          />
        }
      >
        <View className="gap-1 px-1">
          <Text variant="heading" testID="business-name">
            {b.name}
          </Text>
          <Text className="text-[13px] text-text-3" testID="business-headline">
            {DESK_BUSINESS_WORDS.headline(b, dayWords(b.createdAt))}
          </Text>
        </View>

        {canLook ? (
          <Button
            variant="secondary"
            icon={staff.founder ? KeyRound : Eye}
            onPress={() => void openWeb(`/admin/businesses/${b.workspaceId}`)}
            testID="business-look-on-web"
          >
            {staff.founder ? DESK_PHONE_WORDS.openAsOwnerOnWeb : DESK_PHONE_WORDS.lookOnWeb}
          </Button>
        ) : null}

        <GlanceFlags
          flags={deskBusinessFlags({ ...b, tickets: detail.tickets }, glance, wallet)}
          testID="business"
        />

        <Stats items={deskQuickLookCounts(detail.counts, glance)} testID="business-counts" />

        <GlanceActivity glance={glance} testID="business-activity" />

        <GlanceSetup
          title={DESK_BUSINESS_WORDS.whatIsSetUp}
          setup={deskSetupRows(glance.setup)}
          testID="business-setup"
        />

        <Section title={DESK_BUSINESS_WORDS.theirPeople} testID="business-people">
          {detail.people.map((p) => (
            <View key={p.userId} className="flex-row items-baseline justify-between gap-3">
              <Text className="min-w-0 flex-shrink text-[13.5px]" numberOfLines={1}>
                {p.fullName || p.email}
                <Text className="text-[13.5px] text-text-3"> · {p.role}</Text>
              </Text>
              <Text className="text-[13.5px] text-text-3">{deskLastActive(p.lastActiveAt)}</Text>
            </View>
          ))}
          {/* The web's page for the business has View as beside each of them: the phone holds no copy of theirs. */}
          {canLook && detail.people.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              icon={UserRoundSearch}
              onPress={() => void openWeb(`/admin/businesses/${b.workspaceId}`)}
              testID="business-view-as-on-web"
            >
              {DESK_PHONE_WORDS.viewAsOnWeb}
            </Button>
          ) : null}
        </Section>

        <GlanceLines
          title={DESK_QUICK_LOOK_WORDS.theirPlan}
          lines={deskPlanLines(glance.plan)}
          testID="business-plan"
        />

        <GlanceLines
          title={DESK_QUICK_LOOK_WORDS.whatCustomersPayThem}
          detail={DESK_QUICK_LOOK_WORDS.whatCustomersPayThemExplain}
          lines={deskTheirMoneyLines(glance)}
          testID="business-their-money"
        />

        <WalletSection
          workspaceId={b.workspaceId}
          businessName={b.name}
          wallet={wallet}
          canChange={canMoveWallet}
          onChanged={live.reload}
        />

        <PhoneModelSection
          workspaceId={b.workspaceId}
          phoneModel={detail.phoneModel}
          canChange={canPickModel}
          onChanged={live.reload}
        />

        <OwnBusinessSection
          workspaceId={b.workspaceId}
          isPlatform={detail.isPlatform}
          canChange={canMarkOwn}
          onChanged={live.reload}
        />

        <GlanceLines
          title={DESK_QUICK_LOOK_WORDS.moreAboutThem}
          lines={deskMoreLines(b, glance, detail.phoneModel)}
          testID="business-more"
        />

        <Section title={DESK_BUSINESS_WORDS.theirTickets} testID="business-tickets">
          {detail.tickets.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{DESK_BUSINESS_WORDS.neverWrittenIn}</Text>
          ) : (
            detail.tickets.map((t) => (
              <Pressable
                key={t.id}
                role="link"
                onPress={() => router.push(deskHref(`tickets/${t.id}`) as Href)}
                className="min-h-10 justify-center active:opacity-70"
                testID={`business-ticket-${t.number}`}
              >
                <Text className="text-[13.5px]" numberOfLines={1}>
                  #{t.number} {t.subject}
                  <Text className="text-[13.5px] text-text-3">
                    {' '}
                    · {TICKET_STATUS_WORDS[t.status]} · {whenWords(t.createdAt)}
                  </Text>
                </Text>
              </Pressable>
            ))
          )}
        </Section>

        <GlanceProblemReports glance={glance} testID="business-problems" />
      </ScrollView>
    </Screen>
  );
}

/**
 * Their usage balance (M16), with **cost beside price**: the one place in the product it shows. Moving a business along
 * the rollout is the only control in HandsFreeOS that can stop somebody's phone working, so it is one business at a
 * time, behind a sheet, with a reason; a credit goes on the same way.
 */
function WalletSection({
  workspaceId,
  businessName,
  wallet,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  businessName: string;
  wallet: Wallet;
  canChange: boolean;
  onChanged: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [moving, setMoving] = React.useState<DeskWalletStage | null>(null);
  const [crediting, setCrediting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [amount, setAmount] = React.useState<string>(DESK_WALLET_WORDS.defaultAmount);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Made when the credit sheet opens, not on each press: a second press after an answer lost on the way back is the
  // same credit, which wallet.adjust then records once.
  const reference = React.useRef<string | null>(null);
  const stage = DESK_WALLET_STAGES[wallet.stage];

  const open = (what: () => void) => {
    setReason('');
    setError(null);
    what();
  };
  const close = () => {
    reference.current = null;
    setMoving(null);
    setCrediting(false);
    setReason('');
    setError(null);
  };

  /** One change to the balance, then the business asked for again; the API's words in the sheet if it can't. */
  const run = async (fn: () => Promise<unknown>, said: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      close();
      toast.show(said);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Why first, as the web asks it: the commands refuse a change nobody explained.
  const moveTo = (to: DeskWalletStage) => {
    if (!deskReasonGiven(reason)) return setError(DESK_WALLET_WORDS.sayWhy);
    void run(
      () =>
        desk('/v1/commands/wallet.set_stage', { workspaceId, stage: to, reason: reason.trim() }),
      DESK_BUSINESS_PHONE_WORDS.movedTo(to),
    );
  };

  const credit = () => {
    if (!deskReasonGiven(reason)) return setError(DESK_WALLET_WORDS.sayWhy);
    const cents = deskCreditCents(amount);
    if (cents === null) return setError(DESK_WALLET_WORDS.putInAmount);
    void run(
      () =>
        desk('/v1/commands/wallet.adjust', {
          workspaceId,
          amountCents: cents,
          reason: reason.trim(),
          // One reference per decision: sending the same one twice is the same credit, not a second.
          reference: (reference.current ??= deskCreditReference(workspaceId)),
        }),
      DESK_BUSINESS_PHONE_WORDS.creditPutOn,
    );
  };

  const lift = keyboard ? { paddingBottom: keyboard } : undefined;

  return (
    <Section
      title={DESK_WALLET_WORDS.title}
      detail={DESK_WALLET_WORDS.explain}
      end={
        <Badge variant={DESK_WALLET_STAGE_TONES[wallet.stage]} testID="wallet-stage">
          {stage.label}
        </Badge>
      }
      testID="business-wallet"
    >
      {!wallet.opened ? (
        <Text className="text-[13.5px] text-text-3">{DESK_WALLET_WORDS.notOpened}</Text>
      ) : (
        <View className="gap-2" testID="wallet-lines">
          {deskWalletLines(wallet).map((l) => (
            <Line
              key={l.label}
              label={l.label}
              value={l.value}
              tone={l.tone ?? undefined}
              testID={`wallet-line-${l.label}`}
            />
          ))}
        </View>
      )}

      {wallet.suspendedAt ? (
        <View className="rounded-[10px] bg-danger-soft px-3.5 py-3" testID="wallet-suspended">
          <Text className="text-[13px] text-danger-text">
            {DESK_WALLET_WORDS.suspended(dayWords(wallet.suspendedAt), wallet.suspendedReason)}
          </Text>
        </View>
      ) : null}

      <Text className="text-[13px] leading-[18px] text-text-3">{stage.what}</Text>

      {canChange ? (
        <View className="gap-2">
          {deskWalletMoves(wallet.stage).map((s) => (
            <Button
              key={s}
              variant="secondary"
              size="md"
              onPress={() => open(() => setMoving(s))}
              testID={`wallet-to-${s}`}
            >
              {DESK_WALLET_WORDS.moveTo(s)}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="md"
            onPress={() => open(() => setCrediting(true))}
            testID="wallet-credit"
          >
            {DESK_WALLET_WORDS.credit}
          </Button>
        </View>
      ) : null}

      <Sheet
        open={moving !== null}
        onClose={close}
        title={moving ? DESK_WALLET_WORDS.moveTitle(businessName, moving) : ''}
        description={moving ? DESK_WALLET_STAGES[moving].what : undefined}
        testID="wallet-move-sheet"
      >
        <View className="mt-4 gap-4" style={lift}>
          {wallet.stage === 'agency' && wallet.balanceCents < 0 ? (
            <View className="rounded-[10px] bg-card-2 px-3.5 py-3">
              <Text className="text-[13px] text-text-2">
                {DESK_WALLET_WORDS.writtenOff(-wallet.balanceCents)}
              </Text>
            </View>
          ) : null}
          {moving === 'enforce' ? (
            <View className="rounded-[10px] bg-warning-soft px-3.5 py-3">
              <Text className="text-[13px] text-warning-text">
                {DESK_WALLET_WORDS.enforceWarning}
              </Text>
            </View>
          ) : null}
          <View className="gap-1.5">
            <Label nativeID="wallet-move-reason-label">{DESK_WALLET_WORDS.why}</Label>
            <Input
              value={reason}
              onChangeText={setReason}
              placeholder={DESK_WALLET_WORDS.movePlaceholder}
              aria-labelledby="wallet-move-reason-label"
              maxLength={300}
              testID="wallet-move-reason"
            />
          </View>
          <FieldError testID="wallet-move-error">{error}</FieldError>
          <Button
            loading={busy}
            onPress={() => (moving ? moveTo(moving) : undefined)}
            testID="wallet-move-confirm"
          >
            {DESK_WALLET_WORDS.moveThem}
          </Button>
          <Button variant="ghost" onPress={close}>
            {DESK_WALLET_WORDS.cancel}
          </Button>
        </View>
      </Sheet>

      <Sheet
        open={crediting}
        onClose={close}
        title={DESK_WALLET_WORDS.creditTitle(businessName)}
        description={DESK_WALLET_WORDS.creditExplain}
        testID="wallet-credit-sheet"
      >
        <View className="mt-4 gap-4" style={lift}>
          <View className="gap-1.5">
            <Label nativeID="wallet-credit-amount-label">{DESK_WALLET_WORDS.howMuch}</Label>
            <Input
              value={amount}
              onChangeText={setAmount}
              // A minus takes a credit back, and an iPhone's number pad has none.
              keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
              aria-labelledby="wallet-credit-amount-label"
              testID="wallet-credit-amount"
            />
          </View>
          <View className="gap-1.5">
            <Label nativeID="wallet-credit-reason-label">{DESK_WALLET_WORDS.why}</Label>
            <Input
              value={reason}
              onChangeText={setReason}
              placeholder={DESK_WALLET_WORDS.creditPlaceholder}
              aria-labelledby="wallet-credit-reason-label"
              maxLength={300}
              testID="wallet-credit-reason"
            />
          </View>
          <FieldError testID="wallet-credit-error">{error}</FieldError>
          <Button loading={busy} onPress={credit} testID="wallet-credit-confirm">
            {DESK_WALLET_WORDS.putItOn}
          </Button>
          <Button variant="ghost" onPress={close}>
            {DESK_WALLET_WORDS.cancel}
          </Button>
        </View>
      </Sheet>
    </Section>
  );
}

/** One quick switch on the business, then the business asked for again; the API's words if it can't. */
function useSwitch(onChanged: () => void) {
  const [busy, setBusy] = React.useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.show(DESK_PHONE_WORDS.saved);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

type ModelChoice = PhoneModel | 'default';

/**
 * The model the AI teammate thinks with on this business's calls. Support flips it to hear how a faster model sounds,
 * without a redeploy, and flips it back; it takes effect from the next call.
 */
function PhoneModelSection({
  workspaceId,
  phoneModel,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  phoneModel: PhoneModel | null;
  canChange: boolean;
  onChanged: () => void;
}) {
  const { busy, run } = useSwitch(onChanged);
  const value: ModelChoice = phoneModel ?? 'default';
  return (
    <Section
      title={DESK_PHONE_MODEL_WORDS.title}
      detail={DESK_PHONE_MODEL_WORDS.explain}
      testID="business-phone-model"
    >
      {canChange ? (
        <Segmented<ModelChoice>
          label={DESK_PHONE_MODEL_WORDS.label}
          value={value}
          onChange={(choice) =>
            void run(() =>
              desk('/v1/commands/phone_model.set', {
                workspaceId,
                model: choice === 'default' ? null : choice,
              }),
            )
          }
          options={[
            {
              value: 'default',
              label: DESK_PHONE_MODEL_WORDS.default,
              testID: 'phone-model-default',
              disabled: busy,
            },
            ...PHONE_MODELS.map((m) => ({
              value: m,
              label: PHONE_MODEL_LABELS[m],
              testID: `phone-model-${m}`,
              disabled: busy,
            })),
          ]}
        />
      ) : (
        <Text className="text-[13.5px]" testID="phone-model-value">
          {phoneModel ? PHONE_MODEL_LABELS[phoneModel] : DESK_PHONE_MODEL_WORDS.default}
        </Text>
      )}
    </Section>
  );
}

/** Whether this is HandsFreeOS's own business (M19), the one that may use handsfreeos.com for its email. */
function OwnBusinessSection({
  workspaceId,
  isPlatform,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  isPlatform: boolean;
  canChange: boolean;
  onChanged: () => void;
}) {
  const { busy, run } = useSwitch(onChanged);
  return (
    <Section
      title={DESK_OWN_BUSINESS_WORDS.title}
      detail={DESK_OWN_BUSINESS_WORDS.explain}
      testID="business-own"
    >
      {canChange ? (
        <Segmented<'yes' | 'no'>
          label={DESK_OWN_BUSINESS_WORDS.title}
          value={isPlatform ? 'yes' : 'no'}
          onChange={(choice) =>
            void run(() =>
              desk('/v1/commands/own_business.set', { workspaceId, on: choice === 'yes' }),
            )
          }
          options={[
            {
              value: 'no',
              label: DESK_OWN_BUSINESS_WORDS.no,
              testID: 'own-business-no',
              disabled: busy,
            },
            {
              value: 'yes',
              label: DESK_OWN_BUSINESS_WORDS.yes,
              testID: 'own-business-yes',
              disabled: busy,
            },
          ]}
        />
      ) : (
        <Text className="text-[13.5px]" testID="own-business-value">
          {isPlatform ? DESK_OWN_BUSINESS_WORDS.yes : DESK_OWN_BUSINESS_WORDS.no}
        </Text>
      )}
    </Section>
  );
}
