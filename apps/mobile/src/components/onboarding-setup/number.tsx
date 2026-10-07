import { onboardingSetupNumberLine, ONBOARDING_SETUP_WORDS as W, WIZARD_WORDS } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Option } from '@/components/ai-setup/fields';
import { Clock, Info, Phone, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import {
  NotInThisBuild,
  type AvailableNumber,
  type NumberType,
  type OnboardingSetupCalls,
} from '@/onboarding-setup/calls';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

import { EmailMeALink, Note, type OwnScreenProps } from './screens';

/**
 * "Your business number" on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8). Where the
 * web opens Settings → Texting & calls in place, the phone does the part a phone does well: the EIN question, then
 * numbers near the address (local) or toll-free, picked from a list and bought right here (`phone_number.buy`). The
 * carriers' registration that follows is a long form, so it emails the person a link, as does keeping a number they
 * already have. Once there's a number, it says where it stands, in the summary's words.
 */
export function NumberScreen({
  workspaceId,
  state,
  answers,
  set,
  calls,
  can,
  refresh,
}: OwnScreenProps) {
  const n = state.numberSetup;
  if (!can('channels.manage')) return <Note icon={Info}>{W.cantDo}</Note>;
  if (n.next === 'ready' && n.display)
    return (
      <View
        className="flex-row items-center gap-3.5 rounded-menu border border-border p-4"
        testID="setup-number-ready"
      >
        <View className="size-10 items-center justify-center rounded-full bg-success-soft">
          <Icon as={Phone} className="size-[18px] text-success-text" />
        </View>
        <Text className="min-w-0 flex-1 text-[15px] font-medium">
          {WIZARD_WORDS.numberReady(n.display)}
        </Text>
      </View>
    );
  if (n.next !== 'buy_number') {
    const line = onboardingSetupNumberLine(state, answers);
    const register = n.next === 'submit_registration' || n.next === 'rejected';
    return (
      <View className="gap-3" testID={`setup-number-${n.next}`}>
        {line ? (
          <Note
            tone={n.next === 'rejected' ? 'danger' : n.next === 'provisioning' ? 'accent' : 'info'}
            busy={n.next === 'provisioning'}
            icon={n.next === 'rejected' ? TriangleAlert : Clock}
          >
            {line}
          </Note>
        ) : null}
        {register ? (
          <Note
            icon={Info}
            action={
              <EmailMeALink workspaceId={workspaceId} step="number" testID="setup-number-link" />
            }
            testID="setup-number-register"
          >
            {P.registerOnComputer}
          </Note>
        ) : null}
      </View>
    );
  }
  const numberType: NumberType = answers.hasEin === false ? 'toll_free' : 'local';
  const address = state.address;
  return (
    <>
      <View className="gap-2">
        <View className="gap-1">
          <Label>{W.ein}</Label>
          <Text className="text-[13px] leading-[18px] text-text-3">{W.einHint}</Text>
        </View>
        <View className="gap-2" role="radiogroup" accessibilityLabel={W.ein}>
          <Option
            on={answers.hasEin === true}
            onSelect={() => set('hasEin', true)}
            title={WIZARD_WORDS.ein.yes}
            description={WIZARD_WORDS.ein.yesDetail}
            testID="setup-ein-yes"
          />
          <Option
            on={answers.hasEin === false}
            onSelect={() => set('hasEin', false)}
            title={WIZARD_WORDS.ein.no}
            description={WIZARD_WORDS.ein.noDetail}
            testID="setup-ein-no"
          />
        </View>
      </View>
      {answers.hasEin !== null ? (
        // Keyed on the answer, so the search starts again on the kind of number it now points to.
        <NumberSearch
          key={numberType}
          workspaceId={workspaceId}
          numberType={numberType}
          near={address ? { city: address.city, state: address.state } : null}
          calls={calls}
          onBought={refresh}
        />
      ) : null}
      <HaveNumber workspaceId={workspaceId} />
    </>
  );
}

/** The numbers free right now, near the address or toll-free, to pick one and buy it. */
function NumberSearch({
  workspaceId,
  numberType,
  near,
  calls,
  onBought,
}: {
  workspaceId: string;
  numberType: NumberType;
  /** Where local numbers are looked for first: the business's city. */
  near: { readonly city: string; readonly state: string } | null;
  calls: OnboardingSetupCalls;
  onBought: () => Promise<void>;
}) {
  const [results, setResults] = React.useState<readonly AvailableNumber[] | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const [areaCode, setAreaCode] = React.useState('');
  /** What the list is: near the city, an area code, or anywhere. */
  const [scope, setScope] = React.useState<'near' | 'area' | 'anywhere'>(
    numberType === 'local' && near ? 'near' : 'anywhere',
  );
  const [searching, setSearching] = React.useState(false);
  const [buying, setBuying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Why the number picked couldn't be bought: not enough on the balance for its first month, say. */
  const [buyError, setBuyError] = React.useState<string | null>(null);
  const [noBuild, setNoBuild] = React.useState(false);

  const search = React.useCallback(
    async (how: 'near' | 'area' | 'anywhere', code = '') => {
      setScope(how);
      setSearching(true);
      setError(null);
      setBuyError(null);
      try {
        const found = await calls.searchNumbers({
          numberType,
          ...(how === 'area' && code ? { areaCode: code } : {}),
          ...(how === 'near' && near
            ? { city: near.city, state: near.state, withinMiles: 25 }
            : {}),
        });
        setResults(found);
        setPicked(found[0]?.e164 ?? null);
        if (!found.length)
          setError(how === 'near' && near ? P.nothingNear(near.city) : P.nothingFree);
      } catch (e) {
        if (e instanceof NotInThisBuild) setNoBuild(true);
        else setError(errorMessage(e));
      } finally {
        setSearching(false);
      }
    },
    [calls, numberType, near],
  );

  // Numbers near the business, or toll-free ones, show straight away. Once, on the way in.
  const looked = React.useRef(false);
  React.useEffect(() => {
    if (looked.current) return;
    looked.current = true;
    void search(numberType === 'local' && near ? 'near' : 'anywhere');
  }, [search, numberType, near]);

  const chosen = results?.find((r) => r.e164 === picked) ?? null;

  async function buy() {
    if (!chosen) return;
    setBuying(true);
    setBuyError(null);
    try {
      await calls.buyNumber(chosen.e164, numberType);
      toast.show(P.bought(chosen.display));
      await onBought();
    } catch (e) {
      // Kept on screen: the refusal says where to go, like topping up the balance first.
      setBuyError(errorMessage(e));
      setBuying(false);
    }
  }

  if (noBuild)
    return (
      <Note
        icon={Info}
        action={<EmailMeALink workspaceId={workspaceId} step="number" testID="setup-number-link" />}
      >
        {P.numberOnComputer}
      </Note>
    );

  const heading =
    numberType === 'toll_free'
      ? P.tollFreeNumbers
      : scope === 'near' && near
        ? P.numbersNear(near.city)
        : null;
  return (
    <View className="gap-3" testID="setup-number-search">
      {heading ? <Label>{heading}</Label> : null}
      {searching ? (
        <Note tone="accent" busy testID="setup-number-searching">
          {P.searching}
        </Note>
      ) : null}
      {!searching && results?.length ? (
        <View className="gap-2" role="radiogroup" accessibilityLabel={heading ?? P.pickNumber}>
          {results.map((r) => (
            <Option
              key={r.e164}
              on={picked === r.e164}
              onSelect={() => {
                setPicked(r.e164);
                setBuyError(null);
              }}
              title={r.display}
              description={[r.locality, r.region].filter(Boolean).join(', ') || null}
              testID={`setup-number-${r.e164.replace(/\D/g, '')}`}
            />
          ))}
        </View>
      ) : null}
      {error ? (
        <Note
          icon={Info}
          action={
            scope !== 'anywhere' ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => void search('anywhere')}
                testID="setup-number-anywhere"
              >
                {P.anywhere}
              </Button>
            ) : null
          }
          testID="setup-number-none"
        >
          {error}
        </Note>
      ) : null}
      {chosen && !searching ? (
        <Button loading={buying} onPress={() => void buy()} testID="setup-number-buy">
          {P.getNumber(chosen.display)}
        </Button>
      ) : null}
      {buyError ? (
        <Note tone="danger" icon={TriangleAlert} testID="setup-number-buy-error">
          {buyError}
        </Note>
      ) : null}
      {numberType === 'local' ? (
        <View className="gap-1.5">
          <Label>{P.areaCode}</Label>
          <View className="flex-row items-center gap-2">
            <View className="min-w-0 flex-1">
              <Input
                value={areaCode}
                onChangeText={(text) => setAreaCode(text.replace(/\D/g, '').slice(0, 3))}
                keyboardType="number-pad"
                maxLength={3}
                returnKeyType="search"
                onSubmitEditing={() => {
                  if (areaCode.length === 3) void search('area', areaCode);
                }}
                accessibilityLabel={P.areaCode}
                testID="setup-number-area-code"
              />
            </View>
            <Button
              variant="secondary"
              disabled={areaCode.length !== 3 || searching}
              onPress={() => void search('area', areaCode)}
              testID="setup-number-area-search"
            >
              {P.search}
            </Button>
          </View>
          <Text className="text-[13px] leading-[18px] text-text-3">{P.areaCodeHint}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** "I already have a number": moving one here is a longer job, sent to a computer. */
function HaveNumber({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View className="gap-2">
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        className="self-start py-1"
        testID="setup-number-have"
      >
        <Text className="text-[13.5px] font-medium text-accent-text">{W.haveNumber}</Text>
      </Pressable>
      {open ? (
        <Note
          icon={Info}
          action={
            <EmailMeALink workspaceId={workspaceId} step="number" testID="setup-number-keep-link" />
          }
        >
          {P.haveNumber}
        </Note>
      ) : null}
    </View>
  );
}
